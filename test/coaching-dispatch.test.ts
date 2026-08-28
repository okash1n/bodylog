/**
 * Worker からの AIコーチング生成ワークフロー起動（dispatchCoachingIfDue）のテスト。
 * GitHub API と Slack（管理者アラート）は stubFetch でモックし、時刻は nowMs 引数で固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchCoachingIfDue } from '../src/coaching-dispatch';
import type { Env } from '../src/types';
import { resetTables, stubFetch, testEnv } from './helpers';

const dispatchEnv: Env = {
  ...testEnv,
  GITHUB_DISPATCH_TOKEN: 'test-gh-pat',
  GITHUB_DISPATCH_REPO: 'owner/repo',
};

// TZ_OFFSET_HOURS 未設定 → 9（JST）。DUE = 2026-08-26 23:31 JST、BEFORE = 同 23:29 JST
const DUE = Date.UTC(2026, 7, 26, 14, 31);
const BEFORE = Date.UTC(2026, 7, 26, 14, 29);
const DISPATCH_PATH = '/repos/owner/repo/actions/workflows/coaching.yml/dispatches';

function githubStub() {
  const stub = stubFetch();
  const authHeaders: (string | null)[] = [];
  stub.on({
    host: 'api.github.com',
    path: DISPATCH_PATH,
    reply: (req) => {
      authHeaders.push(req.headers.get('Authorization'));
      return new Response(null, { status: 204 });
    },
  });
  return { stub, authHeaders };
}

describe('dispatchCoachingIfDue', () => {
  beforeEach(resetTables);
  afterEach(() => vi.unstubAllGlobals());

  it('GITHUB_DISPATCH_TOKEN / GITHUB_DISPATCH_REPO 未設定なら何もしない', async () => {
    const stub = stubFetch();
    expect(await dispatchCoachingIfDue(testEnv, DUE)).toEqual({ dispatched: false });
    expect(
      await dispatchCoachingIfDue({ ...dispatchEnv, GITHUB_DISPATCH_REPO: undefined }, DUE),
    ).toEqual({ dispatched: false });
    expect(stub.requests().length).toBe(0);
  });

  it('23:30前は起動せず、過ぎた最初の呼び出しで当日を date 入力にして起動する', async () => {
    const { stub, authHeaders } = githubStub();
    expect(await dispatchCoachingIfDue(dispatchEnv, BEFORE)).toEqual({ dispatched: false });
    expect(stub.requests().length).toBe(0);

    expect(await dispatchCoachingIfDue(dispatchEnv, DUE)).toEqual({ dispatched: true });
    const reqs = stub.requests({ host: 'api.github.com' });
    expect(reqs.length).toBe(1);
    expect(reqs[0].url).toContain(DISPATCH_PATH);
    expect(JSON.parse(reqs[0].body)).toEqual({ ref: 'main', inputs: { date: '2026-08-26' } });
    expect(authHeaders).toEqual(['Bearer test-gh-pat']);
  });

  it('同じ日の後続tickでは起動せず、翌日は再び起動する', async () => {
    const { stub } = githubStub();
    await dispatchCoachingIfDue(dispatchEnv, DUE);
    expect(await dispatchCoachingIfDue(dispatchEnv, DUE + 5 * 60_000)).toEqual({
      dispatched: false,
    });
    expect(stub.requests({ host: 'api.github.com' }).length).toBe(1);

    expect(await dispatchCoachingIfDue(dispatchEnv, DUE + 86_400_000)).toEqual({
      dispatched: true,
    });
    const reqs = stub.requests({ host: 'api.github.com' });
    expect(reqs.length).toBe(2);
    expect(JSON.parse(reqs[1].body).inputs.date).toBe('2026-08-27');
  });

  it('起動失敗は管理者アラートを送り、その日は再試行しない（scheduleフォールバック前提）', async () => {
    const stub = stubFetch();
    stub.on({
      host: 'api.github.com',
      path: DISPATCH_PATH,
      reply: () => new Response('bad credentials', { status: 401 }),
    });
    stub.on({ host: 'hooks.slack.com', reply: () => new Response('ok', { status: 200 }) });

    expect(await dispatchCoachingIfDue(dispatchEnv, DUE)).toEqual({ dispatched: false });
    const alerts = stub.requests({ host: 'hooks.slack.com' });
    expect(alerts.length).toBe(1);
    expect(alerts[0].body).toContain('起動に失敗');

    // クレーム済みなので同日中は再試行もアラート再送もしない
    expect(await dispatchCoachingIfDue(dispatchEnv, DUE + 5 * 60_000)).toEqual({
      dispatched: false,
    });
    expect(stub.requests({ host: 'api.github.com' }).length).toBe(1);
    expect(stub.requests({ host: 'hooks.slack.com' }).length).toBe(1);
  });
});
