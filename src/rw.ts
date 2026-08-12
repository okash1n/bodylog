/**
 * 認証必須（/rw/）のルート。OAuthProviderのapiHandlerとして動くため、
 * ここに到達した時点でBearerトークンは検証済み。
 */
import { Hono } from 'hono';
import type { Env } from './types';
import { noindexHeaders } from './util';

export function createRwApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.notFound((c) => c.text('not found', 404, noindexHeaders()));
  app.onError((err, c) => {
    console.error('[rw] unhandled error', err);
    return c.text('internal error', 500, noindexHeaders());
  });
  return app;
}
