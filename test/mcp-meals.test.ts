import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMenu, logMeal } from '../src/meals';
import worker from '../src/index';
import {
  mcpRpc as rwRpc, localYmdDaysAgo, obtainAccessToken, parseToolJson, resetTables,
  rootTestEnv as rootEnv, testEnv,
} from './helpers';

interface RpcResponse {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

describe('/mcp 書き込みツール', () => {
  let token: string;
  beforeEach(async () => {
    await resetTables();
    token = await obtainAccessToken(rootEnv);
  });

  it('トークン無しは401', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      rootEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(401);
  });

  it('tools/list に書き込みツールが現れる', async () => {
    const res = await rwRpc(rootEnv, token, 'tools/list');
    const tools = ((await res.json()) as RpcResponse).result!.tools as { name: string }[];
    expect(tools.map((t) => t.name)).toContain('log_meal');
    expect(tools.map((t) => t.name)).toContain('create_menu');
  });

  it('search_menus が部分一致で返す', async () => {
    await createMenu(testEnv, { name: '唐揚げ定食', calories: 850 });
    const res = await rwRpc(rootEnv, token, 'tools/call', { name: 'search_menus', arguments: { q: '唐揚げ' } });
    const data = parseToolJson<{ menus: { name: string }[] }>(((await res.json()) as RpcResponse).result!);
    expect(data.menus[0].name).toBe('唐揚げ定食');
  });

  it('get_meal_logs が実効値付きで返す', async () => {
    const menu = await createMenu(testEnv, { name: '唐揚げ定食', calories: 850 });
    await logMeal(testEnv, { menu_id: menu.id, eaten_at: `${localYmdDaysAgo(0)}T03:00:00Z` });
    const res = await rwRpc(rootEnv, token, 'tools/call', { name: 'get_meal_logs', arguments: { days: 7 } });
    const data = parseToolJson<{ meals: { effective_calories: number }[] }>(((await res.json()) as RpcResponse).result!);
    expect(data.meals[0].effective_calories).toBeCloseTo(850);
  });

  it('create_menu → log_meal（メニュー名解決）で記録できる', async () => {
    const created = await rwRpc(rootEnv, token, 'tools/call', {
      name: 'create_menu',
      arguments: { name: '豚汁', calories: 250, protein_g: 12 },
    });
    expect(((await created.json()) as RpcResponse).result!.isError).toBeUndefined();

    const logged = await rwRpc(rootEnv, token, 'tools/call', {
      name: 'log_meal',
      arguments: { menu_name: '豚汁', multiplier: 2, meal_type: 'dinner' },
    });
    const log = parseToolJson<{ effective_calories: number }>(((await logged.json()) as RpcResponse).result!);
    expect(log.effective_calories).toBeCloseTo(500);
  });

  it('log_meal: メニュー名が曖昧なら候補付きisError、見つからなければisError', async () => {
    await createMenu(testEnv, { name: 'カレーライス', calories: 700 });
    await createMenu(testEnv, { name: 'カレーうどん', calories: 600 });
    const ambiguous = await rwRpc(rootEnv, token, 'tools/call', {
      name: 'log_meal',
      arguments: { menu_name: 'カレー' },
    });
    const body = ((await ambiguous.json()) as RpcResponse).result!;
    expect(body.isError).toBe(true);
    expect((body.content as { text: string }[])[0].text).toContain('カレーライス');

    const missing = await rwRpc(rootEnv, token, 'tools/call', {
      name: 'log_meal',
      arguments: { menu_name: '存在しない' },
    });
    expect(((await missing.json()) as RpcResponse).result!.isError).toBe(true);
  });
});

describe('/mcp 編集・削除ツール（食事）', () => {
  let token: string;
  beforeEach(async () => {
    await resetTables();
    token = await obtainAccessToken(rootEnv);
  });
  const call = async (name: string, args: Record<string, unknown>): Promise<RpcResponse> =>
    (await (await rwRpc(rootEnv, token, 'tools/call', { name, arguments: args })).json()) as RpcResponse;
  const isError = (r: RpcResponse): boolean => (r.result as { isError?: boolean }).isError === true;

  it('update_menu は指定項目だけ更新し、null で栄養素を消せる。未知IDや項目なしはエラー', async () => {
    const menu = await createMenu(testEnv, { name: '唐揚げ定食', calories: 850, protein_g: 30 });
    const ok = await call('update_menu', { menu_id: menu.id, calories: 800, protein_g: null });
    const updated = parseToolJson<{ name: string; calories: number; protein_g: number | null }>(ok.result!);
    expect(updated.name).toBe('唐揚げ定食');
    expect(updated.calories).toBe(800);
    expect(updated.protein_g).toBeNull();
    expect(isError(await call('update_menu', { menu_id: 'nope', calories: 1 }))).toBe(true);
    expect(isError(await call('update_menu', { menu_id: menu.id }))).toBe(true);
  });

  it('archive_menu で検索から消え、archived:false で戻る', async () => {
    const menu = await createMenu(testEnv, { name: '豚汁', calories: 250 });
    expect(isError(await call('archive_menu', { menu_id: menu.id }))).toBe(false);
    expect(parseToolJson<{ menus: unknown[] }>((await call('search_menus', { q: '豚汁' })).result!).menus).toHaveLength(0);
    expect(isError(await call('archive_menu', { menu_id: menu.id, archived: false }))).toBe(false);
    expect(parseToolJson<{ menus: unknown[] }>((await call('search_menus', { q: '豚汁' })).result!).menus).toHaveLength(1);
    expect(isError(await call('archive_menu', { menu_id: 'nope' }))).toBe(true);
  });

  it('update_meal_log は倍率・区分を直し、delete_meal_log で消える', async () => {
    const menu = await createMenu(testEnv, { name: 'カレーライス', calories: 700 });
    const log = await logMeal(testEnv, { menu_id: menu.id, eaten_at: `${localYmdDaysAgo(0)}T03:00:00Z` });
    if ('error' in log) throw new Error(log.error);
    const updated = parseToolJson<{ effective_calories: number; meal_type: string | null }>(
      (await call('update_meal_log', { meal_id: log.id, multiplier: 2, meal_type: 'dinner' })).result!,
    );
    expect(updated.effective_calories).toBeCloseTo(1400);
    expect(updated.meal_type).toBe('dinner');
    expect(isError(await call('update_meal_log', { meal_id: log.id }))).toBe(true); // 項目なし
    expect(isError(await call('update_meal_log', { meal_id: 'nope', multiplier: 1 }))).toBe(true);

    expect(isError(await call('delete_meal_log', { meal_id: log.id }))).toBe(false);
    expect(parseToolJson<{ meals: unknown[] }>((await call('get_meal_logs', { days: 7 })).result!).meals).toHaveLength(0);
    expect(isError(await call('delete_meal_log', { meal_id: log.id }))).toBe(true);
  });
});
