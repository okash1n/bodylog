/**
 * 食事データ層。メニュー（マスタ）と記録（スナップショット）のD1クエリを集約する。
 */
import type { Env, Menu, MenuInput } from './types';
import { isoNow, newId } from './util';

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
