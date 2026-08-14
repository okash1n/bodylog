/**
 * 書き込みAPI（/api/* の POST/PATCH/DELETE）。読み取りと同じ /api 名前空間にメソッドで同居し、
 * 各ハンドラは withAuth（Bearerトークン検証）で保護する。/rw プレフィックスは廃止。
 * ドメイン直下モードとスラッグモードの両ルータから同じ定義を登録するため関数化する。
 */
import type { Context, Hono } from 'hono';
import type { Env } from './types';
import {
  createMenu, deleteMealLog, logMeal, parseMealFields, parseMenuInput, parseMenuPatch, setMenuArchived,
  updateMealLog, updateMenu,
} from './meals';
import {
  createExerciseMenu, deleteExerciseLog, logExercise, parseExerciseLogFields,
  parseExerciseMenuInput, parseExerciseMenuPatch, setExerciseMenuArchived, updateExerciseMenu,
} from './exercise';
import { withAuth } from './auth';
import { coachingTokenMatches, parseCoachingInput, upsertCoachingNote } from './coaching';
import { queueCoachingNotification } from './slack';
import { noindexHeaders } from './util';

type Ctx = Context<{ Bindings: Env }>;
type Handler = (c: Ctx) => Response | Promise<Response>;

const headers = (): Record<string, string> => noindexHeaders({ 'Cache-Control': 'no-store' });
const readJson = async (c: Ctx): Promise<Record<string, unknown> | null> =>
  (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
// 計算パス（p()）はHonoの:idリテラル推論が効かず param('id') が string|undefined になる。
// ルートが:idを保証するのでstringとして扱う
const pid = (c: Ctx): string => c.req.param('id') as string;

/**
 * 書き込みルートを app に登録する。
 * @param guarded スラッグ判定などの外側ガード（読み取りと共通）。write = guarded(withAuth(handler))
 * @param prefix ルータの基点（スラッグモードは '/:slug'、ドメイン直下は ''）
 */
export function registerWriteRoutes(
  app: Hono<{ Bindings: Env }>,
  guarded: (h: Handler) => Handler,
  prefix: string,
): void {
  // 500もJSON {error}で返す（フロントは res.json().error を読む契約。text/plainだとalertが出ず無言で失敗する）
  const guardedErrors = (h: Handler): Handler => async (c) => {
    try {
      return await h(c);
    } catch (err) {
      console.error('[writes] unhandled error', err);
      return c.json({ error: 'internal error' }, 500, headers());
    }
  };
  const w = (h: Handler): Handler => guarded(withAuth(guardedErrors(h)));
  const p = (path: string): string => `${prefix}${path}`;

  // ---- 食事メニュー ----
  app.post(p('/api/menus'), w(async (c) => {
    const parsed = parseMenuInput(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400, headers());
    return c.json(await createMenu(c.env, parsed.value), 201, headers());
  }));
  app.patch(p('/api/menus/:id'), w(async (c) => {
    const parsed = parseMenuPatch(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400, headers());
    const menu = await updateMenu(c.env, pid(c), parsed.value);
    return menu ? c.json(menu, 200, headers()) : c.json({ error: 'menu not found' }, 404, headers());
  }));
  app.post(p('/api/menus/:id/archive'), w(async (c) =>
    (await setMenuArchived(c.env, pid(c), true))
      ? c.json({ ok: true }, 200, headers())
      : c.json({ error: 'menu not found' }, 404, headers())));
  app.post(p('/api/menus/:id/unarchive'), w(async (c) =>
    (await setMenuArchived(c.env, pid(c), false))
      ? c.json({ ok: true }, 200, headers())
      : c.json({ error: 'menu not found' }, 404, headers())));

  // ---- 食事記録 ----
  app.post(p('/api/meals'), w(async (c) => {
    const body = (await readJson(c)) ?? {};
    if (typeof body.menu_id !== 'string') return c.json({ error: 'menu_id is required' }, 400, headers());
    const fields = parseMealFields(body);
    if (!fields.ok) return c.json({ error: fields.error }, 400, headers());
    const log = await logMeal(c.env, { menu_id: body.menu_id, ...fields.value });
    if ('error' in log) return c.json({ error: log.error }, 400, headers());
    return c.json(log, 201, headers());
  }));
  app.patch(p('/api/meals/:id'), w(async (c) => {
    const body = (await readJson(c)) ?? {};
    const fields = parseMealFields(body);
    if (!fields.ok) return c.json({ error: fields.error }, 400, headers());
    const log = await updateMealLog(c.env, pid(c), fields.value);
    return log ? c.json(log, 200, headers()) : c.json({ error: 'meal log not found' }, 404, headers());
  }));
  app.delete(p('/api/meals/:id'), w(async (c) =>
    (await deleteMealLog(c.env, pid(c)))
      ? c.json({ ok: true }, 200, headers())
      : c.json({ error: 'meal log not found' }, 404, headers())));

  // ---- 運動種目 ----
  app.post(p('/api/exercise/menus'), w(async (c) => {
    const parsed = parseExerciseMenuInput(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400, headers());
    return c.json(await createExerciseMenu(c.env, parsed.value), 201, headers());
  }));
  app.patch(p('/api/exercise/menus/:id'), w(async (c) => {
    const parsed = parseExerciseMenuPatch(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400, headers());
    const menu = await updateExerciseMenu(c.env, pid(c), parsed.value);
    return menu ? c.json(menu, 200, headers()) : c.json({ error: 'menu not found' }, 404, headers());
  }));
  app.post(p('/api/exercise/menus/:id/archive'), w(async (c) =>
    (await setExerciseMenuArchived(c.env, pid(c), true))
      ? c.json({ ok: true }, 200, headers())
      : c.json({ error: 'menu not found' }, 404, headers())));
  app.post(p('/api/exercise/menus/:id/unarchive'), w(async (c) =>
    (await setExerciseMenuArchived(c.env, pid(c), false))
      ? c.json({ ok: true }, 200, headers())
      : c.json({ error: 'menu not found' }, 404, headers())));

  // ---- 運動記録 ----
  app.post(p('/api/exercise/logs'), w(async (c) => {
    const body = (await readJson(c)) ?? {};
    if (typeof body.menu_id !== 'string') return c.json({ error: 'menu_id is required' }, 400, headers());
    const fields = parseExerciseLogFields(body);
    if (!fields.ok) return c.json({ error: fields.error }, 400, headers());
    const log = await logExercise(c.env, { menu_id: body.menu_id, ...fields.value });
    if ('error' in log) return c.json({ error: log.error }, 400, headers());
    return c.json(log, 201, headers());
  }));
  app.delete(p('/api/exercise/logs/:id'), w(async (c) =>
    (await deleteExerciseLog(c.env, pid(c)))
      ? c.json({ ok: true }, 200, headers())
      : c.json({ error: 'exercise log not found' }, 404, headers())));

  // ---- AIコーチング講評 ----
  // GitHub Actions からのサーバー間書き込みのため、OAuth（withAuth）ではなく
  // COACHING_API_SECRET とのBearer照合で保護する。secret未設定の環境では404（機能無効）
  app.post(p('/api/coaching'), guarded(guardedErrors(async (c) => {
    const secret = c.env.COACHING_API_SECRET;
    if (!secret) return c.json({ error: 'not found' }, 404, headers());
    const auth = c.req.header('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    if (!token || !coachingTokenMatches(token, secret)) {
      return c.json({ error: 'unauthorized' }, 401, headers());
    }
    const parsed = parseCoachingInput(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400, headers());
    const note = await upsertCoachingNote(c.env, parsed.value);
    // Slack配信失敗で保存自体を失敗にしない（配信は既存のリトライ機構が引き継ぐ）
    const { queued } = await queueCoachingNotification(c.env, new URL(c.req.url).origin, note).catch(
      (err: unknown) => {
        console.error('[writes] coaching notification queue failed', err);
        return { queued: 0 };
      },
    );
    return c.json({ ...note, queued }, 201, headers());
  })));
}
