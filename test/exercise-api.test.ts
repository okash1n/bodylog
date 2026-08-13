import { createExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import worker from '../src/index';
import { createRootDashboardRouter } from '../src/dashboard';
import { createExerciseMenu, logExercise } from '../src/exercise';
import { insertMeasurement, localYmdDaysAgo, obtainAccessToken, resetTables, testEnv } from './helpers';

const rootEnv: Env = { ...testEnv, DASHBOARD_SLUG: '' };
const app = new Hono<{ Bindings: Env }>().route('/', createRootDashboardRouter());

function request(path: string): Promise<Response> {
  return app.request(path, {}, rootEnv, createExecutionContext());
}

function rw(path: string, token: string | null, method: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    rootEnv,
    createExecutionContext(),
  );
}

// performed_at=now（実時刻）以前になるよう、体重は明確に過去（2日前）にseedする。
// これで実行時のUTC時刻に関わらず getBodyWeightAt(now) が体重を拾える
async function seedWeight(weight: number): Promise<void> {
  await insertMeasurement({ grpid: 1, measured_at: `${localYmdDaysAgo(2)}T00:00:00Z`, weight, fat_free_mass: weight * 0.8 });
}

describe('公開REST（運動）', () => {
  beforeEach(async () => {
    await resetTables();
    await seedWeight(70);
    const run = await createExerciseMenu(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    const bench = await createExerciseMenu(testEnv, { name: 'ベンチプレス', category: 'strength', muscle_group: '胸' });
    await logExercise(testEnv, { menu_id: run.id, performed_at: `${localYmdDaysAgo(0)}T03:00:00Z`, duration_min: 30 });
    await logExercise(testEnv, {
      menu_id: bench.id, performed_at: `${localYmdDaysAgo(0)}T04:00:00Z`,
      sets: [{ reps: 10, weight_kg: 40 }, { reps: 8, weight_kg: 42.5 }],
    });
  });

  it('GET /api/exercise/menus が一覧を返し、categoryで絞れる', async () => {
    const all = (await (await request('/api/exercise/menus')).json()) as { menus: { name: string }[] };
    expect(all.menus.map((m) => m.name).sort()).toEqual(['ベンチプレス', 'ランニング']);
    const cardio = (await (await request('/api/exercise/menus?category=cardio')).json()) as { menus: { name: string }[] };
    expect(cardio.menus.map((m) => m.name)).toEqual(['ランニング']);
  });

  it('GET /api/exercise/logs がセット明細・総ボリューム付きで返す', async () => {
    const res = await request('/api/exercise/logs?days=7');
    const body = (await res.json()) as { logs: { category: string; total_volume: number | null; calories: number | null }[] };
    const strength = body.logs.find((l) => l.category === 'strength');
    const cardio = body.logs.find((l) => l.category === 'cardio');
    expect(strength?.total_volume).toBe(740);
    expect(cardio?.calories).toBeCloseTo(294);
  });

  it('GET /api/exercise/daily が全日分のBMR・消費kcal・総ボリュームを返す', async () => {
    const res = await request('/api/exercise/daily?days=7');
    const body = (await res.json()) as {
      days: { d: string; bmr: number | null; calories_burned: number | null; strength_volume: number | null }[];
    };
    expect(body.days).toHaveLength(7); // 運動が無い日も返る（BMRは毎日成立）
    const today = body.days.find((r) => r.d === localYmdDaysAgo(0));
    expect(today?.calories_burned).toBeCloseTo(294);
    expect(today?.strength_volume).toBe(740);
    // seedWeight(70) → ffm 56 → Katch-McArdle 1579.6。計測日(2日前)以降はcarry-forwardで同値
    expect(today?.bmr).toBeCloseTo(1579.6);
    const beforeMeasure = body.days.find((r) => r.d === localYmdDaysAgo(5));
    expect(beforeMeasure?.bmr).toBeNull();
  });

  it('期間バリデーションは既存規約（days+from併用は400）', async () => {
    expect((await request(`/api/exercise/logs?days=7&from=${localYmdDaysAgo(3)}`)).status).toBe(400);
  });
});

describe('/api/ 書き込み（運動・OAuth必須）', () => {
  let token: string;
  beforeEach(async () => {
    await resetTables();
    token = await obtainAccessToken(rootEnv);
    await seedWeight(70);
  });

  it('トークン無しは401', async () => {
    expect((await rw('/api/exercise/menus', null, 'POST', { name: 'x', category: 'strength' })).status).toBe(401);
  });

  it('有酸素種目の作成→記録（消費kcal算出）→削除', async () => {
    const created = await rw('/api/exercise/menus', token, 'POST', { name: 'バイク', category: 'cardio', mets: 6 });
    expect(created.status).toBe(201);
    const menu = (await created.json()) as { id: string };

    const logged = await rw('/api/exercise/logs', token, 'POST', { menu_id: menu.id, duration_min: 60 });
    expect(logged.status).toBe(201);
    const log = (await logged.json()) as { id: string; calories: number };
    expect(log.calories).toBeCloseTo(6 * 70 * 1 * 1.05); // 441

    expect((await rw(`/api/exercise/logs/${log.id}`, token, 'DELETE')).status).toBe(200);
    expect((await rw(`/api/exercise/logs/${log.id}`, token, 'DELETE')).status).toBe(404);
  });

  it('筋トレ種目の作成→セット記録→総ボリューム', async () => {
    const created = await rw('/api/exercise/menus', token, 'POST', {
      name: 'スクワット', category: 'strength', muscle_group: '脚',
    });
    const menu = (await created.json()) as { id: string };
    const logged = await rw('/api/exercise/logs', token, 'POST', {
      menu_id: menu.id, sets: [{ reps: 5, weight_kg: 100 }, { reps: 5, weight_kg: 100 }],
    });
    expect(logged.status).toBe(201);
    const log = (await logged.json()) as { total_volume: number; sets: unknown[] };
    expect(log.total_volume).toBe(1000);
    expect(log.sets).toHaveLength(2);
  });

  it('バリデーション: cardioでmets無し・categoryなしは400、cardioにduration無しは400', async () => {
    expect((await rw('/api/exercise/menus', token, 'POST', { name: 'x', category: 'cardio' })).status).toBe(400);
    expect((await rw('/api/exercise/menus', token, 'POST', { name: 'x' })).status).toBe(400);
    const cardio = await rw('/api/exercise/menus', token, 'POST', { name: 'run', category: 'cardio', mets: 8 });
    const menu = (await cardio.json()) as { id: string };
    expect((await rw('/api/exercise/logs', token, 'POST', { menu_id: menu.id })).status).toBe(400); // duration無し
  });
});

describe('MCP 運動ツール（/mcp）', () => {
  const RW_MCP = 'http://localhost/mcp';
  let token: string;
  beforeEach(async () => {
    await resetTables();
    token = await obtainAccessToken(rootEnv);
    await seedWeight(70);
  });

  function rpc(method: string, params?: unknown): Promise<Response> {
    return worker.fetch(
      new Request(RW_MCP, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} }),
      }),
      rootEnv,
      createExecutionContext(),
    );
  }

  function toolJson<T>(result: Record<string, unknown>): T {
    const content = result.content as { type: string; text: string }[];
    return JSON.parse(content[0].text) as T;
  }

  it('create_exercise_menu → log_exercise（menu_name解決）→ get_exercise_logs', async () => {
    const created = await rpc('tools/call', {
      name: 'create_exercise_menu', arguments: { name: 'ランニング', category: 'cardio', mets: 8 },
    });
    expect((await created.json() as { error?: unknown }).error).toBeUndefined();

    const logged = await rpc('tools/call', {
      name: 'log_exercise', arguments: { menu_name: 'ランニング', duration_min: 30 },
    });
    const logBody = (await logged.json()) as { result: Record<string, unknown> };
    const log = toolJson<{ calories: number }>(logBody.result);
    expect(log.calories).toBeCloseTo(294);

    const listed = await rpc('tools/call', { name: 'get_exercise_logs', arguments: { days: 7 } });
    const listBody = (await listed.json()) as { result: Record<string, unknown> };
    const logs = toolJson<{ logs: { calories: number }[] }>(listBody.result);
    expect(logs.logs).toHaveLength(1);
  });

  it('search_exercise_menus がcategoryで絞れる', async () => {
    await createExerciseMenu(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    await createExerciseMenu(testEnv, { name: 'ベンチ', category: 'strength' });
    const res = await rpc('tools/call', { name: 'search_exercise_menus', arguments: { category: 'strength' } });
    const body = (await res.json()) as { result: Record<string, unknown> };
    const found = toolJson<{ menus: { name: string }[] }>(body.result);
    expect(found.menus.map((m) => m.name)).toEqual(['ベンチ']);
  });
});
