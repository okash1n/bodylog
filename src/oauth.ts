/**
 * OAuth認可画面（本人確認）。workers-oauth-providerが/token・/registerを担い、
 * /authorizeの中身（誰を認証しトークン発行を許すか）はここで実装する。
 * 本人確認はGoogleログイン: userinfoのメールを OWNER_EMAILS と照合する。
 */
import type { Hono } from 'hono';
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { Env } from './types';
import { assertSecret, noindexHeaders } from './util';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

function ownerEmails(env: Env): string[] {
  return (env.OWNER_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}

export function registerOauthRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get('/authorize', async (c) => {
    const env = c.env;
    // OAUTH_PROVIDERはworkers-oauth-providerがenvに注入するヘルパー
    const helpers = (env as unknown as { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;
    const authReq = await helpers.parseAuthRequest(c.req.raw).catch(() => null);
    if (!authReq) return c.text('invalid authorization request', 400, noindexHeaders());
    const origin = new URL(c.req.url).origin;
    // 認可リクエスト全体をGoogleのstateに載せてラウンドトリップする
    // （単一オーナー用途。stateの完全性はGoogleのcode交換が自クライアント限定である事に依存）
    const state = b64urlEncode(JSON.stringify(authReq));
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('client_id', assertSecret(env.GOOGLE_OAUTH_CLIENT_ID, 'GOOGLE_OAUTH_CLIENT_ID'));
    url.searchParams.set('redirect_uri', `${origin}/authorize/callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
    return c.redirect(url.toString(), 302);
  });

  app.get('/authorize/callback', async (c) => {
    const env = c.env;
    const helpers = (env as unknown as { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;
    const code = c.req.query('code');
    const stateRaw = c.req.query('state');
    if (!code || !stateRaw) return c.text('missing code/state', 400, noindexHeaders());
    let authReq: AuthRequest;
    try {
      authReq = JSON.parse(b64urlDecode(stateRaw));
    } catch {
      return c.text('invalid state', 400, noindexHeaders());
    }
    const origin = new URL(c.req.url).origin;
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: assertSecret(env.GOOGLE_OAUTH_CLIENT_ID, 'GOOGLE_OAUTH_CLIENT_ID'),
        client_secret: assertSecret(env.GOOGLE_OAUTH_CLIENT_SECRET, 'GOOGLE_OAUTH_CLIENT_SECRET'),
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${origin}/authorize/callback`,
      }).toString(),
    });
    if (!tokenRes.ok) {
      console.error('[oauth] google token exchange failed', tokenRes.status);
      return c.text('google login failed', 502, noindexHeaders());
    }
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    if (!access_token) return c.text('google login failed', 502, noindexHeaders());
    const userinfoRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!userinfoRes.ok) return c.text('google login failed', 502, noindexHeaders());
    const userinfo = (await userinfoRes.json()) as { email?: string; email_verified?: boolean };
    const email = (userinfo.email ?? '').toLowerCase();
    if (!userinfo.email_verified || !ownerEmails(env).includes(email)) {
      console.warn('[oauth] rejected non-owner login');
      return c.text('forbidden: not the owner', 403, noindexHeaders());
    }
    const { redirectTo } = await helpers.completeAuthorization({
      request: authReq,
      userId: email,
      metadata: {},
      scope: authReq.scope ?? [],
      props: { email },
    });
    return c.redirect(redirectTo, 302);
  });
}
