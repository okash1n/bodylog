/**
 * coaching/derive.mjs（講評生成の入力データを整形する純粋関数）のテスト。
 * - deriveTerms: Worker 側 getTermStats と同じ定義（recent7 = D-6〜D、prev7 = D-13〜D-7 の日平均の平均）を固定する
 * - deriveTrend / trendLabel: 21日回帰の傾きとノイズを踏まえたラベル（境界値を含む）
 * - deriveIntakeAvg: 直近7日の平均摂取（当日除外オプション）
 * - deriveExerciseContext: 連続トレ日数（回復提案の客観条件）
 * - summarizeSessions: 運動ログの圧縮（サーキットは親1行。入力順に依存しない）
 * - selectPreviousNotes: 前日までの講評の選択（窓の下限）
 * フィクスチャの日付・数値・文言はすべて合成（実測データではない）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HARD_BURN_KCAL,
  deriveExerciseContext,
  deriveIntakeAvg,
  deriveTerms,
  deriveTrend,
  roundTo,
  selectPreviousNotes,
  summarizeSessions,
  trendLabel,
} from '../coaching/derive.mjs';

function day(d: string, weight: number | null, fat_mass: number | null = null, fat_free_mass: number | null = null) {
  return { d, weight, fat_mass, fat_free_mass };
}

const NULL_TRIPLE = { weight: null, fat_mass: null, fat_free_mass: null };
const ZERO_TRIPLE = { weight: 0, fat_mass: 0, fat_free_mass: 0 };

describe('roundTo', () => {
  it('指定桁に丸め、null は維持する', () => {
    expect(roundTo(1.2345, 1)).toBe(1.2);
    expect(roundTo(1.2345, 2)).toBe(1.23);
    expect(roundTo(null, 1)).toBeNull();
  });
});

describe('deriveTerms', () => {
  it('D-6〜D を recent7、D-13〜D-7 を prev7 として日平均の平均と差を返す', () => {
    const days = [
      day('2026-08-11', 90), // D-13（prev の先頭）
      day('2026-08-17', 88), // D-7（prev の末尾）
      day('2026-08-18', 85), // D-6（recent の先頭）
      day('2026-08-24', 83), // D
    ];
    const t = deriveTerms(days, '2026-08-24');
    expect(t.recent7_avg.weight).toBe(84);
    expect(t.diff_vs_prev7.weight).toBe(84 - 89);
    expect(t.recent7_n.weight).toBe(2);
    expect(t.prev7_n.weight).toBe(2);
  });

  it('対象日より後の日と D-14 以前の日は集計に含めない', () => {
    const days = [
      day('2026-08-10', 100), // D-14: 範囲外
      day('2026-08-20', 84),
      day('2026-08-25', 70), // D+1: 範囲外
    ];
    const t = deriveTerms(days, '2026-08-24');
    expect(t.recent7_avg.weight).toBe(84);
    expect(t.diff_vs_prev7.weight).toBeNull(); // prev7 に該当日が無い
    expect(t.prev7_n.weight).toBe(0);
  });

  it('対象日自体に計測が無くても窓内の他の日から算出する', () => {
    const t = deriveTerms([day('2026-08-22', 82), day('2026-08-23', 84)], '2026-08-24');
    expect(t.recent7_avg.weight).toBe(83);
  });

  it('指標ごとに null を無視し、値が1つも無い指標は null になる（実測日数も指標ごと）', () => {
    const days = [day('2026-08-23', 84, 20, null), day('2026-08-24', 82, null, 62)];
    const t = deriveTerms(days, '2026-08-24');
    expect(t.recent7_avg).toEqual({ weight: 83, fat_mass: 20, fat_free_mass: 62 });
    expect(t.diff_vs_prev7).toEqual(NULL_TRIPLE);
    expect(t.recent7_n).toEqual({ weight: 2, fat_mass: 1, fat_free_mass: 1 });
  });

  it('入力が空なら全て null（実測日数は 0）', () => {
    expect(deriveTerms([], '2026-08-24')).toEqual({
      recent7_avg: NULL_TRIPLE,
      diff_vs_prev7: NULL_TRIPLE,
      recent7_n: ZERO_TRIPLE,
      prev7_n: ZERO_TRIPLE,
    });
  });
});

describe('trendLabel', () => {
  it('減少・増加がノイズで説明できなければ declining / rising、±0.4kg/週を否定できれば flat、それ以外は uncertain', () => {
    expect(trendLabel(-0.5, 0.1)).toBe('declining');
    expect(trendLabel(0.5, 0.1)).toBe('rising');
    expect(trendLabel(-0.3, 0.2)).toBe('uncertain'); // −0.3 + 0.4 > 0
    expect(trendLabel(0.3, 0.2)).toBe('uncertain'); // 0.3 − 0.4 < 0
    expect(trendLabel(-0.05, 0.1)).toBe('flat'); // ±0.2 で ±0.4 の内側
    expect(trendLabel(-0.05, 0.3)).toBe('uncertain'); // −0.05 − 0.6 < −0.4
    expect(trendLabel(null, null)).toBe('uncertain');
  });

  it('境界値: −0.15 ちょうどは declining 側、傾き − 2SE が −0.4 ちょうどは flat にしない', () => {
    expect(trendLabel(-0.15, 0.05)).toBe('declining');
    expect(trendLabel(0.15, 0.05)).toBe('rising');
    expect(trendLabel(-0.1, 0.15)).toBe('uncertain'); // −0.1 − 0.3 = −0.4
    expect(trendLabel(-0.1, 0.14)).toBe('flat');
    expect(trendLabel(0.1, 0.15)).toBe('uncertain'); // 0.1 + 0.3 = 0.4
  });
});

describe('deriveTrend', () => {
  /** 21日分の日次値を作る（yAt: 窓先頭からの日数 → 値） */
  function series(date: string, yAt: (i: number) => number, skip: number[] = []) {
    const start = Date.parse(`${date}T00:00:00Z`) - 20 * 86_400_000;
    const rows = [];
    for (let i = 0; i < 21; i++) {
      if (skip.includes(i)) continue;
      const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      rows.push({ d, weight: null, fat_mass: yAt(i), fat_free_mass: 64 + (i % 2 === 0 ? 0.3 : -0.3) });
    }
    return rows;
  }

  it('一定の減少（−0.5kg/週）は declining、交互のノイズだけの系列は flat。D-21 の点は窓に入れない', () => {
    const rows = series('2026-09-14', (i) => 19 - (0.5 / 7) * i);
    rows.push({ d: '2026-08-24', weight: null, fat_mass: 100, fat_free_mass: 64 }); // D-21: 外れ値だが範囲外
    const t = deriveTrend(rows, '2026-09-14');
    expect(t.window_days).toBe(21);
    expect(t.fat.n).toBe(21);
    expect(t.fat.slope_kg_per_week).toBeCloseTo(-0.5, 1);
    expect(t.fat.label).toBe('declining');
    expect(t.ffm.label).toBe('flat');
    expect(t.ffm.slope_kg_per_week).toBeCloseTo(0, 1);
  });

  it('一定の増加（+0.5kg/週）は rising', () => {
    const t = deriveTrend(series('2026-09-14', (i) => 18 + (0.5 / 7) * i), '2026-09-14');
    expect(t.fat.label).toBe('rising');
    expect(t.fat.slope_kg_per_week).toBeCloseTo(0.5, 1);
  });

  it('点が minPoints 未満の指標は傾き null で uncertain、ちょうど minPoints なら計算し、対象日より後の点は使わない', () => {
    const seven = series('2026-09-14', (i) => 19 - (0.5 / 7) * i, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    seven.push({ d: '2026-09-15', weight: null, fat_mass: 10, fat_free_mass: 60 }); // D+1: 無視
    const t7 = deriveTrend(seven, '2026-09-14');
    expect(t7.fat).toEqual({ slope_kg_per_week: null, se_kg_per_week: null, n: 7, label: 'uncertain' });
    expect(t7.weight).toEqual({ slope_kg_per_week: null, se_kg_per_week: null, n: 0, label: 'uncertain' });
    const eight = series('2026-09-14', (i) => 19 - (0.5 / 7) * i, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const t8 = deriveTrend(eight, '2026-09-14');
    expect(t8.fat.n).toBe(8);
    expect(t8.fat.slope_kg_per_week).toBeCloseTo(-0.5, 1);
  });

  it('ノイズが大きい減少は uncertain になる（±2SE が 0 をまたぐ）', () => {
    // 週 −0.2kg の緩い減少に ±1kg の交互ノイズ
    const t = deriveTrend(series('2026-09-14', (i) => 19 - (0.2 / 7) * i + (i % 2 === 0 ? 1 : -1)), '2026-09-14');
    expect(t.fat.label).toBe('uncertain');
  });
});

describe('deriveIntakeAvg', () => {
  const days = [
    { d: '2026-01-07', count: 1, calories: 9000 }, // D-7: 範囲外（当日を含む窓）
    { d: '2026-01-08', count: 2, calories: 1800 }, // D-6
    { d: '2026-01-10', count: 3, calories: 1801 },
    { d: '2026-01-13', count: 0, calories: 0 }, // 記録なし（防御的: API の集計行では起きない）
    { d: '2026-01-14', count: 4, calories: 500 }, // D: 当日の部分記録
    { d: '2026-01-15', count: 1, calories: 9000 }, // D+1: 範囲外
  ];

  it('D-6 を含み D-7 を除き、記録のある日だけを平均して四捨五入する', () => {
    expect(deriveIntakeAvg(days, '2026-01-14')).toBe(Math.round((1800 + 1801 + 500) / 3));
  });

  it('excludeDate なら窓は D-7〜D-1 になり、当日の部分記録が平均を下げない', () => {
    expect(deriveIntakeAvg(days, '2026-01-14', { excludeDate: true })).toBe(Math.round((9000 + 1800 + 1801) / 3));
  });

  it('該当日が無ければ null', () => {
    expect(deriveIntakeAvg([], '2026-01-14')).toBeNull();
    expect(deriveIntakeAvg([{ d: '2026-01-14', count: 1, calories: 1000 }], '2026-01-14', { excludeDate: true })).toBeNull();
  });
});

describe('deriveExerciseContext', () => {
  // 値は合成。連続の切れ目と burn の境界（500）だけを見る
  const days = [
    { d: '2026-01-08', strength_count: 3, calories_burned: 450 },
    { d: '2026-01-09', strength_count: 0, calories_burned: null }, // 完全休養
    { d: '2026-01-10', strength_count: 2, calories_burned: 300 },
    { d: '2026-01-11', strength_count: 1, calories_burned: 900 },
    { d: '2026-01-12', strength_count: 0, calories_burned: 700 }, // 有酸素のみ（高負荷日には数える）
    { d: '2026-01-13', strength_count: 4, calories_burned: 400 },
    { d: '2026-01-14', strength_count: 5, calories_burned: 800 },
    { d: '2026-01-15', strength_count: 9, calories_burned: 999 }, // 対象日より後: 無視
  ];

  it('筋トレ日の連続数・高負荷日の連続数・前日起点の連続数・直近7日の筋トレ日数を返す', () => {
    const c = deriveExerciseContext(days, '2026-01-14');
    expect(c.strength_streak_days).toBe(2); // 01-13, 01-14（01-12 は有酸素のみ）
    expect(c.hard_streak_days).toBe(5); // 01-10〜01-14（01-12 は burn 700 ≥ 500）
    expect(c.strength_streak_days_before_today).toBe(1); // 01-13 のみ
    expect(c.hard_streak_days_before_today).toBe(4); // 01-10〜01-13
    expect(c.strength_days_last7).toBe(5); // 01-08, 10, 11, 13, 14
    expect(c.days_since_last_strength).toBe(0);
  });

  it('対象日に運動が無ければ当日起点の連続数は 0 だが前日起点の連続数は残り、最後の筋トレ日からの日数を返す', () => {
    const c = deriveExerciseContext(days, '2026-01-09');
    expect(c.strength_streak_days).toBe(0);
    expect(c.hard_streak_days).toBe(0);
    expect(c.strength_streak_days_before_today).toBe(1); // 01-08
    expect(c.hard_streak_days_before_today).toBe(1);
    expect(c.days_since_last_strength).toBe(1);
  });

  it('高負荷日の境界: burn ちょうど既定値は数え、1 少なければ数えない。閾値はオプションで変えられる', () => {
    const at = (burn: number, opts?: { hardBurnKcal?: number }) =>
      deriveExerciseContext([{ d: '2026-01-14', strength_count: 0, calories_burned: burn }], '2026-01-14', opts).hard_streak_days;
    expect(DEFAULT_HARD_BURN_KCAL).toBe(500);
    expect(at(500)).toBe(1);
    expect(at(499)).toBe(0);
    expect(at(350, { hardBurnKcal: 300 })).toBe(1);
  });

  it('空なら 0 / null', () => {
    expect(deriveExerciseContext([], '2026-01-14')).toEqual({
      strength_streak_days: 0,
      hard_streak_days: 0,
      strength_streak_days_before_today: 0,
      hard_streak_days_before_today: 0,
      strength_days_last7: 0,
      days_since_last_strength: null,
    });
  });
});

describe('summarizeSessions', () => {
  // 値・名称は合成
  const logs = [
    {
      id: 'p1',
      menu_id: 'm-circuit',
      performed_at: '2026-01-08T09:41:00Z', // 18:41 JST
      category: 'strength',
      menu_name: 'サーキットA',
      duration_min: 20,
      calories: 200,
      group_id: 'p1',
      rounds: 20,
      sets: [],
      note: null,
    },
    {
      id: 'c1',
      menu_id: 'm-push',
      performed_at: '2026-01-08T09:41:00Z',
      category: 'strength',
      menu_name: '自重種目1',
      group_id: 'p1',
      sets: [{ reps: 200, weight_kg: null, volume: 8000 }],
    },
    {
      id: 'c2',
      menu_id: 'm-pull',
      performed_at: '2026-01-08T09:41:00Z',
      category: 'strength',
      menu_name: '自重種目2',
      group_id: 'p1',
      sets: [{ reps: 100, weight_kg: 0, volume: 7000 }],
    },
    {
      id: 's1',
      menu_id: 'm-machine',
      performed_at: '2026-01-08T08:47:00Z', // 17:47 JST
      category: 'strength',
      menu_name: 'マシン種目',
      group_id: null,
      sets: [
        { reps: 10, weight_kg: 50, volume: 500 },
        { reps: 8, weight_kg: 50, volume: 400 },
      ],
      note: ' メモ ',
    },
    {
      id: 'k1',
      menu_id: 'm-cardio',
      performed_at: '2026-01-08T01:00:00+09:00', // 01-08 01:00 JST（深夜）= 01-07T16:00Z。オフセット形式
      category: 'cardio',
      menu_name: '有酸素',
      duration_min: 60,
      calories: 400,
      group_id: null,
      sets: [],
    },
  ];

  it('サーキットは親1行に畳んで子のボリュームを合算し、時刻順（オフセット形式が混在しても）に並べ、ローカル時を付ける', () => {
    const muscleGroups = new Map([['m-machine', 'back']]);
    const out = summarizeSessions(logs, 9, { muscleGroups });
    expect(out.map((s) => s.name)).toEqual(['有酸素', 'マシン種目', 'サーキットA']);
    expect(out[0]).toMatchObject({ d: '2026-01-08', hh: 1, kind: 'cardio', min: 60, kcal: 400, weighted_volume: 0, bodyweight_volume: 0 });
    expect(out[1]).toMatchObject({
      hh: 17,
      kind: 'strength',
      weighted_volume: 900,
      bodyweight_volume: 0,
      muscle_group: 'back',
      note: 'メモ',
    });
    expect(out[2]).toMatchObject({ hh: 18, kind: 'circuit', rounds: 20, min: 20, kcal: 200, weighted_volume: 0, bodyweight_volume: 15000 });
    expect(out.every((s) => !('t' in s))).toBe(true);
  });

  it('子ログが親より先に来ても結果は同じ（入力順に依存しない）', () => {
    const out = summarizeSessions([...logs].reverse(), 9);
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.name)).toEqual(['有酸素', 'マシン種目', 'サーキットA']);
    expect(out[2]).toMatchObject({ kind: 'circuit', weighted_volume: 0, bodyweight_volume: 15000 });
  });

  it('ログが無ければ空配列、親の無い子は無視する', () => {
    expect(summarizeSessions([], 9)).toEqual([]);
    expect(summarizeSessions(undefined, 9)).toEqual([]);
    expect(summarizeSessions([logs[1]], 9)).toEqual([]);
  });
});

describe('selectPreviousNotes', () => {
  it('対象日より前・窓内の daily だけを日付昇順で返し、本文は上限で切る', () => {
    const notes = [
      { kind: 'daily', date: '2026-08-24', content: 'b' },
      { kind: 'weekly', date: '2026-08-23', content: 'weekly' },
      { kind: 'daily', date: '2026-08-25', content: '対象日当日' },
      { kind: 'daily', date: '2026-08-26', content: '未来' },
      { kind: 'daily', date: '2026-08-22', content: 'x'.repeat(20) },
      { kind: 'daily', date: '2026-08-17', content: '8日前（窓外）' },
    ];
    const picked = selectPreviousNotes(notes, '2026-08-25', { maxChars: 10 });
    expect(picked).toEqual([
      { date: '2026-08-22', content: `${'x'.repeat(10)}…` },
      { date: '2026-08-24', content: 'b' },
    ]);
    // 窓は minDate で広げられる
    expect(selectPreviousNotes(notes, '2026-08-25', { minDate: '2026-08-01' }).map((n) => n.date)).toEqual([
      '2026-08-17',
      '2026-08-22',
      '2026-08-24',
    ]);
  });

  it('notes が無ければ空配列', () => {
    expect(selectPreviousNotes(undefined, '2026-08-25')).toEqual([]);
    expect(selectPreviousNotes([], '2026-08-25')).toEqual([]);
  });
});
