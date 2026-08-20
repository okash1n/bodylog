# スタンドアロン化（Withings任意化＋手動体重記録） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Withings未設定でも全機能が動くようにし、体重の手動記録経路（MCP `log_weight`＋`POST /api/weight`）を追加する。

**Architecture:** `measurements` に `source` 列を追加し、手動記録は負ID採番で同居させる（読み取り側は無変更）。書き込みは新モジュール `src/weight.ts` に集約し、REST/MCPの両経路から呼ぶ。Withings系cronはトークン行の有無でゲートし、`public_origin` は認証済み書き込み到着時に初期化する。

**Tech Stack:** Cloudflare Workers + Hono + D1 + @modelcontextprotocol/sdk + vitest(workers pool)

**Spec:** docs/superpowers/specs/2026-08-20-standalone-weight-design.md

## Global Constraints

- パブリックリポジトリ: 実環境値（本番ドメイン・ID・シークレット値）を一切書かない。URL例は `weight.example.com`
- コミットは Conventional Commits、`Co-Authored-By` なし
- テストの日付依存seedは固定時刻 `${ymd}T03:00:00Z`（JST正午）
- 検証: `npm run typecheck` と `npm test`
- weight範囲 20–300、fat_ratio範囲 3–75、measured_at は 2000-01-01以降〜now+5分以内

---

### Task 1: migration 0006（source列）

**Files:**
- Create: `migrations/0006_measurement_source.sql`

**Interfaces:**
- Produces: `measurements.source TEXT NOT NULL DEFAULT 'withings'`（後続タスク全部が依存）

- [ ] **Step 1: マイグレーション作成**

```sql
-- Migration number: 0006 	 measurement source
-- 手動体重記録の出所区別。既存行（Withings由来）は 'withings' のまま。
-- 手動記録は grpid に負の整数を採番して同居する（Withingsのgrpidは常に正）。
ALTER TABLE measurements ADD COLUMN source TEXT NOT NULL DEFAULT 'withings';
```

- [ ] **Step 2: テストが通ること（マイグレーション適用のsmoke）**

Run: `npm test -- --run test/queries.test.ts`
Expected: PASS（apply-migrations.tsが0006を適用して既存テストが壊れない）

- [ ] **Step 3: Commit**

```bash
git add migrations/0006_measurement_source.sql
git commit -m "feat: add measurements.source column for manual weight entries"
```

### Task 2: src/weight.ts（検証・挿入・削除）＋ユニットテスト

**Files:**
- Create: `src/weight.ts`
- Test: `test/weight.test.ts`

**Interfaces:**
- Consumes: `immediateDestinations(env)`（src/slack.ts:79）, `newId()`（src/util.ts:41）
- Produces:
  - `parseWeightInput(b: Record<string, unknown>): { ok: true; value: WeightInput } | { ok: false; error: string }`
  - `logWeight(env: Env, input: WeightInput): Promise<ManualMeasurement>`
  - `deleteManualMeasurement(env: Env, id: number): Promise<boolean>`
  - `type WeightInput = { weight: number; fat_ratio: number | null; measured_at: string }`
  - `type ManualMeasurement = { id: number; measured_at: string; weight: number; fat_ratio: number | null; fat_free_mass: number | null; source: string }`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/weight.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteManualMeasurement, logWeight, parseWeightInput } from '../src/weight';
import { insertMeasurement, localYmdDaysAgo, resetTables, testEnv } from './helpers';

describe('parseWeightInput', () => {
  it('weight_kg必須・範囲20–300', () => {
    expect(parseWeightInput({}).ok).toBe(false);
    expect(parseWeightInput({ weight_kg: 19 }).ok).toBe(false);
    expect(parseWeightInput({ weight_kg: 301 }).ok).toBe(false);
    const ok = parseWeightInput({ weight_kg: 83.4 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.fat_ratio).toBeNull();
  });
  it('fat_ratioは3–75', () => {
    expect(parseWeightInput({ weight_kg: 80, fat_ratio: 2 }).ok).toBe(false);
    expect(parseWeightInput({ weight_kg: 80, fat_ratio: 76 }).ok).toBe(false);
    expect(parseWeightInput({ weight_kg: 80, fat_ratio: 28.3 }).ok).toBe(true);
  });
  it('measured_atは2000年以降〜now+5分。省略時は現在時刻', () => {
    expect(parseWeightInput({ weight_kg: 80, measured_at: 'not-a-date' }).ok).toBe(false);
    expect(parseWeightInput({ weight_kg: 80, measured_at: '1999-12-31T00:00:00Z' }).ok).toBe(false);
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(parseWeightInput({ weight_kg: 80, measured_at: future }).ok).toBe(false);
    const ok = parseWeightInput({ weight_kg: 80 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(Date.parse(ok.value.measured_at)).toBeGreaterThan(Date.now() - 5000);
  });
});

describe('logWeight / deleteManualMeasurement', () => {
  beforeEach(resetTables);
  const at = `${localYmdDaysAgo(0)}T03:00:00Z`;

  it('負IDを-1,-2と連番採番し、fat_free_massを導出して保存する', async () => {
    await insertMeasurement({ grpid: 1234567890, measured_at: at, weight: 84 });
    const m1 = await logWeight(testEnv, { weight: 83.4, fat_ratio: 28.3, measured_at: at });
    expect(m1.id).toBe(-1);
    expect(m1.source).toBe('manual');
    expect(m1.fat_free_mass).toBeCloseTo(83.4 * (1 - 0.283), 2);
    const m2 = await logWeight(testEnv, { weight: 83.0, fat_ratio: null, measured_at: at });
    expect(m2.id).toBe(-2);
    expect(m2.fat_free_mass).toBeNull();
  });

  it('挿入時にimmediate通知先へbatchをenqueueする', async () => {
    await logWeight(testEnv, { weight: 83.4, fat_ratio: null, measured_at: at });
    const item = await testEnv.DB.prepare('SELECT grpid, batch_id FROM notification_batch_items').first<{
      grpid: number; batch_id: string;
    }>();
    expect(item?.grpid).toBe(-1);
    const batch = await testEnv.DB.prepare(
      "SELECT status FROM notification_batches WHERE batch_id = ?1",
    ).bind(item?.batch_id).first<{ status: string }>();
    expect(batch?.status).toBe('pending');
  });

  it('deleteはmanual行のみ削除できる', async () => {
    await insertMeasurement({ grpid: 42, measured_at: at, weight: 84 });
    const m = await logWeight(testEnv, { weight: 83.4, fat_ratio: null, measured_at: at });
    expect(await deleteManualMeasurement(testEnv, 42)).toBe(false);
    expect(await deleteManualMeasurement(testEnv, 999)).toBe(false);
    expect(await deleteManualMeasurement(testEnv, m.id)).toBe(true);
    const left = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM measurements').first<{ n: number }>();
    expect(left?.n).toBe(1);
  });
});
```

- [ ] **Step 2: 失敗確認**

Run: `npm test -- --run test/weight.test.ts`
Expected: FAIL（src/weight.ts が存在しない）

- [ ] **Step 3: 実装**

```ts
// src/weight.ts
/**
 * 手動体重記録。Withings由来の行と同じ measurements テーブルに source='manual' で同居し、
 * IDは負の整数を採番する（Withingsのgrpidは常に正なので衝突しない）。
 * 挿入・通知enqueue・採番は1つの db.batch()（=1トランザクション）で原子的に行う。
 */
import type { Env } from './types';
import { immediateDestinations } from './slack';
import { newId } from './util';

export interface WeightInput {
  weight: number;
  fat_ratio: number | null;
  measured_at: string; // ISO8601
}

export interface ManualMeasurement {
  id: number;
  measured_at: string;
  weight: number;
  fat_ratio: number | null;
  fat_free_mass: number | null;
  source: string;
}

const WEIGHT_MIN = 20;
const WEIGHT_MAX = 300;
const FAT_RATIO_MIN = 3;
const FAT_RATIO_MAX = 75;
const MEASURED_AT_MIN_MS = Date.parse('2000-01-01T00:00:00Z');
const FUTURE_SLACK_MS = 5 * 60_000;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function parseWeightInput(
  b: Record<string, unknown> | null,
): { ok: true; value: WeightInput } | { ok: false; error: string } {
  const body = b ?? {};
  const weight = body.weight_kg;
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < WEIGHT_MIN || weight > WEIGHT_MAX) {
    return { ok: false, error: `weight_kg is required (${WEIGHT_MIN}-${WEIGHT_MAX})` };
  }
  let fatRatio: number | null = null;
  if (body.fat_ratio !== undefined && body.fat_ratio !== null) {
    const r = body.fat_ratio;
    if (typeof r !== 'number' || !Number.isFinite(r) || r < FAT_RATIO_MIN || r > FAT_RATIO_MAX) {
      return { ok: false, error: `fat_ratio must be ${FAT_RATIO_MIN}-${FAT_RATIO_MAX} (%)` };
    }
    fatRatio = r;
  }
  let measuredAt = new Date().toISOString();
  if (body.measured_at !== undefined) {
    if (typeof body.measured_at !== 'string') return { ok: false, error: 'measured_at must be an ISO8601 string' };
    const t = Date.parse(body.measured_at);
    if (!Number.isFinite(t)) return { ok: false, error: 'measured_at is not a valid ISO8601 datetime' };
    if (t < MEASURED_AT_MIN_MS) return { ok: false, error: 'measured_at is too old (before 2000-01-01)' };
    if (t > Date.now() + FUTURE_SLACK_MS) return { ok: false, error: 'measured_at is in the future' };
    measuredAt = new Date(t).toISOString();
  }
  return { ok: true, value: { weight, fat_ratio: fatRatio, measured_at: measuredAt } };
}

export async function logWeight(env: Env, input: WeightInput): Promise<ManualMeasurement> {
  const fatFreeMass = input.fat_ratio === null ? null : round2(input.weight * (1 - input.fat_ratio / 100));
  const rawJson = JSON.stringify({ source: 'manual', input });
  // 採番（負の最小-1）をINSERT内のスカラサブクエリで行い、直後の文からは
  // 「負の最小grpid=今挿入した行」として参照する（同一トランザクション内なのでレース無し）
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      'INSERT INTO measurements (grpid, measured_at, weight, fat_ratio, fat_free_mass, raw_json, source) ' +
        "SELECT (SELECT COALESCE(MIN(grpid), 0) FROM measurements WHERE grpid < 0) - 1, ?1, ?2, ?3, ?4, ?5, 'manual'",
    ).bind(input.measured_at, input.weight, input.fat_ratio, fatFreeMass, rawJson),
  ];
  // Withings webhook経由と同じ即時通知パイプラインに乗せる（dailyのみの通知先はダイジェストで届く）
  const destinations = immediateDestinations(env);
  const batchId = newId();
  statements.push(
    env.DB.prepare(
      'INSERT OR IGNORE INTO notification_batch_items (grpid, batch_id) ' +
        'VALUES ((SELECT MIN(grpid) FROM measurements WHERE grpid < 0), ?1)',
    ).bind(batchId),
  );
  for (const dest of destinations) {
    statements.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO notification_batches (batch_id, destination_id, status, next_attempt_at) ' +
          "SELECT ?1, ?2, 'pending', datetime('now') " +
          'WHERE EXISTS (SELECT 1 FROM notification_batch_items WHERE batch_id = ?3)',
      ).bind(batchId, dest.id, batchId),
    );
  }
  statements.push(
    env.DB.prepare(
      'SELECT grpid AS id, measured_at, weight, fat_ratio, fat_free_mass, source FROM measurements ' +
        'WHERE grpid = (SELECT MIN(grpid) FROM measurements WHERE grpid < 0)',
    ),
  );
  const results = await env.DB.batch<ManualMeasurement>(statements);
  const row = results[results.length - 1].results[0];
  if (!row) throw new Error('manual measurement insert did not return a row');
  return row;
}

export async function deleteManualMeasurement(env: Env, id: number): Promise<boolean> {
  const res = await env.DB.prepare(
    "DELETE FROM measurements WHERE grpid = ?1 AND source = 'manual'",
  ).bind(id).run();
  return res.meta.changes > 0;
}
```

- [ ] **Step 4: テスト通過確認**

Run: `npm test -- --run test/weight.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/weight.ts test/weight.test.ts
git commit -m "feat: manual weight logging module (negative-id rows in measurements)"
```

### Task 3: REST（POST /api/weight, DELETE /api/weight/:id）＋public_origin初期化

**Files:**
- Modify: `src/writes.ts`（ルート追加＋originフック）
- Modify: `src/util.ts`（ensurePublicOrigin追加）
- Test: `test/weight-api.test.ts`

**Interfaces:**
- Consumes: Task 2の `parseWeightInput` / `logWeight` / `deleteManualMeasurement`
- Produces: `ensurePublicOrigin(env: Env, origin: string): Promise<void>`（Task 4のMCP側も使う）

- [ ] **Step 1: 失敗するテストを書く**

```ts
// test/weight-api.test.ts
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { apiFetch, insertMeasurement, localYmdDaysAgo, obtainAccessToken, resetTables, rootTestEnv, setSetting, testEnv } from './helpers';

let token: string;
beforeAll(async () => {
  await resetTables();
  token = await obtainAccessToken(rootTestEnv);
});
afterEach(() => vi.unstubAllGlobals());

const at = `${localYmdDaysAgo(0)}T03:00:00Z`;

describe('POST /api/weight', () => {
  beforeEach(async () => {
    // tokensはOAuthプロバイダ(KV)と無関係なので消してよいが、settings/measurementsだけ選んで消す
    await testEnv.DB.batch([
      testEnv.DB.prepare('DELETE FROM measurements'),
      testEnv.DB.prepare('DELETE FROM notification_batch_items'),
      testEnv.DB.prepare('DELETE FROM notification_batches'),
      testEnv.DB.prepare('DELETE FROM settings'),
    ]);
  });

  it('未認証は401', async () => {
    const res = await apiFetch(rootTestEnv, '/api/weight', null, 'POST', { weight_kg: 83.4 });
    expect(res.status).toBe(401);
  });

  it('バリデーション失敗は400', async () => {
    const res = await apiFetch(rootTestEnv, '/api/weight', token, 'POST', { weight_kg: 10 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('weight_kg');
  });

  it('201で保存行を返し、summary系の読み取りに載る', async () => {
    const res = await apiFetch(rootTestEnv, '/api/weight', token, 'POST', {
      weight_kg: 83.4, fat_ratio: 28.3, measured_at: at,
    });
    expect(res.status).toBe(201);
    const saved = (await res.json()) as { id: number; source: string; fat_free_mass: number };
    expect(saved.id).toBe(-1);
    expect(saved.source).toBe('manual');
    const summary = await worker.fetch(
      new Request('http://localhost/api/summary'), rootTestEnv, createExecutionContext(),
    );
    const body = (await summary.json()) as { latest: { weight: number } };
    expect(body.latest.weight).toBeCloseTo(83.4, 3);
  });

  it('public_originが未設定なら書き込み到着時に初期化し、設定済みなら上書きしない', async () => {
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request('http://localhost/api/weight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ weight_kg: 83.4, measured_at: at }),
      }),
      rootTestEnv, ctx,
    );
    await waitOnExecutionContext(ctx);
    const row = await testEnv.DB.prepare("SELECT value FROM settings WHERE key = 'public_origin'").first<{ value: string }>();
    expect(row?.value).toBe('http://localhost');

    await setSetting('public_origin', 'https://weight.example.com');
    const ctx2 = createExecutionContext();
    await worker.fetch(
      new Request('http://localhost/api/weight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ weight_kg: 83.2, measured_at: at }),
      }),
      rootTestEnv, ctx2,
    );
    await waitOnExecutionContext(ctx2);
    const row2 = await testEnv.DB.prepare("SELECT value FROM settings WHERE key = 'public_origin'").first<{ value: string }>();
    expect(row2?.value).toBe('https://weight.example.com');
  });
});

describe('DELETE /api/weight/:id', () => {
  it('manual行は削除でき、Withings行と不在IDは404', async () => {
    await insertMeasurement({ grpid: 42, measured_at: at, weight: 84 });
    const created = await apiFetch(rootTestEnv, '/api/weight', token, 'POST', { weight_kg: 83.4, measured_at: at });
    const { id } = (await created.json()) as { id: number };
    expect((await apiFetch(rootTestEnv, '/api/weight/42', token, 'DELETE')).status).toBe(404);
    expect((await apiFetch(rootTestEnv, '/api/weight/abc', token, 'DELETE')).status).toBe(404);
    expect((await apiFetch(rootTestEnv, `/api/weight/${id}`, token, 'DELETE')).status).toBe(200);
    expect((await apiFetch(rootTestEnv, `/api/weight/${id}`, token, 'DELETE')).status).toBe(404);
  });
});
```

- [ ] **Step 2: 失敗確認**

Run: `npm test -- --run test/weight-api.test.ts`
Expected: FAIL（404: ルート未定義）

- [ ] **Step 3: 実装**

`src/util.ts` に追加:

```ts
/**
 * settings.public_origin が未設定なら初期化する（設定済みは上書きしない）。
 * 通知系の起点originはWithings認証時にしか入らなかったため、認証済み書き込みの
 * 到着時にも初期化してWithings無し運用でもダイジェストが動くようにする。
 */
export async function ensurePublicOrigin(env: Env, origin: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('public_origin', ?1) ON CONFLICT(key) DO NOTHING",
  ).bind(origin).run();
}
```

（`import type { Env } from './types';` が util.ts に無ければ追加）

`src/writes.ts` の変更（w定義の直後にフック、ルートは運動記録の後に追加）:

```ts
import { deleteManualMeasurement, logWeight, parseWeightInput } from './weight';
import { ensurePublicOrigin, noindexHeaders } from './util';

  // w定義を差し替え: 認証済み書き込みの到着時にpublic_originを初期化（レイテンシ外で）
  const withOriginInit = (h: Handler): Handler => (c) => {
    c.executionCtx.waitUntil(
      ensurePublicOrigin(c.env, new URL(c.req.url).origin).catch((err) =>
        console.error('[writes] ensurePublicOrigin failed', err),
      ),
    );
    return h(c);
  };
  const w = (h: Handler): Handler => guarded(withAuth(guardedErrors(withOriginInit(h))));

  // ---- 体重（手動記録） ----
  app.post(p('/api/weight'), w(async (c) => {
    const parsed = parseWeightInput(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400, headers());
    return c.json(await logWeight(c.env, parsed.value), 201, headers());
  }));
  app.delete(p('/api/weight/:id'), w(async (c) => {
    const raw = pid(c);
    const id = /^-?\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(id) || !(await deleteManualMeasurement(c.env, id))) {
      return c.json({ error: 'manual measurement not found' }, 404, headers());
    }
    return c.json({ ok: true }, 200, headers());
  }));
```

- [ ] **Step 4: テスト通過確認**

Run: `npm test -- --run test/weight-api.test.ts test/writes-api.test.ts`
Expected: PASS（既存writes-apiのリグレッション無し）

- [ ] **Step 5: Commit**

```bash
git add src/writes.ts src/util.ts test/weight-api.test.ts
git commit -m "feat: POST/DELETE /api/weight and public_origin init on authed writes"
```

### Task 4: MCP log_weight＋instructions更新

**Files:**
- Modify: `src/mcp.ts`（write群にlog_weight追加、ヘッダコメント5つ→6つ、instructions更新、MCP write到着時のensurePublicOrigin）
- Test: `test/mcp.test.ts`（ツール数12→13、log_weightの正常/異常）

**Interfaces:**
- Consumes: Task 2の `parseWeightInput` / `logWeight`、Task 3の `ensurePublicOrigin`

- [ ] **Step 1: 失敗するテストを書く（mcp.test.tsへ追記）**

既存の tools/list 件数アサーションを 13 に更新し、以下を追加:

```ts
it('log_weight で手動体重を記録できる', async () => {
  const res = await mcpRpc(rootTestEnv, writeToken, 'tools/call', {
    name: 'log_weight',
    arguments: { weight_kg: 83.4, fat_ratio: 28.3, measured_at: `${localYmdDaysAgo(0)}T03:00:00Z` },
  });
  const parsed = parseToolJson<{ id: number; source: string }>(
    ((await res.json()) as { result: Record<string, unknown> }).result,
  );
  expect(parsed.source).toBe('manual');
  expect(parsed.id).toBeLessThan(0);
});

it('log_weight のバリデーションエラーはisErrorで返る', async () => {
  const res = await mcpRpc(rootTestEnv, writeToken, 'tools/call', {
    name: 'log_weight',
    arguments: { weight_kg: 10 },
  });
  const result = ((await res.json()) as { result: { isError?: boolean } }).result;
  expect(result.isError).toBe(true);
});
```

（`writeToken` は既存の書き込みテストで使っているトークン取得の変数名に合わせる）

- [ ] **Step 2: 失敗確認**

Run: `npm test -- --run test/mcp.test.ts`
Expected: FAIL（unknown tool / 件数不一致）

- [ ] **Step 3: 実装**

`src/mcp.ts` write群（set_goalの後）に追加:

```ts
    server.registerTool(
      'log_weight',
      {
        description:
          '体重を手動記録する（体重計が無い/Withings未連携でも記録できる）。fat_ratioを渡すと除脂肪体重を導出して保存し、BMR計算にも使われる',
        inputSchema: {
          weight_kg: z.number().min(20).max(300).describe('体重kg'),
          fat_ratio: z.number().min(3).max(75).optional().describe('体脂肪率%（任意）'),
          measured_at: z.string().optional().describe('計測日時 ISO8601（省略時は現在時刻）'),
        },
      },
      (args) => guarded('log_weight', async () => {
        const parsed = parseWeightInput(args as Record<string, unknown>);
        if (!parsed.ok) return errorResult(parsed.error);
        return jsonResult(await logWeight(env, parsed.value));
      }),
    );
```

- ヘッダコメント: `書き込みツール5つ（log_meal / create_menu / log_exercise / create_exercise_menu / set_goal）` → `書き込みツール6つ（… / set_goal / log_weight）`
- instructions(): 冒頭行を `個人の体重・体組成・食事・運動を照会・記録するサーバー（bodylog）。体重はWithings連携または手動記録（log_weight）で入る。` に変更し、目標の行の後に `体重はlog_weightで手動記録できる（Withings連携が無い場合の記録手段。ユーザーが体重を報告したときに使う）。` を追加
- `handleMcpRequest` のPOST処理成功パスで write時に origin 初期化: `if (write) c.executionCtx.waitUntil(ensurePublicOrigin(c.env, new URL(c.req.url).origin).catch((err) => console.error('[mcp] ensurePublicOrigin failed', err)));` を `try {` の直前に追加。import に `ensurePublicOrigin` を足す

- [ ] **Step 4: テスト通過確認**

Run: `npm test -- --run test/mcp.test.ts test/mcp-meals.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp.ts test/mcp.test.ts
git commit -m "feat: MCP log_weight tool for manual weight entries"
```

### Task 5: Withings任意化（cronゲート＋authルートの明示エラー）

**Files:**
- Modify: `src/ingest.ts`（runDailyBackfill / ensureSubscription冒頭ゲート）
- Modify: `src/index.ts`（/auth/start, /auth/callbackのシークレット未設定ガード）
- Test: `test/ingest.test.ts`（ゲートの検証を追記）

**Interfaces:**
- Consumes: `getTokenRow(env)`（src/withings.ts:138、null = 未連携）

- [ ] **Step 1: 失敗するテストを書く（ingest.test.tsへ追記）**

```ts
describe('withings未連携時のcronゲート', () => {
  beforeEach(resetTables);
  afterEach(() => vi.unstubAllGlobals());

  it('トークン行が無ければrunDailyBackfillは外部通信せずに終わる', async () => {
    const stub = stubFetch(); // ルート未登録: fetchが飛べばthrowする
    await runDailyBackfill(testEnv);
    expect(stub.requests().length).toBe(0);
  });

  it('トークン行が無ければensureSubscriptionは外部通信せずに終わる', async () => {
    const stub = stubFetch();
    await ensureSubscription(testEnv, 'https://weight.example.com/webhook/withings-x');
    expect(stub.requests().length).toBe(0);
  });
});
```

- [ ] **Step 2: 失敗確認**

Run: `npm test -- --run test/ingest.test.ts`
Expected: FAIL（sendAdminAlertのfetchが飛んでunexpected fetchでreject）

- [ ] **Step 3: 実装**

`src/ingest.ts`: import に `getTokenRow` を追加し、両関数の冒頭に:

```ts
  // Withings未連携（シークレット未設定 or 未認証）ならこのステップは対象外
  if (!(await getTokenRow(env))) {
    console.info('[ingest] withings not linked; skipping daily backfill');
    return;
  }
```

（ensureSubscription側のメッセージは `skipping subscription check`）

`src/index.ts` `/auth/start` のSETUP_SECRETチェック直後と `/auth/callback` の冒頭（authHeaders設定後）に:

```ts
  if (!env.WITHINGS_CLIENT_ID || !env.WITHINGS_CLIENT_SECRET) {
    return c.html(
      errorPage(
        'Withings連携が未設定です',
        'WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET を登録すると体重計連携が有効になります。Withings無しでも体重はMCPの log_weight か POST /api/weight で記録できます。',
      ),
      503,
    );
  }
```

- [ ] **Step 4: テスト通過確認**

Run: `npm test -- --run test/ingest.test.ts test/withings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingest.ts src/index.ts test/ingest.test.ts
git commit -m "feat: make Withings optional (skip cron steps and guard auth routes when unlinked)"
```

### Task 6: docs（ai.ts / README / wrangler.toml.example）

**Files:**
- Modify: `src/ai.ts`（llms.txt/openapiに /api/weight を追記）
- Modify: `README.md`（Withings任意化のセットアップ再構成）
- Modify: `wrangler.toml.example`（Withingsシークレットを任意と明記）
- Test: `test/ai-api.test.ts`（既存アサーションが壊れないこと。/api/weight の記載チェックを1本追加）

- [ ] **Step 1: ai.ts更新**

llms.txt の書き込みAPI一覧に `POST /api/weight`（weight_kg必須20–300 / fat_ratio任意3–75 / measured_at任意）と `DELETE /api/weight/:id`（manual行のみ）を追加。openapi の paths にも同エンドポイントを追加し、レスポンススキーマ `ManualMeasurement {id(負整数), measured_at, weight, fat_ratio, fat_free_mass, source}` を定義。測定の出所として `source: 'withings' | 'manual'` の説明を1行追記。

- [ ] **Step 2: ai-api.test.tsに追記**

```ts
it('llms.txt が /api/weight を案内する', async () => {
  const res = await worker.fetch(new Request('http://localhost/llms.txt'), rootTestEnv, createExecutionContext());
  expect(await res.text()).toContain('/api/weight');
});
```

- [ ] **Step 3: README再構成**

- 「必要なもの」: Withings開発者アカウント・体重計を「任意（Withings連携を使う場合のみ）」へ移動。コア要件は Cloudflare / Google OAuth / Slack / gh CLI
- セットアップ手順: 「コアセットアップ」と「任意: Withings連携」に分離。Withingsセクションに従来の開発者ポータル・/auth/start手順を移す
- 手動記録の説明: MCP `log_weight` と `POST /api/weight` の記載を追加（URL例は weight.example.com）
- チェックリスト: 「Withings無しの場合: log_weightで記録→ダッシュボード反映を確認」を追加

- [ ] **Step 4: wrangler.toml.example更新**

`WITHINGS_CLIENT_ID` / `WITHINGS_CLIENT_SECRET` のコメントを `# 任意: Withings連携を使う場合のみ。` 付きに変更。

- [ ] **Step 5: 全体検証**

Run: `npm run typecheck && npm test`
Expected: 全テストPASS

- [ ] **Step 6: Commit**

```bash
git add src/ai.ts README.md wrangler.toml.example test/ai-api.test.ts
git commit -m "docs: make Withings optional in setup docs; document manual weight endpoints"
```

### Task 7: デプロイと本番検証

- [ ] **Step 1: 実値混入チェック**

Run: `git diff origin/main --stat && git log origin/main..HEAD --oneline` の全diffを確認し、本番ドメイン・シークレット値・32桁hex/UUIDが無いことを確認

- [ ] **Step 2: push（=本番デプロイ）**

```bash
git push origin main
gh run watch $(gh run list --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId') --exit-status
```

- [ ] **Step 3: 本番スモーク**

本番URL（ローカルwrangler.tomlの実値）に対して: `GET /llms.txt` に `/api/weight` が載ること、MCPの tools/list に log_weight が出ること（curlでinitialize+tools/list、またはMCPクライアントで確認）
