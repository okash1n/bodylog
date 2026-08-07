import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, LatestMeasurement, NotificationStats } from '../src/types';
import { LIMITS } from '../src/util';
import { buildMessageBlocks, parseDestinations, processNotificationBatches } from '../src/slack';
import { insertMeasurement, resetTables, stubFetch, testEnv } from './helpers';

const SLACK_HOST = 'hooks.slack.com';
const SLACK_PATH = '/services/T0/B0/X';
const ORIGIN = 'https://origin.example';

describe('buildMessageBlocks', () => {
  const latest: LatestMeasurement = {
    measured_at: '2026-01-05T15:00:00Z',
    weight: 65.2,
    fat_mass: null,
    fat_free_mass: 53.1,
    fat_ratio: 18.5,
  };
  const stats: NotificationStats = {
    recent7: { weight: 65.5, fat_mass: null, fat_free_mass: 53.0 },
    diff7: { weight: -0.4, fat_mass: null, fat_free_mass: 0.3 },
    baselineDate: '2025-12-01',
    baselineDiff: { weight: -2.3, fat_mass: null, fat_free_mass: 0.5 },
  };
  const dashboardUrl = 'https://origin.example/d/slug/?v=2026-01-06';

  it('数値はcode・見出しはbold・nullは—で描画される', () => {
    const blocks = buildMessageBlocks({ latest, extraCount: 0, stats, dashboardUrl, tzOffset: 9 });
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
    const text = JSON.stringify(blocks);

    expect(text).toContain('計測結果');
    expect(text).toContain('2026-01-06 00:00'); // UTC 15:00 → JST 翌0:00
    expect(text).toContain('*体重*');
    expect(text).toContain('`65.2 kg`');
    expect(text).toContain('`53.1 kg`');
    expect(text).toContain('`18.5%`'); // 体脂肪率は計測結果行のみ
    expect(text).toContain('—'); // fat_mass null
    expect(text).toContain('-0.4 kg'); // 符号付き差分
    expect(text).toContain('基準日（2025-12-01）');
    expect(text).toContain('-2.3 kg');
    expect(text).toContain(dashboardUrl);
    expect(text).not.toContain('ほか');
  });

  it('複数件はほかN件・正の差分は+符号付き', () => {
    const blocks = buildMessageBlocks({
      latest,
      extraCount: 2,
      stats: { ...stats, diff7: { weight: 0.3, fat_mass: null, fat_free_mass: null } },
      dashboardUrl,
      tzOffset: 9,
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain('ほか 2 件取り込み');
    expect(text).toContain('+0.3');
  });

  it('ogImageUrl 指定時は画像ブロックを付け、未指定なら付けない', () => {
    const withImage = buildMessageBlocks({
      latest,
      extraCount: 0,
      stats,
      dashboardUrl,
      tzOffset: 9,
      ogImageUrl: 'https://origin.example/og.png?v=2026-01-06',
    });
    const image = (withImage as { type: string; image_url?: string }[]).find((b) => b.type === 'image');
    expect(image?.image_url).toBe('https://origin.example/og.png?v=2026-01-06');

    const withoutImage = buildMessageBlocks({ latest, extraCount: 0, stats, dashboardUrl, tzOffset: 9 });
    expect(JSON.stringify(withoutImage)).not.toContain('"image"');
  });

  it('基準日未設定なら基準日ブロックを省略する', () => {
    const blocks = buildMessageBlocks({
      latest,
      extraCount: 0,
      stats: { ...stats, baselineDate: null, baselineDiff: { weight: null, fat_mass: null, fat_free_mass: null } },
      dashboardUrl,
      tzOffset: 9,
    });
    expect(JSON.stringify(blocks)).not.toContain('基準日');
  });
});

describe('parseDestinations', () => {
  const withWebhooks = (value: string | undefined): Env => ({ ...testEnv, SLACK_WEBHOOKS: value });

  it('正しいJSONをパースする', () => {
    expect(parseDestinations(testEnv)).toEqual([
      {
        id: 'main',
        url: 'https://hooks.slack.com/services/T0/B0/X',
        mode: 'immediate',
        digestTimeMinutes: null,
        digestTarget: 'same',
      },
    ]);
  });

  it('不正な形式はthrowする', () => {
    expect(() => parseDestinations(withWebhooks(undefined))).toThrow();
    expect(() => parseDestinations(withWebhooks('not-json'))).toThrow();
    expect(() => parseDestinations(withWebhooks('{"id":"a"}'))).toThrow(); // 配列でない
    expect(() => parseDestinations(withWebhooks('[{"url":"https://hooks.slack.com/x"}]'))).toThrow(); // id欠落
    expect(() => parseDestinations(withWebhooks('[{"id":"a","url":"https://example.com/x"}]'))).toThrow(); // Slack以外のURL
  });
});

describe('processNotificationBatches', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function seedBatch(
    batchId: string,
    grpid: number,
    opts?: { attempts?: number; nextOffsetSec?: number },
  ): Promise<void> {
    await insertMeasurement({ grpid, measured_at: '2026-01-05T15:00:00Z', weight: 65.2 });
    await testEnv.DB.prepare('INSERT INTO notification_batch_items (grpid, batch_id) VALUES (?, ?)')
      .bind(grpid, batchId)
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO notification_batches (batch_id, destination_id, status, attempts, next_attempt_at)
       VALUES (?, 'main', 'pending', ?, datetime('now', ? || ' seconds'))`,
    )
      .bind(batchId, opts?.attempts ?? 0, String(opts?.nextOffsetSec ?? -5))
      .run();
  }

  async function batchRow(batchId: string): Promise<{
    status: string;
    attempts: number;
    sent_at: string | null;
    delta: number | null;
  }> {
    const row = await testEnv.DB.prepare(
      `SELECT status, attempts, sent_at,
              CAST(strftime('%s', next_attempt_at) AS INTEGER) - CAST(strftime('%s', 'now') AS INTEGER) AS delta
       FROM notification_batches WHERE batch_id = ?`,
    )
      .bind(batchId)
      .first<{ status: string; attempts: number; sent_at: string | null; delta: number | null }>();
    if (!row) throw new Error(`batch row missing: ${batchId}`);
    return row;
  }

  it('2xxで sent になり blocks をPOSTする', async () => {
    await seedBatch('b-ok', 501);
    const stub = stubFetch().on({ host: SLACK_HOST, path: SLACK_PATH, method: 'POST', times: 1, reply: () => new Response('ok') });

    const result = await processNotificationBatches(testEnv, ORIGIN);
    expect(result).toEqual({ sent: 1, deferred: 0, dead: 0 });
    const row = await batchRow('b-ok');
    expect(row.status).toBe('sent');
    expect(row.sent_at).not.toBeNull();
    const posts = stub.requests({ host: SLACK_HOST });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain('"blocks"');
  });

  it('429は Retry-After を尊重して pending のまま延期する', async () => {
    await seedBatch('b-429', 502);
    stubFetch().on({
      host: SLACK_HOST,
      path: SLACK_PATH,
      method: 'POST',
      times: 1,
      reply: () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '120' } }),
    });

    const result = await processNotificationBatches(testEnv, ORIGIN);
    expect(result).toEqual({ sent: 0, deferred: 1, dead: 0 });
    const row = await batchRow('b-429');
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    // 指数バックオフ（attempts=1 → 60秒）ではなく Retry-After=120秒 が優先される
    expect(row.delta).toBeGreaterThanOrEqual(90);
    expect(row.delta).toBeLessThanOrEqual(150);
  });

  it('attempts 上限到達で dead になり admin alert を送る', async () => {
    await seedBatch('b-dead', 503, { attempts: LIMITS.MAX_NOTIFY_ATTEMPTS - 1 });
    const stub = stubFetch()
      .on({ host: SLACK_HOST, path: SLACK_PATH, method: 'POST', times: 1, reply: () => new Response('boom', { status: 500 }) })
      // ADMIN_SLACK_WEBHOOK 未設定 → SLACK_WEBHOOKS 先頭に alert が飛ぶ
      .on({ host: SLACK_HOST, path: SLACK_PATH, method: 'POST', times: 1, reply: () => new Response('ok') });

    const result = await processNotificationBatches(testEnv, ORIGIN);
    expect(result).toEqual({ sent: 0, deferred: 0, dead: 1 });
    expect((await batchRow('b-dead')).status).toBe('dead');
    expect(stub.requests({ host: SLACK_HOST })).toHaveLength(2);
  });
});
