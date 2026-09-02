import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { logExercise } from '../src/exercise';
import {
  createExerciseMenuOk, insertMeasurement, localYmdDaysAgo, mcpRpc, obtainAccessToken,
  parseToolJson, resetTables, rootTestEnv as rootEnv,
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
    expect((body.result as { tools: unknown[] }).tools).toHaveLength(22);
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

  it('tools/list が読み取り8＋書き込み14ツールを返す', async () => {
    const res = await rwRpc(token, 'tools/list');
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    const names = (body.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'archive_exercise_menu',
      'archive_menu',
      'create_exercise_menu',
      'create_menu',
      'delete_exercise_log',
      'delete_meal_log',
      'delete_weight',
      'get_daily_series',
      'get_exercise_logs',
      'get_exercise_records',
      'get_meal_logs',
      'get_raw_measurements',
      'get_weight_summary',
      'log_exercise',
      'log_meal',
      'log_weight',
      'search_exercise_menus',
      'search_menus',
      'set_goal',
      'update_exercise_menu',
      'update_meal_log',
      'update_menu',
    ]);
  });

  it('get_exercise_records は menu_name で解決し自己ベストを返す。曖昧・未知・有酸素はエラー', async () => {
    const bench = await createExerciseMenuOk(rootEnv, { name: 'ベンチプレス', category: 'strength' });
    await createExerciseMenuOk(rootEnv, { name: 'インクラインベンチプレス', category: 'strength' });
    await createExerciseMenuOk(rootEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    await logExercise(rootEnv, {
      menu_id: bench.id, performed_at: '2026-08-01T03:00:00Z', sets: [{ reps: 5, weight_kg: 80 }, { reps: 8, weight_kg: 70 }],
    });

    const call = async (args: Record<string, unknown>): Promise<RpcResponse> =>
      (await (await rwRpc(token, 'tools/call', { name: 'get_exercise_records', arguments: args })).json()) as RpcResponse;

    const ok = await call({ menu_name: 'ベンチプレス' });
    expect(ok.error).toBeUndefined();
    const records = parseToolJson<{
      menu: { id: string }; max_weight: { weight_kg: number }; rep_maxes: { reps: number }[]; last_session: { total_volume: number };
    }>(ok.result as Record<string, unknown>);
    expect(records.menu.id).toBe(bench.id); // 完全一致が部分一致より優先
    expect(records.max_weight.weight_kg).toBe(80);
    expect(records.rep_maxes.map((r) => r.reps)).toEqual([5, 8]);
    expect(records.last_session.total_volume).toBe(960);

    expect(((await call({ menu_name: 'ベンチ' })).result as { isError?: boolean }).isError).toBe(true); // 曖昧
    expect(((await call({ menu_name: 'ランニング' })).result as { isError?: boolean }).isError).toBe(true); // 有酸素
    expect(((await call({ menu_id: 'nope' })).result as { isError?: boolean }).isError).toBe(true); // 未知
    expect(((await call({})).result as { isError?: boolean }).isError).toBe(true); // 指定なし
  });

  it('circuit: menu_name解決で登録し、roundsだけで記録できる（導出値付き・自己ベスト対象外）', async () => {
    await createExerciseMenuOk(rootEnv, {
      name: 'アシスト懸垂', category: 'strength', is_bodyweight: true, bodyweight_factor: 0.75,
    });
    await createExerciseMenuOk(rootEnv, {
      name: '腕立て伏せ', category: 'strength', is_bodyweight: true, bodyweight_factor: 0.65,
    });
    const created = (await (await rwRpc(token, 'tools/call', {
      name: 'create_exercise_menu',
      arguments: {
        name: 'Cindy', category: 'strength', mets: 8,
        circuit: [{ menu_name: 'アシスト懸垂', reps: 5 }, { menu_name: '腕立て', reps: 10 }], // 部分一致で一意解決
      },
    })).json()) as RpcResponse;
    expect(created.error).toBeUndefined();
    const menu = parseToolJson<{ id: string; circuit: { menu_id: string; reps: number }[] }>(
      created.result as Record<string, unknown>,
    );
    expect(menu.circuit).toHaveLength(2);

    const logged = (await (await rwRpc(token, 'tools/call', {
      name: 'log_exercise',
      arguments: { menu_name: 'Cindy', rounds: 15, duration_min: 20 },
    })).json()) as RpcResponse;
    expect(logged.error).toBeUndefined();
    const log = parseToolJson<{
      group_id: string; id: string; rounds: number; body_weight_kg: number; calories: number;
      records_broken: unknown[];
      circuit: { total_reps: number; total_volume: number; per_movement: { total_reps: number }[] };
    }>(logged.result as Record<string, unknown>);
    expect(log.group_id).toBe(log.id);
    expect(log.rounds).toBe(15);
    expect(log.records_broken).toEqual([]);
    expect(log.circuit.total_reps).toBe(225); // (5+10)×15
    expect(log.circuit.per_movement.map((p) => p.total_reps)).toEqual([75, 150]);
    // 換算はサーバ算出: bw×(0.75×5 + 0.65×10)×15、kcal = 8×bw×(20/60)×1.05
    expect(log.circuit.total_volume).toBeCloseTo(log.body_weight_kg * (0.75 * 5 + 0.65 * 10) * 15, 2);
    expect(log.calories).toBeCloseTo(8 * log.body_weight_kg * (20 / 60) * 1.05, 2);

    // 構成種目未解決のときは isError
    const bad = (await (await rwRpc(token, 'tools/call', {
      name: 'create_exercise_menu',
      arguments: { name: 'X', category: 'strength', circuit: [{ menu_name: '存在しない種目', reps: 5 }] },
    })).json()) as RpcResponse;
    expect((bad.result as { isError?: boolean }).isError).toBe(true);
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
    expect(saved.id).toBeGreaterThan(0);
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
    expect((body.result as { tools: unknown[] }).tools).toHaveLength(22);
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

describe('/mcp 編集・削除ツール（運動・体重）', () => {
  let token: string;
  beforeEach(async () => {
    await resetTables();
    token = await obtainAccessToken(rootEnv);
  });
  const call = async (name: string, args: Record<string, unknown>): Promise<RpcResponse> =>
    (await (await rwRpc(token, 'tools/call', { name, arguments: args })).json()) as RpcResponse;
  const isError = (r: RpcResponse): boolean => (r.result as { isError?: boolean }).isError === true;

  it('update_exercise_menu は指定項目だけ更新し、未知IDや項目なしはエラー', async () => {
    const menu = await createExerciseMenuOk(rootEnv, { name: 'ベンチプレス', category: 'strength', muscle_group: '胸' });
    const ok = await call('update_exercise_menu', { menu_id: menu.id, name: 'ベンチプレス（バーベル）', muscle_group: null });
    const updated = parseToolJson<{ name: string; muscle_group: string | null; category: string }>(ok.result as Record<string, unknown>);
    expect(updated.name).toBe('ベンチプレス（バーベル）');
    expect(updated.muscle_group).toBeNull();
    expect(updated.category).toBe('strength');
    expect(isError(await call('update_exercise_menu', { menu_id: 'nope', name: 'x' }))).toBe(true);
    expect(isError(await call('update_exercise_menu', { menu_id: menu.id }))).toBe(true);
  });

  it('archive_exercise_menu で検索から消え、archived:false で戻る', async () => {
    const menu = await createExerciseMenuOk(rootEnv, { name: 'スクワット', category: 'strength' });
    expect(isError(await call('archive_exercise_menu', { menu_id: menu.id }))).toBe(false);
    const hidden = parseToolJson<{ menus: unknown[] }>((await call('search_exercise_menus', { q: 'スクワット' })).result as Record<string, unknown>);
    expect(hidden.menus).toHaveLength(0);
    expect(isError(await call('archive_exercise_menu', { menu_id: menu.id, archived: false }))).toBe(false);
    const back = parseToolJson<{ menus: unknown[] }>((await call('search_exercise_menus', { q: 'スクワット' })).result as Record<string, unknown>);
    expect(back.menus).toHaveLength(1);
    expect(isError(await call('archive_exercise_menu', { menu_id: 'nope' }))).toBe(true);
  });

  it('delete_exercise_log は記録をセットごと消し、未知IDはエラー', async () => {
    const menu = await createExerciseMenuOk(rootEnv, { name: 'デッドリフト', category: 'strength' });
    const log = await logExercise(rootEnv, { menu_id: menu.id, sets: [{ reps: 5, weight_kg: 100 }] });
    if ('error' in log) throw new Error(log.error);
    expect(isError(await call('delete_exercise_log', { log_id: log.id }))).toBe(false);
    const logs = parseToolJson<{ logs: unknown[] }>((await call('get_exercise_logs', { days: 7 })).result as Record<string, unknown>);
    expect(logs.logs).toHaveLength(0);
    expect(isError(await call('delete_exercise_log', { log_id: log.id }))).toBe(true);
  });

  it('delete_weight は手動記録だけ消せる（Withings由来はエラー）', async () => {
    await insertMeasurement({ grpid: 5150, measured_at: `${localYmdDaysAgo(2)}T03:00:00Z`, weight: 80, fat_free_mass: 62 });
    const saved = parseToolJson<{ id: number }>(
      (await call('log_weight', { weight_kg: 81.2, measured_at: `${localYmdDaysAgo(1)}T03:00:00Z` })).result as Record<string, unknown>,
    );
    expect(isError(await call('delete_weight', { id: saved.id }))).toBe(false);
    expect(isError(await call('delete_weight', { id: saved.id }))).toBe(true); // 二重削除
    expect(isError(await call('delete_weight', { id: 5150 }))).toBe(true); // Withings由来
    const raw = parseToolJson<{ measurements: { id: number }[] }>((await call('get_raw_measurements', { days: 7 })).result as Record<string, unknown>);
    expect(raw.measurements.map((m) => m.id)).toEqual([5150]);
  });
});
