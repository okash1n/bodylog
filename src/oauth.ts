/**
 * OAuth認可画面（本人確認）。workers-oauth-providerが/token・/registerを担い、
 * /authorizeの中身（誰を認証しトークン発行を許すか）はここで実装する。
 * 本人確認はGoogleログイン: userinfoのメールを OWNER_EMAILS と照合する。
 *
 * stateは発信ブラウザに束縛する（login CSRF / authorization code injection対策）。
 * authReq本体はクライアントへ渡さずOAUTH_KVにワンタイム保存し、Googleへのstateには
 * ランダムnonceのみを渡す。callbackではそのnonceがHttpOnly Cookie(oauth_txn)と
 * 一致する場合のみ有効なセッションとして扱う。GoogleレッグにもPKCEを付け多層防御する。
 */
import type { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { Env } from './types';
import { assertSecret, noindexHeaders } from './util';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const OAUTH_TXN_COOKIE = 'oauth_txn';
// KVの保存期間とCookieの有効期限を揃える（Googleログインに掛けられる猶予）
const AUTHFLOW_TTL_SECONDS = 600;

interface AuthFlowState {
  authReq: AuthRequest;
  googleVerifier: string;
}

function ownerEmails(env: Env): string[] {
  return (env.OWNER_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function b64urlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** CSRF用nonce・PKCE verifier共用のランダムトークン生成 */
function randomToken(byteLength = 32): string {
  return b64urlEncodeBytes(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64urlEncodeBytes(new Uint8Array(digest));
}

export function registerOauthRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get('/authorize', async (c) => {
    const env = c.env;
    // OAUTH_PROVIDERはworkers-oauth-providerがenvに注入するヘルパー
    const helpers = (env as unknown as { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;
    const authReq = await helpers.parseAuthRequest(c.req.raw).catch(() => null);
    if (!authReq) return c.text('invalid authorization request', 400, noindexHeaders());
    const origin = new URL(c.req.url).origin;

    // authReq本体はKVにワンタイム保存し、Googleへ渡すstateにはnonceのみを載せる。
    // 同じnonceをHttpOnly CookieにもセットしcallbackでCookieとの一致を必須にすることで、
    // 攻撃者が自分のcode/stateを正規オーナーのブラウザに踏ませて認可を成立させる
    // login CSRFを防ぐ（発信ブラウザへの束縛）。
    const nonce = randomToken();
    const googleVerifier = randomToken();
    const flow: AuthFlowState = { authReq, googleVerifier };
    await env.OAUTH_KV.put(`authflow:${nonce}`, JSON.stringify(flow), {
      expirationTtl: AUTHFLOW_TTL_SECONDS,
    });
    setCookie(c, OAUTH_TXN_COOKIE, nonce, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: AUTHFLOW_TTL_SECONDS,
    });

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('client_id', assertSecret(env.GOOGLE_OAUTH_CLIENT_ID, 'GOOGLE_OAUTH_CLIENT_ID'));
    url.searchParams.set('redirect_uri', `${origin}/authorize/callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email');
    url.searchParams.set('state', nonce);
    // Googleレッグ自体にもPKCEを付ける（多層防御。nonce束縛と独立に有効）
    url.searchParams.set('code_challenge', await pkceChallenge(googleVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'select_account');
    return c.redirect(url.toString(), 302);
  });

  app.get('/authorize/callback', async (c) => {
    const env = c.env;
    const helpers = (env as unknown as { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;
    const code = c.req.query('code');
    const nonce = c.req.query('state');
    if (!code || !nonce) return c.text('missing code/state', 400, noindexHeaders());

    // stateはCookieの値と一致して初めて有効。不一致・欠落は、攻撃者が別ブラウザで
    // 開始した認可フローのcode/stateをオーナーに踏ませようとしている状態であり、
    // ここで拒否することで発信ブラウザへの束縛を担保する（Googleへは到達させない）。
    const cookieNonce = getCookie(c, OAUTH_TXN_COOKIE);
    deleteCookie(c, OAUTH_TXN_COOKIE, { path: '/' });
    if (!cookieNonce || cookieNonce !== nonce) {
      console.warn('[oauth] state/cookie mismatch on callback (possible login CSRF)');
      return c.text('forbidden: invalid session', 403, noindexHeaders());
    }

    const kvKey = `authflow:${nonce}`;
    const stored = await env.OAUTH_KV.get(kvKey);
    if (!stored) return c.text('authorization session expired or already used', 400, noindexHeaders());
    // ワンタイム化（リプレイ防止）。取り出した時点で即削除する
    await env.OAUTH_KV.delete(kvKey);
    let flow: AuthFlowState;
    try {
      flow = JSON.parse(stored) as AuthFlowState;
    } catch {
      return c.text('invalid session data', 400, noindexHeaders());
    }
    const { authReq, googleVerifier } = flow;

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
        code_verifier: googleVerifier,
      }).toString(),
    });
    if (!tokenRes.ok) {
      console.error('[oauth] google token exchange failed', tokenRes.status);
      return c.text('google login failed', 502, noindexHeaders());
    }
    // 外部応答は型を保証しないため境界でguardする（非文字列のtokenやemailを素通しすると
    // 後段で不定形の例外＝500になる。値そのものはログへ出さない）
    const tokenBody = (await tokenRes.json().catch(() => null)) as { access_token?: unknown } | null;
    const access_token = tokenBody?.access_token;
    if (typeof access_token !== 'string' || access_token === '') {
      console.error('[oauth] google token response is malformed');
      return c.text('google login failed', 502, noindexHeaders());
    }
    const userinfoRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!userinfoRes.ok) return c.text('google login failed', 502, noindexHeaders());
    const userinfo = (await userinfoRes.json().catch(() => null)) as
      | { email?: unknown; email_verified?: unknown }
      | null;
    const email = typeof userinfo?.email === 'string' ? userinfo.email.toLowerCase() : '';
    if (userinfo?.email_verified !== true || email === '' || !ownerEmails(env).includes(email)) {
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
