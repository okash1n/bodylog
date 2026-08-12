/** 食事の公開読み取りREST。書き込みは src/rw.ts（認証必須） */
import type { Context } from 'hono';
import { getDailyIntake, listMealLogs, listMenus } from './meals';
import type { Env } from './types';
import { localToday, noindexHeaders, resolveRange } from './util';

type MealsContext = Context<{ Bindings: Env }>;
type Handler = (c: MealsContext) => Response | Promise<Response>;

const NO_STORE = { 'Cache-Control': 'no-store' };

function withRange(
  c: MealsContext,
  fn: (from: string, to: string) => Promise<Response>,
): Promise<Response> | Response {
  const headers = noindexHeaders(NO_STORE);
  const range = resolveRange(
    { days: c.req.query('days'), from: c.req.query('from'), to: c.req.query('to') },
    localToday(c.env),
  );
  if (!range.ok) return c.json({ error: range.error }, 400, headers);
  return fn(range.from, range.to);
}

export const serveMenus: Handler = async (c) => {
  const headers = noindexHeaders(NO_STORE);
  try {
    const menus = await listMenus(c.env, {
      q: c.req.query('q') || undefined,
      includeArchived: c.req.query('archived') === '1',
    });
    return c.json({ menus }, 200, headers);
  } catch (err) {
    console.error('[meals-api] listMenus failed', err);
    return c.json({ error: 'internal error' }, 500, headers);
  }
};

export const serveMealsList: Handler = (c) =>
  withRange(c, async (from, to) => {
    try {
      return c.json({ meals: await listMealLogs(c.env, from, to) }, 200, noindexHeaders(NO_STORE));
    } catch (err) {
      console.error('[meals-api] listMealLogs failed', err);
      return c.json({ error: 'internal error' }, 500, noindexHeaders(NO_STORE));
    }
  });

export const serveMealsDaily: Handler = (c) =>
  withRange(c, async (from, to) => {
    try {
      return c.json({ days: await getDailyIntake(c.env, from, to) }, 200, noindexHeaders(NO_STORE));
    } catch (err) {
      console.error('[meals-api] getDailyIntake failed', err);
      return c.json({ error: 'internal error' }, 500, noindexHeaders(NO_STORE));
    }
  });
