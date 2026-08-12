import { createExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { createMenu, logMeal } from '../src/meals';
import { createRootDashboardRouter } from '../src/dashboard';
import worker from '../src/index';
import { localYmdDaysAgo, obtainAccessToken, resetTables, testEnv } from './helpers';

const rootEnv: Env = { ...testEnv, DASHBOARD_SLUG: '' };
const app = new Hono<{ Bindings: Env }>().route('/', createRootDashboardRouter());

interface RpcResponse {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let nextId = 1;

async function rpc(
  target: Hono<{ Bindings: Env }>,
  env: Env,
  path: string,
  method: string,
  params?: unknown,
): Promise<Response> {
  return target.request(
    path,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: params ?? {} }),
    },
    env,
    createExecutionContext(),
  );
}

/** ツール結果のtextコンテンツ（JSON文字列）をパースして返す */
function parseToolJson<T>(result: Record<string, unknown>): T {
  const content = result.content as { type: string; text: string }[];
  expect(content[0]?.type).toBe('text');
  return JSON.parse(content[0].text) as T;
}

describe('MCP食事ツール（公開）', () => {
  beforeEach(async () => {
    await resetTables();
    const menu = await createMenu(testEnv, { name: '唐揚げ定食', calories: 850 });
    await logMeal(testEnv, { menu_id: menu.id, eaten_at: `${localYmdDaysAgo(0)}T03:00:00Z` });
  });

  it('tools/list に search_menus と get_meal_logs が現れる（書き込みツールは現れない）', async () => {
    const res = await rpc(app, rootEnv, '/mcp', 'tools/list');
    const body = (await res.json()) as RpcResponse;
    const tools = (body.result as { tools: { name: string }[] }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('search_menus');
    expect(names).toContain('get_meal_logs');
    expect(names).not.toContain('log_meal');
    expect(names).not.toContain('create_menu');
  });

  it('search_menus が部分一致で返す', async () => {
    const res = await rpc(app, rootEnv, '/mcp', 'tools/call', { name: 'search_menus', arguments: { q: '唐揚げ' } });
    const body = (await res.json()) as RpcResponse;
    const data = parseToolJson<{ menus: { name: string }[] }>(body.result!);
    expect(data.menus[0].name).toBe('唐揚げ定食');
  });

  it('get_meal_logs が実効値付きで返す', async () => {
    const res = await rpc(app, rootEnv, '/mcp', 'tools/call', { name: 'get_meal_logs', arguments: { days: 7 } });
    const body = (await res.json()) as RpcResponse;
    const data = parseToolJson<{ meals: { effective_calories: number }[] }>(body.result!);
    expect(data.meals[0].effective_calories).toBeCloseTo(850);
  });
});

async function rwRpc(env: Env, token: string, method: string, params?: unknown): Promise<Response> {
  return worker.fetch(
    new Request('http://localhost/rw/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method, params: params ?? {} }),
    }),
    env,
    createExecutionContext(),
  );
}

describe('/rw/mcp 書き込みツール', () => {
  let token: string;
  beforeEach(async () => {
    await resetTables();
    token = await obtainAccessToken(rootEnv);
  });

  it('トークン無しは401', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/rw/mcp', {
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
