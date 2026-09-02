/**
 * 筋トレ種目の自己ベスト集計（src/exercise-records.ts）のテスト。
 * 定義は docs/superpowers/specs/2026-08-26-exercise-records-design.md の「集計の定義」節。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExerciseMenu, ExerciseRecords } from '../src/types';
import { logExercise } from '../src/exercise';
import {
  computeRecords, diffRecords, effectiveWeight, getExerciseRecords, type RecordSetRow,
} from '../src/exercise-records';
import { createExerciseMenuOk, insertMeasurement, resetTables, testEnv } from './helpers';

const bench: ExerciseMenu = {
  id: 'm-bench', name: 'ベンチプレス', category: 'strength', mets: null, muscle_group: '胸',
  is_bodyweight: false, bodyweight_factor: 1, circuit: null, note: null, archived: false,
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
};
const pullup: ExerciseMenu = { ...bench, id: 'm-pullup', name: '懸垂', muscle_group: '背中', is_bodyweight: true };

/** セット行を作る。log の順序は performed_at 昇順で渡すこと（DB の ORDER BY と同じ前提） */
function row(
  log: string, performed: string, setIndex: number, reps: number, weight: number | null,
  bw: { factor?: number; body?: number | null } | null = null,
): RecordSetRow {
  return {
    log_id: log, performed_at: performed, set_index: setIndex, reps, weight_kg: weight,
    is_bodyweight: bw ? 1 : 0, bodyweight_factor: bw?.factor ?? 1, body_weight_kg: bw ? bw.body ?? null : null,
  };
}

describe('effectiveWeight', () => {
  it('自重種目は追加重量+体重×係数、それ以外は追加重量（nullは0）', () => {
    expect(effectiveWeight(false, 80, 1, 60)).toBe(60);
    expect(effectiveWeight(false, 80, 1, null)).toBe(0);
    expect(effectiveWeight(true, 80, 1, null)).toBe(80);
    expect(effectiveWeight(true, 80, 0.5, 10)).toBe(50);
    expect(effectiveWeight(true, null, 1, 5)).toBe(5);
  });
});

describe('computeRecords', () => {
  it('記録が無ければ全項目 null / 空', () => {
    const r = computeRecords(bench, []);
    expect(r.sessions).toBe(0);
    expect(r.first_performed_at).toBeNull();
    expect(r.max_weight).toBeNull();
    expect(r.rep_maxes).toEqual([]);
    expect(r.estimated_1rm).toBeNull();
    expect(r.max_reps).toBeNull();
    expect(r.max_set_volume).toBeNull();
    expect(r.max_session_volume).toBeNull();
    expect(r.last_session).toBeNull();
    expect(r.menu).toEqual({
      id: 'm-bench', name: 'ベンチプレス', category: 'strength', muscle_group: '胸', is_bodyweight: false, bodyweight_factor: 1,
    });
  });

  it('最大重量・レップマックス表・推定1RM・最大REP・セット/セッションボリューム・前回セッションを集計する', () => {
    const rows = [
      row('L1', '2026-08-01T03:00:00Z', 1, 8, 80), // vol 640
      row('L1', '2026-08-01T03:00:00Z', 2, 8, 80),
      row('L1', '2026-08-01T03:00:00Z', 3, 6, 80), // L1 total 1760
      row('L2', '2026-08-05T03:00:00Z', 1, 5, 90), // vol 450, 1RM 105
      row('L2', '2026-08-05T03:00:00Z', 2, 3, 100), // vol 300, 1RM 110 → 最大
      row('L2', '2026-08-05T03:00:00Z', 3, 12, 60), // vol 720 → 最大セット
    ];
    const r = computeRecords(bench, rows);
    expect(r.sessions).toBe(2);
    expect(r.first_performed_at).toBe('2026-08-01T03:00:00Z');
    expect(r.last_performed_at).toBe('2026-08-05T03:00:00Z');
    expect(r.max_weight).toEqual({ weight_kg: 100, reps: 3, performed_at: '2026-08-05T03:00:00Z', log_id: 'L2' });
    expect(r.rep_maxes).toEqual([
      { reps: 3, weight_kg: 100, performed_at: '2026-08-05T03:00:00Z', log_id: 'L2' },
      { reps: 5, weight_kg: 90, performed_at: '2026-08-05T03:00:00Z', log_id: 'L2' },
      { reps: 6, weight_kg: 80, performed_at: '2026-08-01T03:00:00Z', log_id: 'L1' },
      { reps: 8, weight_kg: 80, performed_at: '2026-08-01T03:00:00Z', log_id: 'L1' },
      { reps: 12, weight_kg: 60, performed_at: '2026-08-05T03:00:00Z', log_id: 'L2' },
    ]);
    expect(r.estimated_1rm).toEqual({ value_kg: 110, weight_kg: 100, reps: 3, performed_at: '2026-08-05T03:00:00Z', log_id: 'L2' });
    expect(r.max_reps).toEqual({ reps: 12, weight_kg: 60, performed_at: '2026-08-05T03:00:00Z', log_id: 'L2' });
    expect(r.max_set_volume).toEqual({ volume: 720, reps: 12, effective_weight_kg: 60, performed_at: '2026-08-05T03:00:00Z', log_id: 'L2' });
    expect(r.max_session_volume).toEqual({ volume: 1760, sets: 3, performed_at: '2026-08-01T03:00:00Z', log_id: 'L1' });
    expect(r.last_session).toEqual({
      performed_at: '2026-08-05T03:00:00Z', log_id: 'L2', total_volume: 1470,
      sets: [
        { set_index: 1, reps: 5, weight_kg: 90, effective_weight_kg: 90, volume: 450 },
        { set_index: 2, reps: 3, weight_kg: 100, effective_weight_kg: 100, volume: 300 },
        { set_index: 3, reps: 12, weight_kg: 60, effective_weight_kg: 60, volume: 720 },
      ],
    });
  });

  it('同値は最初に達成した日が残る（先勝ち）', () => {
    const rows = [
      row('L1', '2026-08-01T03:00:00Z', 1, 5, 100),
      row('L2', '2026-08-08T03:00:00Z', 1, 5, 100),
    ];
    const r = computeRecords(bench, rows);
    expect(r.max_weight?.log_id).toBe('L1');
    expect(r.rep_maxes[0].log_id).toBe('L1');
    expect(r.estimated_1rm?.log_id).toBe('L1');
    expect(r.max_set_volume?.log_id).toBe('L1');
    expect(r.max_session_volume?.log_id).toBe('L1');
    expect(r.last_session?.log_id).toBe('L2');
  });

  it('推定1RMは reps<=12 のセットだけから計算し、小数1桁に丸める', () => {
    const rows = [
      row('L1', '2026-08-01T03:00:00Z', 1, 20, 60), // 60×(1+20/30)=100 だが対象外
      row('L1', '2026-08-01T03:00:00Z', 2, 10, 70), // 70×(1+10/30)=93.33 → 93.3
    ];
    expect(computeRecords(bench, rows).estimated_1rm).toMatchObject({ value_kg: 93.3, weight_kg: 70, reps: 10 });
  });

  it('自重種目: 純自重セットは最大重量/レップマックス/1RMの対象外、ボリュームは実効重量で計算し、1RMは常にnull', () => {
    const rows = [
      row('L1', '2026-08-01T03:00:00Z', 1, 10, null, { body: 80 }), // 実効80, vol 800
      row('L1', '2026-08-01T03:00:00Z', 2, 5, 10, { body: 80 }), // 実効90, vol 450
    ];
    const r = computeRecords(pullup, rows);
    expect(r.max_weight).toMatchObject({ weight_kg: 10, reps: 5 });
    expect(r.rep_maxes).toEqual([{ reps: 5, weight_kg: 10, performed_at: '2026-08-01T03:00:00Z', log_id: 'L1' }]);
    expect(r.estimated_1rm).toBeNull();
    expect(r.max_reps).toMatchObject({ reps: 10, weight_kg: null });
    expect(r.max_set_volume).toMatchObject({ volume: 800, reps: 10, effective_weight_kg: 80 });
    expect(r.max_session_volume).toMatchObject({ volume: 1250, sets: 2 });
  });

  it('純自重のみの種目は max_weight が null', () => {
    const r = computeRecords(pullup, [row('L1', '2026-08-01T03:00:00Z', 1, 12, null, { body: 80 })]);
    expect(r.max_weight).toBeNull();
    expect(r.rep_maxes).toEqual([]);
    expect(r.max_reps).toMatchObject({ reps: 12 });
  });
});

describe('diffRecords', () => {
  const empty = computeRecords(bench, []);
  const first = computeRecords(bench, [row('L1', '2026-08-01T03:00:00Z', 1, 5, 80)]);

  it('初回記録は previous=null で全項目が更新扱い', () => {
    expect(diffRecords(empty, first)).toEqual([
      { kind: 'max_weight', previous: null, current: 80 },
      { kind: 'rep_max', reps: 5, previous: null, current: 80 },
      { kind: 'estimated_1rm', previous: null, current: 93.3 },
      { kind: 'max_reps', previous: null, current: 5 },
      { kind: 'max_set_volume', previous: null, current: 400 },
      { kind: 'max_session_volume', previous: null, current: 400 },
    ]);
  });

  it('上回った項目だけを返し、同値は更新扱いにしない', () => {
    const after = computeRecords(bench, [
      row('L1', '2026-08-01T03:00:00Z', 1, 5, 80),
      row('L2', '2026-08-03T03:00:00Z', 1, 5, 80), // 同値
      row('L2', '2026-08-03T03:00:00Z', 2, 8, 70), // 新しい reps の記録。セッション 400+560=960
    ]);
    expect(diffRecords(first, after)).toEqual([
      { kind: 'rep_max', reps: 8, previous: null, current: 70 },
      { kind: 'max_reps', previous: 5, current: 8 },
      { kind: 'max_set_volume', previous: 400, current: 560 },
      { kind: 'max_session_volume', previous: 400, current: 960 },
    ]);
  });

  it('何も上回らなければ空', () => {
    const after: ExerciseRecords = computeRecords(bench, [
      row('L1', '2026-08-01T03:00:00Z', 1, 5, 80),
      row('L2', '2026-08-03T03:00:00Z', 1, 3, 60),
    ]);
    expect(diffRecords(first, after)).toEqual([{ kind: 'rep_max', reps: 3, previous: null, current: 60 }]);
    expect(diffRecords(after, after)).toEqual([]);
  });
});

describe('getExerciseRecords（D1）', () => {
  beforeEach(async () => {
    await resetTables();
    // 自重種目の体重スナップショット用（過去日に固定）
    await insertMeasurement({ grpid: 9601, measured_at: '2026-07-01T03:00:00Z', weight: 80, fat_free_mass: 64 });
  });

  it('記録順に関係なく performed_at 順で集計し、他種目の記録は混ぜない', async () => {
    const squat = await createExerciseMenuOk(testEnv, { name: 'スクワット', category: 'strength' });
    const other = await createExerciseMenuOk(testEnv, { name: 'デッドリフト', category: 'strength' });
    // 新しい日を先に記録してから古い日を追記する（過去日付の追記でも先勝ちが崩れないこと）
    const l2 = await logExercise(testEnv, { menu_id: squat.id, performed_at: '2026-08-10T03:00:00Z', sets: [{ reps: 5, weight_kg: 100 }] });
    const l1 = await logExercise(testEnv, { menu_id: squat.id, performed_at: '2026-08-03T03:00:00Z', sets: [{ reps: 5, weight_kg: 100 }, { reps: 8, weight_kg: 80 }] });
    await logExercise(testEnv, { menu_id: other.id, performed_at: '2026-08-11T03:00:00Z', sets: [{ reps: 3, weight_kg: 140 }] });
    if ('error' in l1 || 'error' in l2) throw new Error('seed failed');

    const r = await getExerciseRecords(testEnv, squat);
    expect(r.sessions).toBe(2);
    expect(r.max_weight).toMatchObject({ weight_kg: 100, log_id: l1.id }); // 同値 → 古い日（先勝ち）
    expect(r.max_session_volume).toMatchObject({ volume: 1140, log_id: l1.id });
    expect(r.last_session).toMatchObject({ log_id: l2.id, total_volume: 500 });
    expect(r.rep_maxes.map((x) => x.reps)).toEqual([5, 8]);
  });

  it('記録が無い種目は sessions=0 で各項目 null', async () => {
    const menu = await createExerciseMenuOk(testEnv, { name: 'ローイング', category: 'strength' });
    const r = await getExerciseRecords(testEnv, menu);
    expect(r.sessions).toBe(0);
    expect(r.max_weight).toBeNull();
    expect(r.last_session).toBeNull();
  });
});

describe('レビュー所見の回帰: float 誤差 / performed_at の書式混在 / weight_kg=0', () => {
  it('体重 50.2kg の自重種目で同じ総ボリュームをセット分割違いで記録しても、同値扱い（先勝ち・更新なし）になる', () => {
    const bw = { body: 50.2 };
    const l1 = [
      row('L1', '2026-08-03T03:00:00Z', 1, 10, null, bw),
      row('L1', '2026-08-03T03:00:00Z', 2, 10, null, bw),
      row('L1', '2026-08-03T03:00:00Z', 3, 10, null, bw),
    ];
    const l2 = [
      row('L2', '2026-08-05T03:00:00Z', 1, 8, null, bw),
      row('L2', '2026-08-05T03:00:00Z', 2, 8, null, bw),
      row('L2', '2026-08-05T03:00:00Z', 3, 8, null, bw),
      row('L2', '2026-08-05T03:00:00Z', 4, 6, null, bw),
    ];
    const before = computeRecords(pullup, l1);
    const after = computeRecords(pullup, [...l1, ...l2]);
    expect(before.max_session_volume?.volume).toBe(1506);
    expect(after.max_session_volume).toMatchObject({ volume: 1506, log_id: 'L1' });
    expect(after.last_session?.total_volume).toBe(1506);
    expect(diffRecords(before, after).map((b) => b.kind)).not.toContain('max_session_volume');
  });

  it('weight_kg=0 のセットは max_weight / rep_maxes / estimated_1rm の対象外', () => {
    const r = computeRecords(bench, [row('L1', '2026-08-01T03:00:00Z', 1, 12, 0)]);
    expect(r.max_weight).toBeNull();
    expect(r.rep_maxes).toEqual([]);
    expect(r.estimated_1rm).toBeNull();
    expect(r.max_reps).toMatchObject({ reps: 12, weight_kg: 0 });
  });

  it('D1: performed_at に +09:00 と Z が混在しても時刻順で集計する（先勝ち・前回セッション）', async () => {
    await resetTables();
    const bench2 = await createExerciseMenuOk(testEnv, { name: 'ベンチプレス', category: 'strength' });
    // A = 21:00+09:00 = 12:00Z（先）、B = 13:00Z（後）。文字列順では B が先になってしまう
    const a = await logExercise(testEnv, { menu_id: bench2.id, performed_at: '2026-08-20T21:00:00+09:00', sets: [{ reps: 5, weight_kg: 100 }] });
    const b = await logExercise(testEnv, { menu_id: bench2.id, performed_at: '2026-08-20T13:00:00Z', sets: [{ reps: 5, weight_kg: 100 }] });
    if ('error' in a || 'error' in b) throw new Error('seed failed');
    const r = await getExerciseRecords(testEnv, bench2);
    expect(r.first_performed_at).toBe('2026-08-20T21:00:00+09:00');
    expect(r.last_performed_at).toBe('2026-08-20T13:00:00Z');
    expect(r.max_weight?.log_id).toBe(a.id); // 同値 → 先に達成した A
    expect(r.last_session?.log_id).toBe(b.id);
  });
});
