import { createExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { createRootDashboardRouter } from '../src/dashboard';
import { createMenu, logMeal } from '../src/meals';
import { localYmdDaysAgo, resetTables, testEnv } from './helpers';

const rootEnv: Env = { ...testEnv, DASHBOARD_SLUG: '' };
const app = new Hono<{ Bindings: Env }>().route('/', createRootDashboardRouter());

function request(path: string): Promise<Response> {
  return app.request(path, {}, rootEnv, createExecutionContext());
}

describe('公開REST（食事）', () => {
  beforeEach(async () => {
    await resetTables();
    const menu = await createMenu(testEnv, { name: '定食', calories: 650, protein_g: 30 });
    await logMeal(testEnv, {
      menu_id: menu.id,
      eaten_at: `${localYmdDaysAgo(0)}T03:00:00Z`,
      multiplier: 2,
    });
  });

  it('GET /api/menus が一覧を返す', async () => {
    const res = await request('/api/menus');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { menus: { name: string }[] };
    expect(body.menus.map((m) => m.name)).toEqual(['定食']);
  });

  it('GET /api/meals?days=7 が実効値付きで返す', async () => {
    const res = await request('/api/meals?days=7');
    const body = (await res.json()) as { meals: { effective_calories: number }[] };
    expect(body.meals[0].effective_calories).toBeCloseTo(1300);
  });

  it('GET /api/meals/daily?days=7 が日次合計を返す', async () => {
    const res = await request('/api/meals/daily?days=7');
    const body = (await res.json()) as { days: { d: string; calories: number }[] };
    expect(body.days).toHaveLength(1);
    expect(body.days[0].calories).toBeCloseTo(1300);
  });

  it('/api/summary に intake_today が含まれる', async () => {
    const res = await request('/api/summary');
    const body = (await res.json()) as { intake_today: { calories: number } | null };
    expect(body.intake_today?.calories).toBeCloseTo(1300);
  });

  it('期間バリデーションは既存規約（days+from併用は400）', async () => {
    expect((await request(`/api/meals?days=7&from=${localYmdDaysAgo(3)}`)).status).toBe(400);
  });
});
