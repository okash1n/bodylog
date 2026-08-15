import { beforeEach, describe, expect, it } from 'vitest';
import { createMenu, deleteMealLog, getDailyIntake, getMenu, listMenus, listMealLogs, logMeal, setMenuArchived, updateMenu, updateMealLog } from '../src/meals';
import { localYmdDaysAgo, resetTables, testEnv } from './helpers';

describe('メニューCRUD', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('作成・取得・更新ができる', async () => {
    const menu = await createMenu(testEnv, { name: 'ラーメン', calories: 800, protein_g: 20 });
    expect(menu.id).toBeTruthy();
    expect(menu.archived).toBe(false);
    const fetched = await getMenu(testEnv, menu.id);
    expect(fetched?.name).toBe('ラーメン');
    expect(fetched?.protein_g).toBe(20);
    expect(fetched?.fat_g).toBeNull();

    const updated = await updateMenu(testEnv, menu.id, { name: 'ラーメン大', calories: 1000 });
    expect(updated?.calories).toBe(1000);
    expect(updated?.protein_g).toBe(20); // 部分更新: patchに含まれないフィールドは現状維持
  });

  it('listMenusは部分一致検索でき、archivedは既定で除外', async () => {
    const a = await createMenu(testEnv, { name: '鶏むね定食', calories: 600 });
    await createMenu(testEnv, { name: 'サラダ', calories: 100 });
    await setMenuArchived(testEnv, a.id, true);

    expect((await listMenus(testEnv, {})).map((m) => m.name)).toEqual(['サラダ']);
    expect((await listMenus(testEnv, { includeArchived: true })).length).toBe(2);
    expect((await listMenus(testEnv, { q: 'ラダ' })).map((m) => m.name)).toEqual(['サラダ']);
  });

  it('listMenusのqはLIKEワイルドカード（%, _）をリテラル文字として扱う', async () => {
    await createMenu(testEnv, { name: 'off50%', calories: 100 });
    await createMenu(testEnv, { name: 'off50X', calories: 100 });
    expect((await listMenus(testEnv, { q: '50%' })).map((m) => m.name)).toEqual(['off50%']);

    await createMenu(testEnv, { name: 'a_b', calories: 100 });
    await createMenu(testEnv, { name: 'aXb', calories: 100 });
    expect((await listMenus(testEnv, { q: 'a_b' })).map((m) => m.name)).toEqual(['a_b']);
  });

  it('一覧は利用頻度順（直近90日の記録回数→最終使用→名前）で返す', async () => {
    const a = await createMenu(testEnv, { name: 'あまり食べない', calories: 100 });
    const b = await createMenu(testEnv, { name: 'よく食べる', calories: 200 });
    const c = await createMenu(testEnv, { name: 'たまに食べる', calories: 300 });
    void a;
    await logMeal(testEnv, { menu_id: b.id });
    await logMeal(testEnv, { menu_id: b.id });
    await logMeal(testEnv, { menu_id: c.id });
    expect((await listMenus(testEnv, {})).map((m) => m.name)).toEqual([
      'よく食べる',
      'たまに食べる',
      'あまり食べない',
    ]);
  });

  it('存在しないIDの更新はnull、archive切替はfalseを返す', async () => {
    expect(await updateMenu(testEnv, 'nope', { name: 'x', calories: 1 })).toBeNull();
    expect(await setMenuArchived(testEnv, 'nope', true)).toBe(false);
  });
});

describe('食事記録', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('メニューからスナップショット付きで記録し、倍率が実効値に効く', async () => {
    const menu = await createMenu(testEnv, { name: 'カレー', calories: 700, protein_g: 15 });
    const log = await logMeal(testEnv, { menu_id: menu.id, multiplier: 1.5, meal_type: 'dinner' });
    if ('error' in log) throw new Error(log.error);
    expect(log.menu_name).toBe('カレー');
    expect(log.effective_calories).toBeCloseTo(1050);
    expect(log.effective_protein_g).toBeCloseTo(22.5);
    expect(log.effective_fat_g).toBeNull();
  });

  it('メニューを後から編集しても過去の記録は変わらない（スナップショット保全）', async () => {
    const menu = await createMenu(testEnv, { name: 'カレー', calories: 700 });
    const log = await logMeal(testEnv, { menu_id: menu.id });
    if ('error' in log) throw new Error(log.error);
    await updateMenu(testEnv, menu.id, { name: 'カレー改', calories: 900 });
    const logs = await listMealLogs(testEnv, localYmdDaysAgo(1), localYmdDaysAgo(0));
    expect(logs[0].menu_name).toBe('カレー');
    expect(logs[0].calories).toBe(700);
  });

  it('archivedメニュー・未知IDへの記録はエラー', async () => {
    const menu = await createMenu(testEnv, { name: '旧メニュー', calories: 100 });
    await setMenuArchived(testEnv, menu.id, true);
    expect(await logMeal(testEnv, { menu_id: menu.id })).toHaveProperty('error');
    expect(await logMeal(testEnv, { menu_id: 'nope' })).toHaveProperty('error');
  });

  it('記録の修正・削除ができる', async () => {
    const menu = await createMenu(testEnv, { name: 'パン', calories: 200 });
    const log = await logMeal(testEnv, { menu_id: menu.id });
    if ('error' in log) throw new Error(log.error);
    const patched = await updateMealLog(testEnv, log.id, { multiplier: 2 });
    expect(patched?.effective_calories).toBeCloseTo(400);
    expect(await deleteMealLog(testEnv, log.id)).toBe(true);
    expect(await deleteMealLog(testEnv, log.id)).toBe(false);
  });

  it('日次集計はJSTローカル日付境界で行われる', async () => {
    const menu = await createMenu(testEnv, { name: '夜食', calories: 300 });
    // JST 2026-xx-xxの23:30 = 同日UTC 14:30 → ローカルでは当日扱い
    const today = localYmdDaysAgo(0);
    await logMeal(testEnv, { menu_id: menu.id, eaten_at: `${today}T14:30:00Z` });
    await logMeal(testEnv, { menu_id: menu.id, eaten_at: `${today}T03:00:00Z`, multiplier: 2 });
    const daily = await getDailyIntake(testEnv, today, today);
    expect(daily).toHaveLength(1);
    expect(daily[0].count).toBe(2);
    expect(daily[0].calories).toBeCloseTo(900);
  });
});
