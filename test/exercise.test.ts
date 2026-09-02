import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteExerciseLog, getBodyWeightAt, getDailyExercise, getExerciseForDay,
  getExerciseMenu, listExerciseLogs, listExerciseMenus, logExercise, parseExerciseLogFields,
  parseExerciseMenuInput, setExerciseMenuArchived, updateExerciseMenu,
} from '../src/exercise';
import { createExerciseMenuOk, insertMeasurement, localYmdDaysAgo, resetTables, testEnv, unwrapMenu } from './helpers';

// 体重スナップショット取得のため、テスト日の朝(JST正午=03:00Z)に体重を1件seedする
async function seedWeight(ymd: string, weight: number): Promise<void> {
  await insertMeasurement({ grpid: Number(ymd.replace(/-/g, '')) % 1_000_000, measured_at: `${ymd}T00:00:00Z`, weight, fat_free_mass: weight * 0.8 });
}

describe('運動種目マスタ', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('有酸素種目はMETsを、筋トレ種目は部位/自重を保持する', async () => {
    const cardio = await createExerciseMenuOk(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    expect(cardio.category).toBe('cardio');
    expect(cardio.mets).toBe(8);
    expect(cardio.is_bodyweight).toBe(false);

    const strength = await createExerciseMenuOk(testEnv, {
      name: '懸垂', category: 'strength', muscle_group: '背中', is_bodyweight: true,
    });
    expect(strength.mets).toBeNull();
    expect(strength.muscle_group).toBe('背中');
    expect(strength.is_bodyweight).toBe(true);
  });

  it('listExerciseMenusはcategory絞り込み・部分一致・archived除外ができる', async () => {
    await createExerciseMenuOk(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    const bench = await createExerciseMenuOk(testEnv, { name: 'ベンチプレス', category: 'strength' });
    await createExerciseMenuOk(testEnv, { name: 'スクワット', category: 'strength' });
    await setExerciseMenuArchived(testEnv, bench.id, true);

    expect((await listExerciseMenus(testEnv, { category: 'cardio' })).map((m) => m.name)).toEqual(['ランニング']);
    expect((await listExerciseMenus(testEnv, { category: 'strength' })).map((m) => m.name)).toEqual(['スクワット']);
    expect((await listExerciseMenus(testEnv, { category: 'strength', includeArchived: true })).length).toBe(2);
    expect((await listExerciseMenus(testEnv, { q: 'ラン' })).map((m) => m.name)).toEqual(['ランニング']);
  });

  it('自重係数: 実効重量=追加重量+体重×係数でボリュームが補正される', async () => {
    await insertMeasurement({ grpid: 40001, measured_at: `${localYmdDaysAgo(0)}T03:00:00Z`, weight: 83.4 });
    const circuit = await createExerciseMenuOk(testEnv, {
      name: 'コアサーキット', category: 'strength', is_bodyweight: true, bodyweight_factor: 0.1,
    });
    expect(circuit.bodyweight_factor).toBe(0.1);
    const log = await logExercise(testEnv, { menu_id: circuit.id, sets: [{ reps: 75 }] });
    if ('error' in log) throw new Error(log.error);
    expect(log.bodyweight_factor).toBe(0.1);
    expect(log.sets[0].effective_weight_kg).toBeCloseTo(8.34, 5); // 83.4 × 0.1
    expect(log.total_volume).toBeCloseTo(625.5, 3); // 75回 × 8.34

    // 日次集計のボリュームも係数を反映する
    const daily = await getDailyExercise(testEnv, localYmdDaysAgo(0), localYmdDaysAgo(0));
    expect(daily[0].strength_volume).toBeCloseTo(625.5, 3);

    // 係数未指定の自重種目は従来どおり全体重（既定1.0）
    const pullup = await createExerciseMenuOk(testEnv, {
      name: '懸垂', category: 'strength', is_bodyweight: true,
    });
    expect(pullup.bodyweight_factor).toBe(1);
    const log2 = await logExercise(testEnv, { menu_id: pullup.id, sets: [{ reps: 10 }] });
    if ('error' in log2) throw new Error(log2.error);
    expect(log2.total_volume).toBeCloseTo(834, 3);

    // PATCHで係数を変えても過去ログのスナップショットは変わらない
    await updateExerciseMenu(testEnv, circuit.id, { bodyweight_factor: 0.5 });
    expect((await getExerciseMenu(testEnv, circuit.id))?.bodyweight_factor).toBe(0.5);
    const relisted = await listExerciseLogs(testEnv, localYmdDaysAgo(0), localYmdDaysAgo(0));
    const kept = relisted.find((l) => l.id === log.id);
    expect(kept?.total_volume).toBeCloseTo(625.5, 3);
  });

  it('自重係数のバリデーション: 範囲外は400相当のエラー', () => {
    expect(parseExerciseMenuInput({ name: 'x', category: 'strength', is_bodyweight: true, bodyweight_factor: 1.5 }).ok).toBe(false);
    expect(parseExerciseMenuInput({ name: 'x', category: 'strength', is_bodyweight: true, bodyweight_factor: -0.1 }).ok).toBe(false);
    expect(parseExerciseMenuInput({ name: 'x', category: 'strength', is_bodyweight: true, bodyweight_factor: 0 }).ok).toBe(true);
  });

  it('種目一覧は利用頻度順（直近90日の記録回数→最終使用→名前）で返す', async () => {
    // 有酸素の記録は消費kcal算出用の体重スナップショットが必須
    await insertMeasurement({ grpid: 30001, measured_at: `${localYmdDaysAgo(0)}T03:00:00Z`, weight: 80 });
    await createExerciseMenuOk(testEnv, { name: 'やらない種目', category: 'strength' });
    const run = await createExerciseMenuOk(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    const squat = await createExerciseMenuOk(testEnv, { name: 'スクワット', category: 'strength' });
    expect('error' in (await logExercise(testEnv, { menu_id: run.id, duration_min: 30 }))).toBe(false);
    expect('error' in (await logExercise(testEnv, { menu_id: run.id, duration_min: 20 }))).toBe(false);
    expect('error' in (await logExercise(testEnv, { menu_id: squat.id, sets: [{ reps: 10 }] }))).toBe(false);
    expect((await listExerciseMenus(testEnv, {})).map((m) => m.name)).toEqual([
      'ランニング',
      'スクワット',
      'やらない種目',
    ]);
  });

  it('種目のPATCHは部分更新、archive切替できる', async () => {
    const menu = await createExerciseMenuOk(testEnv, { name: 'ベンチ', category: 'strength', muscle_group: '胸' });
    const updated = unwrapMenu(await updateExerciseMenu(testEnv, menu.id, { name: 'ベンチプレス' }));
    expect(updated.name).toBe('ベンチプレス');
    expect(updated.muscle_group).toBe('胸'); // 未指定は保持
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

  it('同日ローカル日付内なら、実施時刻より後の計測でも拾う（過去日backfill対応）', async () => {
    const d = localYmdDaysAgo(1);
    // 実施はJST正午(03:00Z)想定。その日の夕方(13:00Z=JST22時)に計測 → 同日なので採用される
    await insertMeasurement({ grpid: 55, measured_at: `${d}T13:00:00Z`, weight: 68 });
    expect(await getBodyWeightAt(testEnv, `${d}T03:00:00Z`)).toBe(68);
  });
});

describe('有酸素の記録', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('消費kcal = METs × 体重 × 時間 × 1.05 を凍結して記録する', async () => {
    const today = localYmdDaysAgo(0);
    await seedWeight(today, 70);
    const menu = await createExerciseMenuOk(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    const log = await logExercise(testEnv, { menu_id: menu.id, performed_at: `${today}T03:00:00Z`, duration_min: 30 });
    if ('error' in log) throw new Error(log.error);
    expect(log.category).toBe('cardio');
    expect(log.body_weight_kg).toBe(70);
    expect(log.calories).toBeCloseTo(8 * 70 * 0.5 * 1.05); // 294
    expect(log.sets).toEqual([]);
    expect(log.total_volume).toBeNull();
  });

  it('体重の実測が無い日はcardioを記録できない', async () => {
    const menu = await createExerciseMenuOk(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    const res = await logExercise(testEnv, { menu_id: menu.id, duration_min: 30 });
    expect(res).toHaveProperty('error');
  });

  it('duration_min無しのcardioはエラー', async () => {
    const today = localYmdDaysAgo(0);
    await seedWeight(today, 70);
    const menu = await createExerciseMenuOk(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    expect(await logExercise(testEnv, { menu_id: menu.id })).toHaveProperty('error');
  });
});

describe('筋トレの記録', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('セット明細のボリューム = レップ × 重量。総ボリュームは合計', async () => {
    const today = localYmdDaysAgo(0);
    const menu = await createExerciseMenuOk(testEnv, { name: 'ベンチプレス', category: 'strength', muscle_group: '胸' });
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
    const menu = await createExerciseMenuOk(testEnv, { name: '懸垂', category: 'strength', is_bodyweight: true });
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
    const menu = await createExerciseMenuOk(testEnv, { name: '腕立て', category: 'strength', is_bodyweight: true });
    expect(await logExercise(testEnv, { menu_id: menu.id, sets: [{ reps: 20 }] })).toHaveProperty('error');
  });

  it('sets無しのstrengthはエラー', async () => {
    const menu = await createExerciseMenuOk(testEnv, { name: 'ベンチ', category: 'strength' });
    expect(await logExercise(testEnv, { menu_id: menu.id })).toHaveProperty('error');
  });

  it('記録削除はセット明細も消す', async () => {
    const today = localYmdDaysAgo(0);
    const menu = await createExerciseMenuOk(testEnv, { name: 'デッドリフト', category: 'strength' });
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
    const menu = await createExerciseMenuOk(testEnv, { name: 'スクワット', category: 'strength' });
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
    const run = await createExerciseMenuOk(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    const bench = await createExerciseMenuOk(testEnv, { name: 'ベンチ', category: 'strength' });
    await logExercise(testEnv, { menu_id: run.id, performed_at: `${today}T03:00:00Z`, duration_min: 30 });
    await logExercise(testEnv, { menu_id: bench.id, performed_at: `${today}T04:00:00Z`, sets: [{ reps: 10, weight_kg: 40 }] });

    const daily = await getDailyExercise(testEnv, today, today);
    expect(daily).toHaveLength(1);
    expect(daily[0].calories_burned).toBeCloseTo(294);
    expect(daily[0].strength_volume).toBe(400);
    expect(daily[0].cardio_count).toBe(1);
    expect(daily[0].strength_count).toBe(1);
    // BMR = Katch-McArdle。seedWeight(70)のffm = 70*0.8 = 56 → 370 + 21.6*56 = 1579.6
    expect(daily[0].bmr).toBeCloseTo(1579.6);
  });

  it('該当カテゴリが無い日はnull（0の棒を描かせない）。FFM実測が無ければbmrもnull', async () => {
    const today = localYmdDaysAgo(0);
    const bench = await createExerciseMenuOk(testEnv, { name: 'ベンチ', category: 'strength' });
    await logExercise(testEnv, { menu_id: bench.id, performed_at: `${today}T03:00:00Z`, sets: [{ reps: 10, weight_kg: 40 }] });
    const day = await getExerciseForDay(testEnv, today);
    expect(day?.calories_burned).toBeNull();
    expect(day?.strength_volume).toBe(400);
    expect(day?.bmr).toBeNull();
  });

  it('範囲開始より前の計測がseedとしてcarry-forwardされる（範囲内に計測ゼロでもBMRが出る）', async () => {
    await seedWeight(localYmdDaysAgo(5), 70); // ffm 56 → bmr 1579.6（範囲外・過去）
    const daily = await getDailyExercise(testEnv, localYmdDaysAgo(1), localYmdDaysAgo(0));
    expect(daily).toHaveLength(2);
    expect(daily[0].bmr).toBeCloseTo(1579.6);
    expect(daily[1].bmr).toBeCloseTo(1579.6);
  });

  it('期間内の全日を返し、BMRは直近FFMをcarry-forwardする（運動なしの日も成立）', async () => {
    const d2 = localYmdDaysAgo(2);
    await seedWeight(d2, 70); // ffm 56 → bmr 1579.6
    const daily = await getDailyExercise(testEnv, localYmdDaysAgo(3), localYmdDaysAgo(0));
    expect(daily).toHaveLength(4);
    expect(daily.map((r) => r.d)).toEqual([localYmdDaysAgo(3), d2, localYmdDaysAgo(1), localYmdDaysAgo(0)]);
    expect(daily[0].bmr).toBeNull(); // 計測より前の日はnull
    expect(daily[1].bmr).toBeCloseTo(1579.6); // 計測日
    expect(daily[3].bmr).toBeCloseTo(1579.6); // 未計測日はcarry-forward
    expect(daily[3].calories_burned).toBeNull(); // 運動なしの日
    expect(daily[3].cardio_count).toBe(0);
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

describe('自己ベスト更新フラグ（records_broken）', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('logExercise は自己ベスト更新を records_broken で返す（初回=全項目、更新なし=空、有酸素=空）', async () => {
    const bench = await createExerciseMenuOk(testEnv, { name: 'ベンチプレス', category: 'strength' });
    const first = await logExercise(testEnv, { menu_id: bench.id, performed_at: '2026-08-01T03:00:00Z', sets: [{ reps: 5, weight_kg: 80 }] });
    if ('error' in first) throw new Error(first.error);
    expect(first.records_broken?.map((b) => b.kind)).toEqual([
      'max_weight', 'rep_max', 'estimated_1rm', 'max_reps', 'max_set_volume', 'max_session_volume',
    ]);
    expect(first.records_broken?.[0]).toEqual({ kind: 'max_weight', previous: null, current: 80 });

    const second = await logExercise(testEnv, { menu_id: bench.id, performed_at: '2026-08-03T03:00:00Z', sets: [{ reps: 5, weight_kg: 82.5 }] });
    if ('error' in second) throw new Error(second.error);
    expect(second.records_broken).toEqual([
      { kind: 'max_weight', previous: 80, current: 82.5 },
      { kind: 'rep_max', reps: 5, previous: 80, current: 82.5 },
      { kind: 'estimated_1rm', previous: 93.3, current: 96.3 },
      { kind: 'max_set_volume', previous: 400, current: 412.5 },
      { kind: 'max_session_volume', previous: 400, current: 412.5 },
    ]);

    const third = await logExercise(testEnv, { menu_id: bench.id, performed_at: '2026-08-05T03:00:00Z', sets: [{ reps: 3, weight_kg: 60 }] });
    if ('error' in third) throw new Error(third.error);
    expect(third.records_broken).toEqual([{ kind: 'rep_max', reps: 3, previous: null, current: 60 }]);

    await seedWeight(localYmdDaysAgo(1), 80);
    const run = await createExerciseMenuOk(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    const cardio = await logExercise(testEnv, { menu_id: run.id, duration_min: 30 });
    if ('error' in cardio) throw new Error(cardio.error);
    expect(cardio.records_broken).toEqual([]);
  });
});
