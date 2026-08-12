import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import worker from '../src/index';
import { testEnv } from './helpers';

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
