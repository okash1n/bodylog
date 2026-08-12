/**
 * MCP（Model Context Protocol）サーバー。公開エンドポイント（/mcp）では読み取り専用
 * ツール5つを、認証済みエンドポイント（/rw/mcp）では書き込みツール2つ（log_meal /
 * create_menu）を追加で公開する。
 * リクエストごとにサーバー/トランスポートを生成するステートレス構成
 * （セッションを持たないため、Durable Objects等の追加インフラが不要）。
 */
import { StreamableHTTPTransport } from '@hono/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { getDailySeries, getRawMeasurements, getSummary } from './queries';
import { createMenu, listMealLogs, listMenus, logMeal, parseMealFields, parseMenuInput } from './meals';
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
    '食事記録はsearch_menus / get_meal_logsで照会できる（記録・メニュー作成は認可済みエンドポイント/rw/mcpのみ）。',
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

function buildServer(env: Env, opts: { write: boolean }): McpServer {
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
  server.registerTool(
    'search_menus',
    {
      description: '登録済みの食事メニュー（マスタ）を名前の部分一致で検索する',
      inputSchema: { q: z.string().optional().describe('検索語（省略時は全件、最大500件）') },
      annotations: { readOnlyHint: true },
    },
    (args) => guarded('search_menus', async () =>
      jsonResult({ menus: await listMenus(env, { q: args.q }) })),
  );
  server.registerTool(
    'get_meal_logs',
    {
      description: '食事記録を返す（メニュー名・倍率・実効kcal/PFC付き）。daysまたはfrom/toで期間指定',
      inputSchema: rangeShape,
      annotations: { readOnlyHint: true },
    },
    (args) => guarded('get_meal_logs', async () => {
      const range = resolveRange(args, localToday(env));
      if (!range.ok) return errorResult(range.error);
      return jsonResult({ meals: await listMealLogs(env, range.from, range.to) });
    }),
  );
  if (opts.write) {
    server.registerTool(
      'log_meal',
      {
        description:
          '食事を記録する。menu_id か menu_name で登録済みメニューを指定する（メニューにない食事は記録できない。無ければユーザーに確認の上create_menuで登録してから記録する）',
        inputSchema: {
          menu_id: z.string().optional().describe('メニューID（search_menusで取得）'),
          menu_name: z.string().optional().describe('メニュー名（完全一致→一意な部分一致の順で解決）'),
          multiplier: z.number().positive().max(20).optional().describe('倍率（省略時1.0）'),
          eaten_at: z.string().optional().describe('食べた日時 ISO8601（省略時は現在時刻）'),
          meal_type: z.enum(['breakfast', 'lunch', 'dinner', 'snack']).optional(),
        },
      },
      (args) => guarded('log_meal', async () => {
        let menuId = args.menu_id;
        if (!menuId && args.menu_name) {
          const all = await listMenus(env, { q: args.menu_name });
          const exact = all.filter((m) => m.name === args.menu_name);
          const candidates = exact.length > 0 ? exact : all;
          if (candidates.length === 0) return errorResult(`menu not found: ${args.menu_name}`);
          if (candidates.length > 1) {
            return errorResult(
              `menu name is ambiguous: ${candidates.slice(0, 5).map((m) => m.name).join(' / ')}`,
            );
          }
          menuId = candidates[0].id;
        }
        if (!menuId) return errorResult('menu_id or menu_name is required');
        const fields = parseMealFields(args as Record<string, unknown>);
        if (!fields.ok) return errorResult(fields.error);
        const log = await logMeal(env, { menu_id: menuId, ...fields.value });
        if ('error' in log) return errorResult(log.error);
        return jsonResult(log);
      }),
    );
    server.registerTool(
      'create_menu',
      {
        description:
          '食事メニュー（マスタ）を新規登録する。ユーザーが明示的にメニュー登録を依頼したときだけ使うこと',
        inputSchema: {
          name: z.string().describe('メニュー名'),
          calories: z.number().positive().describe('1食分のkcal'),
          protein_g: z.number().positive().optional(),
          fat_g: z.number().positive().optional(),
          carbs_g: z.number().positive().optional(),
          note: z.string().optional(),
        },
      },
      (args) => guarded('create_menu', async () => {
        const parsed = parseMenuInput(args);
        if (!parsed.ok) return errorResult(parsed.error);
        return jsonResult(await createMenu(env, parsed.value));
      }),
    );
  }
  return server;
}

function rpcError(c: Context<{ Bindings: Env }>, code: number, message: string): Response {
  return c.json({ jsonrpc: '2.0', error: { code, message }, id: null }, 400, noindexHeaders());
}

function withNoindex(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(noindexHeaders())) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

async function dispatchToTransport(
  c: Context<{ Bindings: Env }>,
  body: unknown,
  write: boolean,
): Promise<Response> {
  const server = buildServer(c.env, { write });
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const res = await transport.handleRequest(c, body);
  // ステートレスPOST処理では必ずResponseが返る想定。念のためのフォールバック
  if (!res) return c.text('not found', 404, noindexHeaders());
  return withNoindex(res);
}

/**
 * Streamable HTTPのMCPリクエストを処理する。POSTのレスポンスはJSON
 * （enableJsonResponse）にして、SSE非対応のクライアントとテストを単純にする。
 * ステートレス構成でサーバー発信メッセージは無いため、POST以外は405で受けない
 * （MCP仕様: GETのSSEを提供しないサーバーは405を返してよい）。
 */
export async function handleMcpRequest(
  c: Context<{ Bindings: Env }>,
  opts?: { write?: boolean },
): Promise<Response> {
  const write = opts?.write ?? false;
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
  // クライアント互換性問題の切り分け用（bodyはtailに出ないため、メソッドとツール名だけ残す）
  if (typeof body === 'object' && body !== null) {
    const b = body as { method?: unknown; params?: { name?: unknown } };
    console.log('[mcp] request', String(b.method ?? '?'), String(b.params?.name ?? ''));
  }
  try {
    // ChatGPT（openai-mcp）等はSDK未対応の新しいMCP-Protocol-Versionヘッダを
    // 交渉前から送り、@hono/mcpはそれをヘッダ検証404でthrowする。未対応版は
    // ヘッダを外し、initialize本文でのバージョン交渉（サーバー対応版への
    // ダウングレード）に任せる
    const protocolVersion = c.req.header('mcp-protocol-version');
    if (protocolVersion !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      const headers = new Headers(c.req.raw.headers);
      headers.delete('mcp-protocol-version');
      const inner = new Hono<{ Bindings: Env }>()
        .post('*', (ic) => dispatchToTransport(ic, body, write))
        .onError((err, ic) => {
          if (err instanceof HTTPException) return withNoindex(err.getResponse());
          console.error('[mcp] transport error', err);
          return ic.text('internal error', 500, noindexHeaders());
        });
      return await inner.fetch(
        new Request(c.req.url, { method: 'POST', headers, body: JSON.stringify(body) }),
        c.env,
        c.executionCtx,
      );
    }
    return await dispatchToTransport(c, body, write);
  } catch (err) {
    // @hono/mcpは検証エラー（Accept/Content-Type/セッション等）をHTTPExceptionで
    // throwする。グローバルonErrorに渡すと500になるため、本来の4xxで返す
    if (err instanceof HTTPException) return withNoindex(err.getResponse());
    throw err;
  }
}
