/**
 * POST /api/digest（指定日の日次ダイジェストを手動送信）のテスト。
 * 自動送信が「23:55 時点で計測なし」でスキップされた日に、後から体重を記録して送り直す用途。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { upsertCoachingNote } from '../src/coaching';
import { createMenu, logMeal } from '../src/meals';
import {
  apiFetch, insertMeasurement, localYmdDaysAgo, resetTables, rootTestEnv, setSetting, stubFetch, testEnv,
} from './helpers';

const SECRET = 'digest-test-secret';
const SLACK_HOST = 'hooks.slack.com';
const SLACK_PATH = '/services/T0/B0/X';
const ADMIN_PATH = '/services/T0/B0/ADMIN';
const digestEnv: Env = {
  ...rootTestEnv,
  COACHING_API_SECRET: SECRET,
  SLACK_WEBHOOKS: '[{"id":"night","url":"https://hooks.slack.com/services/T0/B0/X","mode":"daily"}]',
  ADMIN_SLACK_WEBHOOK: `https://hooks.slack.com${ADMIN_PATH}`,
};

const post = (env: Env, body: unknown, token: string | null = SECRET): Promise<Response> =>
  apiFetch(env, '/api/digest', token, 'POST', body);

async function batchStatus(ymd: string): Promise<string | undefined> {
  const row = await testEnv.DB.prepare('SELECT status FROM notification_batches WHERE batch_id = ?1')
    .bind(`daily-${ymd}`)
    .first<{ status: string }>();
  return row?.status;
}

describe('POST /api/digest', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('COACHING_API_SECRET 未設定なら404、Bearer なし・不一致は401', async () => {
    const body = { date: localYmdDaysAgo(1) };
    expect((await post({ ...digestEnv, COACHING_API_SECRET: undefined }, body)).status).toBe(404);
    expect((await post(digestEnv, body, null)).status).toBe(401);
    expect((await post(digestEnv, body, 'wrong-secret')).status).toBe(401);
  });

  it('date の欠落・形式不正・未来日は400', async () => {
    expect((await post(digestEnv, {})).status).toBe(400);
    expect((await post(digestEnv, { date: '2026/08/24' })).status).toBe(400);
    expect((await post(digestEnv, { date: localYmdDaysAgo(-1) })).status).toBe(400);
  });

  it('対象日に記録（体重・食事・運動）が何も無ければ409で送信しない', async () => {
    stubFetch(); // 経路を登録しない = fetch が起きれば throw
    const res = await post(digestEnv, { date: localYmdDaysAgo(1) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('no records');
  });

  it('体重計測が無くても食事記録があればダイジェストを送る（見出しは「計測なし」、摂取行あり、基準日比は省略）', async () => {
    const ymd = localYmdDaysAgo(1);
    const menu = await createMenu(testEnv, { name: 'テスト定食', calories: 700 });
    await logMeal(testEnv, { menu_id: menu.id, eaten_at: `${ymd}T03:00:00Z` });
    await setSetting('baseline_date', localYmdDaysAgo(10));
    const stub = stubFetch().on({
      host: SLACK_HOST,
      path: SLACK_PATH,
      method: 'POST',
      times: 1,
      reply: () => new Response('ok'),
    });

    const res = await post(digestEnv, { date: ymd });
    expect(res.status).toBe(200);
    const body = stub.requests({ host: SLACK_HOST })[0].body;
    expect(body).toContain(`日次サマリー（${ymd}・計測なし）`);
    expect(body).toContain('体重の計測なし');
    expect(body).toContain('700 kcal');
    expect(body).not.toContain('基準日');
  });

  it('daily の送信先が無ければ409', async () => {
    stubFetch();
    const ymd = localYmdDaysAgo(1);
    await insertMeasurement({ grpid: 9401, measured_at: `${ymd}T03:00:00Z`, weight: 82, fat_free_mass: 62 });
    const env: Env = {
      ...digestEnv,
      SLACK_WEBHOOKS: '[{"id":"now","url":"https://hooks.slack.com/services/T0/B0/X"}]',
    };
    const res = await post(env, { date: ymd });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('no daily digest destination');
  });

  it('前日分を送ると、その日の計測と講評を含むダイジェストが1通届き、再送は409', async () => {
    const ymd = localYmdDaysAgo(1);
    await insertMeasurement({ grpid: 9402, measured_at: `${ymd}T03:00:00Z`, weight: 82.9, fat_free_mass: 62.0 });
    await upsertCoachingNote(digestEnv, { kind: 'daily', date: ymd, content: '前日分の講評テキスト', model: null });
    const stub = stubFetch().on({
      host: SLACK_HOST,
      path: SLACK_PATH,
      method: 'POST',
      times: 1,
      reply: () => new Response('ok'),
    });

    const res = await post(digestEnv, { date: ymd });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ date: ymd, queued: 1 });
    const posts = stub.requests({ host: SLACK_HOST });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain('日次サマリー');
    expect(posts[0].body).toContain('82.9 kg');
    expect(posts[0].body).toContain('前日分の講評テキスト');
    expect(await batchStatus(ymd)).toBe('sent');

    // 送信済みの日の再送は batch_id の UNIQUE で投入0 → 409、Slack にも二重送信しない
    const again = await post(digestEnv, { date: ymd });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain('already sent');
    expect(stub.requests({ host: SLACK_HOST })).toHaveLength(1);
  });

  it('Slack が 4xx を返して dead になった日も、手動送信なら pending に戻して送り直せる', async () => {
    const ymd = localYmdDaysAgo(1);
    await insertMeasurement({ grpid: 9403, measured_at: `${ymd}T03:00:00Z`, weight: 81, fat_free_mass: 61 });
    const stub = stubFetch()
      .on({ host: SLACK_HOST, path: SLACK_PATH, method: 'POST', times: 1, reply: () => new Response('no_service', { status: 404 }) })
      .on({ host: SLACK_HOST, path: ADMIN_PATH, method: 'POST', times: 1, reply: () => new Response('ok') }) // dead 化の管理者アラート
      .on({ host: SLACK_HOST, path: SLACK_PATH, method: 'POST', times: 1, reply: () => new Response('ok') });

    const first = await post(digestEnv, { date: ymd });
    expect(first.status).toBe(200); // 投入自体は成功し、送信が 404 で dead になる
    expect(await batchStatus(ymd)).toBe('dead');

    const second = await post(digestEnv, { date: ymd });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ date: ymd, queued: 1 });
    expect(await batchStatus(ymd)).toBe('sent');
    const digestPosts = stub.requests({ host: SLACK_HOST, path: SLACK_PATH });
    expect(digestPosts).toHaveLength(2);
    expect(digestPosts[1].body).toContain('日次サマリー');
    stub.assertAllConsumed();
  });

  it('過去日の「7日間平均（前ターム比）」は送信日ではなく対象日を基準に計算される', async () => {
    const target = localYmdDaysAgo(10);
    // 対象日基準: recent7 = D-6〜D = 80kg、prev7 = D-13〜D-7 = 95kg → `80.0 kg` (`-15.0 kg`)
    // 送信日基準だと recent7 = 今日〜6日前 = 70kg、prev7 に D が入って 80kg → `70.0 kg` (`-10.0 kg`) になってしまう
    const seed: [number, number][] = [[10, 80], [13, 80], [16, 80], [17, 95], [23, 95], [0, 70], [3, 70]];
    let grpid = 9500;
    for (const [daysAgo, weight] of seed) {
      await insertMeasurement({
        grpid: grpid++,
        measured_at: `${localYmdDaysAgo(daysAgo)}T03:00:00Z`,
        weight,
        fat_free_mass: 60,
      });
    }
    const stub = stubFetch().on({
      host: SLACK_HOST,
      path: SLACK_PATH,
      method: 'POST',
      times: 1,
      reply: () => new Response('ok'),
    });

    const res = await post(digestEnv, { date: target });
    expect(res.status).toBe(200);
    const body = stub.requests({ host: SLACK_HOST })[0].body;
    expect(body).toContain(`日次サマリー（${target}`);
    expect(body).toContain('`80.0 kg` (`-15.0 kg`)');
    expect(body).not.toContain('`70.0 kg`');
  });
});
