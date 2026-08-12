/**
 * 書き込みエンドポイント（/api/* のPOST/PATCH/DELETE）用の認証。
 * OAuthProviderのapiRouteゲート（パス前方一致）ではメソッド単位に分けられないため、
 * ここで Bearer トークンを unwrapToken で検証してメソッド単位に認可する。
 *
 * unwrapToken はトークン自体とKV（OAUTH_KV）だけで検証・復号し、options由来の秘密鍵は
 * 使わない。getOAuthApi は options の妥当性検証のため構造的に妥当な最小 options を要求するので、
 * ここでは呼ばれないダミーハンドラ付きの最小 options を渡す（indexの本物providerとは独立）。
 */
import { getOAuthApi, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import type { Context } from 'hono';
import type { Env } from './types';
import { noindexHeaders } from './util';

const NOOP_HANDLER = {
  fetch: (_req: Request, _env: Env, _ctx: ExecutionContext): Response => new Response(null, { status: 404 }),
};

const HELPERS_OPTIONS: OAuthProviderOptions<Env> = {
  apiRoute: '/mcp',
  apiHandler: NOOP_HANDLER,
  defaultHandler: NOOP_HANDLER,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
};

/** Authorization: Bearer のトークンを検証し、オーナー（＝有効トークン保持者）なら true */
export async function isOwner(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const match = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '');
  if (!match) return false;
  const summary = await getOAuthApi(HELPERS_OPTIONS, c.env)
    .unwrapToken(match[1])
    .catch(() => null);
  // トークンを持てるのはオーナーのみ（/authorizeでOWNER_EMAILS照合済み）。
  // unwrapTokenがKV存在＋期限を検証するので、非nullなら認可
  return summary !== null;
}

type Handler = (c: Context<{ Bindings: Env }>) => Response | Promise<Response>;

/** 書き込みハンドラをオーナー認証で保護する。未認可は401 */
export function withAuth(handler: Handler): Handler {
  return async (c) => {
    if (!(await isOwner(c))) {
      return c.json(
        { error: 'unauthorized' },
        401,
        noindexHeaders({ 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' }),
      );
    }
    return handler(c);
  };
}
