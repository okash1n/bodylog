import { createExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import worker from '../src/index';
import { stubFetch, testEnv } from './helpers';

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

  it('/rw/ 配下はトークン無しだと401', async () => {
    const res = await worker.fetch(
      req('/rw/meals', { method: 'POST', body: '{}' }),
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

    const stub = stubFetch();
    stub.on({ host: 'oauth2.googleapis.com', path: '/token', reply: () => Response.json({ access_token: 'g-at' }) });
    stub.on({
      host: 'openidconnect.googleapis.com',
      path: '/v1/userinfo',
      reply: () => Response.json({ email: 'owner@example.com', email_verified: true }),
    });
    const cb = await worker.fetch(
      req(`/authorize/callback?code=g-code&state=${encodeURIComponent(googleState)}`),
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
    const stub = stubFetch();
    stub.on({ host: 'oauth2.googleapis.com', path: '/token', reply: () => Response.json({ access_token: 'g-at' }) });
    stub.on({
      host: 'openidconnect.googleapis.com',
      path: '/v1/userinfo',
      reply: () => Response.json({ email: 'attacker@example.com', email_verified: true }),
    });
    const cb = await worker.fetch(
      req(`/authorize/callback?code=g-code&state=${encodeURIComponent(googleState)}`),
      rootEnv,
      createExecutionContext(),
    );
    expect(cb.status).toBe(403);
  });
});
