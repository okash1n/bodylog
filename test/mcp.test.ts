import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import {
  insertMeasurement, localYmdDaysAgo, mcpRpc, obtainAccessToken, parseToolJson,
  resetTables, rootTestEnv as rootEnv,
} from './helpers';

// MCPは OAuth 必須の /mcp のみ（旧 /rw/mcp は廃止）。
// protocol層の挙動（handleMcpRequest）は /mcp 経由（=providerのapiHandler配下）で検証する。
const RW_MCP = 'http://localhost/mcp';

interface RpcResponse {
  jsonrpc: string;
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** 認証付きで /mcp にJSON-RPCを投げる */
const rwRpc = (token: string, method: string, params?: unknown, extraHeaders?: Record<string, string>): Promise<Response> =>
  mcpRpc(rootEnv, token, method, params, extraHeaders);

/** 認証付きで /mcp に任意のボディ/メソッドで投げる（不正ボディ・非POSTの検証用） */
function rwRaw(token: string, init: RequestInit): Promise<Response> {
  return worker.fetch(
    new Request(RW_MCP, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
    }),
    rootEnv,
    createExecutionContext(),
  );
}

describe('MCPサーバー（/mcp・OAuth必須）', () => {
  let token: string;
  beforeEach(async () => {
    await resetTables();
    token = await obtainAccessToken(rootEnv);
    // 03:00Z = JST正午。日付境界（00:00-01:00 JST実行時のフレーク）を避けるため固定時刻でseedする
    await insertMeasurement({
      grpid: 1,
      measured_at: `${localYmdDaysAgo(0)}T03:00:00Z`,
      weight: 70,
      fat_free_mass: 50,
    });
  });

  it('トークン無しは401（無認証MCPは廃止）', async () => {
    const res = await worker.fetch(
      new Request(RW_MCP, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      rootEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(401);
  });

  it('/mcp（短いパス）もOAuth必須で、認証付きならtools/listを返す', async () => {
    const anon = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      rootEnv,
      createExecutionContext(),
    );
    expect(anon.status).toBe(401);
    const authed = await worker.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      rootEnv,
      createExecutionContext(),
    );
    expect(authed.status).toBe(200);
    const body = (await authed.json()) as RpcResponse;
    expect((body.result as { tools: unknown[] }).tools).toHaveLength(13);
  });

  it('initializeに応答する（ステートレス・セッションIDなし）', async () => {
    const res = await rwRpc(token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    expect(body.error).toBeUndefined();
    const serverInfo = (body.result as { serverInfo: { name: string } }).serverInfo;
    expect(serverInfo.name).toBe('bodylog');
  });

  it('tools/list が読み取り7＋書き込み6ツールを返す', async () => {
    const res = await rwRpc(token, 'tools/list');
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    const names = (body.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'create_exercise_menu',
      'create_menu',
      'get_daily_series',
      'get_exercise_logs',
      'get_meal_logs',
      'get_raw_measurements',
      'get_weight_summary',
      'log_exercise',
      'log_meal',
      'log_weight',
      'search_exercise_menus',
      'search_menus',
      'set_goal',
    ]);
  });

  it('log_weight で手動体重を記録できる', async () => {
    const res = await rwRpc(token, 'tools/call', {
      name: 'log_weight',
      arguments: { weight_kg: 83.4, fat_ratio: 28.3, measured_at: `${localYmdDaysAgo(1)}T03:00:00Z` },
    });
    const body = (await res.json()) as RpcResponse;
    expect(body.error).toBeUndefined();
    const saved = parseToolJson<{ id: number; source: string; fat_free_mass: number }>(
      body.result as Record<string, unknown>,
    );
    expect(saved.source).toBe('manual');
    expect(saved.id).toBeLessThan(0);
    expect(saved.fat_free_mass).toBeCloseTo(83.4 * (1 - 0.283), 2);
  });

  it('log_weight のバリデーションエラーはisErrorで返る', async () => {
    const res = await rwRpc(token, 'tools/call', { name: 'log_weight', arguments: { weight_kg: 10 } });
    const body = (await res.json()) as RpcResponse;
    expect((body.result as { isError?: boolean }).isError).toBe(true);
  });

  it('get_weight_summary が要約JSONを返す', async () => {
    const res = await rwRpc(token, 'tools/call', { name: 'get_weight_summary', arguments: {} });
    const body = (await res.json()) as RpcResponse;
    expect(body.error).toBeUndefined();
    const summary = parseToolJson<{ latest: { weight: number }; units: { mass: string } }>(body.result!);
    expect(summary.latest.weight).toBeCloseTo(70);
    expect(summary.units.mass).toBe('kg');
  });

  it('get_daily_series が days 指定で時系列を返す', async () => {
    const res = await rwRpc(token, 'tools/call', { name: 'get_daily_series', arguments: { days: 30 } });
    const body = (await res.json()) as RpcResponse;
    const series = parseToolJson<{ days: { d: string; weight: number }[] }>(body.result!);
    expect(series.days.map((p) => p.d)).toContain(localYmdDaysAgo(0));
  });

  it('get_raw_measurements が from/to 指定で明細を返す', async () => {
    const res = await rwRpc(token, 'tools/call', {
      name: 'get_raw_measurements',
      arguments: { from: localYmdDaysAgo(7), to: localYmdDaysAgo(0) },
    });
    const body = (await res.json()) as RpcResponse;
    const raw = parseToolJson<{ measurements: { weight: number }[] }>(body.result!);
    expect(raw.measurements).toHaveLength(1);
    expect(raw.measurements[0].weight).toBeCloseTo(70);
  });

  it('daysとfrom/toの併用はisErrorのツール結果になる', async () => {
    const res = await rwRpc(token, 'tools/call', {
      name: 'get_daily_series',
      arguments: { days: 7, from: localYmdDaysAgo(3) },
    });
    const body = (await res.json()) as RpcResponse;
    expect(body.error).toBeUndefined();
    expect(body.result!.isError).toBe(true);
  });

  it('スキーマ違反（days上限超え）はisErrorのツール結果になる', async () => {
    const res = await rwRpc(token, 'tools/call', { name: 'get_daily_series', arguments: { days: 5000 } });
    const body = (await res.json()) as RpcResponse;
    expect(body.error).toBeUndefined();
    expect(body.result!.isError).toBe(true);
    const content = body.result!.content as { text: string }[];
    expect(content[0].text).toContain('731');
  });

  it('POST以外（トークンあり）は405（ステートレス構成ではSSEを提供しない）', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await rwRaw(token, { method, headers: { Accept: 'text/event-stream' } });
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('POST');
    }
  });

  it('JSON-RPCバッチ（配列ボディ）は400で拒否する', async () => {
    const res = await rwRaw(token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_weight_summary', arguments: {} } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_weight_summary', arguments: {} } },
      ]),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });

  it('不正JSONボディは-32700を返す', async () => {
    const res = await rwRaw(token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('POST応答にもX-Robots-Tag: noindexが付く', async () => {
    const res = await rwRpc(token, 'tools/list');
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
  });

  // ChatGPT（openai-mcp）はSDK未対応の新しいプロトコル版ヘッダを交渉前から送る。
  // ヘッダ検証で拒否せず、initialize本文のバージョン交渉に任せることを保証する
  it('SDK未対応のMCP-Protocol-Versionヘッダが付いていても処理できる', async () => {
    const res = await rwRpc(token, 'tools/list', {}, { 'MCP-Protocol-Version': '2026-07-28' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    expect((body.result as { tools: unknown[] }).tools).toHaveLength(13);
  });

  it('未対応バージョンヘッダ付きinitializeはサーバー対応版へ交渉される', async () => {
    const res = await rwRpc(
      token,
      'initialize',
      { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'openai-mcp', version: '1.0.0' } },
      { 'MCP-Protocol-Version': '2026-07-28' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    const negotiated = (body.result as { protocolVersion: string }).protocolVersion;
    // サーバーが対応する版（YYYY-MM-DD形式）にダウングレードして返す
    expect(negotiated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(negotiated <= '2025-11-25').toBe(true);
  });

  // @hono/mcp の検証エラー（HTTPException）がグローバルonErrorで500化されず、本来の4xxで返る
  it('不正なAcceptヘッダは500ではなく406で返る', async () => {
    const res = await rwRaw(token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/html' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(406);
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
  });
});
