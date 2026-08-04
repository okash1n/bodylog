import { createExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env, LatestMeasurement } from '../src/types';
import { createDashboardRouter } from '../src/dashboard';
import { insertMeasurement, localYmdDaysAgo, resetTables, testEnv } from './helpers';

const slug = testEnv.DASHBOARD_SLUG;
const app = new Hono<{ Bindings: Env }>().route('/d', createDashboardRouter());

function request(path: string): Promise<Response> {
  return app.request(path, {}, testEnv, createExecutionContext());
}

describe('api/raw（計測明細）', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('同日の複数計測を集計せず新しい順で返す', async () => {
    const d = localYmdDaysAgo(1);
    // ローカル日付 d のUTC正午相当（JST前提のテスト値ではなくローカル日付に収まる時刻を選ぶ）
    await insertMeasurement({ grpid: 1, measured_at: `${d}T01:00:00.000Z`, weight: 85.0 });
    await insertMeasurement({ grpid: 2, measured_at: `${d}T03:30:00.000Z`, weight: 84.4, fat_ratio: 23.4 });
    const res = await request(`/d/${slug}/api/raw?from=${d}&to=${d}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { measurements: LatestMeasurement[] };
    expect(body.measurements.length).toBe(2);
    // 新しい順
    expect(body.measurements[0].weight).toBe(84.4);
    expect(body.measurements[1].weight).toBe(85.0);
    expect(body.measurements[1].fat_ratio).toBeNull();
  });

  it('期間バリデーションは api/measurements と同一', async () => {
    const d = localYmdDaysAgo(0);
    expect((await request(`/d/${slug}/api/raw?from=bad&to=${d}`)).status).toBe(400);
    expect((await request(`/d/${slug}/api/raw?from=2026-02-01&to=2026-01-01`)).status).toBe(400);
    expect((await request(`/d/wrong-slug/api/raw?from=${d}&to=${d}`)).status).toBe(404);
  });

  it('no-store と noindex ヘッダーが付く', async () => {
    const d = localYmdDaysAgo(0);
    const res = await request(`/d/${slug}/api/raw?from=${d}&to=${d}`);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
  });
});
