import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { immediateDestinations, parseDestinations, runDailyDigest } from '../src/slack';
import { insertMeasurement, resetTables, stubFetch, testEnv } from './helpers';

const SLACK_HOST = 'hooks.slack.com';
const SLACK_PATH = '/services/T0/B0/X';
const ORIGIN = 'https://origin.example';

function envWith(webhooks: string): Env {
  return { ...testEnv, SLACK_WEBHOOKS: webhooks };
}

const DAILY_ENV = envWith('[{"id":"night","url":"https://hooks.slack.com/services/T0/B0/X","mode":"daily"}]');

describe('通知モード', () => {
  it('mode省略はimmediate扱い・不正modeはthrow', () => {
    expect(parseDestinations(testEnv)[0].mode).toBe('immediate');
    expect(() =>
      parseDestinations(envWith('[{"id":"a","url":"https://hooks.slack.com/x","mode":"hourly"}]')),
    ).toThrow();
  });

  it('immediateDestinations は daily を除外し immediate/both を含む', () => {
    const env = envWith(
      '[{"id":"a","url":"https://hooks.slack.com/a"},{"id":"b","url":"https://hooks.slack.com/b","mode":"daily"},{"id":"c","url":"https://hooks.slack.com/c","mode":"both"}]',
    );
    expect(immediateDestinations(env).map((d) => d.id)).toEqual(['a', 'c']);
  });
});

describe('runDailyDigest', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('当日の計測があればダイジェストを1通送り、再実行しても二重送信しない', async () => {
    await insertMeasurement({
      grpid: 9001,
      measured_at: new Date().toISOString(),
      weight: 82.9,
      fat_free_mass: 62.0,
    });
    const stub = stubFetch().on({
      host: SLACK_HOST,
      path: SLACK_PATH,
      method: 'POST',
      times: 1,
      reply: () => new Response('ok'),
    });

    const first = await runDailyDigest(DAILY_ENV, ORIGIN);
    expect(first.queued).toBe(1);
    const posts = stub.requests({ host: SLACK_HOST });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain('日次サマリー');
    expect(posts[0].body).toContain('計測 1 回');
    expect(posts[0].body).toContain('82.9 kg');
    expect(posts[0].body).toContain('20.9 kg'); // 脂肪量 = 82.9 - 62.0
    expect(posts[0].body).toContain('og.png?v=');

    // 同日再実行はUNIQUE制約で投入0（送信もされない）
    const second = await runDailyDigest(DAILY_ENV, ORIGIN);
    expect(second.queued).toBe(0);
    expect(stub.requests({ host: SLACK_HOST })).toHaveLength(1);
  });

  it('当日の計測がなければ何も送らない', async () => {
    stubFetch(); // 未登録fetchはthrowするので、呼ばれないことの検証を兼ねる
    const result = await runDailyDigest(DAILY_ENV, ORIGIN);
    expect(result.queued).toBe(0);
  });

  it('daily/both の通知先がなければ何もしない', async () => {
    await insertMeasurement({ grpid: 9002, measured_at: new Date().toISOString(), weight: 80 });
    stubFetch();
    const result = await runDailyDigest(testEnv, ORIGIN); // mode省略=immediateのみ
    expect(result.queued).toBe(0);
  });
});
