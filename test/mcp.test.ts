import { createExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { createDashboardRouter, createRootDashboardRouter } from '../src/dashboard';
import worker from '../src/index';
import { insertMeasurement, localYmdDaysAgo, resetTables, testEnv } from './helpers';

const rootEnv: Env = { ...testEnv, DASHBOARD_SLUG: '' };
const app = new Hono<{ Bindings: Env }>().route('/', createRootDashboardRouter());
const slugApp = new Hono<{ Bindings: Env }>().route('/d', createDashboardRouter());

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

describe('MCPサーバー（/mcp）', () => {
  beforeEach(async () => {
    await resetTables();
    // 03:00Z = JST正午。日付境界（00:00-01:00 JST実行時のフレーク）を避けるため固定時刻でseedする
    await insertMeasurement({
      grpid: 1,
      measured_at: `${localYmdDaysAgo(0)}T03:00:00Z`,
      weight: 70,
      fat_free_mass: 50,
    });
  });

  it('initializeに応答する（ステートレス・セッションIDなし）', async () => {
    const res = await rpc(app, rootEnv, '/mcp', 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    expect(body.error).toBeUndefined();
    const serverInfo = (body.result as { serverInfo: { name: string } }).serverInfo;
    expect(serverInfo.name).toBe('withings-weight-tracker');
  });

  it('tools/list が読み取り専用ツール5つを返す', async () => {
    const res = await rpc(app, rootEnv, '/mcp', 'tools/list');
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    const tools = (body.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_daily_series',
      'get_meal_logs',
      'get_raw_measurements',
      'get_weight_summary',
      'search_menus',
    ]);
  });

  it('get_weight_summary が要約JSONを返す', async () => {
    const res = await rpc(app, rootEnv, '/mcp', 'tools/call', {
      name: 'get_weight_summary',
      arguments: {},
    });
    const body = (await res.json()) as RpcResponse;
    expect(body.error).toBeUndefined();
    const summary = parseToolJson<{ latest: { weight: number }; units: { mass: string } }>(
      body.result!,
    );
    expect(summary.latest.weight).toBeCloseTo(70);
    expect(summary.units.mass).toBe('kg');
  });

  it('get_daily_series が days 指定で時系列を返す', async () => {
    const res = await rpc(app, rootEnv, '/mcp', 'tools/call', {
      name: 'get_daily_series',
      arguments: { days: 30 },
    });
    const body = (await res.json()) as RpcResponse;
    const series = parseToolJson<{ days: { d: string; weight: number }[] }>(body.result!);
    expect(series.days.map((p) => p.d)).toContain(localYmdDaysAgo(0));
  });

  it('get_raw_measurements が from/to 指定で明細を返す', async () => {
    const res = await rpc(app, rootEnv, '/mcp', 'tools/call', {
      name: 'get_raw_measurements',
      arguments: { from: localYmdDaysAgo(7), to: localYmdDaysAgo(0) },
    });
    const body = (await res.json()) as RpcResponse;
    const raw = parseToolJson<{ measurements: { weight: number }[] }>(body.result!);
    expect(raw.measurements).toHaveLength(1);
    expect(raw.measurements[0].weight).toBeCloseTo(70);
  });

  it('daysとfrom/toの併用はisErrorのツール結果になる', async () => {
    const res = await rpc(app, rootEnv, '/mcp', 'tools/call', {
      name: 'get_daily_series',
      arguments: { days: 7, from: localYmdDaysAgo(3) },
    });
    const body = (await res.json()) as RpcResponse;
    expect(body.error).toBeUndefined();
    expect(body.result!.isError).toBe(true);
  });

  it('スキーマ違反（days上限超え）はisErrorのツール結果になる', async () => {
    const res = await rpc(app, rootEnv, '/mcp', 'tools/call', {
      name: 'get_daily_series',
      arguments: { days: 5000 },
    });
    const body = (await res.json()) as RpcResponse;
    expect(body.error).toBeUndefined();
    expect(body.result!.isError).toBe(true);
    const content = body.result!.content as { text: string }[];
    expect(content[0].text).toContain('731');
  });

  it('POST以外は405（ステートレス構成ではSSEを提供しない）', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await app.request(
        '/mcp',
        { method, headers: { Accept: 'text/event-stream' } },
        rootEnv,
        createExecutionContext(),
      );
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('POST');
    }
  });

  it('JSON-RPCバッチ（配列ボディ）は400で拒否する', async () => {
    const res = await app.request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_weight_summary', arguments: {} } },
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_weight_summary', arguments: {} } },
        ]),
      },
      rootEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });

  it('不正JSONボディは-32700を返す', async () => {
    const res = await app.request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: '{not json',
      },
      rootEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('POST応答にもX-Robots-Tag: noindexが付く', async () => {
    const res = await rpc(app, rootEnv, '/mcp', 'tools/list');
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
  });

  // ChatGPT（openai-mcp）はSDK未対応の新しいプロトコル版ヘッダを交渉前から送る。
  // ヘッダ検証で拒否せず、initialize本文のバージョン交渉に任せることを保証する
  it('SDK未対応のMCP-Protocol-Versionヘッダが付いていても処理できる', async () => {
    const res = await app.request(
      '/mcp',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }),
      },
      rootEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    expect((body.result as { tools: unknown[] }).tools).toHaveLength(5);
  });

  it('未対応バージョンヘッダ付きinitializeはサーバー対応版へ交渉される', async () => {
    const res = await app.request(
      '/mcp',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 11,
          method: 'initialize',
          params: {
            protocolVersion: '2026-07-28',
            capabilities: {},
            clientInfo: { name: 'openai-mcp', version: '1.0.0' },
          },
        }),
      },
      rootEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    const negotiated = (body.result as { protocolVersion: string }).protocolVersion;
    // サーバーが対応する版（YYYY-MM-DD形式）にダウングレードして返す
    expect(negotiated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(negotiated <= '2025-11-25').toBe(true);
  });

  // @hono/mcp の検証エラー（HTTPException）がグローバルonErrorで500化されず、
  // 本来の4xxで返ることを保証する
  it('不正なAcceptヘッダは500ではなく406で返る', async () => {
    const res = await app.request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/html' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/list', params: {} }),
      },
      rootEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(406);
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
  });

  // 本番はsrc/index.tsのグローバルonError配下で動く。HTTPExceptionが500化される
  // 回帰（ChatGPTコネクタ作成失敗の原因）を防ぐ統合テスト
  it('本番構成（index.ts経由）でも未対応バージョンヘッダが500にならない', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2026-07-28',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'tools/list', params: {} }),
      }),
      rootEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
  });

  it('slugモードでは /d/{slug}/mcp で動き、ドメイン直下は404', async () => {
    const ok = await rpc(slugApp, testEnv, '/d/testslug/mcp', 'tools/list');
    expect(ok.status).toBe(200);
    const ng = await rpc(app, testEnv, '/mcp', 'tools/list');
    expect(ng.status).toBe(404);
  });
});
