/**
 * 運動記録モデル v2（docs/superpowers/specs/2026-08-31-exercise-model-v2-design.md）のテスト。
 * Phase 0: カテゴリ不一致フィールドの明示エラー化（D8）
 * Phase 1: strength の duration_min / METs / kcal 開放（D1）
 * Phase 2: circuit + rounds のサーバ展開（D2/D3）と自己ベスト除外（D7）
 * Phase 3: ボリューム内訳（weighted / bodyweight）の読み取り時分解（D6）
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createExerciseMenu, deleteExerciseLog, dropIncompleteTrailingGroup, getDailyExercise, getExerciseMenu,
  listExerciseLogs, logExercise, parseExerciseLogFields, parseExerciseMenuInput, setExerciseMenuArchived,
  updateExerciseMenu,
} from '../src/exercise';
import { getExerciseRecords } from '../src/exercise-records';
import type { ExerciseMenu } from '../src/types';
import { insertMeasurement, localYmdDaysAgo, resetTables, testEnv } from './helpers';

// 日付境界のフレークを避けるため固定時刻（JST正午）で体重をseedする
async function seedWeight(ymd: string, weight: number): Promise<void> {
  await insertMeasurement({
    grpid: Number(ymd.replace(/-/g, '')) % 1_000_000,
    measured_at: `${ymd}T03:00:00Z`,
    weight,
    fat_free_mass: weight * 0.8,
  });
}

function unwrap(menu: ExerciseMenu | { error: string }): ExerciseMenu {
  if ('error' in menu) throw new Error(menu.error);
  return menu;
}

async function seedCircuitMenus(): Promise<{ cindy: ExerciseMenu; pullup: ExerciseMenu; pushup: ExerciseMenu; squat: ExerciseMenu }> {
  const pullup = unwrap(await createExerciseMenu(testEnv, {
    name: 'アシスト懸垂', category: 'strength', is_bodyweight: true, bodyweight_factor: 0.75,
  }));
  const pushup = unwrap(await createExerciseMenu(testEnv, {
    name: '腕立て伏せ', category: 'strength', is_bodyweight: true, bodyweight_factor: 0.65,
  }));
  const squat = unwrap(await createExerciseMenu(testEnv, {
    name: 'フルスクワット', category: 'strength', is_bodyweight: true, bodyweight_factor: 0.4,
  }));
  const cindy = unwrap(await createExerciseMenu(testEnv, {
    name: 'Cindy', category: 'strength', mets: 8,
    circuit: [
      { menu_id: pullup.id, reps: 5 },
      { menu_id: pushup.id, reps: 10 },
      { menu_id: squat.id, reps: 15 },
    ],
  }));
  return { cindy, pullup, pushup, squat };
}

describe('Phase 0: カテゴリ不一致フィールドの明示エラー化', () => {
  beforeEach(async () => {
    await resetTables();
    await seedWeight(localYmdDaysAgo(0), 70);
  });

  it('cardioにsetsを送ると黙殺せずエラーになる', async () => {
    const run = unwrap(await createExerciseMenu(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 }));
    const res = await logExercise(testEnv, { menu_id: run.id, duration_min: 30, sets: [{ reps: 10 }] });
    expect(res).toEqual({ error: 'sets is not allowed for cardio menu "ランニング" — pass duration_min' });
  });

  it('cardio・非circuitのstrengthにroundsを送るとエラーになる', async () => {
    const run = unwrap(await createExerciseMenu(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 }));
    const bench = unwrap(await createExerciseMenu(testEnv, { name: 'ベンチプレス', category: 'strength' }));
    expect(await logExercise(testEnv, { menu_id: run.id, duration_min: 30, rounds: 5 })).toEqual({
      error: 'rounds is only valid for circuit menus — "ランニング" is cardio, pass duration_min',
    });
    expect(await logExercise(testEnv, { menu_id: bench.id, sets: [{ reps: 5, weight_kg: 60 }], rounds: 5 })).toEqual({
      error: 'rounds is only valid for circuit menus — "ベンチプレス" is strength, pass sets: [{reps, weight_kg?}]',
    });
  });

  it('roundsのバリデーション: 整数1..50以外は拒否', () => {
    expect(parseExerciseLogFields({ rounds: 0 }).ok).toBe(false);
    expect(parseExerciseLogFields({ rounds: 51 }).ok).toBe(false);
    expect(parseExerciseLogFields({ rounds: 1.5 }).ok).toBe(false);
    expect(parseExerciseLogFields({ rounds: 15 }).ok).toBe(true);
  });
});

describe('Phase 1: strengthのduration_min / METs / kcal', () => {
  beforeEach(async () => {
    await resetTables();
    await seedWeight(localYmdDaysAgo(0), 70);
  });

  it('METs付きstrengthに時間を記録すると消費kcalを算出して凍結する', async () => {
    const menu = unwrap(await createExerciseMenu(testEnv, { name: 'ケトルベル', category: 'strength', mets: 6 }));
    expect(menu.mets).toBe(6);
    const log = await logExercise(testEnv, {
      menu_id: menu.id, duration_min: 30, sets: [{ reps: 10, weight_kg: 16 }],
    });
    if ('error' in log) throw new Error(log.error);
    expect(log.duration_min).toBe(30);
    expect(log.mets).toBe(6);
    expect(log.calories).toBeCloseTo(6 * 70 * 0.5 * 1.05, 5); // 220.5
    expect(log.total_volume).toBeCloseTo(160, 3); // ボリュームは従来どおりセットから
  });

  it('METs無しstrengthは時間のみ保存しkcalはnull', async () => {
    const menu = unwrap(await createExerciseMenu(testEnv, { name: 'ベンチプレス', category: 'strength' }));
    const log = await logExercise(testEnv, { menu_id: menu.id, duration_min: 45, sets: [{ reps: 5, weight_kg: 60 }] });
    if ('error' in log) throw new Error(log.error);
    expect(log.duration_min).toBe(45);
    expect(log.mets).toBeNull();
    expect(log.calories).toBeNull();
  });

  it('kcal算出には体重実測が必要（cardioと同文言のエラー）', async () => {
    await resetTables(); // 体重なし
    const menu = unwrap(await createExerciseMenu(testEnv, { name: 'ケトルベル', category: 'strength', mets: 6 }));
    const res = await logExercise(testEnv, { menu_id: menu.id, duration_min: 30, sets: [{ reps: 10, weight_kg: 16 }] });
    expect(res).toEqual({ error: 'no body weight measurement on or before performed_at' });
    // 時間を記録しなければ非自重strengthは体重なしでも記録できる（従来どおり）
    const ok = await logExercise(testEnv, { menu_id: menu.id, sets: [{ reps: 10, weight_kg: 16 }] });
    expect('error' in ok).toBe(false);
  });

  it('日次集計: strengthのkcalもcalories_burnedに合算され、内訳が分かれる', async () => {
    const today = localYmdDaysAgo(0);
    const run = unwrap(await createExerciseMenu(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 }));
    const kb = unwrap(await createExerciseMenu(testEnv, { name: 'ケトルベル', category: 'strength', mets: 6 }));
    await logExercise(testEnv, { menu_id: run.id, duration_min: 30 }); // 8×70×0.5×1.05 = 294
    await logExercise(testEnv, { menu_id: kb.id, duration_min: 30, sets: [{ reps: 10, weight_kg: 16 }] }); // 220.5
    const [day] = await getDailyExercise(testEnv, today, today);
    expect(day.calories_burned).toBeCloseTo(294 + 220.5, 3);
    expect(day.cardio_calories).toBeCloseTo(294, 3);
    expect(day.strength_calories).toBeCloseTo(220.5, 3);
  });

  it('回帰: kcal材料の無い日は従来どおりcalories_burnedがnullのまま', async () => {
    const today = localYmdDaysAgo(0);
    const bench = unwrap(await createExerciseMenu(testEnv, { name: 'ベンチプレス', category: 'strength' }));
    await logExercise(testEnv, { menu_id: bench.id, sets: [{ reps: 5, weight_kg: 60 }] });
    const [day] = await getDailyExercise(testEnv, today, today);
    expect(day.calories_burned).toBeNull();
    expect(day.cardio_calories).toBeNull();
    expect(day.strength_calories).toBeNull();
    expect(day.strength_volume).toBeCloseTo(300, 3);
  });

  it('PATCHでstrengthにMETsを設定できる', async () => {
    const menu = unwrap(await createExerciseMenu(testEnv, { name: 'バーピー', category: 'strength' }));
    const updated = await updateExerciseMenu(testEnv, menu.id, { mets: 8 });
    if (!updated || 'error' in updated) throw new Error('update failed');
    expect(updated.mets).toBe(8);
  });
});

describe('Phase 2: circuitメニューの検証', () => {
  beforeEach(async () => {
    await resetTables();
    await seedWeight(localYmdDaysAgo(0), 70);
  });

  it('circuit構成のバリデーション（パース層）', () => {
    const item = { menu_id: 'x', reps: 5 };
    expect(parseExerciseMenuInput({ name: 'C', category: 'cardio', mets: 8, circuit: [item] })).toEqual({
      ok: false, error: 'circuit is only valid for strength menus',
    });
    expect(parseExerciseMenuInput({ name: 'C', category: 'strength', is_bodyweight: true, circuit: [item] }).ok).toBe(false);
    expect(parseExerciseMenuInput({ name: 'C', category: 'strength', circuit: [] }).ok).toBe(false);
    expect(parseExerciseMenuInput({ name: 'C', category: 'strength', circuit: Array(11).fill(item) }).ok).toBe(false);
    expect(parseExerciseMenuInput({ name: 'C', category: 'strength', circuit: [{ menu_id: 'x', reps: 0 }] }).ok).toBe(false);
    expect(parseExerciseMenuInput({ name: 'C', category: 'strength', circuit: [{ reps: 5 }] }).ok).toBe(false);
    expect(parseExerciseMenuInput({ name: 'C', category: 'strength', circuit: [item] }).ok).toBe(true);
  });

  it('構成種目の参照整合性: 不在・cardio・非自重・archived・入れ子はエラー', async () => {
    const run = unwrap(await createExerciseMenu(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 }));
    const bench = unwrap(await createExerciseMenu(testEnv, { name: 'ベンチプレス', category: 'strength' }));
    const { cindy, squat } = await seedCircuitMenus();

    expect(await createExerciseMenu(testEnv, {
      name: 'X', category: 'strength', circuit: [{ menu_id: 'no-such-id', reps: 5 }],
    })).toEqual({ error: 'circuit item menu not found: no-such-id' });
    expect(await createExerciseMenu(testEnv, {
      name: 'X', category: 'strength', circuit: [{ menu_id: run.id, reps: 5 }],
    })).toEqual({ error: 'circuit item "ランニング" must be a strength menu' });
    expect(await createExerciseMenu(testEnv, {
      name: 'X', category: 'strength', circuit: [{ menu_id: cindy.id, reps: 5 }],
    })).toEqual({ error: 'circuit item "Cindy" is itself a circuit — nesting is not supported' });
    // 非自重種目は展開セットが weight_kg NULL で入りボリュームが黙って0になるため拒否する
    expect(await createExerciseMenu(testEnv, {
      name: 'X', category: 'strength', circuit: [{ menu_id: bench.id, reps: 5 }],
    })).toEqual({
      error: 'circuit item "ベンチプレス" is not a bodyweight menu — register it as is_bodyweight with a factor, or log it standalone with sets',
    });

    await setExerciseMenuArchived(testEnv, squat.id, true);
    expect(await createExerciseMenu(testEnv, {
      name: 'X', category: 'strength', circuit: [{ menu_id: squat.id, reps: 5 }],
    })).toEqual({ error: 'circuit item "フルスクワット" is archived — unarchive it or remove it from the circuit' });
  });

  it('PATCHでcircuitの差し替え・クリア・自己参照拒否ができる', async () => {
    const { cindy, pullup } = await seedCircuitMenus();
    const self = await updateExerciseMenu(testEnv, cindy.id, { circuit: [{ menu_id: cindy.id, reps: 5 }] });
    expect(self).toEqual({ error: 'a circuit cannot reference itself' });

    const replaced = await updateExerciseMenu(testEnv, cindy.id, { circuit: [{ menu_id: pullup.id, reps: 3 }] });
    if (!replaced || 'error' in replaced) throw new Error('update failed');
    expect(replaced.circuit).toEqual([{ menu_id: pullup.id, reps: 3 }]);

    const cleared = await updateExerciseMenu(testEnv, cindy.id, { circuit: null });
    if (!cleared || 'error' in cleared) throw new Error('update failed');
    expect(cleared.circuit).toBeNull();
  });

  it('被参照種目へのcircuit付与は拒否される（逆方向の入れ子禁止）', async () => {
    const { pullup, pushup } = await seedCircuitMenus(); // Cindy が pullup/pushup を参照中
    const res = await updateExerciseMenu(testEnv, pushup.id, { circuit: [{ menu_id: pullup.id, reps: 10 }] });
    expect(res).toEqual({
      error: 'menu "腕立て伏せ" is a circuit item of "Cindy" — remove it from that circuit first',
    });
  });

  it('D8: 種目登録でもカテゴリ不一致フィールドは黙殺せずエラーにする', async () => {
    expect(parseExerciseMenuInput({ name: 'x', category: 'cardio', mets: 8, muscle_group: '脚' }))
      .toEqual({ ok: false, error: 'muscle_group is not allowed for cardio menus' });
    expect(parseExerciseMenuInput({ name: 'x', category: 'cardio', mets: 8, is_bodyweight: true }))
      .toEqual({ ok: false, error: 'is_bodyweight is not allowed for cardio menus' });
    expect(parseExerciseMenuInput({ name: 'x', category: 'cardio', mets: 8, bodyweight_factor: 0.5 }))
      .toEqual({ ok: false, error: 'bodyweight_factor is not allowed for cardio menus' });
    // is_bodyweight 指定漏れの factor は「非自重・係数1.0」として黙って登録される事故のもと
    expect(parseExerciseMenuInput({ name: '懸垂', category: 'strength', bodyweight_factor: 0.8 }))
      .toEqual({ ok: false, error: 'bodyweight_factor requires is_bodyweight: true' });
    // 既定値と同義の指定（factor 1.0 / is_bodyweight false）は許容する
    expect(parseExerciseMenuInput({ name: 'x', category: 'cardio', mets: 8, bodyweight_factor: 1, is_bodyweight: false }).ok).toBe(true);

    // PATCH側: cardio種目へのstrength専用フィールド、自重でない種目への係数を拒否
    const run = unwrap(await createExerciseMenu(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 }));
    expect(await updateExerciseMenu(testEnv, run.id, { muscle_group: '脚' }))
      .toEqual({ error: 'muscle_group is not allowed for cardio menus' });
    const bench = unwrap(await createExerciseMenu(testEnv, { name: 'ベンチプレス', category: 'strength' }));
    expect(await updateExerciseMenu(testEnv, bench.id, { bodyweight_factor: 0.8 }))
      .toEqual({ error: 'bodyweight_factor requires is_bodyweight: true' });
    // 自重種目への係数単独更新は従来どおり通る
    const dips = unwrap(await createExerciseMenu(testEnv, {
      name: 'ディップス', category: 'strength', is_bodyweight: true, bodyweight_factor: 0.85,
    }));
    const updated = await updateExerciseMenu(testEnv, dips.id, { bodyweight_factor: 0.8 });
    if (!updated || 'error' in updated) throw new Error('update failed');
    expect(updated.bodyweight_factor).toBe(0.8);
  });

  it('dropIncompleteTrailingGroup: 上限到達時のみ末尾の不完全グループを落とす', () => {
    const row = (id: string, group: string | null) => ({ id, group_id: group });
    const full = [row('a', null), row('p', 'p'), row('c1', 'p')];
    expect(dropIncompleteTrailingGroup(full, 3)).toEqual([row('a', null)]); // 上限到達→末尾グループ除去
    expect(dropIncompleteTrailingGroup(full, 4)).toEqual(full); // 上限未満→そのまま
    expect(dropIncompleteTrailingGroup([row('a', null), row('b', null)], 2)).toEqual([row('a', null), row('b', null)]); // 末尾が単独記録→そのまま
  });
});

describe('Phase 2: circuit記録の展開', () => {
  beforeEach(async () => {
    await resetTables();
    await seedWeight(localYmdDaysAgo(0), 70);
  });

  it('roundsだけで親+子ログに展開され、導出値が返る', async () => {
    const { cindy, pullup, pushup, squat } = await seedCircuitMenus();
    const log = await logExercise(testEnv, { menu_id: cindy.id, rounds: 15, duration_min: 20 });
    if ('error' in log) throw new Error(log.error);

    // 親ログ: 時間・kcalを担い、setsを持たない
    expect(log.group_id).toBe(log.id);
    expect(log.rounds).toBe(15);
    expect(log.duration_min).toBe(20);
    expect(log.calories).toBeCloseTo(8 * 70 * (20 / 60) * 1.05, 3); // 196
    expect(log.sets).toEqual([]);
    expect(log.records_broken).toEqual([]);

    // 導出値: 種目別レップ・総レップ・換算ボリューム（全てサーバ算出）
    expect(log.circuit?.total_reps).toBe(450);
    expect(log.circuit?.per_movement.map((p) => p.total_reps)).toEqual([75, 150, 225]);
    // 懸垂 70×0.75=52.5×75 + 腕立て 70×0.65=45.5×150 + スクワット 70×0.4=28×225
    expect(log.circuit?.total_volume).toBeCloseTo(52.5 * 75 + 45.5 * 150 + 28 * 225, 3);

    // 子ログ: 構成種目の通常strengthログとして展開・凍結される
    const today = localYmdDaysAgo(0);
    const logs = await listExerciseLogs(testEnv, today, today);
    expect(logs.length).toBe(4); // 親1 + 子3
    const child = logs.find((l) => l.menu_id === pullup.id);
    expect(child?.group_id).toBe(log.id);
    expect(child?.sets.length).toBe(15); // 1ラウンド=1セット
    expect(child?.sets[0].reps).toBe(5);
    expect(child?.sets[0].effective_weight_kg).toBeCloseTo(52.5, 3);
    expect(logs.find((l) => l.menu_id === pushup.id)?.sets.length).toBe(15);
    expect(logs.find((l) => l.menu_id === squat.id)?.sets[0].reps).toBe(15);
    // 一覧でも親にroundsが復元される
    expect(logs.find((l) => l.id === log.id)?.rounds).toBe(15);
  });

  it('circuitにはroundsが必須でsetsは渡せない', async () => {
    const { cindy } = await seedCircuitMenus();
    expect(await logExercise(testEnv, { menu_id: cindy.id, duration_min: 20 })).toEqual({
      error: 'rounds is required for circuit menu "Cindy"',
    });
    expect(await logExercise(testEnv, { menu_id: cindy.id, rounds: 15, sets: [{ reps: 5 }] })).toEqual({
      error: 'sets is not allowed for circuit menu "Cindy" — pass rounds',
    });
  });

  it('構成種目が後からarchivedされたら記録はエラー', async () => {
    const { cindy, pushup } = await seedCircuitMenus();
    await setExerciseMenuArchived(testEnv, pushup.id, true);
    expect(await logExercise(testEnv, { menu_id: cindy.id, rounds: 10 })).toEqual({
      error: 'circuit item "腕立て伏せ" is archived — unarchive it or remove it from the circuit',
    });
  });

  it('circuit定義を後から編集しても過去ログは不変（展開スナップショット）', async () => {
    const { cindy, pullup } = await seedCircuitMenus();
    const log = await logExercise(testEnv, { menu_id: cindy.id, rounds: 15, duration_min: 20 });
    if ('error' in log) throw new Error(log.error);
    const before = log.circuit!.total_volume;

    await updateExerciseMenu(testEnv, cindy.id, { circuit: [{ menu_id: pullup.id, reps: 1 }] });
    await updateExerciseMenu(testEnv, pullup.id, { bodyweight_factor: 0.1 });

    const today = localYmdDaysAgo(0);
    const logs = await listExerciseLogs(testEnv, today, today);
    const total = logs.filter((l) => l.group_id === log.id && l.id !== log.id)
      .reduce((a, l) => a + (l.total_volume ?? 0), 0);
    expect(total).toBeCloseTo(before, 3);
  });

  it('親id削除でグループ全体が消え、子id単独の削除は拒否される（D-06）', async () => {
    const { cindy } = await seedCircuitMenus();
    const today = localYmdDaysAgo(0);
    const log = await logExercise(testEnv, { menu_id: cindy.id, rounds: 5 });
    if ('error' in log) throw new Error(log.error);

    let logs = await listExerciseLogs(testEnv, today, today);
    const child = logs.find((l) => l.group_id === log.id && l.id !== log.id)!;
    // 子ログの単独削除はグループ整合が壊れるため拒否（親id削除を案内するエラー）
    const rejected = await deleteExerciseLog(testEnv, child.id);
    expect(rejected).toEqual({
      error: `this log is part of a circuit session — delete the parent log ${log.id} to remove the whole session`,
    });
    logs = await listExerciseLogs(testEnv, today, today);
    expect(logs.length).toBe(4); // 何も消えていない

    expect(await deleteExerciseLog(testEnv, log.id)).toBe(true);
    logs = await listExerciseLogs(testEnv, today, today);
    expect(logs.length).toBe(0);
    const sets = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM exercise_sets').first<{ n: number }>();
    expect(sets?.n).toBe(0);
  });

  it('D7: サーキットの子セットは構成種目の自己ベストに影響しない', async () => {
    const { cindy, pullup } = await seedCircuitMenus();
    const solo = await logExercise(testEnv, { menu_id: pullup.id, sets: [{ reps: 8 }] });
    if ('error' in solo) throw new Error(solo.error);
    const before = await getExerciseRecords(testEnv, (await getExerciseMenu(testEnv, pullup.id))!);
    expect(before.max_reps?.reps).toBe(8);

    const circuitLog = await logExercise(testEnv, { menu_id: cindy.id, rounds: 15 }); // 懸垂 5rep×15セット
    if ('error' in circuitLog) throw new Error(circuitLog.error);
    expect(circuitLog.records_broken).toEqual([]);

    const after = await getExerciseRecords(testEnv, (await getExerciseMenu(testEnv, pullup.id))!);
    expect(after).toEqual(before); // セッション数・volume系も一切変わらない
  });

  it('日次集計: サーキットは1件と数え、ボリューム・kcalが合算される', async () => {
    const { cindy, squat } = await seedCircuitMenus();
    const today = localYmdDaysAgo(0);
    await logExercise(testEnv, { menu_id: cindy.id, rounds: 15, duration_min: 20 });
    await logExercise(testEnv, { menu_id: squat.id, sets: [{ reps: 20 }] }); // 単独 28×20=560
    const [day] = await getDailyExercise(testEnv, today, today);
    expect(day.strength_count).toBe(2); // サーキット1 + 単独1
    expect(day.strength_volume).toBeCloseTo(52.5 * 75 + 45.5 * 150 + 28 * 225 + 560, 1);
    expect(day.strength_calories).toBeCloseTo(196, 1);
    expect(day.calories_burned).toBeCloseTo(196, 1);
  });
});

describe('Phase 3: ボリューム内訳（実荷重 / 自重換算）', () => {
  beforeEach(async () => {
    await resetTables();
    await seedWeight(localYmdDaysAgo(0), 70);
  });

  it('weighted_volume + bodyweight_volume = strength_volume', async () => {
    const today = localYmdDaysAgo(0);
    const bench = unwrap(await createExerciseMenu(testEnv, { name: 'ベンチプレス', category: 'strength' }));
    const dips = unwrap(await createExerciseMenu(testEnv, {
      name: 'ディップス', category: 'strength', is_bodyweight: true, bodyweight_factor: 0.85,
    }));
    await logExercise(testEnv, { menu_id: bench.id, sets: [{ reps: 5, weight_kg: 60 }] }); // 実荷重 300
    await logExercise(testEnv, { menu_id: dips.id, sets: [{ reps: 10, weight_kg: 10 }] }); // 実荷重100 + 自重595
    const [day] = await getDailyExercise(testEnv, today, today);
    expect(day.weighted_volume).toBeCloseTo(400, 3);
    expect(day.bodyweight_volume).toBeCloseTo(595, 3); // 70×0.85×10
    expect(day.strength_volume).toBeCloseTo(995, 3);
    expect(day.weighted_volume! + day.bodyweight_volume!).toBeCloseTo(day.strength_volume!, 3);
  });

  it('自重成分の無い日はbodyweight_volumeが0、記録の無い日は全てnull', async () => {
    const today = localYmdDaysAgo(0);
    const bench = unwrap(await createExerciseMenu(testEnv, { name: 'ベンチプレス', category: 'strength' }));
    await logExercise(testEnv, { menu_id: bench.id, sets: [{ reps: 5, weight_kg: 60 }] });
    const [day] = await getDailyExercise(testEnv, today, today);
    expect(day.bodyweight_volume).toBe(0);
    const [empty] = await getDailyExercise(testEnv, localYmdDaysAgo(1), localYmdDaysAgo(1));
    expect(empty.strength_volume).toBeNull();
    expect(empty.weighted_volume).toBeNull();
    expect(empty.bodyweight_volume).toBeNull();
  });
});
