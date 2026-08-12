/**
 * 認証必須（/rw/）のルート。OAuthProviderのapiHandlerとして動くため、
 * ここに到達した時点でBearerトークンは検証済み。
 */
import { Hono, type Context } from 'hono';
import type { Env } from './types';
import {
  createMenu, deleteMealLog, logMeal, parseMealFields, parseMenuInput, parseMenuPatch, setMenuArchived,
  updateMealLog, updateMenu,
} from './meals';
import {
  createExerciseMenu, deleteExerciseLog, logExercise, parseExerciseLogFields,
  parseExerciseMenuInput, parseExerciseMenuPatch, setExerciseMenuArchived, updateExerciseMenu,
} from './exercise';
import { handleMcpRequest } from './mcp';
import { noindexHeaders } from './util';

export function createRwApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const headers = () => noindexHeaders({ 'Cache-Control': 'no-store' });
  const readJson = async (c: Context<{ Bindings: Env }>): Promise<Record<string, unknown> | null> =>
    (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

  app.post('/rw/menus', async (c) => {
    const parsed = parseMenuInput(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400, headers());
    return c.json(await createMenu(c.env, parsed.value), 201, headers());
  });

  app.patch('/rw/menus/:id', async (c) => {
    const parsed = parseMenuPatch(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400, headers());
    const menu = await updateMenu(c.env, c.req.param('id'), parsed.value);
    return menu ? c.json(menu, 200, headers()) : c.json({ error: 'menu not found' }, 404, headers());
  });

  app.post('/rw/menus/:id/archive', async (c) =>
    (await setMenuArchived(c.env, c.req.param('id'), true))
      ? c.json({ ok: true }, 200, headers())
      : c.json({ error: 'menu not found' }, 404, headers()));

  app.post('/rw/menus/:id/unarchive', async (c) =>
    (await setMenuArchived(c.env, c.req.param('id'), false))
      ? c.json({ ok: true }, 200, headers())
      : c.json({ error: 'menu not found' }, 404, headers()));

  app.post('/rw/meals', async (c) => {
    const body = (await readJson(c)) ?? {};
    if (typeof body.menu_id !== 'string') return c.json({ error: 'menu_id is required' }, 400, headers());
    const fields = parseMealFields(body);
    if (!fields.ok) return c.json({ error: fields.error }, 400, headers());
    const log = await logMeal(c.env, { menu_id: body.menu_id, ...fields.value });
    if ('error' in log) return c.json({ error: log.error }, 400, headers());
    return c.json(log, 201, headers());
  });

  app.patch('/rw/meals/:id', async (c) => {
    const body = (await readJson(c)) ?? {};
    const fields = parseMealFields(body);
    if (!fields.ok) return c.json({ error: fields.error }, 400, headers());
    const log = await updateMealLog(c.env, c.req.param('id'), fields.value);
    return log ? c.json(log, 200, headers()) : c.json({ error: 'meal log not found' }, 404, headers());
  });

  app.delete('/rw/meals/:id', async (c) =>
    (await deleteMealLog(c.env, c.req.param('id')))
      ? c.json({ ok: true }, 200, headers())
      : c.json({ error: 'meal log not found' }, 404, headers()));

  // ---- 運動 ----
  app.post('/rw/exercise/menus', async (c) => {
    const parsed = parseExerciseMenuInput(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400, headers());
    return c.json(await createExerciseMenu(c.env, parsed.value), 201, headers());
  });

  app.patch('/rw/exercise/menus/:id', async (c) => {
    const parsed = parseExerciseMenuPatch(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400, headers());
    const menu = await updateExerciseMenu(c.env, c.req.param('id'), parsed.value);
    return menu ? c.json(menu, 200, headers()) : c.json({ error: 'menu not found' }, 404, headers());
  });

  app.post('/rw/exercise/menus/:id/archive', async (c) =>
    (await setExerciseMenuArchived(c.env, c.req.param('id'), true))
      ? c.json({ ok: true }, 200, headers())
      : c.json({ error: 'menu not found' }, 404, headers()));

  app.post('/rw/exercise/menus/:id/unarchive', async (c) =>
    (await setExerciseMenuArchived(c.env, c.req.param('id'), false))
      ? c.json({ ok: true }, 200, headers())
      : c.json({ error: 'menu not found' }, 404, headers()));

  app.post('/rw/exercise/logs', async (c) => {
    const body = (await readJson(c)) ?? {};
    if (typeof body.menu_id !== 'string') return c.json({ error: 'menu_id is required' }, 400, headers());
    const fields = parseExerciseLogFields(body);
    if (!fields.ok) return c.json({ error: fields.error }, 400, headers());
    const log = await logExercise(c.env, { menu_id: body.menu_id, ...fields.value });
    if ('error' in log) return c.json({ error: log.error }, 400, headers());
    return c.json(log, 201, headers());
  });

  app.delete('/rw/exercise/logs/:id', async (c) =>
    (await deleteExerciseLog(c.env, c.req.param('id')))
      ? c.json({ ok: true }, 200, headers())
      : c.json({ error: 'exercise log not found' }, 404, headers()));

  // MCPは /mcp（短いパス）と /rw/mcp（後方互換エイリアス）の両方で受ける。どちらもOAuth必須・同一挙動
  app.all('/mcp', (c) => handleMcpRequest(c, { write: true }));
  app.all('/rw/mcp', (c) => handleMcpRequest(c, { write: true }));

  app.notFound((c) => c.text('not found', 404, noindexHeaders()));
  app.onError((err, c) => {
    console.error('[rw] unhandled error', err);
    return c.text('internal error', 500, noindexHeaders());
  });
  return app;
}
