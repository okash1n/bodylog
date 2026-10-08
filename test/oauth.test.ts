import { createExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import worker from '../src/index';
import { OAUTH_LIFETIMES, logOauthError } from '../src/oauth';
import { obtainTokens, stubFetch, testEnv } from './helpers';

const rootEnv: Env = { ...testEnv, DASHBOARD_SLUG: '' };

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

describe('OAuthProvider骨組み', () => {
  it('POST /register で動的クライアント登録ができる', async () => {
    const res = await worker.fetch(
      req('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'test-client',
          redirect_uris: ['http://localhost/cb'],
          token_endpoint_auth_method: 'none',
        }),
      }),
      rootEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string };
    expect(body.client_id).toBeTruthy();
  });

  it('/api/ の書き込み（POST）はトークン無しだと401', async () => {
    const res = await worker.fetch(
      req('/api/meals', { method: 'POST', body: '{}' }),
      rootEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(401);
  });

  it('既存の公開ルートは影響を受けない', async () => {
    const res = await worker.fetch(req('/api/status'), rootEnv, createExecutionContext());
    expect(res.status).toBe(200);
  });
});

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** /authorize のSet-CookieヘッダーからCookie値を取り出す（ブラウザのCookieジャーの代わり） */
function extractCookieValue(res: Response, name: string): string {
  const raw = res.headers.get('set-cookie');
  if (!raw) throw new Error(`no set-cookie header (looking for ${name})`);
  const found = raw
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`));
  if (!found) throw new Error(`cookie ${name} not found in set-cookie header: ${raw}`);
  return found.slice(name.length + 1);
}

async function registerClient(env: Env): Promise<string> {
  const res = await worker.fetch(
    req('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'test-client',
        redirect_uris: ['http://localhost/cb'],
        token_endpoint_auth_method: 'none',
      }),
    }),
    env,
    createExecutionContext(),
  );
  return ((await res.json()) as { client_id: string }).client_id;
}

describe('Google認可フロー', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('/authorize がGoogleへリダイレクトし、オーナーのメールならcode付きで戻る', async () => {
    const clientId = await registerClient(rootEnv);
    const verifier = 'test-verifier-01234567890123456789012345678901';
    const challenge = b64url(
      String.fromCharCode(
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
      ),
    );
    const authorize = await worker.fetch(
      req(
        `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('http://localhost/cb')}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&scope=meals`,
      ),
      rootEnv,
      createExecutionContext(),
    );
    expect(authorize.status).toBe(302);
    const googleUrl = new URL(authorize.headers.get('Location')!);
    expect(googleUrl.host).toBe('accounts.google.com');
    const googleState = googleUrl.searchParams.get('state')!;
    // Googleへの必須パラメータの検証（Googleレッグ自体にもPKCEを付ける多層防御）
    expect(googleUrl.searchParams.get('client_id')).toBe('gcid');
    expect(googleUrl.searchParams.get('response_type')).toBe('code');
    expect(googleUrl.searchParams.get('scope')).toBeTruthy();
    expect(googleUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(googleUrl.searchParams.get('code_challenge_method')).toBe('S256');
    // /authorize はブラウザセッション束縛用のCookieを発行する
    const txnCookie = extractCookieValue(authorize, 'oauth_txn');
    expect(txnCookie).toBe(googleState);

    const stub = stubFetch();
    stub.on({ host: 'oauth2.googleapis.com', path: '/token', reply: () => Response.json({ access_token: 'g-at' }) });
    stub.on({
      host: 'openidconnect.googleapis.com',
      path: '/v1/userinfo',
      reply: () => Response.json({ email: 'owner@example.com', email_verified: true }),
    });
    const cb = await worker.fetch(
      req(`/authorize/callback?code=g-code&state=${encodeURIComponent(googleState)}`, {
        headers: { Cookie: `oauth_txn=${txnCookie}` },
      }),
      rootEnv,
      createExecutionContext(),
    );
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get('Location')!);
    expect(back.origin + back.pathname).toBe('http://localhost/cb');
    expect(back.searchParams.get('code')).toBeTruthy();
    expect(back.searchParams.get('state')).toBe('xyz');

    // codeをトークンに交換できる
    const token = await worker.fetch(
      req('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: back.searchParams.get('code')!,
          redirect_uri: 'http://localhost/cb',
          client_id: clientId,
          code_verifier: verifier,
        }).toString(),
      }),
      rootEnv,
      createExecutionContext(),
    );
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as { access_token: string };
    expect(tokens.access_token).toBeTruthy();
  });

  it('オーナー以外のメールは403でトークンを発行しない', async () => {
    const clientId = await registerClient(rootEnv);
    const authorize = await worker.fetch(
      req(
        `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('http://localhost/cb')}&code_challenge=abc&code_challenge_method=S256&state=x&scope=meals`,
      ),
      rootEnv,
      createExecutionContext(),
    );
    const googleState = new URL(authorize.headers.get('Location')!).searchParams.get('state')!;
    const txnCookie = extractCookieValue(authorize, 'oauth_txn');
    const stub = stubFetch();
    stub.on({ host: 'oauth2.googleapis.com', path: '/token', reply: () => Response.json({ access_token: 'g-at' }) });
    stub.on({
      host: 'openidconnect.googleapis.com',
      path: '/v1/userinfo',
      reply: () => Response.json({ email: 'attacker@example.com', email_verified: true }),
    });
    const cb = await worker.fetch(
      req(`/authorize/callback?code=g-code&state=${encodeURIComponent(googleState)}`, {
        headers: { Cookie: `oauth_txn=${txnCookie}` },
      }),
      rootEnv,
      createExecutionContext(),
    );
    expect(cb.status).toBe(403);
    // トークン発行につながるcode/Locationが一切発行されていないこと
    expect(cb.headers.get('Location')).toBeNull();
  });

  it('refresh_token で新しいアクセストークンを取り直せる', async () => {
    const issued = await obtainTokens(rootEnv);
    expect(issued.refresh_token).toBeTruthy();
    const res = await worker.fetch(
      req('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: issued.refresh_token,
          client_id: issued.client_id,
        }).toString(),
      }),
      rootEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const refreshed = (await res.json()) as { access_token: string; refresh_token: string };
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(issued.access_token);
    // refresh_token はローテーションされる（READMEの「ローテーション競合」はこの挙動が前提）
    expect(refreshed.refresh_token).toBeTruthy();
    expect(refreshed.refresh_token).not.toBe(issued.refresh_token);
  });

  it('state（nonce）に対応するoauth_txn Cookieが無い/不一致だと403で、Googleへのトークン交換にも到達しない（login CSRF対策）', async () => {
    const clientId = await registerClient(rootEnv);
    const authorize = await worker.fetch(
      req(
        `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('http://localhost/cb')}&code_challenge=abc&code_challenge_method=S256&state=x&scope=meals`,
      ),
      rootEnv,
      createExecutionContext(),
    );
    const googleState = new URL(authorize.headers.get('Location')!).searchParams.get('state')!;
    // stubFetchにGoogleのルートを一切登録しない
    // → CSRF検査より先にGoogleへのfetchが発生した場合は「unexpected fetch」で失敗する
    stubFetch();

    const noCookie = await worker.fetch(
      req(`/authorize/callback?code=g-code&state=${encodeURIComponent(googleState)}`),
      rootEnv,
      createExecutionContext(),
    );
    expect(noCookie.status).toBe(403);
    expect(noCookie.headers.get('Location')).toBeNull();

    const wrongCookie = await worker.fetch(
      req(`/authorize/callback?code=g-code&state=${encodeURIComponent(googleState)}`, {
        headers: { Cookie: 'oauth_txn=not-the-real-nonce' },
      }),
      rootEnv,
      createExecutionContext(),
    );
    expect(wrongCookie.status).toBe(403);
    expect(wrongCookie.headers.get('Location')).toBeNull();
  });
});

/**
 * ライブラリ既定（refresh 30日・DCRクライアント 90日）のままだと、MCPクライアント
 * （ChatGPT等）が月次で再認可、四半期でコネクタ作り直しになる。寿命はKVの
 * expiration に乗るので、保存されたキーの期限で設定が効いていることを確認する
 */
describe('OAuthトークン寿命', () => {
  afterEach(() => vi.restoreAllMocks());

  function expectExpirationNear(expiration: number | undefined, ttlSeconds: number, issuedAtMs: number): void {
    expect(expiration).toBeDefined();
    const expected = Math.floor(issuedAtMs / 1000) + ttlSeconds;
    expect(Math.abs((expiration as number) - expected)).toBeLessThan(120);
  }

  /** refresh_token は `${userId}:${grantId}:${secret}`。対応する grant キーの KV expiration を引く */
  async function grantExpiration(refreshToken: string): Promise<number | undefined> {
    const [userId, grantId] = refreshToken.split(':');
    const { keys } = await rootEnv.OAUTH_KV.list({ prefix: `grant:${userId}:${grantId}` });
    expect(keys).toHaveLength(1);
    return keys[0].expiration;
  }

  it('寿命はライブラリ既定（refresh 30日 / クライアント 90日）より長い', () => {
    expect(OAUTH_LIFETIMES.refreshTokenTTL).toBeGreaterThan(30 * 86_400);
    expect(OAUTH_LIFETIMES.clientRegistrationTTL).toBeGreaterThan(90 * 86_400);
    // クライアントが先に切れると refresh が invalid_client で死ぬため、クライアント側を長く保つ
    expect(OAUTH_LIFETIMES.clientRegistrationTTL).toBeGreaterThanOrEqual(OAUTH_LIFETIMES.refreshTokenTTL);
  });

  it('grant（refresh_token）の期限は認可から OAUTH_LIFETIMES.refreshTokenTTL 秒', async () => {
    const issuedAt = Date.now();
    const issued = await obtainTokens(rootEnv);
    expectExpirationNear(await grantExpiration(issued.refresh_token), OAUTH_LIFETIMES.refreshTokenTTL, issuedAt);
  });

  it('refresh しても grant の期限は延びない（認可時点からの絶対期限）', async () => {
    const issued = await obtainTokens(rootEnv);
    const before = await grantExpiration(issued.refresh_token);
    // ライブラリは Date.now() で現在時刻を取る。2日進めて refresh し、スライド式なら期限が動くことを検出する
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 2 * 86_400_000);
    const res = await worker.fetch(
      req('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: issued.refresh_token,
          client_id: issued.client_id,
        }).toString(),
      }),
      rootEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const refreshed = (await res.json()) as { refresh_token: string };
    // ローテーション後も grant キーは同じ（userId:grantId は不変）
    expect(await grantExpiration(refreshed.refresh_token)).toBe(before);
  });

  it('動的登録クライアントの期限は登録から OAUTH_LIFETIMES.clientRegistrationTTL 秒', async () => {
    const registeredAt = Date.now();
    const clientId = await registerClient(rootEnv);
    const { keys } = await rootEnv.OAUTH_KV.list({ prefix: `client:${clientId}` });
    expect(keys).toHaveLength(1);
    expectExpirationNear(keys[0].expiration, OAUTH_LIFETIMES.clientRegistrationTTL, registeredAt);
  });

  it('/token の失敗は理由付きで [oauth] ログに残る（トークン値は出さない）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const issued = await obtainTokens(rootEnv);
    const bogus = `${issued.refresh_token}-tampered`;
    const res = await worker.fetch(
      req('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: bogus,
          client_id: issued.client_id,
        }).toString(),
      }),
      rootEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_grant' });
    const lines = warn.mock.calls.map((c) => c.map(String).join(' '));
    const tagged = lines.filter((l) => l.startsWith('[oauth] error response'));
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).toContain('invalid_grant');
    expect(tagged[0]).not.toContain(bogus);
  });

  it('logOauthError は description の改行を潰し長さを抑える（未認証リクエスト由来の文字列が入る経路があるため）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logOauthError({ status: 400, code: 'invalid_client_metadata', description: `line1\r\nline2\n${'x'.repeat(500)}` });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.length).toBeLessThan(300);
    expect(line).toContain('[oauth] error response 400 invalid_client_metadata: line1 line2');
  });
});
