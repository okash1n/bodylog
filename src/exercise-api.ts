/** 運動の公開読み取りREST。書き込みは src/writes.ts（/api の POST/PATCH/DELETE・認証必須） */
import type { Context } from 'hono';
import type { Env, ExerciseCategory } from './types';
import { getDailyExercise, getExerciseMenu, listExerciseLogs, listExerciseMenus } from './exercise';
import { getExerciseRecords } from './exercise-records';
import { noindexHeaders, withRange } from './util';

type ExerciseContext = Context<{ Bindings: Env }>;
type Handler = (c: ExerciseContext) => Response | Promise<Response>;

const NO_STORE = { 'Cache-Control': 'no-store' };

function categoryParam(c: ExerciseContext): ExerciseCategory | undefined {
  const cat = c.req.query('category');
  return cat === 'cardio' || cat === 'strength' ? cat : undefined;
}

export const serveExerciseMenus: Handler = async (c) => {
  const headers = noindexHeaders(NO_STORE);
  try {
    const menus = await listExerciseMenus(c.env, {
      q: c.req.query('q') || undefined,
      category: categoryParam(c),
      includeArchived: c.req.query('archived') === '1',
    });
    return c.json({ menus }, 200, headers);
  } catch (err) {
    console.error('[exercise-api] listExerciseMenus failed', err);
    return c.json({ error: 'internal error' }, 500, headers);
  }
};

export const serveExerciseLogs: Handler = (c) =>
  withRange(c, async (from, to) => {
    try {
      return c.json({ logs: await listExerciseLogs(c.env, from, to) }, 200, noindexHeaders(NO_STORE));
    } catch (err) {
      console.error('[exercise-api] listExerciseLogs failed', err);
      return c.json({ error: 'internal error' }, 500, noindexHeaders(NO_STORE));
    }
  });

export const serveExerciseDaily: Handler = (c) =>
  withRange(c, async (from, to) => {
    try {
      return c.json({ days: await getDailyExercise(c.env, from, to) }, 200, noindexHeaders(NO_STORE));
    } catch (err) {
      console.error('[exercise-api] getDailyExercise failed', err);
      return c.json({ error: 'internal error' }, 500, noindexHeaders(NO_STORE));
    }
  });

/** 筋トレ種目の自己ベスト（都度集計）。menu_id 必須・筋トレ種目のみ */
export const serveExerciseRecords: Handler = async (c) => {
  const headers = noindexHeaders(NO_STORE);
  const menuId = c.req.query('menu_id')?.trim();
  if (!menuId) return c.json({ error: 'menu_id is required' }, 400, headers);
  try {
    const menu = await getExerciseMenu(c.env, menuId);
    if (!menu) return c.json({ error: 'menu not found' }, 404, headers);
    if (menu.category !== 'strength') {
      return c.json({ error: 'records are only available for strength menus' }, 400, headers);
    }
    return c.json(await getExerciseRecords(c.env, menu), 200, headers);
  } catch (err) {
    console.error('[exercise-api] getExerciseRecords failed', err);
    return c.json({ error: 'internal error' }, 500, headers);
  }
};
