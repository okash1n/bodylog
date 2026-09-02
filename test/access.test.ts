import { createExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import worker from '../src/index';
import { processNotificationBatches, runDailyDigest } from '../src/slack';
import {
  insertMeasurement, localYmdDaysAgo, obtainAccessToken, resetTables, rootTestEnv, stubFetch, testEnv,
} from './helpers';

const OG_TOKEN = 'og-test-token';
const COACH_SECRET = 'coach-read-secret';

const privateEnv: Env = {
  ...rootTestEnv,
  READ_ACCESS: 'private',
  OG_ACCESS_TOKEN: OG_TOKEN,
  COACHING_API_SECRET: COACH_SECRET,
};

function get(env: Env, path: string, headers?: Record<string, string>): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers }),
    env,
    createExecutionContext(),
  );
}

describe('READ_ACCESS=private の読み取り保護', () => {
  let ownerToken: string;
  beforeAll(async () => {
    await resetTables();
    ownerToken = await obtainAccessToken(privateEnv);
  });
  beforeEach(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare('DELETE FROM measurements'),
      testEnv.DB.prepare('DELETE FROM settings'),
    ]);
    await insertMeasurement({
      grpid: 7001,
      measured_at: `${localYmdDaysAgo(1)}T03:00:00Z`,
      weight: 82.5,
      fat_free_mass: 62.0,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('データ系読み取りは無認証で401（JSON・no-store）', async () => {
    for (const path of [
      '/api/summary', '/api/measurements?days=7', '/api/raw?days=7', '/api/exercise/records?menu_id=x',
      '/llms.txt', '/openapi.json',
    ]) {
      const res = await get(privateEnv, path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get('Cache-Control'), path).toBe('no-store');
      expect(((await res.json()) as { error: string }).error).toBe('unauthorized');
    }
  });

  it('アプリ外枠（HTML・JS・manifest等）は無認証のまま200', async () => {
    for (const path of ['/', '/app.js', '/shared.js', '/styles.css', '/manifest.webmanifest', '/sw.js']) {
      expect((await get(privateEnv, path)).status, path).toBe(200);
    }
  });

  it('オーナーのOAuth Bearerで読み取りできる', async () => {
    const res = await get(privateEnv, '/api/summary', { Authorization: `Bearer ${ownerToken}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { latest: { weight: number } };
    expect(body.latest.weight).toBeCloseTo(82.5, 3);
  });

  it('COACHING_API_SECRET のBearerで読み取りできる（AIコーチングジョブ用）', async () => {
    const res = await get(privateEnv, '/api/summary', { Authorization: `Bearer ${COACH_SECRET}` });
    expect(res.status).toBe(200);
  });

  it('不正なBearerは401', async () => {
    expect((await get(privateEnv, '/api/summary', { Authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('llms.txt / openapi.json は認可付きで取得でき、private向けの文言になる', async () => {
    const llms = await get(privateEnv, '/llms.txt', { Authorization: `Bearer ${COACH_SECRET}` });
    expect(llms.status).toBe(200);
    const text = await llms.text();
    expect(text).toContain('READ_ACCESS=private');
    expect(text).not.toContain('認証不要');
    const spec = await get(privateEnv, '/openapi.json', { Authorization: `Bearer ${COACH_SECRET}` });
    const body = (await spec.json()) as {
      info: { description: string };
      components: { securitySchemes?: Record<string, unknown> };
      security?: unknown[];
    };
    expect(body.info.description).not.toContain('認証不要');
    expect(body.components.securitySchemes).toHaveProperty('bearerAuth');
    expect(body.security).toEqual([{ bearerAuth: [] }]);
  });

  it('シェルHTMLのog:image ?v= に最新計測日を埋めない（無認証HTMLからの計測メタデータ漏洩防止）', async () => {
    // beforeEachのseedは昨日の計測。privateでは ?v= が計測日由来にならないこと
    const yesterday = localYmdDaysAgo(1);
    const privateHtml = await (await get(privateEnv, '/')).text();
    expect(privateHtml).not.toContain(`og.png?v=${yesterday}`);
    // publicでは従来どおり最新計測日がキャッシュバスターに使われる（回帰確認）
    const publicHtml = await (await get(rootTestEnv, '/')).text();
    expect(publicHtml).toContain(`og.png?v=${yesterday}`);
  });

  it('og.png は key 一致で通り、不一致・欠落は401', async () => {
    expect((await get(privateEnv, `/og.png?v=x&key=${OG_TOKEN}`)).status).toBe(200);
    expect((await get(privateEnv, '/og.png?v=x&key=wrong')).status).toBe(401);
    expect((await get(privateEnv, '/og.png?v=x')).status).toBe(401);
  });

  it('OG_ACCESS_TOKEN 未設定なら key を渡しても401', async () => {
    const env: Env = { ...privateEnv, OG_ACCESS_TOKEN: undefined };
    expect((await get(env, `/og.png?v=x&key=${OG_TOKEN}`)).status).toBe(401);
  });

  it('書き込みルートの保護は従来どおり（無認証401）', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/api/weight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weight_kg: 80 }),
      }),
      privateEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(401);
  });
});

describe('READ_ACCESS 既定（public）は挙動不変', () => {
  beforeEach(async () => {
    await resetTables();
    await insertMeasurement({
      grpid: 7101,
      measured_at: `${localYmdDaysAgo(1)}T03:00:00Z`,
      weight: 82.5,
    });
  });

  it('無認証で読み取りできる', async () => {
    expect((await get(rootTestEnv, '/api/summary')).status).toBe(200);
    expect((await get(rootTestEnv, '/llms.txt')).status).toBe(200);
  });

  it('未設定・空文字は既定どおり public（既存デプロイとの後方互換）', async () => {
    expect((await get({ ...rootTestEnv, READ_ACCESS: undefined }, '/api/summary')).status).toBe(200);
    expect((await get({ ...rootTestEnv, READ_ACCESS: '' }, '/api/summary')).status).toBe(200);
  });
});

describe('READ_ACCESS の未知値は fail-closed（private 扱い）', () => {
  beforeEach(async () => {
    await resetTables();
    await insertMeasurement({
      grpid: 7102,
      measured_at: `${localYmdDaysAgo(1)}T03:00:00Z`,
      weight: 82.5,
    });
  });

  it.each(['privte', 'Private', 'PUBLIC', 'true'])('READ_ACCESS=%s は読み取りが401になる', async (v) => {
    expect((await get({ ...rootTestEnv, READ_ACCESS: v }, '/api/summary')).status).toBe(401);
  });
});

describe('private時のSlack画像URL', () => {
  const SLACK_HOST = 'hooks.slack.com';
  beforeEach(resetTables);
  afterEach(() => vi.unstubAllGlobals());

  const dailyWebhooks = '[{"id":"night","url":"https://hooks.slack.com/services/T0/B0/X","mode":"daily"}]';

  async function seedToday(): Promise<void> {
    await insertMeasurement({
      grpid: 7201,
      measured_at: new Date().toISOString(),
      weight: 82.9,
      fat_free_mass: 62.0,
    });
  }

  it('OG_ACCESS_TOKEN 設定時はダイジェストの画像URLに key が付く', async () => {
    await seedToday();
    const env: Env = { ...privateEnv, SLACK_WEBHOOKS: dailyWebhooks };
    const stub = stubFetch().on({ host: SLACK_HOST, method: 'POST', times: 1, reply: () => new Response('ok') });
    await runDailyDigest(env, 'https://origin.example');
    const posts = stub.requests({ host: SLACK_HOST });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain(`key=${OG_TOKEN}`);
  });

  it('即時通知（processNotificationBatches）の画像URLにも key が付く', async () => {
    await seedToday();
    const env: Env = {
      ...privateEnv,
      SLACK_WEBHOOKS: '[{"id":"main","url":"https://hooks.slack.com/services/T0/B0/X","mode":"immediate"}]',
    };
    await testEnv.DB.prepare(
      'INSERT INTO notification_batch_items (measurement_id, batch_id) VALUES (7201, ?1)',
    ).bind('b-imm').run();
    await testEnv.DB.prepare(
      "INSERT INTO notification_batches (batch_id, destination_id, status, next_attempt_at) VALUES (?1, 'main', 'pending', datetime('now', '-5 seconds'))",
    ).bind('b-imm').run();
    const stub = stubFetch().on({ host: SLACK_HOST, method: 'POST', times: 1, reply: () => new Response('ok') });
    await processNotificationBatches(env, 'https://origin.example');
    const posts = stub.requests({ host: SLACK_HOST });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain(`key=${OG_TOKEN}`);
  });

  it('OG_ACCESS_TOKEN 未設定なら画像ブロックを省略して送る', async () => {
    await seedToday();
    const env: Env = { ...privateEnv, OG_ACCESS_TOKEN: undefined, SLACK_WEBHOOKS: dailyWebhooks };
    const stub = stubFetch().on({ host: SLACK_HOST, method: 'POST', times: 1, reply: () => new Response('ok') });
    await runDailyDigest(env, 'https://origin.example');
    const posts = stub.requests({ host: SLACK_HOST });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).not.toContain('og.png');
    expect(posts[0].body).toContain('日次サマリー');
  });
});
