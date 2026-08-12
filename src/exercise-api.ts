/** 運動の公開読み取りREST。書き込みは src/rw.ts（認証必須） */
import type { Context } from 'hono';
import type { Env, ExerciseCategory } from './types';
import { getDailyExercise, listExerciseLogs, listExerciseMenus } from './exercise';
import { noindexHeaders, resolveRangeFromQuery } from './util';

type ExerciseContext = Context<{ Bindings: Env }>;
type Handler = (c: ExerciseContext) => Response | Promise<Response>;

const NO_STORE = { 'Cache-Control': 'no-store' };

function categoryParam(c: ExerciseContext): ExerciseCategory | undefined {
  const cat = c.req.query('category');
  return cat === 'cardio' || cat === 'strength' ? cat : undefined;
}

function withRange(
  c: ExerciseContext,
  fn: (from: string, to: string) => Promise<Response>,
): Promise<Response> | Response {
  const headers = noindexHeaders(NO_STORE);
  const range = resolveRangeFromQuery(c, headers);
  if (range instanceof Response) return range;
  return fn(range.from, range.to);
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
