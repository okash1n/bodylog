/**
 * 食事データ層。メニュー（マスタ）と記録（スナップショット）のD1クエリを集約する。
 */
import type { DailyIntake, Env, MealLog, Menu, MenuInput, MealType } from './types';
import { isoNow, newId, tzModifier } from './util';

interface MenuRow {
  id: string; name: string; calories: number;
  protein_g: number | null; fat_g: number | null; carbs_g: number | null;
  note: string | null; archived: number; created_at: string; updated_at: string;
}

function toMenu(r: MenuRow): Menu {
  return { ...r, archived: r.archived !== 0 };
}

const MENU_COLS = 'id, name, calories, protein_g, fat_g, carbs_g, note, archived, created_at, updated_at';

export async function createMenu(env: Env, input: MenuInput): Promise<Menu> {
  const now = isoNow();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO menus (id, name, calories, protein_g, fat_g, carbs_g, note, archived, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)`,
  )
    .bind(id, input.name, input.calories, input.protein_g ?? null, input.fat_g ?? null,
          input.carbs_g ?? null, input.note ?? null, now)
    .run();
  return (await getMenu(env, id))!;
}

export async function getMenu(env: Env, id: string): Promise<Menu | null> {
  const row = await env.DB.prepare(`SELECT ${MENU_COLS} FROM menus WHERE id = ?1`)
    .bind(id)
    .first<MenuRow>();
  return row ? toMenu(row) : null;
}

/** 更新可能な列の固定リスト（列名はここからのみ組み立て、ユーザー入力を列名に使わない） */
const MENU_PATCHABLE_COLS = ['name', 'calories', 'protein_g', 'fat_g', 'carbs_g', 'note'] as const;

/**
 * patchに含まれるキーのみをSETする真の部分更新。キーが存在しないフィールドは現状維持、
 * 値がnullのフィールドはクリアする（呼び出し元でこの区別を作っておくこと。parseMenuPatch参照）。
 */
export async function updateMenu(env: Env, id: string, patch: Partial<MenuInput>): Promise<Menu | null> {
  const binds: unknown[] = [id];
  const sets: string[] = [];
  for (const col of MENU_PATCHABLE_COLS) {
    if (col in patch) {
      binds.push(patch[col] ?? null);
      sets.push(`${col} = ?${binds.length}`);
    }
  }
  binds.push(isoNow());
  sets.push(`updated_at = ?${binds.length}`);
  const res = await env.DB.prepare(`UPDATE menus SET ${sets.join(', ')} WHERE id = ?1`)
    .bind(...binds)
    .run();
  if ((res.meta.changes ?? 0) === 0) return null;
  return getMenu(env, id);
}

export async function setMenuArchived(env: Env, id: string, archived: boolean): Promise<boolean> {
  const res = await env.DB.prepare('UPDATE menus SET archived = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(id, archived ? 1 : 0, isoNow())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function listMenus(
  env: Env,
  opts: { q?: string; includeArchived?: boolean },
): Promise<Menu[]> {
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (!opts.includeArchived) conds.push('archived = 0');
  if (opts.q) {
    binds.push(`%${opts.q}%`);
    conds.push(`name LIKE ?${binds.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const res = await env.DB.prepare(
    `SELECT ${MENU_COLS} FROM menus ${where} ORDER BY name LIMIT 500`,
  )
    .bind(...binds)
    .all<MenuRow>();
  return res.results.map(toMenu);
}

interface MealLogRow {
  id: string; menu_id: string; eaten_at: string; meal_type: string | null;
  multiplier: number; menu_name: string; calories: number;
  protein_g: number | null; fat_g: number | null; carbs_g: number | null; created_at: string;
}

function toMealLog(r: MealLogRow): MealLog {
  const mul = (v: number | null): number | null => (v === null ? null : v * r.multiplier);
  return {
    ...r,
    meal_type: r.meal_type as MealType | null,
    effective_calories: r.calories * r.multiplier,
    effective_protein_g: mul(r.protein_g),
    effective_fat_g: mul(r.fat_g),
    effective_carbs_g: mul(r.carbs_g),
  };
}

const LOG_COLS =
  'id, menu_id, eaten_at, meal_type, multiplier, menu_name, calories, protein_g, fat_g, carbs_g, created_at';

export async function logMeal(
  env: Env,
  input: { menu_id: string; multiplier?: number; eaten_at?: string; meal_type?: MealType },
): Promise<MealLog | { error: string }> {
  const menu = await getMenu(env, input.menu_id);
  if (!menu) return { error: 'menu not found' };
  if (menu.archived) return { error: 'menu is archived' };
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO meal_logs (${LOG_COLS})
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(id, menu.id, input.eaten_at ?? isoNow(), input.meal_type ?? null,
          input.multiplier ?? 1.0, menu.name, menu.calories, menu.protein_g,
          menu.fat_g, menu.carbs_g, isoNow())
    .run();
  const row = await env.DB.prepare(`SELECT ${LOG_COLS} FROM meal_logs WHERE id = ?1`)
    .bind(id)
    .first<MealLogRow>();
  return toMealLog(row!);
}

export async function updateMealLog(
  env: Env,
  id: string,
  patch: { multiplier?: number; eaten_at?: string; meal_type?: MealType | null },
): Promise<MealLog | null> {
  const row = await env.DB.prepare(`SELECT ${LOG_COLS} FROM meal_logs WHERE id = ?1`)
    .bind(id)
    .first<MealLogRow>();
  if (!row) return null;
  await env.DB.prepare(
    'UPDATE meal_logs SET multiplier = ?2, eaten_at = ?3, meal_type = ?4 WHERE id = ?1',
  )
    .bind(id, patch.multiplier ?? row.multiplier, patch.eaten_at ?? row.eaten_at,
          patch.meal_type === undefined ? row.meal_type : patch.meal_type)
    .run();
  const updated = await env.DB.prepare(`SELECT ${LOG_COLS} FROM meal_logs WHERE id = ?1`)
    .bind(id)
    .first<MealLogRow>();
  return updated ? toMealLog(updated) : null;
}

export async function deleteMealLog(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM meal_logs WHERE id = ?1').bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function listMealLogs(env: Env, from: string, to: string): Promise<MealLog[]> {
  const tz = tzModifier(env);
  const res = await env.DB.prepare(
    `SELECT ${LOG_COLS} FROM meal_logs
WHERE date(eaten_at, '${tz}') BETWEEN ?1 AND ?2
ORDER BY eaten_at DESC LIMIT 2000`,
  )
    .bind(from, to)
    .all<MealLogRow>();
  return res.results.map(toMealLog);
}

export async function getDailyIntake(env: Env, from: string, to: string): Promise<DailyIntake[]> {
  const tz = tzModifier(env);
  const res = await env.DB.prepare(
    `SELECT date(eaten_at, '${tz}') AS d, COUNT(*) AS count,
       SUM(calories * multiplier) AS calories,
       SUM(protein_g * multiplier) AS protein_g,
       SUM(fat_g * multiplier) AS fat_g,
       SUM(carbs_g * multiplier) AS carbs_g
FROM meal_logs
WHERE date(eaten_at, '${tz}') BETWEEN ?1 AND ?2
GROUP BY 1 ORDER BY d`,
  )
    .bind(from, to)
    .all<DailyIntake>();
  return res.results;
}

export async function getIntakeForDay(env: Env, ymd: string): Promise<DailyIntake | null> {
  const rows = await getDailyIntake(env, ymd, ymd);
  return rows[0] ?? null;
}

const MEAL_TYPES: readonly string[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const MAX_MULTIPLIER = 20;

function isPositiveFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function optionalNutrient(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return isPositiveFinite(v) ? v : undefined;
}

/** REST（/rw/menus）とMCP（create_menu、Task 8）の両方から使うメニュー入力バリデータ */
export function parseMenuInput(body: unknown): { ok: true; value: MenuInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.name !== 'string' || b.name.trim() === '') return { ok: false, error: 'name is required' };
  if (!isPositiveFinite(b.calories)) return { ok: false, error: 'calories must be a positive number' };
  for (const key of ['protein_g', 'fat_g', 'carbs_g'] as const) {
    if (b[key] !== undefined && b[key] !== null && !isPositiveFinite(b[key])) {
      return { ok: false, error: `${key} must be a positive number` };
    }
  }
  return {
    ok: true,
    value: {
      name: b.name.trim(),
      calories: b.calories,
      protein_g: optionalNutrient(b.protein_g) ?? null,
      fat_g: optionalNutrient(b.fat_g) ?? null,
      carbs_g: optionalNutrient(b.carbs_g) ?? null,
      note: typeof b.note === 'string' ? b.note : null,
    },
  };
}

/**
 * PATCH /rw/menus/:id 用の部分更新バリデータ。parseMenuInputと異なり、キーの有無
 * （送信されたか否か）と値のnullを区別する: キー無し=現状維持、null=クリア、値あり=検証してセット。
 * name/calories はDB上NOT NULLのためnullクリアを許可しない（送るなら有効値必須）。
 */
export function parseMenuPatch(body: unknown): { ok: true; value: Partial<MenuInput> } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'invalid request body' };
  }
  const b = body as Record<string, unknown>;
  const out: Partial<MenuInput> = {};
  if ('name' in b) {
    if (typeof b.name !== 'string' || b.name.trim() === '') return { ok: false, error: 'name is required' };
    out.name = b.name.trim();
  }
  if ('calories' in b) {
    if (!isPositiveFinite(b.calories)) return { ok: false, error: 'calories must be a positive number' };
    out.calories = b.calories;
  }
  for (const key of ['protein_g', 'fat_g', 'carbs_g'] as const) {
    if (key in b) {
      if (b[key] === null) {
        out[key] = null;
      } else if (isPositiveFinite(b[key])) {
        out[key] = b[key] as number;
      } else {
        return { ok: false, error: `${key} must be a positive number` };
      }
    }
  }
  if ('note' in b) {
    if (b.note === null) {
      out.note = null;
    } else if (typeof b.note === 'string') {
      out.note = b.note;
    } else {
      return { ok: false, error: 'note must be a string or null' };
    }
  }
  if (Object.keys(out).length === 0) return { ok: false, error: 'no fields to update' };
  return { ok: true, value: out };
}

export interface MealFields {
  multiplier?: number;
  eaten_at?: string;
  meal_type?: MealType;
}

/** REST（/rw/meals）とMCP（log_meal、Task 8）の両方から使う記録フィールドバリデータ */
export function parseMealFields(b: Record<string, unknown>): { ok: true; value: MealFields } | { ok: false; error: string } {
  const out: MealFields = {};
  if (b.multiplier !== undefined) {
    if (!isPositiveFinite(b.multiplier) || (b.multiplier as number) > MAX_MULTIPLIER) {
      return { ok: false, error: `multiplier must be a positive number <= ${MAX_MULTIPLIER}` };
    }
    out.multiplier = b.multiplier as number;
  }
  if (b.eaten_at !== undefined) {
    if (typeof b.eaten_at !== 'string' || Number.isNaN(Date.parse(b.eaten_at))) {
      return { ok: false, error: 'eaten_at must be ISO8601' };
    }
    if (Date.parse(b.eaten_at) > Date.parse(isoNow()) + 60_000) {
      return { ok: false, error: 'eaten_at must not be in the future' };
    }
    out.eaten_at = b.eaten_at;
  }
  if (b.meal_type !== undefined && b.meal_type !== null) {
    if (typeof b.meal_type !== 'string' || !MEAL_TYPES.includes(b.meal_type)) {
      return { ok: false, error: `meal_type must be one of ${MEAL_TYPES.join(', ')}` };
    }
    out.meal_type = b.meal_type as MealType;
  }
  return { ok: true, value: out };
}
