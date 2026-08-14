import { createExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { DailyExercise, DailyIntake, DayPoint, Goal, WeightSummary } from '../src/types';
import { getGoal, parseSetGoalInput, setGoal } from '../src/goals';
import { computeMetabolism } from '../src/stats';
import {
  insertMeasurement,
  localYmdDaysAgo,
  mcpRpc,
  obtainAccessToken,
  parseToolJson,
  resetTables,
  rootTestEnv,
  testEnv,
} from './helpers';
import { createMenu, logMeal } from '../src/meals';
import { addDaysYmd } from '../src/util';

interface RpcResponse {
  result?: Record<string, unknown>;
}

function getJson(path: string): Promise<Response> {
  return worker.fetch(new Request(`http://localhost${path}`), rootTestEnv, createExecutionContext());
}

describe('目標の保存とバリデーション', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('parseSetGoalInput: 両方欠如・範囲外はエラー、null解除は許可', () => {
    expect(parseSetGoalInput({}).ok).toBe(false);
    expect(parseSetGoalInput({ weight_kg: 10 }).ok).toBe(false); // 20未満
    expect(parseSetGoalInput({ fat_mass_kg: 0 }).ok).toBe(false);
    expect(parseSetGoalInput({ weight_kg: 'abc' }).ok).toBe(false);
    expect(parseSetGoalInput({ weight_kg: null }).ok).toBe(true);
    expect(parseSetGoalInput({ weight_kg: 80, fat_mass_kg: 15 }).ok).toBe(true);
  });

  it('setGoal: 設定・部分更新・null解除がsettingsに反映される', async () => {
    await setGoal(testEnv, { weight_kg: 80, fat_mass_kg: 15 });
    expect(await getGoal(testEnv)).toEqual({ weight_kg: 80, fat_mass_kg: 15 });
    // 片方だけ更新（もう片方は維持）
    await setGoal(testEnv, { weight_kg: 79.5 });
    expect(await getGoal(testEnv)).toEqual({ weight_kg: 79.5, fat_mass_kg: 15 });
    // null で解除
    await setGoal(testEnv, { fat_mass_kg: null });
    expect(await getGoal(testEnv)).toEqual({ weight_kg: 79.5, fat_mass_kg: null });
  });

  it('/api/summary に goal が含まれる', async () => {
    await setGoal(testEnv, { weight_kg: 80 });
    const res = await getJson('/api/summary');
    expect(res.status).toBe(200);
    const summary = (await res.json()) as WeightSummary;
    expect(summary.goal).toEqual({ weight_kg: 80, fat_mass_kg: null });
  });
});

describe('MCP set_goal ツール', () => {
  let token: string;

  beforeAll(async () => {
    await resetTables();
    token = await obtainAccessToken(rootTestEnv);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('設定→get_weight_summaryへの反映→解除', async () => {
    const set = await mcpRpc(rootTestEnv, token, 'tools/call', {
      name: 'set_goal',
      arguments: { weight_kg: 80, fat_mass_kg: 16 },
    });
    const goal = parseToolJson<Goal>(((await set.json()) as RpcResponse).result!);
    expect(goal).toEqual({ weight_kg: 80, fat_mass_kg: 16 });

    const sum = await mcpRpc(rootTestEnv, token, 'tools/call', {
      name: 'get_weight_summary',
      arguments: {},
    });
    const summary = parseToolJson<WeightSummary>(((await sum.json()) as RpcResponse).result!);
    expect(summary.goal).toEqual({ weight_kg: 80, fat_mass_kg: 16 });

    const clear = await mcpRpc(rootTestEnv, token, 'tools/call', {
      name: 'set_goal',
      arguments: { weight_kg: null, fat_mass_kg: null },
    });
    const cleared = parseToolJson<Goal>(((await clear.json()) as RpcResponse).result!);
    expect(cleared).toEqual({ weight_kg: null, fat_mass_kg: null });
  });

  it('引数なしはエラー', async () => {
    const res = await mcpRpc(rootTestEnv, token, 'tools/call', { name: 'set_goal', arguments: {} });
    const result = ((await res.json()) as RpcResponse).result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

/** 窓28日・線形減量・毎日2000kcal摂取・FFM60kg固定の合成データ */
function syntheticInputs(): {
  series: DayPoint[];
  intake: DailyIntake[];
  exercise: DailyExercise[];
  from: string;
} {
  const to = localYmdDaysAgo(0);
  const from = addDaysYmd(to, -27);
  const series: DayPoint[] = [];
  const intake: DailyIntake[] = [];
  const exercise: DailyExercise[] = [];
  for (let i = 27; i >= 0; i--) {
    const d = addDaysYmd(to, -i);
    const weight = 85 - (27 - i) * 0.05; // 1日-0.05kgの線形減量
    series.push({
      d,
      weight,
      fat_mass: null,
      fat_free_mass: 60,
      weight_7d_avg: weight, // テストでは平滑済みとして同値を渡す
      fat_mass_7d_avg: null,
      fat_free_mass_7d_avg: 60,
    });
    intake.push({ d, count: 2, calories: 2000, protein_g: null, fat_g: null, carbs_g: null });
    exercise.push({
      d,
      bmr: 370 + 21.6 * 60, // 1666
      calories_burned: null,
      strength_volume: null,
      cardio_count: 0,
      strength_count: 0,
    });
  }
  return { series, intake, exercise, from };
}

describe('computeMetabolism（純関数）', () => {
  it('正常系: 推定TDEE = 平均摂取 − 変化ペース×7700', () => {
    const { series, intake, exercise, from } = syntheticInputs();
    const m = computeMetabolism(series, intake, exercise, from);
    expect(m.status).toBe('ok');
    if (m.status !== 'ok') return;
    expect(m.span_days).toBe(27);
    expect(m.intake_days).toBe(28);
    expect(m.avg_intake_kcal).toBe(2000);
    expect(m.weight_change_kg).toBe(-1.35); // -0.05 × 27
    // 2000 − (−1.35/27)×7700 = 2000 + 385 = 2385
    expect(m.estimated_tdee_kcal).toBe(2385);
    expect(m.model_tdee_kcal).toBe(1666);
    expect(m.correction_kcal_per_day).toBe(2385 - 1666);
  });

  it('摂取記録が8割未満なら intake_coverage で不成立', () => {
    const { series, intake, exercise, from } = syntheticInputs();
    const m = computeMetabolism(series, intake.slice(0, 22), exercise, from); // 22日 < 23日
    expect(m).toMatchObject({ status: 'insufficient_data', reason: 'intake_coverage' });
  });

  it('体重7日平均が両端で取れなければ no_weight_avg', () => {
    const { series, intake, exercise, from } = syntheticInputs();
    const noAvg = series.map((d) => ({ ...d, weight_7d_avg: null }));
    const m = computeMetabolism(noAvg, intake, exercise, from);
    expect(m).toMatchObject({ status: 'insufficient_data', reason: 'no_weight_avg' });
  });

  it('実日数が14日未満なら short_span', () => {
    const { series, intake, exercise, from } = syntheticInputs();
    // 直近10日だけ7日平均がある状態
    const shortSpan = series.map((d, idx) => (idx < series.length - 10 ? { ...d, weight_7d_avg: null } : d));
    const m = computeMetabolism(shortSpan, intake, exercise, from);
    expect(m).toMatchObject({ status: 'insufficient_data', reason: 'short_span' });
  });
});

describe('GET /api/metabolism（配線）', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('データなしは insufficient_data を返す', async () => {
    const res = await getJson('/api/metabolism');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    const m = (await res.json()) as { status: string; reason?: string };
    expect(m.status).toBe('insufficient_data');
    expect(m.reason).toBe('intake_coverage');
  });

  it('計測と食事を28日分seedすると ok になる', async () => {
    const menu = await createMenu(testEnv, { name: '定食', calories: 2000 });
    for (let i = 27; i >= 0; i--) {
      const d = localYmdDaysAgo(i);
      await insertMeasurement({
        grpid: 20000 + i,
        measured_at: `${d}T03:00:00Z`, // JST正午（日付境界フレーク回避の規約）
        weight: 85 - (27 - i) * 0.05,
        fat_free_mass: 60,
      });
      await logMeal(testEnv, { menu_id: menu.id, eaten_at: `${d}T03:00:00Z` });
    }
    const res = await getJson('/api/metabolism');
    const m = (await res.json()) as { status: string; avg_intake_kcal?: number; estimated_tdee_kcal?: number };
    expect(m.status).toBe('ok');
    expect(m.avg_intake_kcal).toBe(2000);
    // 7日平均経由なので純関数テストほど厳密には縛らず、妥当なレンジのみ確認
    expect(m.estimated_tdee_kcal).toBeGreaterThan(2000);
    expect(m.estimated_tdee_kcal).toBeLessThan(3000);
  });
});
