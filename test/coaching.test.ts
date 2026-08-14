import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import {
  buildCoachingBlocks,
  coachingBatchId,
  parseCoachingBatchId,
  parseCoachingInput,
} from '../src/coaching';
import type { CoachingNote } from '../src/coaching';
import { resetTables, rootTestEnv, stubFetch, testEnv } from './helpers';

const SECRET = 'test-coaching-secret';
const SLACK_HOST = 'hooks.slack.com';
const SLACK_PATH = '/services/T0/B0/X';

/** daily宛先1件＋シークレット設定済みのドメイン直下Env */
const coachingEnv: Env = {
  ...rootTestEnv,
  COACHING_API_SECRET: SECRET,
  SLACK_WEBHOOKS: `[{"id":"night","url":"https://${SLACK_HOST}${SLACK_PATH}","mode":"daily"}]`,
};

async function postCoaching(env: Env, body: unknown, token: string | null = SECRET): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request('http://localhost/api/coaching', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  // Slack送信はwaitUntilで走るため、アサーション前に完了を待つ
  await waitOnExecutionContext(ctx);
  return res;
}

function getLatest(env: Env): Promise<Response> {
  return worker.fetch(
    new Request('http://localhost/api/coaching/latest'),
    env,
    createExecutionContext(),
  );
}

const validBody = { kind: 'daily', date: '2026-08-13', content: '昨日は脂質過多。今日は揚げ物を控えよう。', model: 'test-model' };

describe('POST /api/coaching の認証', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('COACHING_API_SECRET未設定なら404（機能無効）', async () => {
    const res = await postCoaching({ ...rootTestEnv, COACHING_API_SECRET: undefined }, validBody);
    expect(res.status).toBe(404);
  });

  it('Authorizationなし・トークン不一致は401', async () => {
    expect((await postCoaching(coachingEnv, validBody, null)).status).toBe(401);
    expect((await postCoaching(coachingEnv, validBody, 'wrong-token')).status).toBe(401);
    // 長さ一致でも不一致は401（タイミングセーフ比較の分岐）
    expect((await postCoaching(coachingEnv, validBody, 'x'.repeat(SECRET.length))).status).toBe(401);
  });
});

describe('POST /api/coaching の保存とSlack配信', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('バリデーション: kind/date/content不正は400', async () => {
    const cases: Record<string, unknown>[] = [
      { ...validBody, kind: 'monthly' },
      { ...validBody, date: '2026-02-30' },
      { ...validBody, date: '20260813' },
      { ...validBody, content: '' },
      { ...validBody, content: '  ' },
      { ...validBody, content: 'x'.repeat(4001) },
      { ...validBody, model: 42 },
    ];
    for (const body of cases) {
      const res = await postCoaching(coachingEnv, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });

  it('正常系: 201で保存し、daily宛先へSlack配信する', async () => {
    const stub = stubFetch().on({
      host: SLACK_HOST,
      path: SLACK_PATH,
      method: 'POST',
      times: 1,
      reply: () => new Response('ok'),
    });
    const res = await postCoaching(coachingEnv, validBody);
    expect(res.status).toBe(201);
    const saved = (await res.json()) as CoachingNote & { queued: number };
    expect(saved.kind).toBe('daily');
    expect(saved.date).toBe('2026-08-13');
    expect(saved.queued).toBe(1);

    const posts = stub.requests({ host: SLACK_HOST });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain('AIコーチ（日次・2026-08-13）');
    expect(posts[0].body).toContain('揚げ物を控えよう');
    expect(posts[0].body).toContain('ダッシュボード');
  });

  it('同kind・同日の再保存はcontentを更新し、Slackへは再送しない', async () => {
    const stub = stubFetch().on({
      host: SLACK_HOST,
      path: SLACK_PATH,
      method: 'POST',
      times: 1,
      reply: () => new Response('ok'),
    });
    expect((await postCoaching(coachingEnv, validBody)).status).toBe(201);
    const res2 = await postCoaching(coachingEnv, { ...validBody, content: '改訂版の講評' });
    expect(res2.status).toBe(201);
    expect(((await res2.json()) as { queued: number }).queued).toBe(0);
    expect(stub.requests({ host: SLACK_HOST })).toHaveLength(1);

    const latest = (await (await getLatest(coachingEnv)).json()) as { daily: CoachingNote | null };
    expect(latest.daily?.content).toBe('改訂版の講評');
  });

  it('SLACK_WEBHOOKS未設定でも保存自体は成功する（queued=0）', async () => {
    const env: Env = { ...rootTestEnv, COACHING_API_SECRET: SECRET, SLACK_WEBHOOKS: undefined };
    const res = await postCoaching(env, validBody);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { queued: number }).queued).toBe(0);
  });
});

describe('GET /api/coaching/latest', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未生成なら daily/weekly とも null', async () => {
    const res = await getLatest(rootTestEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(await res.json()).toEqual({ daily: null, weekly: null });
  });

  it('kindごとに日付が最新の1件を返す', async () => {
    stubFetch(); // Slack送信なし（SLACK_WEBHOOKSはimmediateのみのtestEnv値ではなくdaily無し）を保証
    const env: Env = { ...rootTestEnv, COACHING_API_SECRET: SECRET, SLACK_WEBHOOKS: undefined };
    await postCoaching(env, { kind: 'daily', date: '2026-08-12', content: '古い日次' });
    await postCoaching(env, { kind: 'daily', date: '2026-08-13', content: '新しい日次' });
    await postCoaching(env, { kind: 'weekly', date: '2026-08-11', content: '週次総括' });
    const latest = (await (await getLatest(env)).json()) as {
      daily: CoachingNote | null;
      weekly: CoachingNote | null;
    };
    expect(latest.daily?.date).toBe('2026-08-13');
    expect(latest.daily?.content).toBe('新しい日次');
    expect(latest.weekly?.date).toBe('2026-08-11');
  });
});

describe('coaching ユニット', () => {
  it('parseCoachingInput: contentをtrimし、model省略はnull', () => {
    const r = parseCoachingInput({ kind: 'weekly', date: '2026-08-10', content: '  本文  ' });
    expect(r).toEqual({
      ok: true,
      value: { kind: 'weekly', date: '2026-08-10', content: '本文', model: null },
    });
  });

  it('batchId の生成とパースが往復する。不正値はnull', () => {
    expect(coachingBatchId('daily', '2026-08-13')).toBe('coaching-daily-2026-08-13');
    expect(parseCoachingBatchId('coaching-weekly-2026-08-10')).toEqual({
      kind: 'weekly',
      date: '2026-08-10',
    });
    expect(parseCoachingBatchId('coaching-monthly-2026-08-10')).toBeNull();
    expect(parseCoachingBatchId('daily-2026-08-10')).toBeNull();
  });

  it('buildCoachingBlocks: 長文はSlackのsection上限内に分割される', () => {
    const note: CoachingNote = {
      id: 'x',
      kind: 'weekly',
      date: '2026-08-10',
      content: Array.from({ length: 80 }, (_, i) => `行${i} ${'あ'.repeat(50)}`).join('\n'),
      model: null,
      created_at: '2026-08-10T00:00:00Z',
    };
    const blocks = buildCoachingBlocks(note, 'https://weight.example.com/') as {
      text?: { text: string };
    }[];
    expect(blocks.length).toBeGreaterThan(3); // タイトル + 本文2分割以上 + リンク
    for (const b of blocks) {
      expect((b.text?.text ?? '').length).toBeLessThanOrEqual(2800);
    }
    // 分割しても本文が欠落しない
    const joined = blocks
      .slice(1, -1)
      .map((b) => b.text?.text ?? '')
      .join('\n');
    expect(joined).toBe(note.content);
  });
});
