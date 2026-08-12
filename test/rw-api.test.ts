import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import worker from '../src/index';
import { createMenu, setMenuArchived } from '../src/meals';
import { obtainAccessToken, resetTables, testEnv } from './helpers';

const rootEnv: Env = { ...testEnv, DASHBOARD_SLUG: '' };

function rw(path: string, token: string | null, method: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    rootEnv,
    createExecutionContext(),
  );
}

describe('/rw/ 書き込みAPI', () => {
  let token: string;
  beforeEach(async () => {
    await resetTables();
    token = await obtainAccessToken(rootEnv);
  });

  it('トークン無し・不正トークンは401', async () => {
    expect((await rw('/rw/menus', null, 'POST', { name: 'x', calories: 1 })).status).toBe(401);
    expect((await rw('/rw/menus', 'bogus', 'POST', { name: 'x', calories: 1 })).status).toBe(401);
  });

  it('メニューの作成・更新・アーカイブができる', async () => {
    const created = await rw('/rw/menus', token, 'POST', { name: '牛丼', calories: 700, protein_g: 20 });
    expect(created.status).toBe(201);
    const menu = (await created.json()) as { id: string };

    const patched = await rw(`/rw/menus/${menu.id}`, token, 'PATCH', { name: '牛丼大盛', calories: 900 });
    expect(patched.status).toBe(200);
    const patchedMenu = (await patched.json()) as { name: string; calories: number; protein_g: number | null };
    expect(patchedMenu.name).toBe('牛丼大盛');
    expect(patchedMenu.calories).toBe(900);
    // PATCHで送らなかったフィールドは保持される（部分更新。フルリプレイスでnull消去する回帰を防ぐ）
    expect(patchedMenu.protein_g).toBe(20);

    expect((await rw(`/rw/menus/${menu.id}/archive`, token, 'POST')).status).toBe(200);
    expect((await rw(`/rw/menus/${menu.id}/unarchive`, token, 'POST')).status).toBe(200);
  });

  it('メニューPATCHは真の部分更新: 未指定は保持、明示nullはクリア、空パッチは400', async () => {
    const created = await rw('/rw/menus', token, 'POST', {
      name: '定食', calories: 800, protein_g: 25, fat_g: 15, carbs_g: 90, note: 'メモ',
    });
    const menu = (await created.json()) as { id: string };

    // nameだけ送る → calories/protein_g/fat_g/carbs_g/noteは保持される
    const onlyName = await rw(`/rw/menus/${menu.id}`, token, 'PATCH', { name: '定食大盛' });
    expect(onlyName.status).toBe(200);
    const afterOnlyName = (await onlyName.json()) as {
      name: string; calories: number; protein_g: number | null; fat_g: number | null;
      carbs_g: number | null; note: string | null;
    };
    expect(afterOnlyName.name).toBe('定食大盛');
    expect(afterOnlyName.calories).toBe(800);
    expect(afterOnlyName.protein_g).toBe(25);
    expect(afterOnlyName.fat_g).toBe(15);
    expect(afterOnlyName.carbs_g).toBe(90);
    expect(afterOnlyName.note).toBe('メモ');

    // protein_g: null を明示送信 → protein_gだけクリアされ、他は保持される
    const cleared = await rw(`/rw/menus/${menu.id}`, token, 'PATCH', { protein_g: null });
    expect(cleared.status).toBe(200);
    const afterCleared = (await cleared.json()) as {
      name: string; protein_g: number | null; fat_g: number | null; carbs_g: number | null;
    };
    expect(afterCleared.protein_g).toBeNull();
    expect(afterCleared.fat_g).toBe(15);
    expect(afterCleared.carbs_g).toBe(90);
    expect(afterCleared.name).toBe('定食大盛');

    // 有効フィールドが1つも無い空パッチは400
    expect((await rw(`/rw/menus/${menu.id}`, token, 'PATCH', {})).status).toBe(400);
  });

  it('バリデーション: caloriesが負・multiplier過大・不正meal_typeは400', async () => {
    expect((await rw('/rw/menus', token, 'POST', { name: 'x', calories: -1 })).status).toBe(400);
    const menu = await createMenu(testEnv, { name: 'a', calories: 100 });
    expect((await rw('/rw/meals', token, 'POST', { menu_id: menu.id, multiplier: 100 })).status).toBe(400);
    expect((await rw('/rw/meals', token, 'POST', { menu_id: menu.id, meal_type: 'brunch' })).status).toBe(400);
  });

  it('記録の作成（201）→修正→削除。archivedメニューへの記録は400', async () => {
    const menu = await createMenu(testEnv, { name: 'b', calories: 500 });
    const res = await rw('/rw/meals', token, 'POST', { menu_id: menu.id, multiplier: 1.5, meal_type: 'lunch' });
    expect(res.status).toBe(201);
    const log = (await res.json()) as { id: string; effective_calories: number };
    expect(log.effective_calories).toBeCloseTo(750);

    expect((await rw(`/rw/meals/${log.id}`, token, 'PATCH', { multiplier: 1 })).status).toBe(200);
    expect((await rw(`/rw/meals/${log.id}`, token, 'DELETE')).status).toBe(200);
    expect((await rw(`/rw/meals/${log.id}`, token, 'DELETE')).status).toBe(404);

    await setMenuArchived(testEnv, menu.id, true);
    expect((await rw('/rw/meals', token, 'POST', { menu_id: menu.id })).status).toBe(400);
  });

  it('未来のeaten_atは400', async () => {
    const menu = await createMenu(testEnv, { name: 'c', calories: 100 });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await rw('/rw/meals', token, 'POST', { menu_id: menu.id, eaten_at: future })).status).toBe(400);
  });
});
