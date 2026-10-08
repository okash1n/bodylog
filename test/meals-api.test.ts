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
  return Promise.resolve(app.request(path, {}, rootEnv, createExecutionContext()));
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

  it('未来日の食事記録は to に未来日を指定すると返り、days 指定（今日まで）には含まれない', async () => {
    const menu = await createMenu(testEnv, { name: '鶏むね', calories: 300 });
    const today = localYmdDaysAgo(0);
    const tomorrow = localYmdDaysAgo(-1);
    await logMeal(testEnv, { menu_id: menu.id, eaten_at: `${tomorrow}T03:00:00Z` });

    const ranged = await request(`/api/meals?from=${today}&to=${tomorrow}`);
    expect(ranged.status).toBe(200);
    const rangedBody = (await ranged.json()) as { meals: { menu_name: string }[] };
    expect(rangedBody.meals.map((m) => m.menu_name)).toEqual(['鶏むね', '定食']);

    const byDays = (await (await request('/api/meals?days=7')).json()) as { meals: { menu_name: string }[] };
    expect(byDays.meals.map((m) => m.menu_name)).toEqual(['定食']);

    const daily = await request(`/api/meals/daily?from=${today}&to=${tomorrow}`);
    expect(daily.status).toBe(200);
    const dailyBody = (await daily.json()) as { days: { d: string; calories: number }[] };
    expect(dailyBody.days.map((d) => d.d)).toEqual([today, tomorrow]);
    expect(dailyBody.days[1].calories).toBeCloseTo(300);

    // 未来日を許すのは食事の期間指定だけ（体重の時系列は従来どおり今日まで）
    expect((await request(`/api/measurements?from=${today}&to=${tomorrow}`)).status).toBe(400);
    // 未来日を許しても from>to と期間上限（731日）の検証は残る
    expect((await request(`/api/meals?from=${tomorrow}&to=${today}`)).status).toBe(400);
    expect((await request(`/api/meals?from=${today}&to=${localYmdDaysAgo(-731)}`)).status).toBe(400);
    expect((await request(`/api/meals?from=${today}&to=${localYmdDaysAgo(-730)}`)).status).toBe(200);
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
