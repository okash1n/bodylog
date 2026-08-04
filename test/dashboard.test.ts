import { createExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DayPoint, Env } from '../src/types';
import { createDashboardRouter } from '../src/dashboard';
import { insertMeasurement, localYmdDaysAgo, resetTables, testEnv } from './helpers';

const slug = testEnv.DASHBOARD_SLUG;

function request(path: string): Promise<Response> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/d', createDashboardRouter());
  return app.request(path, {}, testEnv, createExecutionContext());
}

describe('dashboard API', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('有効なfrom/toで days を返し X-Robots-Tag を付与する', async () => {
    const d = localYmdDaysAgo(10);
    await insertMeasurement({ grpid: 9001, measured_at: `${d}T03:00:00Z`, weight: 65.2 });

    const res = await request(`/d/${slug}/api/measurements?from=${d}&to=${d}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    const body = (await res.json()) as { days: DayPoint[] };
    expect(body.days).toHaveLength(1);
    expect(body.days[0].d).toBe(d);
    expect(body.days[0].weight).toBeCloseTo(65.2, 5);
  });

  it('不正な日付形式は400', async () => {
    const d = localYmdDaysAgo(10);
    expect((await request(`/d/${slug}/api/measurements?from=abc&to=${d}`)).status).toBe(400);
    expect((await request(`/d/${slug}/api/measurements?from=2026-1-1&to=${d}`)).status).toBe(400);
    expect((await request(`/d/${slug}/api/measurements?from=2026-02-30&to=${d}`)).status).toBe(400);
    expect((await request(`/d/${slug}/api/measurements?to=${d}`)).status).toBe(400); // from欠落
  });

  it('from > to は400', async () => {
    const res = await request(`/d/${slug}/api/measurements?from=2026-02-01&to=2026-01-01`);
    expect(res.status).toBe(400);
  });

  it('期間が LIMITS.API_MAX_RANGE_DAYS 超は400', async () => {
    // 2024-01-01〜2026-01-05 = 735日 > 731日
    const res = await request(`/d/${slug}/api/measurements?from=2024-01-01&to=2026-01-05`);
    expect(res.status).toBe(400);
  });

  it('未来日の to は400', async () => {
    const from = localYmdDaysAgo(0);
    const future = localYmdDaysAgo(-5);
    const res = await request(`/d/${slug}/api/measurements?from=${from}&to=${future}`);
    expect(res.status).toBe(400);
  });

  it('slug 不一致は404', async () => {
    const d = localYmdDaysAgo(10);
    expect((await request(`/d/wrong-slug/api/measurements?from=${d}&to=${d}`)).status).toBe(404);
    expect((await request('/d/wrong-slug/')).status).toBe(404);
  });

  it('api/status は import 状態を返す', async () => {
    const res = await request(`/d/${slug}/api/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('import_status');
  });
});

describe('dashboard HTML', () => {
  it('トップページに X-Robots-Tag が付与される', async () => {
    const res = await request(`/d/${slug}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(res.headers.get('Content-Type') ?? '').toContain('text/html');
    expect((await res.text()).length).toBeGreaterThan(0);
  });
});
