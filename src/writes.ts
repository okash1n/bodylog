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
import { getDayMeasurementCount } from './queries';
import { dailyDestinations, runDailyDigest } from './slack';
import { ensurePublicOrigin, isValidYmd, localToday, noindexHeaders } from './util';
import { deleteManualMeasurement, logWeight, parseWeightInput } from './weight';

type Ctx = Context<{ Bindings: Env }>;
type Handler = (c: Ctx) => Response | Promise<Response>;

const headers = (): Record<string, string> => noindexHeaders({ 'Cache-Control': 'no-store' });
const readJson = async (c: Ctx): Promise<Record<string, unknown> | null> =>
  (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
// 計算パス（p()）はHonoの:idリテラル推論が効かず param('id') が string|undefined になる。
// ルートが:idを保証するのでstringとして扱う
const pid = (c: Ctx): string => c.req.param('id') as string;
/** Authorization: Bearer が COACHING_API_SECRET と一致するか（タイミングセーフ比較）。サーバー間ジョブ用の経路で使う */
const coachingBearerOk = (c: Ctx, secret: string): boolean => {
  const auth = c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  return token !== '' && coachingTokenMatches(token, secret);
};

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
  // 認証済み書き込みの到着時にpublic_originを初期化する（レイテンシ外・失敗しても本処理に影響しない）
  const withOriginInit = (h: Handler): Handler => (c) => {
    c.executionCtx.waitUntil(
      ensurePublicOrigin(c.env, new URL(c.req.url).origin).catch((err) =>
        console.error('[writes] ensurePublicOrigin failed', err),
      ),
    );
    return h(c);
  };
  const w = (h: Handler): Handler => guarded(withAuth(guardedErrors(withOriginInit(h))));
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

  // ---- 体重（手動記録。Withings由来の行はここでは触れない） ----
  app.post(p('/api/weight'), w(async (c) => {
    const parsed = parseWeightInput(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400, headers());
    return c.json(await logWeight(c.env, parsed.value), 201, headers());
  }));
  app.delete(p('/api/weight/:id'), w(async (c) => {
    const raw = pid(c);
    const id = /^-?\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(id) || !(await deleteManualMeasurement(c.env, id))) {
      return c.json({ error: 'manual measurement not found' }, 404, headers());
    }
    return c.json({ ok: true }, 200, headers());
  }));

  // ---- AIコーチング講評 ----
  // GitHub Actions からのサーバー間書き込みのため、OAuth（withAuth）ではなく
  // COACHING_API_SECRET とのBearer照合で保護する。secret未設定の環境では404（機能無効）
  app.post(p('/api/coaching'), guarded(guardedErrors(async (c) => {
    const secret = c.env.COACHING_API_SECRET;
    if (!secret) return c.json({ error: 'not found' }, 404, headers());
    if (!coachingBearerOk(c, secret)) return c.json({ error: 'unauthorized' }, 401, headers());
    const parsed = parseCoachingInput(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400, headers());
    // 保存のみ。Slackへは単独配信せず、日次ダイジェスト（23:55）が当日分を本文に差し込む
    const note = await upsertCoachingNote(c.env, parsed.value);
    return c.json(note, 201, headers());
  })));

  // ---- 日次ダイジェストの手動送信 ----
  // 23:55 時点で計測が無く自動送信がスキップされた日に、後から体重を記録した上で送り直すための経路。
  // 自動送信は「現在のローカル日付」の分しか投入しないため、日付が変わった後は手動でしか送れない。
  // coaching と同じくサーバー間（GitHub Actions の digest.yml）から呼ぶため COACHING_API_SECRET で保護する
  app.post(p('/api/digest'), guarded(guardedErrors(async (c) => {
    const secret = c.env.COACHING_API_SECRET;
    if (!secret) return c.json({ error: 'not found' }, 404, headers());
    if (!coachingBearerOk(c, secret)) return c.json({ error: 'unauthorized' }, 401, headers());
    const date = (await readJson(c))?.date;
    if (typeof date !== 'string' || !isValidYmd(date)) {
      return c.json({ error: 'date must be a valid YYYY-MM-DD' }, 400, headers());
    }
    if (date > localToday(c.env)) return c.json({ error: 'date must not be a future date' }, 400, headers());
    if (dailyDestinations(c.env).length === 0) {
      return c.json({ error: 'no daily digest destination is configured' }, 409, headers());
    }
    if ((await getDayMeasurementCount(c.env, date)) === 0) {
      return c.json({ error: 'no measurements on that date' }, 409, headers());
    }
    // 投入と同時に送信を試みる（dead になっていた行も pending に戻して再試行）。
    // 送信失敗分は5分毎のcron（processNotificationBatches）が再試行する
    const { queued } = await runDailyDigest(c.env, new URL(c.req.url).origin, date);
    if (queued === 0) {
      return c.json({ error: 'digest for that date was already sent or is in progress' }, 409, headers());
    }
    return c.json({ date, queued }, 200, headers());
  })));
}
