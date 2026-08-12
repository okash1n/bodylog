import { createExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { createDashboardRouter, createRootDashboardRouter } from '../src/dashboard';
import { insertMeasurement, localYmdDaysAgo, resetTables, setSetting, testEnv } from './helpers';

const rootEnv: Env = { ...testEnv, DASHBOARD_SLUG: '' };
const app = new Hono<{ Bindings: Env }>().route('/', createRootDashboardRouter());
const slugApp = new Hono<{ Bindings: Env }>().route('/d', createDashboardRouter());

function request(path: string, env: Env = rootEnv): Promise<Response> {
  return app.request(path, {}, env, createExecutionContext());
}

/** N日前のローカル日付のJST正午（03:00Z）。日付境界付近の実行でも安定する固定時刻seed */
function isoDaysAgo(daysAgo: number): string {
  return `${localYmdDaysAgo(daysAgo)}T03:00:00Z`;
}

describe('AI向けREST拡張', () => {
  beforeEach(async () => {
    await resetTables();
  });

  describe('daysパラメータ', () => {
    beforeEach(async () => {
      await insertMeasurement({ grpid: 1, measured_at: isoDaysAgo(0), weight: 70, fat_free_mass: 50 });
      await insertMeasurement({ grpid: 2, measured_at: isoDaysAgo(3), weight: 71, fat_free_mass: 50 });
      await insertMeasurement({ grpid: 3, measured_at: isoDaysAgo(30), weight: 75, fat_free_mass: 50 });
    });

    it('measurements?days=7 が直近7日だけ返す', async () => {
      const res = await request('/api/measurements?days=7');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { days: { d: string; weight: number | null; fat_mass: number | null }[] };
      expect(body.days.map((p) => p.d)).toEqual([localYmdDaysAgo(3), localYmdDaysAgo(0)]);
      const today = body.days[1];
      expect(today.weight).toBeCloseTo(70);
      expect(today.fat_mass).toBeCloseTo(20);
    });

    it('raw?days=7 が直近7日の明細を新しい順に返す', async () => {
      const res = await request('/api/raw?days=7');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { measurements: { weight: number | null }[] };
      expect(body.measurements.map((m) => m.weight)).toEqual([70, 71]);
    });

    it('days=1（境界の下限）は当日のみ', async () => {
      const res = await request('/api/measurements?days=1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { days: { d: string }[] };
      expect(body.days.map((p) => p.d)).toEqual([localYmdDaysAgo(0)]);
    });

    it('days=731（境界の上限）は200', async () => {
      expect((await request('/api/measurements?days=731')).status).toBe(200);
    });

    it.each(['0', '732', 'abc', '-5', '1.5'])('days=%s は400', async (days) => {
      const res = await request(`/api/measurements?days=${days}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('days must be an integer');
    });

    it('days=7 は「今日を末尾とする7日間」（day-6を含みday-7を含まない）', async () => {
      await insertMeasurement({ grpid: 4, measured_at: isoDaysAgo(6), weight: 68, fat_free_mass: 50 });
      await insertMeasurement({ grpid: 5, measured_at: isoDaysAgo(7), weight: 69, fat_free_mass: 50 });
      const res = await request('/api/measurements?days=7');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { days: { d: string }[] };
      const dates = body.days.map((p) => p.d);
      expect(dates).toContain(localYmdDaysAgo(6));
      expect(dates).not.toContain(localYmdDaysAgo(7));
    });

    it('daysとfrom/toの併用は400', async () => {
      const res = await request(`/api/measurements?days=7&from=${localYmdDaysAgo(3)}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('days cannot be combined with from/to');
    });

    it('従来のfrom/to指定は引き続き動く（回帰）', async () => {
      const res = await request(`/api/raw?from=${localYmdDaysAgo(5)}&to=${localYmdDaysAgo(0)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { measurements: unknown[] };
      expect(body.measurements).toHaveLength(2);
    });
  });

  describe('/api/summary', () => {
    it('データが空でも200で各値null', async () => {
      const res = await request('/api/summary');
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const body = (await res.json()) as {
        latest: unknown;
        recent7_avg: { weight: number | null };
        baseline: { date: string | null };
        last_sync_at: string | null;
      };
      expect(body.latest).toBeNull();
      expect(body.recent7_avg.weight).toBeNull();
      expect(body.baseline.date).toBeNull();
      expect(body.last_sync_at).toBeNull();
    });

    it('最新計測・7日平均・前週比・基準日比・最終同期を返す', async () => {
      await insertMeasurement({ grpid: 1, measured_at: isoDaysAgo(0), weight: 70, fat_free_mass: 50, fat_ratio: 28 });
      await insertMeasurement({ grpid: 2, measured_at: isoDaysAgo(10), weight: 72, fat_free_mass: 50 });
      await setSetting('baseline_date', localYmdDaysAgo(10));
      await setSetting('last_sync_at', '2026-08-01T00:00:00.000Z');
      const res = await request('/api/summary');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        units: { mass: string };
        latest: { weight: number; fat_mass: number; fat_ratio: number };
        recent7_avg: { weight: number };
        diff_vs_prev7: { weight: number };
        baseline: { date: string; diff: { weight: number } };
        last_sync_at: string;
      };
      expect(body.units.mass).toBe('kg');
      expect(body.latest.weight).toBeCloseTo(70);
      expect(body.latest.fat_mass).toBeCloseTo(20);
      expect(body.latest.fat_ratio).toBeCloseTo(28);
      expect(body.recent7_avg.weight).toBeCloseTo(70);
      expect(body.diff_vs_prev7.weight).toBeCloseTo(-2);
      expect(body.baseline.date).toBe(localYmdDaysAgo(10));
      expect(body.baseline.diff.weight).toBeCloseTo(-2);
      expect(body.last_sync_at).toBe('2026-08-01T00:00:00.000Z');
    });
  });

  describe('llms.txt / openapi.json', () => {
    it('llms.txt がリクエストオリジンでURL例を組み立てる', async () => {
      const res = await request('/llms.txt');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/plain');
      expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
      const text = await res.text();
      expect(text).toContain('http://localhost/api/summary');
      expect(text).toContain('http://localhost/mcp');
      expect(text).toContain('kg');
    });

    it('openapi.json が4エンドポイントとオリジン由来のserversを持つ', async () => {
      const res = await request('/openapi.json');
      expect(res.status).toBe(200);
      const spec = (await res.json()) as {
        openapi: string;
        servers: { url: string }[];
        paths: Record<string, unknown>;
      };
      expect(spec.openapi).toBe('3.1.0');
      expect(spec.servers[0].url).toBe('http://localhost');
      for (const p of ['/api/summary', '/api/measurements', '/api/raw', '/api/status']) {
        expect(spec.paths).toHaveProperty([p]);
      }
    });

    it('openapi.jsonのsummaryスキーマが実レスポンスのキー集合と一致する（drift検知）', async () => {
      const spec = (await (await request('/openapi.json')).json()) as {
        paths: {
          '/api/summary': {
            get: {
              responses: {
                '200': {
                  content: { 'application/json': { schema: { properties: Record<string, unknown> } } };
                };
              };
            };
          };
        };
      };
      const schemaKeys = Object.keys(
        spec.paths['/api/summary'].get.responses['200'].content['application/json'].schema.properties,
      ).sort();
      const actualKeys = Object.keys((await (await request('/api/summary')).json()) as object).sort();
      expect(actualKeys).toEqual(schemaKeys);
    });

    it('slugモードでは /d/{slug}/ 配下で配信され、ドメイン直下は404', async () => {
      const res = await slugApp.request('/d/testslug/llms.txt', {}, testEnv, createExecutionContext());
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('http://localhost/d/testslug/api/summary');

      const spec = await slugApp.request('/d/testslug/openapi.json', {}, testEnv, createExecutionContext());
      const parsed = (await spec.json()) as { servers: { url: string }[] };
      expect(parsed.servers[0].url).toBe('http://localhost/d/testslug');

      expect((await request('/llms.txt', testEnv)).status).toBe(404);
      expect((await request('/api/summary', testEnv)).status).toBe(404);
    });
  });
});
