/**
 * MCP（Model Context Protocol）サーバー。読み取り専用ツール3つを公開する。
 * リクエストごとにサーバー/トランスポートを生成するステートレス構成
 * （セッションを持たないため、Durable Objects等の追加インフラが不要）。
 */
import { StreamableHTTPTransport } from '@hono/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Context } from 'hono';
import { z } from 'zod';
import { getDailySeries, getRawMeasurements, getSummary } from './queries';
import type { Env } from './types';
import { LIMITS, localToday, noindexHeaders, offsetHours, resolveRange } from './util';

const MCP_SERVER_VERSION = '1.0.0';

function instructions(tzOffsetHours: number): string {
  return [
    '個人の体重・体組成データ（Withings体重計、1ユーザー分）を照会する読み取り専用サーバー。',
    '単位: 質量（weight / fat_mass / fat_free_mass）はkg、fat_ratioのみ%。',
    'fat_mass（脂肪量）は weight - fat_free_mass から導出した値。',
    `日付の境界はUTC${tzOffsetHours >= 0 ? '+' : ''}${tzOffsetHours}のローカル日付。`,
    'まず get_weight_summary で全体像を取り、詳細な推移が必要なときだけ get_daily_series / get_raw_measurements を使う。',
  ].join('\n');
}

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** DBエラー等の内部情報をクライアントに漏らさない（RESTの 'internal error' と同じ方針） */
async function guarded(tool: string, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[mcp] ${tool} failed`, err);
    return errorResult('internal error');
  }
}

const rangeShape = {
  days: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.API_MAX_RANGE_DAYS)
    .optional()
    .describe('今日を末尾とする直近N日（当日含む）。from/toとは併用不可'),
  from: z.string().optional().describe('開始日 YYYY-MM-DD（ローカル日付）'),
  to: z.string().optional().describe('終了日 YYYY-MM-DD（ローカル日付、今日以前）'),
};

function buildServer(env: Env): McpServer {
  const server = new McpServer(
    { name: 'withings-weight-tracker', version: MCP_SERVER_VERSION },
    { instructions: instructions(offsetHours(env)) },
  );
  server.registerTool(
    'get_weight_summary',
    {
      description: '体重データの要約（最新計測・直近7日平均・前週比・基準日比・最終同期）を返す',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guarded('get_weight_summary', async () => jsonResult(await getSummary(env))),
  );
  server.registerTool(
    'get_daily_series',
    {
      description: '日次平均と7日移動平均の時系列を返す（計測がある日のみ）',
      inputSchema: rangeShape,
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guarded('get_daily_series', async () => {
        const range = resolveRange(args, localToday(env));
        if (!range.ok) return errorResult(range.error);
        return jsonResult({ days: await getDailySeries(env, range.from, range.to) });
      }),
  );
  server.registerTool(
    'get_raw_measurements',
    {
      description: '計測1回ごとの明細を返す（新しい順、最大2000件）',
      inputSchema: rangeShape,
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guarded('get_raw_measurements', async () => {
        const range = resolveRange(args, localToday(env));
        if (!range.ok) return errorResult(range.error);
        return jsonResult({ measurements: await getRawMeasurements(env, range.from, range.to) });
      }),
  );
  return server;
}

function rpcError(c: Context<{ Bindings: Env }>, code: number, message: string): Response {
  return c.json({ jsonrpc: '2.0', error: { code, message }, id: null }, 400, noindexHeaders());
}

/**
 * Streamable HTTPのMCPリクエストを処理する。POSTのレスポンスはJSON
 * （enableJsonResponse）にして、SSE非対応のクライアントとテストを単純にする。
 * ステートレス構成でサーバー発信メッセージは無いため、POST以外は405で受けない
 * （MCP仕様: GETのSSEを提供しないサーバーは405を返してよい）。
 */
export async function handleMcpRequest(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.req.method !== 'POST') {
    return c.text('method not allowed', 405, noindexHeaders({ Allow: 'POST' }));
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return rpcError(c, -32700, 'Parse error');
  }
  // JSON-RPCバッチは受けない（MCP 2025-06-18で廃止済み。D1クエリ増幅の防止）
  if (Array.isArray(body)) {
    return rpcError(c, -32600, 'JSON-RPC batch requests are not supported');
  }
  const server = buildServer(c.env);
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const res = await transport.handleRequest(c, body);
  // ステートレスPOST処理では必ずResponseが返る想定。念のためのフォールバック
  if (!res) return c.text('not found', 404, noindexHeaders());
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(noindexHeaders())) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}
