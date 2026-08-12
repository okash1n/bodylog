import { beforeEach, describe, expect, it } from 'vitest';
import { createMenu, getMenu, listMenus, setMenuArchived, updateMenu } from '../src/meals';
import { resetTables, testEnv } from './helpers';

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
    expect(updated?.protein_g).toBeNull(); // 全項目置き換え
  });

  it('listMenusは部分一致検索でき、archivedは既定で除外', async () => {
    const a = await createMenu(testEnv, { name: '鶏むね定食', calories: 600 });
    await createMenu(testEnv, { name: 'サラダ', calories: 100 });
    await setMenuArchived(testEnv, a.id, true);

    expect((await listMenus(testEnv, {})).map((m) => m.name)).toEqual(['サラダ']);
    expect((await listMenus(testEnv, { includeArchived: true })).length).toBe(2);
    expect((await listMenus(testEnv, { q: 'ラダ' })).map((m) => m.name)).toEqual(['サラダ']);
  });

  it('存在しないIDの更新はnull、archive切替はfalseを返す', async () => {
    expect(await updateMenu(testEnv, 'nope', { name: 'x', calories: 1 })).toBeNull();
    expect(await setMenuArchived(testEnv, 'nope', true)).toBe(false);
  });
});
