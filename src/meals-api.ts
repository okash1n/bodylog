/** 食事の公開読み取りREST。書き込みは src/writes.ts（/api の POST/PATCH/DELETE・認証必須） */
import type { Context } from 'hono';
import { getDailyIntake, listMealLogs, listMenus } from './meals';
import type { Env } from './types';
import { noindexHeaders, withRange } from './util';

type MealsContext = Context<{ Bindings: Env }>;
type Handler = (c: MealsContext) => Response | Promise<Response>;

const NO_STORE = { 'Cache-Control': 'no-store' };

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

// 食べる予定の食事は未来日時で先に記録できるため、期間の終端に未来日を許す（体重・運動の期間APIは今日まで）
const MEALS_RANGE = { allowFutureTo: true };

export const serveMealsList: Handler = (c) =>
  withRange(
    c,
    async (from, to) => {
      try {
        return c.json({ meals: await listMealLogs(c.env, from, to) }, 200, noindexHeaders(NO_STORE));
      } catch (err) {
        console.error('[meals-api] listMealLogs failed', err);
        return c.json({ error: 'internal error' }, 500, noindexHeaders(NO_STORE));
      }
    },
    MEALS_RANGE,
  );

export const serveMealsDaily: Handler = (c) =>
  withRange(
    c,
    async (from, to) => {
      try {
        return c.json({ days: await getDailyIntake(c.env, from, to) }, 200, noindexHeaders(NO_STORE));
      } catch (err) {
        console.error('[meals-api] getDailyIntake failed', err);
        return c.json({ error: 'internal error' }, 500, noindexHeaders(NO_STORE));
      }
    },
    MEALS_RANGE,
  );
