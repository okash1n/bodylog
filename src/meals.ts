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

export async function updateMenu(env: Env, id: string, input: MenuInput): Promise<Menu | null> {
  const res = await env.DB.prepare(
    `UPDATE menus SET name = ?2, calories = ?3, protein_g = ?4, fat_g = ?5, carbs_g = ?6, note = ?7, updated_at = ?8
WHERE id = ?1`,
  )
    .bind(id, input.name, input.calories, input.protein_g ?? null, input.fat_g ?? null,
          input.carbs_g ?? null, input.note ?? null, isoNow())
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
