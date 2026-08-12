import { beforeEach, describe, expect, it } from 'vitest';
import {
  createExerciseMenu, deleteExerciseLog, getBodyWeightAt, getDailyExercise, getExerciseForDay,
  listExerciseLogs, listExerciseMenus, logExercise, parseExerciseLogFields, parseExerciseMenuInput,
  setExerciseMenuArchived, updateExerciseMenu,
} from '../src/exercise';
import { insertMeasurement, localYmdDaysAgo, resetTables, testEnv } from './helpers';

// 体重スナップショット取得のため、テスト日の朝(JST正午=03:00Z)に体重を1件seedする
async function seedWeight(ymd: string, weight: number): Promise<void> {
  await insertMeasurement({ grpid: Number(ymd.replace(/-/g, '')) % 1_000_000, measured_at: `${ymd}T00:00:00Z`, weight, fat_free_mass: weight * 0.8 });
}

describe('運動種目マスタ', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('有酸素種目はMETsを、筋トレ種目は部位/自重を保持する', async () => {
    const cardio = await createExerciseMenu(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    expect(cardio.category).toBe('cardio');
    expect(cardio.mets).toBe(8);
    expect(cardio.is_bodyweight).toBe(false);

    const strength = await createExerciseMenu(testEnv, {
      name: '懸垂', category: 'strength', muscle_group: '背中', is_bodyweight: true,
    });
    expect(strength.mets).toBeNull();
    expect(strength.muscle_group).toBe('背中');
    expect(strength.is_bodyweight).toBe(true);
  });

  it('listExerciseMenusはcategory絞り込み・部分一致・archived除外ができる', async () => {
    await createExerciseMenu(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    const bench = await createExerciseMenu(testEnv, { name: 'ベンチプレス', category: 'strength' });
    await createExerciseMenu(testEnv, { name: 'スクワット', category: 'strength' });
    await setExerciseMenuArchived(testEnv, bench.id, true);

    expect((await listExerciseMenus(testEnv, { category: 'cardio' })).map((m) => m.name)).toEqual(['ランニング']);
    expect((await listExerciseMenus(testEnv, { category: 'strength' })).map((m) => m.name)).toEqual(['スクワット']);
    expect((await listExerciseMenus(testEnv, { category: 'strength', includeArchived: true })).length).toBe(2);
    expect((await listExerciseMenus(testEnv, { q: 'ラン' })).map((m) => m.name)).toEqual(['ランニング']);
  });

  it('種目のPATCHは部分更新、archive切替できる', async () => {
    const menu = await createExerciseMenu(testEnv, { name: 'ベンチ', category: 'strength', muscle_group: '胸' });
    const updated = await updateExerciseMenu(testEnv, menu.id, { name: 'ベンチプレス' });
    expect(updated?.name).toBe('ベンチプレス');
    expect(updated?.muscle_group).toBe('胸'); // 未指定は保持
    expect(await setExerciseMenuArchived(testEnv, menu.id, true)).toBe(true);
    expect(await setExerciseMenuArchived(testEnv, 'nope', true)).toBe(false);
  });
});

describe('体重スナップショット', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('getBodyWeightAtはperformed_at以前で最も新しい体重を返す', async () => {
    const d = localYmdDaysAgo(2);
    await seedWeight(d, 70);
    await seedWeight(localYmdDaysAgo(1), 69);
    // 2日前の時点では70、昨日以降は69
    expect(await getBodyWeightAt(testEnv, `${d}T12:00:00Z`)).toBe(70);
    expect(await getBodyWeightAt(testEnv, `${localYmdDaysAgo(0)}T00:00:00Z`)).toBe(69);
  });

  it('計測が1件も無ければnull', async () => {
    expect(await getBodyWeightAt(testEnv, `${localYmdDaysAgo(0)}T00:00:00Z`)).toBeNull();
  });
});

describe('有酸素の記録', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('消費kcal = METs × 体重 × 時間 × 1.05 を凍結して記録する', async () => {
    const today = localYmdDaysAgo(0);
    await seedWeight(today, 70);
    const menu = await createExerciseMenu(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    const log = await logExercise(testEnv, { menu_id: menu.id, performed_at: `${today}T03:00:00Z`, duration_min: 30 });
    if ('error' in log) throw new Error(log.error);
    expect(log.category).toBe('cardio');
    expect(log.body_weight_kg).toBe(70);
    expect(log.calories).toBeCloseTo(8 * 70 * 0.5 * 1.05); // 294
    expect(log.sets).toEqual([]);
    expect(log.total_volume).toBeNull();
  });

  it('体重の実測が無い日はcardioを記録できない', async () => {
    const menu = await createExerciseMenu(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    const res = await logExercise(testEnv, { menu_id: menu.id, duration_min: 30 });
    expect(res).toHaveProperty('error');
  });

  it('duration_min無しのcardioはエラー', async () => {
    const today = localYmdDaysAgo(0);
    await seedWeight(today, 70);
    const menu = await createExerciseMenu(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    expect(await logExercise(testEnv, { menu_id: menu.id })).toHaveProperty('error');
  });
});

describe('筋トレの記録', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('セット明細のボリューム = レップ × 重量。総ボリュームは合計', async () => {
    const today = localYmdDaysAgo(0);
    const menu = await createExerciseMenu(testEnv, { name: 'ベンチプレス', category: 'strength', muscle_group: '胸' });
    const log = await logExercise(testEnv, {
      menu_id: menu.id, performed_at: `${today}T03:00:00Z`,
      sets: [{ reps: 10, weight_kg: 40 }, { reps: 8, weight_kg: 42.5 }],
    });
    if ('error' in log) throw new Error(log.error);
    expect(log.sets.map((s) => s.volume)).toEqual([400, 340]);
    expect(log.sets[0].effective_weight_kg).toBe(40);
    expect(log.total_volume).toBe(740);
    expect(log.body_weight_kg).toBeNull(); // 非自重は体重不要
  });

  it('自重種目は記録時の体重を実効重量に算入する', async () => {
    const today = localYmdDaysAgo(0);
    await seedWeight(today, 70);
    const menu = await createExerciseMenu(testEnv, { name: '懸垂', category: 'strength', is_bodyweight: true });
    const log = await logExercise(testEnv, {
      menu_id: menu.id, performed_at: `${today}T03:00:00Z`,
      sets: [{ reps: 10 }, { reps: 8, weight_kg: 5 }], // 2set目は加重懸垂
    });
    if ('error' in log) throw new Error(log.error);
    expect(log.is_bodyweight).toBe(true);
    expect(log.body_weight_kg).toBe(70);
    expect(log.sets[0].effective_weight_kg).toBe(70); // 純自重
    expect(log.sets[1].effective_weight_kg).toBe(75); // 体重 + 加重
    expect(log.total_volume).toBe(10 * 70 + 8 * 75); // 700 + 600 = 1300
  });

  it('自重種目で体重の実測が無ければエラー', async () => {
    const menu = await createExerciseMenu(testEnv, { name: '腕立て', category: 'strength', is_bodyweight: true });
    expect(await logExercise(testEnv, { menu_id: menu.id, sets: [{ reps: 20 }] })).toHaveProperty('error');
  });

  it('sets無しのstrengthはエラー', async () => {
    const menu = await createExerciseMenu(testEnv, { name: 'ベンチ', category: 'strength' });
    expect(await logExercise(testEnv, { menu_id: menu.id })).toHaveProperty('error');
  });

  it('記録削除はセット明細も消す', async () => {
    const today = localYmdDaysAgo(0);
    const menu = await createExerciseMenu(testEnv, { name: 'デッドリフト', category: 'strength' });
    const log = await logExercise(testEnv, {
      menu_id: menu.id, performed_at: `${today}T03:00:00Z`, sets: [{ reps: 5, weight_kg: 100 }],
    });
    if ('error' in log) throw new Error(log.error);
    expect(await deleteExerciseLog(testEnv, log.id)).toBe(true);
    expect(await deleteExerciseLog(testEnv, log.id)).toBe(false);
    const orphan = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM exercise_sets WHERE log_id = ?1')
      .bind(log.id).first<{ n: number }>();
    expect(orphan?.n).toBe(0);
  });

  it('メニューを後から編集しても過去の記録は変わらない（スナップショット保全）', async () => {
    const today = localYmdDaysAgo(0);
    const menu = await createExerciseMenu(testEnv, { name: 'スクワット', category: 'strength' });
    await logExercise(testEnv, { menu_id: menu.id, performed_at: `${today}T03:00:00Z`, sets: [{ reps: 10, weight_kg: 60 }] });
    await updateExerciseMenu(testEnv, menu.id, { name: 'スクワット改' });
    const logs = await listExerciseLogs(testEnv, today, today);
    expect(logs[0].menu_name).toBe('スクワット');
  });
});

describe('運動の日次集計', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('有酸素の消費kcalと筋トレの総ボリュームを日ごとに集計する', async () => {
    const today = localYmdDaysAgo(0);
    await seedWeight(today, 70);
    const run = await createExerciseMenu(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    const bench = await createExerciseMenu(testEnv, { name: 'ベンチ', category: 'strength' });
    await logExercise(testEnv, { menu_id: run.id, performed_at: `${today}T03:00:00Z`, duration_min: 30 });
    await logExercise(testEnv, { menu_id: bench.id, performed_at: `${today}T04:00:00Z`, sets: [{ reps: 10, weight_kg: 40 }] });

    const daily = await getDailyExercise(testEnv, today, today);
    expect(daily).toHaveLength(1);
    expect(daily[0].calories_burned).toBeCloseTo(294);
    expect(daily[0].strength_volume).toBe(400);
    expect(daily[0].cardio_count).toBe(1);
    expect(daily[0].strength_count).toBe(1);
  });

  it('該当カテゴリが無い日はnull（0の棒を描かせない）', async () => {
    const today = localYmdDaysAgo(0);
    const bench = await createExerciseMenu(testEnv, { name: 'ベンチ', category: 'strength' });
    await logExercise(testEnv, { menu_id: bench.id, performed_at: `${today}T03:00:00Z`, sets: [{ reps: 10, weight_kg: 40 }] });
    const day = await getExerciseForDay(testEnv, today);
    expect(day?.calories_burned).toBeNull();
    expect(day?.strength_volume).toBe(400);
  });
});

describe('運動バリデータ', () => {
  it('parseExerciseMenuInput: cardioはmets必須、strengthは任意、categoryは限定', () => {
    expect(parseExerciseMenuInput({ name: 'x', category: 'cardio' }).ok).toBe(false); // mets無し
    expect(parseExerciseMenuInput({ name: 'x', category: 'cardio', mets: 8 }).ok).toBe(true);
    expect(parseExerciseMenuInput({ name: 'x', category: 'strength' }).ok).toBe(true);
    expect(parseExerciseMenuInput({ name: 'x', category: 'walk' }).ok).toBe(false);
    expect(parseExerciseMenuInput({ name: '', category: 'strength' }).ok).toBe(false);
  });

  it('parseExerciseLogFields: 未来日時・不正セットを弾く', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(parseExerciseLogFields({ performed_at: future }).ok).toBe(false);
    expect(parseExerciseLogFields({ sets: [{ reps: 0, weight_kg: 40 }] }).ok).toBe(false);
    expect(parseExerciseLogFields({ sets: [{ reps: 10, weight_kg: -5 }] }).ok).toBe(false);
    expect(parseExerciseLogFields({ sets: [] }).ok).toBe(false);
    const ok = parseExerciseLogFields({ duration_min: 30, sets: [{ reps: 10 }] });
    expect(ok.ok).toBe(true);
  });
});
