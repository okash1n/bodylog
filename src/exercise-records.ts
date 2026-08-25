/**
 * 筋トレ種目の自己ベスト（都度集計）。DB には保持せず、1種目の全セットを1クエリで取り
 * 純関数 computeRecords で集計する。定義は docs/superpowers/specs/2026-08-26-exercise-records-design.md。
 * exercise.ts から参照されるため、このファイルは exercise.ts を import しない（循環回避）。
 */
import type { Env, ExerciseMenu, ExerciseRecords, ExerciseSet, RecordBroken, RecordKind } from './types';

/** Epley 式で推定 1RM を出す reps の上限（高 rep では式が信頼できない） */
const EPLEY_MAX_REPS = 12;

/** 実効重量 = 追加重量 + （自重種目なら 体重 × 係数）。null は 0 として扱う */
export function effectiveWeight(
  isBodyweight: boolean,
  bodyWeightKg: number | null,
  factor: number,
  weightKg: number | null,
): number {
  return (weightKg ?? 0) + (isBodyweight ? (bodyWeightKg ?? 0) * factor : 0);
}

/** exercise_logs ⋈ exercise_sets の1行（log 側はスナップショット列） */
export interface RecordSetRow {
  log_id: string;
  performed_at: string;
  set_index: number;
  reps: number;
  weight_kg: number | null;
  is_bodyweight: number;
  bodyweight_factor: number;
  body_weight_kg: number | null;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * ボリューム（reps×実効重量、およびその合計）の丸め。体重スナップショットが 50.2 のような
 * 二進で表せない値だと、同じ総ボリュームでもセット分割によって float の合計が 1ulp ずれ、
 * 「同値は更新扱いにしない」「先勝ち」の比較が崩れるため、集計境界で 0.001 kg·rep に丸める
 */
export function roundVolume(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * 1種目の全セットから自己ベストを集計する。rows は performed_at, log_id, set_index 昇順を前提とし、
 * 比較は厳密な > なので同値は最初に達成した行が残る（先勝ち）。
 */
export function computeRecords(menu: ExerciseMenu, rows: RecordSetRow[]): ExerciseRecords {
  let maxWeight: ExerciseRecords['max_weight'] = null;
  const repMaxes = new Map<number, ExerciseRecords['rep_maxes'][number]>();
  let estimated1rm: ExerciseRecords['estimated_1rm'] = null;
  let maxReps: ExerciseRecords['max_reps'] = null;
  let maxSetVolume: ExerciseRecords['max_set_volume'] = null;
  // 挿入順 = performed_at 昇順（Map は挿入順を保つ）
  const sessions = new Map<string, { performed_at: string; volume: number; sets: ExerciseSet[] }>();

  for (const r of rows) {
    const eff = effectiveWeight(r.is_bodyweight !== 0, r.body_weight_kg, r.bodyweight_factor, r.weight_kg);
    const volume = roundVolume(r.reps * eff);
    const ref = { performed_at: r.performed_at, log_id: r.log_id };

    if (r.weight_kg != null && r.weight_kg > 0) {
      if (!maxWeight || r.weight_kg > maxWeight.weight_kg) maxWeight = { ...ref, weight_kg: r.weight_kg, reps: r.reps };
      const rm = repMaxes.get(r.reps);
      if (!rm || r.weight_kg > rm.weight_kg) repMaxes.set(r.reps, { ...ref, reps: r.reps, weight_kg: r.weight_kg });
      if (!menu.is_bodyweight && r.reps <= EPLEY_MAX_REPS) {
        const value = round1(r.weight_kg * (1 + r.reps / 30));
        if (!estimated1rm || value > estimated1rm.value_kg) {
          estimated1rm = { ...ref, value_kg: value, weight_kg: r.weight_kg, reps: r.reps };
        }
      }
    }
    if (!maxReps || r.reps > maxReps.reps) maxReps = { ...ref, reps: r.reps, weight_kg: r.weight_kg };
    if (!maxSetVolume || volume > maxSetVolume.volume) {
      maxSetVolume = { ...ref, volume, reps: r.reps, effective_weight_kg: eff };
    }

    let session = sessions.get(r.log_id);
    if (!session) {
      session = { performed_at: r.performed_at, volume: 0, sets: [] };
      sessions.set(r.log_id, session);
    }
    session.volume += volume;
    session.sets.push({ set_index: r.set_index, reps: r.reps, weight_kg: r.weight_kg, effective_weight_kg: eff, volume });
  }

  let maxSession: ExerciseRecords['max_session_volume'] = null;
  for (const [logId, s] of sessions) {
    s.volume = roundVolume(s.volume); // 合計の float 誤差を落としてから比較する
    if (!maxSession || s.volume > maxSession.volume) {
      maxSession = { performed_at: s.performed_at, log_id: logId, volume: s.volume, sets: s.sets.length };
    }
  }
  const entries = [...sessions.entries()];
  const first = entries[0];
  const last = entries[entries.length - 1];

  return {
    menu: {
      id: menu.id,
      name: menu.name,
      category: menu.category,
      muscle_group: menu.muscle_group,
      is_bodyweight: menu.is_bodyweight,
      bodyweight_factor: menu.bodyweight_factor,
    },
    sessions: entries.length,
    first_performed_at: first?.[1].performed_at ?? null,
    last_performed_at: last?.[1].performed_at ?? null,
    max_weight: maxWeight,
    rep_maxes: [...repMaxes.values()].sort((a, b) => a.reps - b.reps),
    estimated_1rm: estimated1rm,
    max_reps: maxReps,
    max_set_volume: maxSetVolume,
    max_session_volume: maxSession,
    last_session: last
      ? { performed_at: last[1].performed_at, log_id: last[0], total_volume: last[1].volume, sets: last[1].sets }
      : null,
  };
}

/** 挿入前後の記録を比べ、上回った項目を返す（同値は更新扱いにしない。初回は previous=null） */
export function diffRecords(before: ExerciseRecords, after: ExerciseRecords): RecordBroken[] {
  const out: RecordBroken[] = [];
  const push = (kind: RecordKind, prev: number | null | undefined, cur: number | null | undefined, reps?: number): void => {
    if (cur == null) return;
    if (prev != null && cur <= prev) return;
    out.push({ kind, ...(reps === undefined ? {} : { reps }), previous: prev ?? null, current: cur });
  };
  push('max_weight', before.max_weight?.weight_kg, after.max_weight?.weight_kg);
  for (const rm of after.rep_maxes) {
    push('rep_max', before.rep_maxes.find((b) => b.reps === rm.reps)?.weight_kg, rm.weight_kg, rm.reps);
  }
  push('estimated_1rm', before.estimated_1rm?.value_kg, after.estimated_1rm?.value_kg);
  push('max_reps', before.max_reps?.reps, after.max_reps?.reps);
  push('max_set_volume', before.max_set_volume?.volume, after.max_set_volume?.volume);
  push('max_session_volume', before.max_session_volume?.volume, after.max_session_volume?.volume);
  return out;
}

/**
 * 1種目の全セットを実施時刻順（同時刻は log_id, set_index）で取る。絞り込みは idx_exercise_logs_menu_performed。
 * performed_at は入力の ISO8601 文字列をそのまま保存しているため（'Z' と '+09:00' が混在しうる）、
 * 文字列順ではなく julianday() で時刻順にする。個人1人分（年数百行）なので上限は設けない。
 */
export async function fetchRecordRows(env: Env, menuId: string): Promise<RecordSetRow[]> {
  const res = await env.DB.prepare(
    `SELECT s.log_id, l.performed_at, s.set_index, s.reps, s.weight_kg,
        l.is_bodyweight, l.bodyweight_factor, l.body_weight_kg
FROM exercise_sets s JOIN exercise_logs l ON l.id = s.log_id
WHERE l.menu_id = ?1 AND l.category = 'strength'
ORDER BY julianday(l.performed_at), l.id, s.set_index`,
  )
    .bind(menuId)
    .all<RecordSetRow>();
  return res.results;
}

/** 筋トレ種目の自己ベストを都度集計する。menu は呼び出し側が取得した strength の種目 */
export async function getExerciseRecords(env: Env, menu: ExerciseMenu): Promise<ExerciseRecords> {
  return computeRecords(menu, await fetchRecordRows(env, menu.id));
}
