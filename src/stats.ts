/**
 * 実測代謝の推定（GET /api/metabolism）。
 * 直近28日窓で「平均摂取kcal − 体重変化ペース×7700」から実効TDEEを推定し、
 * モデル（BMR＋運動消費）との差分（補正値）を返す。
 * 7700kcal/kgは脂肪換算の近似で、体組成変化（筋肉増）が混ざるとブレるため参考値扱い。
 */
import type { Context } from 'hono';
import type { DailyExercise, DailyIntake, DayPoint, Env } from './types';
import { addDaysYmd, inclusiveDays, localToday, noindexHeaders } from './util';
import { getDailySeries } from './queries';
import { getDailyIntake } from './meals';
import { getDailyExercise } from './exercise';

export const METABOLISM_WINDOW_DAYS = 28;
const KCAL_PER_KG = 7700;
/** 摂取記録のある日がこの割合未満なら推定しない（記録漏れがあると平均摂取が過小になり推定が壊れる） */
const MIN_INTAKE_COVERAGE = 0.8;
/** 体重7日平均の両端の実日数がこれ未満なら推定しない（短すぎると日々の変動に埋もれる） */
const MIN_SPAN_DAYS = 14;

export type Metabolism =
  | {
      status: 'ok';
      window_days: number;
      span_days: number;
      intake_days: number;
      avg_intake_kcal: number;
      weight_change_kg: number;
      estimated_tdee_kcal: number;
      model_tdee_kcal: number | null;
      correction_kcal_per_day: number | null;
    }
  | {
      status: 'insufficient_data';
      window_days: number;
      reason: 'intake_coverage' | 'no_weight_avg' | 'short_span';
      intake_days: number;
    };

/**
 * 純関数部分。seriesは窓開始の6日前から（7日平均のリードイン用）、intake/exerciseは窓内のみを渡す。
 * @param from 窓の開始日（ローカルYMD）
 */
export function computeMetabolism(
  series: DayPoint[],
  intake: DailyIntake[],
  exercise: DailyExercise[],
  from: string,
): Metabolism {
  const windowDays = METABOLISM_WINDOW_DAYS;
  const intakeDays = intake.filter((d) => d.count > 0);
  if (intakeDays.length < Math.ceil(windowDays * MIN_INTAKE_COVERAGE)) {
    return {
      status: 'insufficient_data',
      window_days: windowDays,
      reason: 'intake_coverage',
      intake_days: intakeDays.length,
    };
  }
  const withAvg = series.filter((d) => d.d >= from && d.weight_7d_avg != null);
  const first = withAvg[0];
  const last = withAvg[withAvg.length - 1];
  if (!first || !last || first.d === last.d) {
    return {
      status: 'insufficient_data',
      window_days: windowDays,
      reason: 'no_weight_avg',
      intake_days: intakeDays.length,
    };
  }
  const spanDays = inclusiveDays(first.d, last.d) - 1;
  if (spanDays < MIN_SPAN_DAYS) {
    return {
      status: 'insufficient_data',
      window_days: windowDays,
      reason: 'short_span',
      intake_days: intakeDays.length,
    };
  }
  const weightChange = (last.weight_7d_avg as number) - (first.weight_7d_avg as number);
  const avgIntake = intakeDays.reduce((s, d) => s + d.calories, 0) / intakeDays.length;
  const estimated = avgIntake - (weightChange / spanDays) * KCAL_PER_KG;
  const modelDays = exercise.filter((d) => d.bmr != null);
  const modelTdee =
    modelDays.length > 0
      ? modelDays.reduce((s, d) => s + (d.bmr as number) + (d.calories_burned ?? 0), 0) /
        modelDays.length
      : null;
  return {
    status: 'ok',
    window_days: windowDays,
    span_days: spanDays,
    intake_days: intakeDays.length,
    avg_intake_kcal: Math.round(avgIntake),
    weight_change_kg: Math.round(weightChange * 100) / 100,
    estimated_tdee_kcal: Math.round(estimated),
    model_tdee_kcal: modelTdee == null ? null : Math.round(modelTdee),
    correction_kcal_per_day: modelTdee == null ? null : Math.round(estimated - modelTdee),
  };
}

export async function getMetabolism(env: Env): Promise<Metabolism> {
  const to = localToday(env);
  const from = addDaysYmd(to, -(METABOLISM_WINDOW_DAYS - 1));
  const [series, intake, exercise] = await Promise.all([
    // 7日平均を窓の先頭でも成立させるため6日前からリードインして取得する
    getDailySeries(env, addDaysYmd(from, -6), to),
    getDailyIntake(env, from, to),
    getDailyExercise(env, from, to),
  ]);
  return computeMetabolism(series, intake, exercise, from);
}

/** GET /api/metabolism — 公開読み取り */
export const serveMetabolism = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  const headers = noindexHeaders({ 'Cache-Control': 'no-store' });
  try {
    return c.json(await getMetabolism(c.env), 200, headers);
  } catch (err) {
    console.error('[stats] getMetabolism failed', err);
    return c.json({ error: 'internal error' }, 500, headers);
  }
};
