/**
 * wire contract テスト: REST / OpenAPI / MCP の応答形状 drift を検知する。
 * - 主要GETエンドポイントの実応答キー集合と OpenAPI スキーマの properties を突き合わせる
 *   （文書化されていないフィールドの露出と、実装変更のスキーマ追随漏れの双方向を検知）
 * - MCP read ツールの応答が、対応する REST エンドポイントと同一データ・同一形状であることを検証する
 *   （transport ごとの実装分岐による drift を検知）
 */
import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { createMenu, logMeal } from '../src/meals';
import { logExercise } from '../src/exercise';
import {
  createExerciseMenuOk, insertMeasurement, localYmdDaysAgo, mcpRpc, obtainAccessToken, parseToolJson,
  resetTables, rootTestEnv, unwrapMenu,
} from './helpers';

interface OpenApiSpec {
  paths: Record<string, {
    get?: {
      responses: { '200': { content: { 'application/json': { schema: SchemaNode } } } };
    };
  }>;
  components: { schemas: Record<string, SchemaNode> };
}
interface SchemaNode {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  oneOf?: SchemaNode[];
}

function restGet(path: string): Promise<Response> {
  return worker.fetch(new Request(`http://localhost${path}`), rootTestEnv, createExecutionContext());
}

function resolve(spec: OpenApiSpec, node: SchemaNode): SchemaNode {
  if (node.$ref) {
    const name = node.$ref.replace('#/components/schemas/', '');
    return spec.components.schemas[name];
  }
  return node;
}

function schemaProps(spec: OpenApiSpec, node: SchemaNode): string[] {
  const resolved = resolve(spec, node);
  if (resolved.oneOf) {
    // {schema, null} のような union は null 以外の枝を使う
    const branch = resolved.oneOf.find((n) => resolve(spec, n).type !== 'null');
    if (branch) return schemaProps(spec, branch);
  }
  return Object.keys(resolved.properties ?? {}).sort();
}

async function seedAll(): Promise<{ strengthMenuId: string }> {
  await resetTables();
  // 体重（今日・昨日、JST正午固定）
  await insertMeasurement({ grpid: 8801, measured_at: `${localYmdDaysAgo(1)}T03:00:00Z`, weight: 70, fat_ratio: 20, fat_free_mass: 56 });
  await insertMeasurement({ grpid: 8802, measured_at: `${localYmdDaysAgo(0)}T03:00:00Z`, weight: 69.5, fat_free_mass: 56 });
  // 食事
  const menu = await createMenu(rootTestEnv, { name: '契約テスト定食', calories: 600, protein_g: 30, fat_g: 20, carbs_g: 70, note: null });
  const meal = await logMeal(rootTestEnv, { menu_id: menu.id, eaten_at: `${localYmdDaysAgo(0)}T03:00:00Z`, meal_type: 'lunch' });
  if ('error' in meal) throw new Error(meal.error);
  // 運動: 単独strength・cardio・サーキット（rounds/group_id/内訳のキーまで実応答に出す）
  const bench = await createExerciseMenuOk(rootTestEnv, { name: 'ベンチプレス', category: 'strength', mets: 5 });
  unwrapMenu(await logExercise(rootTestEnv, {
    menu_id: bench.id, performed_at: `${localYmdDaysAgo(0)}T03:30:00Z`, sets: [{ reps: 5, weight_kg: 60 }], duration_min: 30,
  }));
  const run = await createExerciseMenuOk(rootTestEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
  unwrapMenu(await logExercise(rootTestEnv, { menu_id: run.id, performed_at: `${localYmdDaysAgo(0)}T04:00:00Z`, duration_min: 20 }));
  const pullup = await createExerciseMenuOk(rootTestEnv, {
    name: '懸垂', category: 'strength', is_bodyweight: true, bodyweight_factor: 0.8,
  });
  const dips = await createExerciseMenuOk(rootTestEnv, {
    name: 'ディップス', category: 'strength', is_bodyweight: true, bodyweight_factor: 0.85,
  });
  const circuit = await createExerciseMenuOk(rootTestEnv, {
    name: '契約サーキット', category: 'strength', mets: 8,
    circuit: [{ menu_id: pullup.id, reps: 5 }, { menu_id: dips.id, reps: 10 }],
  });
  unwrapMenu(await logExercise(rootTestEnv, {
    menu_id: circuit.id, performed_at: `${localYmdDaysAgo(0)}T05:00:00Z`, rounds: 3, duration_min: 10,
  }));
  return { strengthMenuId: bench.id };
}

describe('REST応答とOpenAPIスキーマの契約', () => {
  let spec: OpenApiSpec;
  let strengthMenuId: string;
  beforeEach(async () => {
    ({ strengthMenuId } = await seedAll());
    spec = (await (await restGet('/openapi.json')).json()) as OpenApiSpec;
  });

  const LIST_CASES: { path: string; wrap: string }[] = [
    { path: '/api/measurements?days=5', wrap: 'days' },
    { path: '/api/raw?days=5', wrap: 'measurements' },
    { path: '/api/menus', wrap: 'menus' },
    { path: '/api/meals?days=5', wrap: 'meals' },
    { path: '/api/meals/daily?days=5', wrap: 'days' },
    { path: '/api/exercise/menus', wrap: 'menus' },
    { path: '/api/exercise/logs?days=5', wrap: 'logs' },
    { path: '/api/exercise/daily?days=5', wrap: 'days' },
  ];

  it('一覧系: トップレベルのキーが一致し、要素の実キーが文書化済みの範囲に収まる', async () => {
    for (const { path, wrap } of LIST_CASES) {
      const specPath = path.split('?')[0];
      const schema = spec.paths[specPath]?.get?.responses['200'].content['application/json'].schema;
      expect(schema, `${specPath} should be documented`).toBeTruthy();
      const res = (await (await restGet(path)).json()) as Record<string, unknown>;
      expect(Object.keys(res).sort(), `${specPath} top-level keys`).toEqual(schemaProps(spec, schema!));

      const items = res[wrap] as Record<string, unknown>[];
      expect(items.length, `${specPath} should have seeded items`).toBeGreaterThan(0);
      const itemSchema = resolve(spec, schema!).properties![wrap].items!;
      const documented = new Set(schemaProps(spec, itemSchema));
      const actualUnion = [...new Set(items.flatMap((i) => Object.keys(i)))].sort();
      for (const key of actualUnion) {
        expect(documented.has(key), `${specPath} item key "${key}" should be documented`).toBe(true);
      }
    }
  });

  it('自己ベスト: 実応答のキー集合がExerciseRecordsスキーマと一致する', async () => {
    const schema = spec.paths['/api/exercise/records']?.get?.responses['200'].content['application/json'].schema;
    const res = (await (await restGet(`/api/exercise/records?menu_id=${strengthMenuId}`)).json()) as Record<string, unknown>;
    expect(Object.keys(res).sort()).toEqual(schemaProps(spec, schema!));
  });
});

describe('MCP readツールとRESTの同値性（transport間drift検知）', () => {
  let token: string;
  let strengthMenuId: string;
  beforeEach(async () => {
    ({ strengthMenuId } = await seedAll());
    token = await obtainAccessToken(rootTestEnv);
    vi.unstubAllGlobals(); // obtainAccessToken内のstubを確実に外す
  });

  async function mcpJson<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    const res = await mcpRpc(rootTestEnv, token, 'tools/call', { name: tool, arguments: args });
    const body = (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
    expect(body.error, `${tool} should not error`).toBeUndefined();
    return parseToolJson<T>(body.result!);
  }

  const PAIRS: { tool: string; args: Record<string, unknown>; rest: string }[] = [
    { tool: 'get_daily_series', args: { days: 5 }, rest: '/api/measurements?days=5' },
    { tool: 'get_raw_measurements', args: { days: 5 }, rest: '/api/raw?days=5' },
    { tool: 'get_meal_logs', args: { days: 5 }, rest: '/api/meals?days=5' },
    { tool: 'get_exercise_logs', args: { days: 5 }, rest: '/api/exercise/logs?days=5' },
    { tool: 'search_menus', args: {}, rest: '/api/menus' },
    { tool: 'search_exercise_menus', args: {}, rest: '/api/exercise/menus' },
  ];

  it('同じデータに対してMCPツールとRESTが同一の応答を返す', async () => {
    for (const { tool, args, rest } of PAIRS) {
      const viaMcp = await mcpJson<unknown>(tool, args);
      const viaRest = (await (await restGet(rest)).json()) as unknown;
      expect(viaMcp, `${tool} vs ${rest}`).toEqual(viaRest);
    }
  });

  it('get_weight_summary は /api/summary と一致する（as_ofのみ揮発）', async () => {
    const viaMcp = await mcpJson<Record<string, unknown>>('get_weight_summary', {});
    const viaRest = (await (await restGet('/api/summary')).json()) as Record<string, unknown>;
    expect(Object.keys(viaMcp).sort()).toEqual(Object.keys(viaRest).sort());
    const { as_of: _m, ...mcpRest } = viaMcp;
    const { as_of: _r, ...restRest } = viaRest;
    expect(mcpRest).toEqual(restRest);
  });

  it('get_exercise_records は /api/exercise/records と一致する', async () => {
    const viaMcp = await mcpJson<unknown>('get_exercise_records', { menu_id: strengthMenuId });
    const viaRest = (await (await restGet(`/api/exercise/records?menu_id=${strengthMenuId}`)).json()) as unknown;
    expect(viaMcp).toEqual(viaRest);
  });
});

describe('MCPツール定義の健全性', () => {
  it('全ツールが object 型の inputSchema を持つ', async () => {
    const token = await obtainAccessToken(rootTestEnv);
    vi.unstubAllGlobals();
    const res = await mcpRpc(rootTestEnv, token, 'tools/list');
    const body = (await res.json()) as { result: { tools: { name: string; inputSchema: { type?: string } }[] } };
    expect(body.result.tools.length).toBe(22);
    for (const tool of body.result.tools) {
      expect(tool.inputSchema?.type, `${tool.name} inputSchema`).toBe('object');
    }
  });
});
