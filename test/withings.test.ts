import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WithingsApiError } from '../src/util';
import { fetchMeasPage, getValidAccessToken } from '../src/withings';
import { insertTokenRow, resetTables, stubFetch, testEnv, withingsReply } from './helpers';

const REFRESH_PATH = '/v2/oauth2';

async function tokenRow(): Promise<{ access_token: string | null; refresh_token: string | null }> {
  const row = await testEnv.DB.prepare('SELECT access_token, refresh_token FROM tokens WHERE id = 1').first<{
    access_token: string | null;
    refresh_token: string | null;
  }>();
  if (!row) throw new Error('tokens row missing');
  return row;
}

describe('withings', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('HTTP 200 でも status!=0 なら WithingsApiError を投げる', async () => {
    stubFetch().on({
      host: 'wbsapi.withings.net',
      path: '/measure',
      reply: () => Response.json({ status: 401, body: {}, error: 'invalid token' }),
    });
    await expect(fetchMeasPage(testEnv, 'at', { startdate: 1, enddate: 2 })).rejects.toBeInstanceOf(
      WithingsApiError,
    );
  });

  it('expires_at が有効なら保存済み access_token を外部通信なしで返す', async () => {
    await insertTokenRow({ accessToken: 'at-fresh', expiresInSec: 3600 });
    stubFetch(); // ルート未登録 = fetch されたら即 throw
    await expect(getValidAccessToken(testEnv)).resolves.toBe('at-fresh');
  });

  it('並行5要求でも外部 refresh は1回だけ実行される', async () => {
    await insertTokenRow({ accessToken: 'at-old', refreshToken: 'rt-old', expiresInSec: -3600 });
    const stub = stubFetch().on({
      host: 'wbsapi.withings.net',
      path: REFRESH_PATH,
      method: 'POST',
      times: 1, // 2回目の refresh は unexpected fetch として失敗させる
      reply: () =>
        withingsReply({ userid: '42', access_token: 'at-new', refresh_token: 'rt-new', expires_in: 10800 }),
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => getValidAccessToken(testEnv)));
    expect(results).toEqual(['at-new', 'at-new', 'at-new', 'at-new', 'at-new']);
    expect(stub.requests({ path: REFRESH_PATH })).toHaveLength(1);

    const row = await tokenRow();
    expect(row.access_token).toBe('at-new');
    expect(row.refresh_token).toBe('rt-new');
    stub.assertAllConsumed();
  });

  it('期限切れ lease は奪取して refresh できる', async () => {
    await insertTokenRow({
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      expiresInSec: -3600,
      leaseOwner: 'dead-owner',
      leaseUntilOffsetSec: -10,
    });
    const stub = stubFetch().on({
      host: 'wbsapi.withings.net',
      path: REFRESH_PATH,
      method: 'POST',
      times: 1,
      reply: () =>
        withingsReply({ userid: '42', access_token: 'at-new2', refresh_token: 'rt-new2', expires_in: 10800 }),
    });

    await expect(getValidAccessToken(testEnv)).resolves.toBe('at-new2');
    expect(stub.requests({ path: REFRESH_PATH })).toHaveLength(1);
    expect((await tokenRow()).refresh_token).toBe('rt-new2');
  });
});
