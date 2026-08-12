# 食事記録 Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** メニュー方式の食事記録（倍率・PFC・日次集計）を、公開読み取りAPI・OAuth 2.1認証付き書き込み（REST + MCP）・ダッシュボード入力UIとして実装する。

**Architecture:** 既存のHono Workerを `@cloudflare/workers-oauth-provider` でラップし、書き込みは `/rw/` プレフィックス（apiRoute）に集約してトークン検証をかける。本人確認はGoogleログイン（userinfoのメールを `OWNER_EMAILS` と照合）。記録は必ずメニュー参照で、記録時にメニュー値をスナップショットする。

**Tech Stack:** Cloudflare Workers / Hono 4 / D1 / KV / @cloudflare/workers-oauth-provider 0.10.x / @hono/mcp + @modelcontextprotocol/sdk / vitest + @cloudflare/vitest-pool-workers

**Spec:** `docs/superpowers/specs/2026-08-12-meal-tracking-phase1-design.md`

## Global Constraints

- **パブリックリポジトリ**: 実環境値（本番ドメイン・ID・シークレット）をリポジトリに書かない。URL例は `weight.example.com`（CLAUDE.md）
- コミットは Conventional Commits。`Co-Authored-By` 禁止
- テストの日付seedは固定時刻 `${ymd}T03:00:00Z`（=JST正午）を使う
- 日付境界は `TZ_OFFSET_HOURS`（既定9=JST）のローカル日付。SQLは `tzModifier(env)` を使う
- RESTエラー形式は既存規約: 400 + `{error: string}`、500は `internal error` にマスクして `console.error`
- MCPは既存規約: 範囲/解決エラーは `isError` ツール結果、内部エラーは `'internal error'` にマスク
- 期間指定は既存 `resolveRange`（days XOR from/to、最大731日）を再利用
- ダッシュボードのアセットを変えたら `src/dashboard.ts` の `ASSET_VERSION` を更新
- 各タスク完了時に `npm run typecheck` と `npx vitest run` が通ること

## File Structure

| ファイル | 責務 |
|---|---|
| `migrations/0002_meals.sql` (新規) | menus / meal_logs テーブル |
| `src/meals.ts` (新規) | 食事データ層（メニューCRUD・記録・日次集計のD1クエリ） |
| `src/meals-api.ts` (新規) | 公開REST読み取りハンドラ（menus/meals/meals-daily） |
| `src/rw.ts` (新規) | 認証必須 `/rw/` のHonoアプリ（REST書き込み + /rw/mcp）。OAuthProviderのapiHandler |
| `src/oauth.ts` (新規) | `/authorize` `/authorize/callback`（Googleログイン→completeAuthorization） |
| `src/index.ts` (変更) | OAuthProviderでラップ、oauthルート登録、scheduled維持 |
| `src/mcp.ts` (変更) | buildServerにwriteフラグ、読み取りツール2つ+書き込みツール2つ追加 |
| `src/queries.ts` (変更) | getSummaryに `intake_today` 追加 |
| `src/types.ts` (変更) | Env拡張、Menu/MealLog/DailyIntake型 |
| `src/dashboard.ts` (変更) | 公開読み取りルート登録、meals.js配信、ASSET_VERSION |
| `src/dashboard/meals.js` (新規) | 食事タブUI + OAuth PKCEクライアント |
| `src/dashboard/index.html` / `styles.css` (変更) | タブUI |
| `src/ai.ts` (変更) | llms.txt / openapi.json に食事APIを追記 |
| `vitest.config.ts` (変更) | OAUTH_KV・テスト用secretsのバインディング |
| `test/helpers.ts` (変更) | insertMenu / obtainAccessToken ヘルパー |
| `test/meals.test.ts` `test/oauth.test.ts` `test/rw-api.test.ts` `test/mcp-meals.test.ts` (新規) | 各層のテスト |
| `schema.sql` `README.md` `wrangler.toml.example` (変更) | ドキュメント・設定例 |

---

### Task 1: OAuthProvider骨組みとテスト基盤

**Files:**
- Modify: `vitest.config.ts`, `src/types.ts`, `src/index.ts`, `package.json`
- Create: `src/rw.ts`
- Test: `test/oauth.test.ts`

**Interfaces:**
- Produces: `createRwApp(): Hono<{ Bindings: Env }>`（/rw/ 配下のルートを持つ。Task 6/8が拡張）; `src/index.ts` の default export は `{ fetch: provider.fetch, scheduled }`; Env に `OAUTH_KV: KVNamespace` `GOOGLE_OAUTH_CLIENT_ID?` `GOOGLE_OAUTH_CLIENT_SECRET?` `OWNER_EMAILS?` を追加

- [ ] **Step 1: 依存を追加**

```bash
npm install @cloudflare/workers-oauth-provider
```

- [ ] **Step 2: vitest.config.ts にKVとテスト用secretsを追加**

`cloudflareTest` の `miniflare` に追記:

```ts
        miniflare: {
          kvNamespaces: ['OAUTH_KV'],
          bindings: {
            TEST_MIGRATIONS: migrations,
            DASHBOARD_SLUG: 'testslug',
            SETUP_SECRET: 'test-setup',
            SLACK_WEBHOOKS: '[{"id":"main","url":"https://hooks.slack.com/services/T0/B0/X"}]',
            WITHINGS_CLIENT_ID: 'cid',
            WITHINGS_CLIENT_SECRET: 'csec',
            GOOGLE_OAUTH_CLIENT_ID: 'gcid',
            GOOGLE_OAUTH_CLIENT_SECRET: 'gsec',
            OWNER_EMAILS: 'owner@example.com',
          },
        },
```

- [ ] **Step 3: src/types.ts のEnvを拡張**

```ts
export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  // Vars (wrangler.toml)
  WEBHOOK_PATH_SECRET: string;
  DASHBOARD_SLUG: string;
  TZ_OFFSET_HOURS?: string;
  // Secrets（未設定でもWorker自体は起動できるようoptionalにし、使用箇所で明示エラーにする）
  WITHINGS_CLIENT_ID?: string;
  WITHINGS_CLIENT_SECRET?: string;
  SLACK_WEBHOOKS?: string;
  SETUP_SECRET?: string;
  ADMIN_SLACK_WEBHOOK?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  OWNER_EMAILS?: string; // カンマ区切りの許可メール
}
```

- [ ] **Step 4: 失敗するテストを書く（test/oauth.test.ts）**

```ts
import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import worker from '../src/index';
import { testEnv } from './helpers';

const rootEnv: Env = { ...testEnv, DASHBOARD_SLUG: '' };

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

describe('OAuthProvider骨組み', () => {
  it('POST /register で動的クライアント登録ができる', async () => {
    const res = await worker.fetch(
      req('/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'test-client',
          redirect_uris: ['http://localhost/cb'],
          token_endpoint_auth_method: 'none',
        }),
      }),
      rootEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string };
    expect(body.client_id).toBeTruthy();
  });

  it('/rw/ 配下はトークン無しだと401', async () => {
    const res = await worker.fetch(
      req('/rw/meals', { method: 'POST', body: '{}' }),
      rootEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(401);
  });

  it('既存の公開ルートは影響を受けない', async () => {
    const res = await worker.fetch(req('/api/status'), rootEnv, createExecutionContext());
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 5: テストが失敗することを確認**

Run: `npx vitest run test/oauth.test.ts`
Expected: FAIL（/register が404）

- [ ] **Step 6: src/rw.ts の骨組みを作る**

```ts
/**
 * 認証必須（/rw/）のルート。OAuthProviderのapiHandlerとして動くため、
 * ここに到達した時点でBearerトークンは検証済み。
 */
import { Hono } from 'hono';
import type { Env } from './types';
import { noindexHeaders } from './util';

export function createRwApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.notFound((c) => c.text('not found', 404, noindexHeaders()));
  app.onError((err, c) => {
    console.error('[rw] unhandled error', err);
    return c.text('internal error', 500, noindexHeaders());
  });
  return app;
}
```

- [ ] **Step 7: src/index.ts をOAuthProviderでラップ**

import追加と、既存 `export default { fetch: app.fetch, scheduled }` の置き換え:

```ts
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { createRwApp } from './rw';
```

```ts
const rwApp = createRwApp();

const provider = new OAuthProvider({
  apiRoute: '/rw/',
  // Honoのfetch(req, env, ctx)はExportedHandlerのfetch(req, env, ctx)と互換
  apiHandler: { fetch: rwApp.fetch as unknown as ExportedHandler<Env>['fetch'] } as never,
  defaultHandler: { fetch: app.fetch as unknown as ExportedHandler<Env>['fetch'] } as never,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: ['meals'],
});

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => provider.fetch(req, env as never, ctx),
  scheduled,
} satisfies ExportedHandler<Env>;
```

型が合わない場合は `as never` の位置を調整してよいが、ランタイム挙動（fetchがproviderを通る・scheduledは素通し）は変えないこと。

- [ ] **Step 8: テストが通ることを確認**

Run: `npm run typecheck && npx vitest run`
Expected: 全テストPASS（既存テストの回帰がないこと）

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/types.ts src/index.ts src/rw.ts test/oauth.test.ts
git commit -m "feat: wrap worker with OAuth 2.1 provider and reserve /rw/ authed routes"
```

---

### Task 2: マイグレーション0002と食事データ層（メニュー）

**Files:**
- Create: `migrations/0002_meals.sql`, `src/meals.ts`
- Modify: `schema.sql`, `src/types.ts`, `test/helpers.ts`
- Test: `test/meals.test.ts`

**Interfaces:**
- Produces:
  - 型: `Menu { id, name, calories, protein_g, fat_g, carbs_g, note, archived, created_at, updated_at }`（数値カラムは `number | null`、archivedは `boolean`）
  - `createMenu(env, input: MenuInput): Promise<Menu>` / `updateMenu(env, id, input: MenuInput): Promise<Menu | null>` / `setMenuArchived(env, id, archived: boolean): Promise<boolean>` / `listMenus(env, opts: { q?: string; includeArchived?: boolean }): Promise<Menu[]>` / `getMenu(env, id): Promise<Menu | null>`
  - `MenuInput = { name: string; calories: number; protein_g?: number | null; fat_g?: number | null; carbs_g?: number | null; note?: string | null }`

- [ ] **Step 1: migrations/0002_meals.sql を作成**

```sql
-- 食事記録 Phase 1: メニュー（マスタ）と記録（スナップショット方式）
CREATE TABLE menus (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  calories   REAL NOT NULL,
  protein_g  REAL,
  fat_g      REAL,
  carbs_g    REAL,
  note       TEXT,
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE meal_logs (
  id         TEXT PRIMARY KEY,
  menu_id    TEXT NOT NULL REFERENCES menus(id),
  eaten_at   TEXT NOT NULL,
  meal_type  TEXT,
  multiplier REAL NOT NULL DEFAULT 1.0,
  menu_name  TEXT NOT NULL,
  calories   REAL NOT NULL,
  protein_g  REAL,
  fat_g      REAL,
  carbs_g    REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_meal_logs_eaten_at ON meal_logs (eaten_at);
CREATE INDEX idx_menus_archived_name ON menus (archived, name);
```

同じCREATE文を `schema.sql` の末尾にも追記する（schema.sqlは参照用の全体スキーマ）。

- [ ] **Step 2: 型を src/types.ts に追加**

```ts
export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface Menu {
  id: string;
  name: string;
  calories: number;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  note: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface MenuInput {
  name: string;
  calories: number;
  protein_g?: number | null;
  fat_g?: number | null;
  carbs_g?: number | null;
  note?: string | null;
}
```

- [ ] **Step 3: test/helpers.ts にリセット対象とヘルパーを追加**

`resetTables()` の配列に `'meal_logs', 'menus'` を追加（外部キーの都合でmeal_logsを先に）。

- [ ] **Step 4: 失敗するテストを書く（test/meals.test.ts）**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createMenu, getMenu, listMenus, setMenuArchived, updateMenu } from '../src/meals';
import { resetTables, testEnv } from './helpers';

describe('メニューCRUD', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('作成・取得・更新ができる', async () => {
    const menu = await createMenu(testEnv, { name: 'ラーメン', calories: 800, protein_g: 20 });
    expect(menu.id).toBeTruthy();
    expect(menu.archived).toBe(false);
    const fetched = await getMenu(testEnv, menu.id);
    expect(fetched?.name).toBe('ラーメン');
    expect(fetched?.protein_g).toBe(20);
    expect(fetched?.fat_g).toBeNull();

    const updated = await updateMenu(testEnv, menu.id, { name: 'ラーメン大', calories: 1000 });
    expect(updated?.calories).toBe(1000);
    expect(updated?.protein_g).toBeNull(); // 全項目置き換え
  });

  it('listMenusは部分一致検索でき、archivedは既定で除外', async () => {
    const a = await createMenu(testEnv, { name: '鶏むね定食', calories: 600 });
    await createMenu(testEnv, { name: 'サラダ', calories: 100 });
    await setMenuArchived(testEnv, a.id, true);

    expect((await listMenus(testEnv, {})).map((m) => m.name)).toEqual(['サラダ']);
    expect((await listMenus(testEnv, { includeArchived: true })).length).toBe(2);
    expect((await listMenus(testEnv, { q: 'ラダ' })).map((m) => m.name)).toEqual(['サラダ']);
  });

  it('存在しないIDの更新はnull、archive切替はfalseを返す', async () => {
    expect(await updateMenu(testEnv, 'nope', { name: 'x', calories: 1 })).toBeNull();
    expect(await setMenuArchived(testEnv, 'nope', true)).toBe(false);
  });
});
```

- [ ] **Step 5: 失敗を確認**

Run: `npx vitest run test/meals.test.ts`
Expected: FAIL（src/meals.ts が存在しない）

- [ ] **Step 6: src/meals.ts を実装**

```ts
/**
 * 食事データ層。メニュー（マスタ）と記録（スナップショット）のD1クエリを集約する。
 */
import type { Env, Menu, MenuInput } from './types';
import { isoNow, newId } from './util';

interface MenuRow {
  id: string; name: string; calories: number;
  protein_g: number | null; fat_g: number | null; carbs_g: number | null;
  note: string | null; archived: number; created_at: string; updated_at: string;
}

function toMenu(r: MenuRow): Menu {
  return { ...r, archived: r.archived !== 0 };
}

const MENU_COLS = 'id, name, calories, protein_g, fat_g, carbs_g, note, archived, created_at, updated_at';

export async function createMenu(env: Env, input: MenuInput): Promise<Menu> {
  const now = isoNow();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO menus (id, name, calories, protein_g, fat_g, carbs_g, note, archived, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)`,
  )
    .bind(id, input.name, input.calories, input.protein_g ?? null, input.fat_g ?? null,
          input.carbs_g ?? null, input.note ?? null, now)
    .run();
  return (await getMenu(env, id))!;
}

export async function getMenu(env: Env, id: string): Promise<Menu | null> {
  const row = await env.DB.prepare(`SELECT ${MENU_COLS} FROM menus WHERE id = ?1`)
    .bind(id)
    .first<MenuRow>();
  return row ? toMenu(row) : null;
}

export async function updateMenu(env: Env, id: string, input: MenuInput): Promise<Menu | null> {
  const res = await env.DB.prepare(
    `UPDATE menus SET name = ?2, calories = ?3, protein_g = ?4, fat_g = ?5, carbs_g = ?6, note = ?7, updated_at = ?8
WHERE id = ?1`,
  )
    .bind(id, input.name, input.calories, input.protein_g ?? null, input.fat_g ?? null,
          input.carbs_g ?? null, input.note ?? null, isoNow())
    .run();
  if ((res.meta.changes ?? 0) === 0) return null;
  return getMenu(env, id);
}

export async function setMenuArchived(env: Env, id: string, archived: boolean): Promise<boolean> {
  const res = await env.DB.prepare('UPDATE menus SET archived = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(id, archived ? 1 : 0, isoNow())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function listMenus(
  env: Env,
  opts: { q?: string; includeArchived?: boolean },
): Promise<Menu[]> {
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (!opts.includeArchived) conds.push('archived = 0');
  if (opts.q) {
    binds.push(`%${opts.q}%`);
    conds.push(`name LIKE ?${binds.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const res = await env.DB.prepare(
    `SELECT ${MENU_COLS} FROM menus ${where} ORDER BY name LIMIT 500`,
  )
    .bind(...binds)
    .all<MenuRow>();
  return res.results.map(toMenu);
}
```

- [ ] **Step 7: テストが通ることを確認**

Run: `npm run typecheck && npx vitest run`
Expected: 全PASS（0002マイグレーションは `test/apply-migrations.ts` が自動適用する）

- [ ] **Step 8: Commit**

```bash
git add migrations/0002_meals.sql schema.sql src/types.ts src/meals.ts test/meals.test.ts test/helpers.ts
git commit -m "feat: add menus/meal_logs schema and menu data layer"
```

---

### Task 3: 記録（meal_logs）データ層

**Files:**
- Modify: `src/meals.ts`, `src/types.ts`
- Test: `test/meals.test.ts`（describe追加）

**Interfaces:**
- Produces:
  - 型: `MealLog { id, menu_id, eaten_at, meal_type, multiplier, menu_name, calories, protein_g, fat_g, carbs_g, created_at, effective_calories, effective_protein_g, effective_fat_g, effective_carbs_g }`
  - 型: `DailyIntake { d: string; count: number; calories: number; protein_g: number | null; fat_g: number | null; carbs_g: number | null }`
  - `logMeal(env, input: { menu_id: string; multiplier?: number; eaten_at?: string; meal_type?: MealType }): Promise<MealLog | { error: string }>`（archivedメニュー・未知IDは `{error}`）
  - `updateMealLog(env, id, patch: { multiplier?: number; eaten_at?: string; meal_type?: MealType | null }): Promise<MealLog | null>`
  - `deleteMealLog(env, id): Promise<boolean>` / `listMealLogs(env, from, to): Promise<MealLog[]>`（新しい順・最大2000件）
  - `getDailyIntake(env, from, to): Promise<DailyIntake[]>` / `getIntakeForDay(env, ymd): Promise<DailyIntake | null>`

- [ ] **Step 1: 型を src/types.ts に追加**

```ts
export interface MealLog {
  id: string;
  menu_id: string;
  eaten_at: string; // ISO8601 UTC
  meal_type: MealType | null;
  multiplier: number;
  menu_name: string;
  calories: number; // 1食分スナップショット
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  created_at: string;
  effective_calories: number; // calories * multiplier（読み取り時に計算）
  effective_protein_g: number | null;
  effective_fat_g: number | null;
  effective_carbs_g: number | null;
}

export interface DailyIntake {
  d: string; // ローカル日付 YYYY-MM-DD
  count: number;
  calories: number;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
}
```

- [ ] **Step 2: 失敗するテストを追加（test/meals.test.ts に describe を足す）**

```ts
import { deleteMealLog, getDailyIntake, listMealLogs, logMeal, updateMealLog } from '../src/meals';
import { localYmdDaysAgo } from './helpers';

describe('食事記録', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('メニューからスナップショット付きで記録し、倍率が実効値に効く', async () => {
    const menu = await createMenu(testEnv, { name: 'カレー', calories: 700, protein_g: 15 });
    const log = await logMeal(testEnv, { menu_id: menu.id, multiplier: 1.5, meal_type: 'dinner' });
    if ('error' in log) throw new Error(log.error);
    expect(log.menu_name).toBe('カレー');
    expect(log.effective_calories).toBeCloseTo(1050);
    expect(log.effective_protein_g).toBeCloseTo(22.5);
    expect(log.effective_fat_g).toBeNull();
  });

  it('メニューを後から編集しても過去の記録は変わらない（スナップショット保全）', async () => {
    const menu = await createMenu(testEnv, { name: 'カレー', calories: 700 });
    const log = await logMeal(testEnv, { menu_id: menu.id });
    if ('error' in log) throw new Error(log.error);
    await updateMenu(testEnv, menu.id, { name: 'カレー改', calories: 900 });
    const logs = await listMealLogs(testEnv, localYmdDaysAgo(1), localYmdDaysAgo(0));
    expect(logs[0].menu_name).toBe('カレー');
    expect(logs[0].calories).toBe(700);
  });

  it('archivedメニュー・未知IDへの記録はエラー', async () => {
    const menu = await createMenu(testEnv, { name: '旧メニュー', calories: 100 });
    await setMenuArchived(testEnv, menu.id, true);
    expect(await logMeal(testEnv, { menu_id: menu.id })).toHaveProperty('error');
    expect(await logMeal(testEnv, { menu_id: 'nope' })).toHaveProperty('error');
  });

  it('記録の修正・削除ができる', async () => {
    const menu = await createMenu(testEnv, { name: 'パン', calories: 200 });
    const log = await logMeal(testEnv, { menu_id: menu.id });
    if ('error' in log) throw new Error(log.error);
    const patched = await updateMealLog(testEnv, log.id, { multiplier: 2 });
    expect(patched?.effective_calories).toBeCloseTo(400);
    expect(await deleteMealLog(testEnv, log.id)).toBe(true);
    expect(await deleteMealLog(testEnv, log.id)).toBe(false);
  });

  it('日次集計はJSTローカル日付境界で行われる', async () => {
    const menu = await createMenu(testEnv, { name: '夜食', calories: 300 });
    // JST 2026-xx-xxの23:30 = 同日UTC 14:30 → ローカルでは当日扱い
    const today = localYmdDaysAgo(0);
    await logMeal(testEnv, { menu_id: menu.id, eaten_at: `${today}T14:30:00Z` });
    await logMeal(testEnv, { menu_id: menu.id, eaten_at: `${today}T03:00:00Z`, multiplier: 2 });
    const daily = await getDailyIntake(testEnv, today, today);
    expect(daily).toHaveLength(1);
    expect(daily[0].count).toBe(2);
    expect(daily[0].calories).toBeCloseTo(900);
  });
});
```

- [ ] **Step 3: 失敗を確認**

Run: `npx vitest run test/meals.test.ts`
Expected: FAIL（logMeal未定義）

- [ ] **Step 4: src/meals.ts に記録系を実装**

```ts
import type { DailyIntake, MealLog, MealType } from './types';
import { tzModifier } from './util';

interface MealLogRow {
  id: string; menu_id: string; eaten_at: string; meal_type: string | null;
  multiplier: number; menu_name: string; calories: number;
  protein_g: number | null; fat_g: number | null; carbs_g: number | null; created_at: string;
}

function toMealLog(r: MealLogRow): MealLog {
  const mul = (v: number | null): number | null => (v === null ? null : v * r.multiplier);
  return {
    ...r,
    meal_type: r.meal_type as MealType | null,
    effective_calories: r.calories * r.multiplier,
    effective_protein_g: mul(r.protein_g),
    effective_fat_g: mul(r.fat_g),
    effective_carbs_g: mul(r.carbs_g),
  };
}

const LOG_COLS =
  'id, menu_id, eaten_at, meal_type, multiplier, menu_name, calories, protein_g, fat_g, carbs_g, created_at';

export async function logMeal(
  env: Env,
  input: { menu_id: string; multiplier?: number; eaten_at?: string; meal_type?: MealType },
): Promise<MealLog | { error: string }> {
  const menu = await getMenu(env, input.menu_id);
  if (!menu) return { error: 'menu not found' };
  if (menu.archived) return { error: 'menu is archived' };
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO meal_logs (${LOG_COLS})
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(id, menu.id, input.eaten_at ?? isoNow(), input.meal_type ?? null,
          input.multiplier ?? 1.0, menu.name, menu.calories, menu.protein_g,
          menu.fat_g, menu.carbs_g, isoNow())
    .run();
  const row = await env.DB.prepare(`SELECT ${LOG_COLS} FROM meal_logs WHERE id = ?1`)
    .bind(id)
    .first<MealLogRow>();
  return toMealLog(row!);
}

export async function updateMealLog(
  env: Env,
  id: string,
  patch: { multiplier?: number; eaten_at?: string; meal_type?: MealType | null },
): Promise<MealLog | null> {
  const row = await env.DB.prepare(`SELECT ${LOG_COLS} FROM meal_logs WHERE id = ?1`)
    .bind(id)
    .first<MealLogRow>();
  if (!row) return null;
  await env.DB.prepare(
    'UPDATE meal_logs SET multiplier = ?2, eaten_at = ?3, meal_type = ?4 WHERE id = ?1',
  )
    .bind(id, patch.multiplier ?? row.multiplier, patch.eaten_at ?? row.eaten_at,
          patch.meal_type === undefined ? row.meal_type : patch.meal_type)
    .run();
  const updated = await env.DB.prepare(`SELECT ${LOG_COLS} FROM meal_logs WHERE id = ?1`)
    .bind(id)
    .first<MealLogRow>();
  return updated ? toMealLog(updated) : null;
}

export async function deleteMealLog(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM meal_logs WHERE id = ?1').bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function listMealLogs(env: Env, from: string, to: string): Promise<MealLog[]> {
  const tz = tzModifier(env);
  const res = await env.DB.prepare(
    `SELECT ${LOG_COLS} FROM meal_logs
WHERE date(eaten_at, '${tz}') BETWEEN ?1 AND ?2
ORDER BY eaten_at DESC LIMIT 2000`,
  )
    .bind(from, to)
    .all<MealLogRow>();
  return res.results.map(toMealLog);
}

export async function getDailyIntake(env: Env, from: string, to: string): Promise<DailyIntake[]> {
  const tz = tzModifier(env);
  const res = await env.DB.prepare(
    `SELECT date(eaten_at, '${tz}') AS d, COUNT(*) AS count,
       SUM(calories * multiplier) AS calories,
       SUM(protein_g * multiplier) AS protein_g,
       SUM(fat_g * multiplier) AS fat_g,
       SUM(carbs_g * multiplier) AS carbs_g
FROM meal_logs
WHERE date(eaten_at, '${tz}') BETWEEN ?1 AND ?2
GROUP BY 1 ORDER BY d`,
  )
    .bind(from, to)
    .all<DailyIntake>();
  return res.results;
}

export async function getIntakeForDay(env: Env, ymd: string): Promise<DailyIntake | null> {
  const rows = await getDailyIntake(env, ymd, ymd);
  return rows[0] ?? null;
}
```

- [ ] **Step 5: テスト通過を確認して Commit**

Run: `npm run typecheck && npx vitest run`

```bash
git add src/meals.ts src/types.ts test/meals.test.ts
git commit -m "feat: meal log data layer with snapshot and daily intake aggregation"
```

---

### Task 4: 公開REST読み取り + summary拡張 + llms/openapi更新

**Files:**
- Create: `src/meals-api.ts`
- Modify: `src/dashboard.ts`, `src/queries.ts`, `src/types.ts`, `src/ai.ts`
- Test: `test/meals-api.test.ts`（新規）、`test/ai-api.test.ts`（summary drift更新）

**Interfaces:**
- Consumes: Task 2/3 の `listMenus` `listMealLogs` `getDailyIntake` `getIntakeForDay`、既存 `validatedRange` 相当（`resolveRange` + `localToday`）
- Produces: Handler `serveMenus` `serveMealsList` `serveMealsDaily`（`src/meals-api.ts` からexport）。`WeightSummary.intake_today: DailyIntake | null` を追加

- [ ] **Step 1: 失敗するテストを書く（test/meals-api.test.ts）**

```ts
import { createExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { createRootDashboardRouter } from '../src/dashboard';
import { createMenu, logMeal } from '../src/meals';
import { localYmdDaysAgo, resetTables, testEnv } from './helpers';

const rootEnv: Env = { ...testEnv, DASHBOARD_SLUG: '' };
const app = new Hono<{ Bindings: Env }>().route('/', createRootDashboardRouter());

function request(path: string): Promise<Response> {
  return app.request(path, {}, rootEnv, createExecutionContext());
}

describe('公開REST（食事）', () => {
  beforeEach(async () => {
    await resetTables();
    const menu = await createMenu(testEnv, { name: '定食', calories: 650, protein_g: 30 });
    await logMeal(testEnv, {
      menu_id: menu.id,
      eaten_at: `${localYmdDaysAgo(0)}T03:00:00Z`,
      multiplier: 2,
    });
  });

  it('GET /api/menus が一覧を返す', async () => {
    const res = await request('/api/menus');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { menus: { name: string }[] };
    expect(body.menus.map((m) => m.name)).toEqual(['定食']);
  });

  it('GET /api/meals?days=7 が実効値付きで返す', async () => {
    const res = await request('/api/meals?days=7');
    const body = (await res.json()) as { meals: { effective_calories: number }[] };
    expect(body.meals[0].effective_calories).toBeCloseTo(1300);
  });

  it('GET /api/meals/daily?days=7 が日次合計を返す', async () => {
    const res = await request('/api/meals/daily?days=7');
    const body = (await res.json()) as { days: { d: string; calories: number }[] };
    expect(body.days).toHaveLength(1);
    expect(body.days[0].calories).toBeCloseTo(1300);
  });

  it('/api/summary に intake_today が含まれる', async () => {
    const res = await request('/api/summary');
    const body = (await res.json()) as { intake_today: { calories: number } | null };
    expect(body.intake_today?.calories).toBeCloseTo(1300);
  });

  it('期間バリデーションは既存規約（days+from併用は400）', async () => {
    expect((await request(`/api/meals?days=7&from=${localYmdDaysAgo(3)}`)).status).toBe(400);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run test/meals-api.test.ts`
Expected: FAIL（/api/menus が404）

- [ ] **Step 3: src/meals-api.ts を実装**

```ts
/** 食事の公開読み取りREST。書き込みは src/rw.ts（認証必須） */
import type { Context } from 'hono';
import { getDailyIntake, listMealLogs, listMenus } from './meals';
import type { Env } from './types';
import { localToday, noindexHeaders, resolveRange } from './util';

type MealsContext = Context<{ Bindings: Env }>;
type Handler = (c: MealsContext) => Response | Promise<Response>;

const NO_STORE = { 'Cache-Control': 'no-store' };

function withRange(
  c: MealsContext,
  fn: (from: string, to: string) => Promise<Response>,
): Promise<Response> | Response {
  const headers = noindexHeaders(NO_STORE);
  const range = resolveRange(
    { days: c.req.query('days'), from: c.req.query('from'), to: c.req.query('to') },
    localToday(c.env),
  );
  if (!range.ok) return c.json({ error: range.error }, 400, headers);
  return fn(range.from, range.to);
}

export const serveMenus: Handler = async (c) => {
  const headers = noindexHeaders(NO_STORE);
  try {
    const menus = await listMenus(c.env, {
      q: c.req.query('q') || undefined,
      includeArchived: c.req.query('archived') === '1',
    });
    return c.json({ menus }, 200, headers);
  } catch (err) {
    console.error('[meals-api] listMenus failed', err);
    return c.json({ error: 'internal error' }, 500, headers);
  }
};

export const serveMealsList: Handler = (c) =>
  withRange(c, async (from, to) => {
    try {
      return c.json({ meals: await listMealLogs(c.env, from, to) }, 200, noindexHeaders(NO_STORE));
    } catch (err) {
      console.error('[meals-api] listMealLogs failed', err);
      return c.json({ error: 'internal error' }, 500, noindexHeaders(NO_STORE));
    }
  });

export const serveMealsDaily: Handler = (c) =>
  withRange(c, async (from, to) => {
    try {
      return c.json({ days: await getDailyIntake(c.env, from, to) }, 200, noindexHeaders(NO_STORE));
    } catch (err) {
      console.error('[meals-api] getDailyIntake failed', err);
      return c.json({ error: 'internal error' }, 500, noindexHeaders(NO_STORE));
    }
  });
```

- [ ] **Step 4: dashboard.ts の両ルーターに登録**

root側（createRootDashboardRouter）:

```ts
  app.get('/api/menus', guarded(serveMenus));
  app.get('/api/meals', guarded(serveMealsList));
  app.get('/api/meals/daily', guarded(serveMealsDaily));
```

slug側（createDashboardRouter）は `'/:slug/api/menus'` 等で同様に登録。**`/api/meals/daily` は `/api/meals` より先に登録**（Honoは登録順で解決するため）。

- [ ] **Step 5: queries.ts の getSummary に intake_today を追加**

`WeightSummary` に `intake_today: DailyIntake | null;` を追加し、getSummary内で:

```ts
import { getIntakeForDay } from './meals';
import { localToday } from './util';
// getSummary内、returnの前に:
const intakeToday = await getIntakeForDay(env, localToday(env));
// return に intake_today: intakeToday を追加
```

- [ ] **Step 6: ai.ts を更新**

- llms.txt のエンドポイント一覧に3行追加:

```
- GET ${root}/api/menus?q= — 食事メニュー（マスタ）一覧・検索
- GET ${root}/api/meals?days=7 — 食事記録（メニュー名・倍率・実効kcal/PFC付き）
- GET ${root}/api/meals/daily?days=30 — 日次の摂取カロリー・PFC合計
```

- openapi.json の `paths` に `/api/menus` `/api/meals` `/api/meals/daily` をGETで追加（rangeParams再利用、componentsに `Menu` `MealLog` `DailyIntake` スキーマを追加）し、`/api/summary` のpropertiesに `intake_today` を追加（`oneOf: [DailyIntake, null]`）。フィールドは実装と同名にする（drift検知テストが検証する）。

- [ ] **Step 7: 全テスト実行・drift修正**

Run: `npm run typecheck && npx vitest run`
Expected: `test/ai-api.test.ts` のsummary drift検知が通ること（`intake_today` をopenapiに足し忘れるとここで落ちる）

- [ ] **Step 8: Commit**

```bash
git add src/meals-api.ts src/dashboard.ts src/queries.ts src/types.ts src/ai.ts test/meals-api.test.ts
git commit -m "feat: public read API for menus, meal logs, daily intake and summary intake_today"
```

---

### Task 5: Google認可フロー（/authorize）

**Files:**
- Create: `src/oauth.ts`
- Modify: `src/index.ts`
- Test: `test/oauth.test.ts`（describe追加）

**Interfaces:**
- Consumes: `env.OAUTH_PROVIDER`（OAuthHelpers: `parseAuthRequest` / `completeAuthorization`）
- Produces: `registerOauthRoutes(app: Hono<{ Bindings: Env }>): void` — `/authorize`（GET）と `/authorize/callback`（GET）を登録。`src/index.ts` で `registerOauthRoutes(app)` を呼ぶ（`app.route('/d', ...)` より前）

- [ ] **Step 1: 失敗するテストを追加（test/oauth.test.ts）**

```ts
import { stubFetch } from './helpers';
import { vi, afterEach } from 'vitest';

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function registerClient(env: Env): Promise<string> {
  const res = await worker.fetch(
    req('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'test-client',
        redirect_uris: ['http://localhost/cb'],
        token_endpoint_auth_method: 'none',
      }),
    }),
    env,
    createExecutionContext(),
  );
  return ((await res.json()) as { client_id: string }).client_id;
}

describe('Google認可フロー', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('/authorize がGoogleへリダイレクトし、オーナーのメールならcode付きで戻る', async () => {
    const clientId = await registerClient(rootEnv);
    const verifier = 'test-verifier-01234567890123456789012345678901';
    const challenge = b64url(
      String.fromCharCode(
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
      ),
    );
    const authorize = await worker.fetch(
      req(
        `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('http://localhost/cb')}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&scope=meals`,
      ),
      rootEnv,
      createExecutionContext(),
    );
    expect(authorize.status).toBe(302);
    const googleUrl = new URL(authorize.headers.get('Location')!);
    expect(googleUrl.host).toBe('accounts.google.com');
    const googleState = googleUrl.searchParams.get('state')!;

    const stub = stubFetch();
    stub.on({ host: 'oauth2.googleapis.com', path: '/token', reply: () => Response.json({ access_token: 'g-at' }) });
    stub.on({
      host: 'openidconnect.googleapis.com',
      path: '/v1/userinfo',
      reply: () => Response.json({ email: 'owner@example.com', email_verified: true }),
    });
    const cb = await worker.fetch(
      req(`/authorize/callback?code=g-code&state=${encodeURIComponent(googleState)}`),
      rootEnv,
      createExecutionContext(),
    );
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get('Location')!);
    expect(back.origin + back.pathname).toBe('http://localhost/cb');
    expect(back.searchParams.get('code')).toBeTruthy();
    expect(back.searchParams.get('state')).toBe('xyz');

    // codeをトークンに交換できる
    const token = await worker.fetch(
      req('/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: back.searchParams.get('code')!,
          redirect_uri: 'http://localhost/cb',
          client_id: clientId,
          code_verifier: verifier,
        }).toString(),
      }),
      rootEnv,
      createExecutionContext(),
    );
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as { access_token: string };
    expect(tokens.access_token).toBeTruthy();
  });

  it('オーナー以外のメールは403でトークンを発行しない', async () => {
    const clientId = await registerClient(rootEnv);
    const authorize = await worker.fetch(
      req(
        `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('http://localhost/cb')}&code_challenge=abc&code_challenge_method=S256&state=x&scope=meals`,
      ),
      rootEnv,
      createExecutionContext(),
    );
    const googleState = new URL(authorize.headers.get('Location')!).searchParams.get('state')!;
    const stub = stubFetch();
    stub.on({ host: 'oauth2.googleapis.com', path: '/token', reply: () => Response.json({ access_token: 'g-at' }) });
    stub.on({
      host: 'openidconnect.googleapis.com',
      path: '/v1/userinfo',
      reply: () => Response.json({ email: 'attacker@example.com', email_verified: true }),
    });
    const cb = await worker.fetch(
      req(`/authorize/callback?code=g-code&state=${encodeURIComponent(googleState)}`),
      rootEnv,
      createExecutionContext(),
    );
    expect(cb.status).toBe(403);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run test/oauth.test.ts`
Expected: FAIL（/authorize が404）

- [ ] **Step 3: src/oauth.ts を実装**

```ts
/**
 * OAuth認可画面（本人確認）。workers-oauth-providerが/token・/registerを担い、
 * /authorizeの中身（誰を認証しトークン発行を許すか）はここで実装する。
 * 本人確認はGoogleログイン: userinfoのメールを OWNER_EMAILS と照合する。
 */
import type { Hono } from 'hono';
import type { Env } from './types';
import { assertSecret, noindexHeaders } from './util';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

function ownerEmails(env: Env): string[] {
  return (env.OWNER_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}

export function registerOauthRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get('/authorize', async (c) => {
    const env = c.env;
    // OAUTH_PROVIDERはworkers-oauth-providerがenvに注入するヘルパー
    const helpers = (env as unknown as { OAUTH_PROVIDER: import('@cloudflare/workers-oauth-provider').OAuthHelpers }).OAUTH_PROVIDER;
    const authReq = await helpers.parseAuthRequest(c.req.raw).catch(() => null);
    if (!authReq) return c.text('invalid authorization request', 400, noindexHeaders());
    const origin = new URL(c.req.url).origin;
    // 認可リクエスト全体をGoogleのstateに載せてラウンドトリップする
    // （単一オーナー用途。stateの完全性はGoogleのcode交換が自クライアント限定である事に依存）
    const state = b64urlEncode(JSON.stringify(authReq));
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('client_id', assertSecret(env.GOOGLE_OAUTH_CLIENT_ID, 'GOOGLE_OAUTH_CLIENT_ID'));
    url.searchParams.set('redirect_uri', `${origin}/authorize/callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
    return c.redirect(url.toString(), 302);
  });

  app.get('/authorize/callback', async (c) => {
    const env = c.env;
    const helpers = (env as unknown as { OAUTH_PROVIDER: import('@cloudflare/workers-oauth-provider').OAuthHelpers }).OAUTH_PROVIDER;
    const code = c.req.query('code');
    const stateRaw = c.req.query('state');
    if (!code || !stateRaw) return c.text('missing code/state', 400, noindexHeaders());
    let authReq: import('@cloudflare/workers-oauth-provider').AuthRequest;
    try {
      authReq = JSON.parse(b64urlDecode(stateRaw));
    } catch {
      return c.text('invalid state', 400, noindexHeaders());
    }
    const origin = new URL(c.req.url).origin;
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: assertSecret(env.GOOGLE_OAUTH_CLIENT_ID, 'GOOGLE_OAUTH_CLIENT_ID'),
        client_secret: assertSecret(env.GOOGLE_OAUTH_CLIENT_SECRET, 'GOOGLE_OAUTH_CLIENT_SECRET'),
        code,
        grant_type: 'authorization_code',
        redirect_uri: `${origin}/authorize/callback`,
      }).toString(),
    });
    if (!tokenRes.ok) {
      console.error('[oauth] google token exchange failed', tokenRes.status);
      return c.text('google login failed', 502, noindexHeaders());
    }
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    if (!access_token) return c.text('google login failed', 502, noindexHeaders());
    const userinfoRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!userinfoRes.ok) return c.text('google login failed', 502, noindexHeaders());
    const userinfo = (await userinfoRes.json()) as { email?: string; email_verified?: boolean };
    const email = (userinfo.email ?? '').toLowerCase();
    if (!userinfo.email_verified || !ownerEmails(env).includes(email)) {
      console.warn('[oauth] rejected non-owner login');
      return c.text('forbidden: not the owner', 403, noindexHeaders());
    }
    const { redirectTo } = await helpers.completeAuthorization({
      request: authReq,
      userId: email,
      metadata: {},
      scope: authReq.scope ?? [],
      props: { email },
    });
    return c.redirect(redirectTo, 302);
  });
}
```

- [ ] **Step 4: src/index.ts で登録**

`app.route('/d', createDashboardRouter());` の直前に:

```ts
registerOauthRoutes(app);
```

- [ ] **Step 5: テスト通過を確認して Commit**

Run: `npm run typecheck && npx vitest run`

```bash
git add src/oauth.ts src/index.ts test/oauth.test.ts
git commit -m "feat: Google-backed OAuth authorization flow for owner verification"
```

---

### Task 6: /rw/ REST書き込みAPI

**Files:**
- Modify: `src/rw.ts`, `test/helpers.ts`
- Test: `test/rw-api.test.ts`

**Interfaces:**
- Consumes: Task 2/3のデータ層、Task 5の認可フロー
- Produces:
  - REST: `POST /rw/menus` `PATCH /rw/menus/:id` `POST /rw/menus/:id/archive` `POST /rw/menus/:id/unarchive` `POST /rw/meals` `PATCH /rw/meals/:id` `DELETE /rw/meals/:id`
  - テストヘルパー: `obtainAccessToken(env: Env): Promise<string>`（クライアント登録→認可→トークン交換の一式。Googleはスタブ）
  - バリデータ: `parseMenuInput(body: unknown): { ok: true; value: MenuInput } | { ok: false; error: string }`（rw.ts内、Task 8のcreate_menuも使う）

- [ ] **Step 1: test/helpers.ts に obtainAccessToken を追加**

Task 5のテストの登録→認可→交換の流れを関数化する（`import worker from '../src/index'` を追加）:

```ts
/** OAuthフロー一式を通して実アクセストークンを得る。呼び出し側でstubFetchを開始していない前提（内部で開始・解除する） */
export async function obtainAccessToken(env: Env): Promise<string> {
  const ctx = () => createExecutionContext();
  const reg = await worker.fetch(
    new Request('http://localhost/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'test',
        redirect_uris: ['http://localhost/cb'],
        token_endpoint_auth_method: 'none',
      }),
    }),
    env,
    ctx(),
  );
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = 'helper-verifier-0123456789012345678901234567';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const auth = await worker.fetch(
    new Request(
      `http://localhost/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent('http://localhost/cb')}&code_challenge=${challenge}&code_challenge_method=S256&state=s&scope=meals`,
    ),
    env,
    ctx(),
  );
  const googleState = new URL(auth.headers.get('Location')!).searchParams.get('state')!;
  const stub = stubFetch();
  stub
    .on({ host: 'oauth2.googleapis.com', path: '/token', reply: () => Response.json({ access_token: 'g-at' }) })
    .on({
      host: 'openidconnect.googleapis.com',
      path: '/v1/userinfo',
      reply: () => Response.json({ email: 'owner@example.com', email_verified: true }),
    });
  const cb = await worker.fetch(
    new Request(`http://localhost/authorize/callback?code=g&state=${encodeURIComponent(googleState)}`),
    env,
    ctx(),
  );
  vi.unstubAllGlobals();
  const code = new URL(cb.headers.get('Location')!).searchParams.get('code')!;
  const token = await worker.fetch(
    new Request('http://localhost/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://localhost/cb',
        client_id,
        code_verifier: verifier,
      }).toString(),
    }),
    env,
    ctx(),
  );
  return ((await token.json()) as { access_token: string }).access_token;
}
```

- [ ] **Step 2: 失敗するテストを書く（test/rw-api.test.ts）**

```ts
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

    expect((await rw(`/rw/menus/${menu.id}/archive`, token, 'POST')).status).toBe(200);
    expect((await rw(`/rw/menus/${menu.id}/unarchive`, token, 'POST')).status).toBe(200);
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
```

- [ ] **Step 3: 失敗を確認**

Run: `npx vitest run test/rw-api.test.ts`
Expected: FAIL（/rw/menus が404）

- [ ] **Step 4: src/rw.ts にルートとバリデーションを実装**

```ts
import type { MealType, MenuInput } from './types';
import {
  createMenu, deleteMealLog, logMeal, setMenuArchived, updateMealLog, updateMenu,
} from './meals';
import { isoNow } from './util';

const MEAL_TYPES: readonly string[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const MAX_MULTIPLIER = 20;

function isPositiveFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function optionalNutrient(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return isPositiveFinite(v) ? v : undefined;
}

export function parseMenuInput(body: unknown): { ok: true; value: MenuInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.name !== 'string' || b.name.trim() === '') return { ok: false, error: 'name is required' };
  if (!isPositiveFinite(b.calories)) return { ok: false, error: 'calories must be a positive number' };
  for (const key of ['protein_g', 'fat_g', 'carbs_g'] as const) {
    if (b[key] !== undefined && b[key] !== null && !isPositiveFinite(b[key])) {
      return { ok: false, error: `${key} must be a positive number` };
    }
  }
  return {
    ok: true,
    value: {
      name: b.name.trim(),
      calories: b.calories,
      protein_g: optionalNutrient(b.protein_g) ?? null,
      fat_g: optionalNutrient(b.fat_g) ?? null,
      carbs_g: optionalNutrient(b.carbs_g) ?? null,
      note: typeof b.note === 'string' ? b.note : null,
    },
  };
}

interface MealFields {
  multiplier?: number;
  eaten_at?: string;
  meal_type?: MealType;
}

export function parseMealFields(b: Record<string, unknown>): { ok: true; value: MealFields } | { ok: false; error: string } {
  const out: MealFields = {};
  if (b.multiplier !== undefined) {
    if (!isPositiveFinite(b.multiplier) || (b.multiplier as number) > MAX_MULTIPLIER) {
      return { ok: false, error: `multiplier must be a positive number <= ${MAX_MULTIPLIER}` };
    }
    out.multiplier = b.multiplier as number;
  }
  if (b.eaten_at !== undefined) {
    if (typeof b.eaten_at !== 'string' || Number.isNaN(Date.parse(b.eaten_at))) {
      return { ok: false, error: 'eaten_at must be ISO8601' };
    }
    if (Date.parse(b.eaten_at) > Date.parse(isoNow()) + 60_000) {
      return { ok: false, error: 'eaten_at must not be in the future' };
    }
    out.eaten_at = b.eaten_at;
  }
  if (b.meal_type !== undefined && b.meal_type !== null) {
    if (typeof b.meal_type !== 'string' || !MEAL_TYPES.includes(b.meal_type)) {
      return { ok: false, error: `meal_type must be one of ${MEAL_TYPES.join(', ')}` };
    }
    out.meal_type = b.meal_type as MealType;
  }
  return { ok: true, value: out };
}
```

createRwApp内にルートを追加:

```ts
  const headers = () => noindexHeaders({ 'Cache-Control': 'no-store' });
  const readJson = async (c: Context<{ Bindings: Env }>): Promise<Record<string, unknown> | null> =>
    (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

  app.post('/rw/menus', async (c) => {
    const parsed = parseMenuInput(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400, headers());
    return c.json(await createMenu(c.env, parsed.value), 201, headers());
  });

  app.patch('/rw/menus/:id', async (c) => {
    const parsed = parseMenuInput(await readJson(c));
    if (!parsed.ok) return c.json({ error: parsed.error }, 400, headers());
    const menu = await updateMenu(c.env, c.req.param('id'), parsed.value);
    return menu ? c.json(menu, 200, headers()) : c.json({ error: 'menu not found' }, 404, headers());
  });

  app.post('/rw/menus/:id/archive', async (c) =>
    (await setMenuArchived(c.env, c.req.param('id'), true))
      ? c.json({ ok: true }, 200, headers())
      : c.json({ error: 'menu not found' }, 404, headers()));

  app.post('/rw/menus/:id/unarchive', async (c) =>
    (await setMenuArchived(c.env, c.req.param('id'), false))
      ? c.json({ ok: true }, 200, headers())
      : c.json({ error: 'menu not found' }, 404, headers()));

  app.post('/rw/meals', async (c) => {
    const body = (await readJson(c)) ?? {};
    if (typeof body.menu_id !== 'string') return c.json({ error: 'menu_id is required' }, 400, headers());
    const fields = parseMealFields(body);
    if (!fields.ok) return c.json({ error: fields.error }, 400, headers());
    const log = await logMeal(c.env, { menu_id: body.menu_id, ...fields.value });
    if ('error' in log) return c.json({ error: log.error }, 400, headers());
    return c.json(log, 201, headers());
  });

  app.patch('/rw/meals/:id', async (c) => {
    const body = (await readJson(c)) ?? {};
    const fields = parseMealFields(body);
    if (!fields.ok) return c.json({ error: fields.error }, 400, headers());
    const log = await updateMealLog(c.env, c.req.param('id'), fields.value);
    return log ? c.json(log, 200, headers()) : c.json({ error: 'meal log not found' }, 404, headers());
  });

  app.delete('/rw/meals/:id', async (c) =>
    (await deleteMealLog(c.env, c.req.param('id')))
      ? c.json({ ok: true }, 200, headers())
      : c.json({ error: 'meal log not found' }, 404, headers()));
```

- [ ] **Step 5: テスト通過を確認して Commit**

Run: `npm run typecheck && npx vitest run`

```bash
git add src/rw.ts test/helpers.ts test/rw-api.test.ts
git commit -m "feat: authenticated /rw/ REST endpoints for menus and meal logs"
```

---

### Task 7: MCP読み取りツール（公開 /mcp に追加）

**Files:**
- Modify: `src/mcp.ts`
- Test: `test/mcp-meals.test.ts`

**Interfaces:**
- Consumes: `listMenus` `listMealLogs`
- Produces: 公開 `/mcp` のツールが5つになる: 既存3 + `search_menus` {q?} + `get_meal_logs` {days?|from?/to?}

- [ ] **Step 1: 失敗するテストを書く（test/mcp-meals.test.ts）**

test/mcp.test.ts の `rpc` / `parseToolJson` と同形のヘルパーを定義した上で:

```ts
describe('MCP食事ツール（公開）', () => {
  beforeEach(async () => {
    await resetTables();
    const menu = await createMenu(testEnv, { name: '唐揚げ定食', calories: 850 });
    await logMeal(testEnv, { menu_id: menu.id, eaten_at: `${localYmdDaysAgo(0)}T03:00:00Z` });
  });

  it('tools/list に search_menus と get_meal_logs が現れる（書き込みツールは現れない）', async () => {
    const res = await rpc(app, rootEnv, '/mcp', 'tools/list');
    const tools = ((await res.json()) as RpcResponse).result!.tools as { name: string }[];
    const names = tools.map((t) => t.name);
    expect(names).toContain('search_menus');
    expect(names).toContain('get_meal_logs');
    expect(names).not.toContain('log_meal');
    expect(names).not.toContain('create_menu');
  });

  it('search_menus が部分一致で返す', async () => {
    const res = await rpc(app, rootEnv, '/mcp', 'tools/call', { name: 'search_menus', arguments: { q: '唐揚げ' } });
    const data = parseToolJson<{ menus: { name: string }[] }>(((await res.json()) as RpcResponse).result!);
    expect(data.menus[0].name).toBe('唐揚げ定食');
  });

  it('get_meal_logs が実効値付きで返す', async () => {
    const res = await rpc(app, rootEnv, '/mcp', 'tools/call', { name: 'get_meal_logs', arguments: { days: 7 } });
    const data = parseToolJson<{ meals: { effective_calories: number }[] }>(((await res.json()) as RpcResponse).result!);
    expect(data.meals[0].effective_calories).toBeCloseTo(850);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run test/mcp-meals.test.ts`
Expected: FAIL（search_menus が無い）

- [ ] **Step 3: src/mcp.ts のbuildServerに読み取りツールを追加**

```ts
import { listMealLogs, listMenus } from './meals';
```

buildServer内（既存3ツールの後）:

```ts
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
```

既存の `instructions` に1行追記: 「食事記録はsearch_menus / get_meal_logsで照会できる（記録・メニュー作成は認可済みエンドポイント/rw/mcpのみ）。」

- [ ] **Step 4: 既存mcp.test.tsのツール数assertを修正**

`tools/list が読み取り専用ツール3つを返す` のexpectを5ツール（`get_daily_series` `get_meal_logs` `get_raw_measurements` `get_weight_summary` `search_menus`）に更新。

- [ ] **Step 5: テスト通過を確認して Commit**

Run: `npm run typecheck && npx vitest run`

```bash
git add src/mcp.ts test/mcp-meals.test.ts test/mcp.test.ts
git commit -m "feat: add menu search and meal log MCP read tools"
```

---

### Task 8: /rw/mcp（MCP書き込みツール）

**Files:**
- Modify: `src/mcp.ts`, `src/rw.ts`
- Test: `test/mcp-meals.test.ts`（describe追加）

**Interfaces:**
- Consumes: Task 6の `parseMenuInput` `parseMealFields`、`obtainAccessToken`
- Produces: `handleMcpRequest(c, opts?: { write?: boolean })` — writeがtruthyのとき `log_meal` と `create_menu` を追加登録。`/rw/mcp` ルート（POST、認証済み）

- [ ] **Step 1: 失敗するテストを追加（test/mcp-meals.test.ts）**

```ts
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
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest run test/mcp-meals.test.ts`
Expected: FAIL（/rw/mcp が404）

- [ ] **Step 3: src/mcp.ts に書き込みツールとwriteフラグを実装**

`buildServer(env: Env, opts: { write: boolean })` に変更し、`handleMcpRequest(c, opts?: { write?: boolean })` からフラグを渡す（既存呼び出しはwrite:false扱い）。書き込みツール:

```ts
import { parseMealFields, parseMenuInput } from './rw';
import { getMenu, listMenus, logMeal, createMenu } from './meals';

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
```

- [ ] **Step 4: src/rw.ts に /rw/mcp ルートを追加**

```ts
import { handleMcpRequest } from './mcp';
// createRwApp内:
  app.all('/rw/mcp', (c) => handleMcpRequest(c, { write: true }));
```

循環import注意: mcp.ts が rw.ts の `parseMenuInput` を、rw.ts が mcp.ts の `handleMcpRequest` をimportすると循環する。**バリデータ（parseMenuInput/parseMealFields）は `src/meals.ts` に移して両者から参照する**（rw.tsからはre-exportしない）。

- [ ] **Step 5: テスト通過を確認して Commit**

Run: `npm run typecheck && npx vitest run`

```bash
git add src/mcp.ts src/rw.ts src/meals.ts test/mcp-meals.test.ts
git commit -m "feat: authenticated /rw/mcp with log_meal and create_menu tools"
```

---

### Task 9: ダッシュボードUI（食事タブ + OAuthログイン）

**Files:**
- Create: `src/dashboard/meals.js`
- Modify: `src/dashboard/index.html`, `src/dashboard/styles.css`, `src/dashboard.ts`
- Test: `test/dashboard-root.test.ts`（配信の確認を追加）

**Interfaces:**
- Consumes: 公開REST（/api/menus /api/meals /api/meals/daily）、/rw/ REST、/register /authorize /token（PKCE）
- Produces: `{{BASE}}meals.js` として配信されるUIモジュール（`initMealsTab(base)` をDOMContentLoadedで呼ぶ）

- [ ] **Step 1: 配信テストを追加（test/dashboard-root.test.ts）**

```ts
  it('/meals.js が配信され、HTMLに食事タブが含まれる', async () => {
    const js = await request('/meals.js', rootEnv);
    expect(js.status).toBe(200);
    expect(js.headers.get('Content-Type')).toContain('javascript');
    const html = await (await request('/', rootEnv)).text();
    expect(html).toContain('id="tab-meals"');
    expect(html).toContain('meals.js');
  });
```

Run: `npx vitest run test/dashboard-root.test.ts` → FAIL を確認。

- [ ] **Step 2: index.html にタブと食事セクションを追加**

`<body>` 直下のヘッダ付近にタブ切替を追加し、既存のグラフ・表全体を `<section id="panel-weight">` で包み、以下を追加:

```html
<nav class="tabs">
  <button id="tab-weight" class="tab active" type="button">体重</button>
  <button id="tab-meals" class="tab" type="button">食事</button>
</nav>
<section id="panel-meals" hidden>
  <div id="meals-auth">
    <button id="meals-login" type="button">ログインして記録する</button>
  </div>
  <div id="meals-today">
    <h2>今日の食事 <span id="meals-total"></span></h2>
    <ul id="meals-list"></ul>
    <form id="meal-add-form" hidden>
      <input id="meal-menu-search" type="search" placeholder="メニューを検索" autocomplete="off">
      <ul id="meal-menu-candidates"></ul>
      <label>倍率 <input id="meal-multiplier" type="number" value="1" min="0.1" max="20" step="0.1"></label>
      <select id="meal-type">
        <option value="">区分なし</option>
        <option value="breakfast">朝食</option>
        <option value="lunch">昼食</option>
        <option value="dinner">夕食</option>
        <option value="snack">間食</option>
      </select>
      <button type="submit">記録</button>
    </form>
  </div>
  <details id="menus-manage">
    <summary>メニュー管理</summary>
    <form id="menu-form">
      <input id="menu-name" placeholder="メニュー名" required>
      <input id="menu-calories" type="number" placeholder="kcal" min="1" required>
      <input id="menu-protein" type="number" placeholder="P(g)" min="0" step="0.1">
      <input id="menu-fat" type="number" placeholder="F(g)" min="0" step="0.1">
      <input id="menu-carbs" type="number" placeholder="C(g)" min="0" step="0.1">
      <button type="submit">追加</button>
    </form>
    <ul id="menus-list"></ul>
  </details>
</section>
<script src="{{BASE}}meals.js?v={{ASSET_VERSION}}" defer></script>
```

- [ ] **Step 3: src/dashboard/meals.js を実装**

```js
/* 食事タブ: 公開READは無認証、書き込みはOAuth(PKCE)のトークンで /rw/ を呼ぶ */
(() => {
  const base = document.querySelector('script[src*="meals.js"]').src.replace(/meals\.js.*$/, '');
  const origin = location.origin;
  const LS = { token: 'meals.token', refresh: 'meals.refresh', client: 'meals.client_id', verifier: 'meals.pkce' };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

  // ---- タブ切替 ----
  const panels = { weight: $('panel-weight'), meals: $('panel-meals') };
  const tabs = { weight: $('tab-weight'), meals: $('tab-meals') };
  function showTab(name) {
    for (const key of Object.keys(panels)) {
      panels[key].hidden = key !== name;
      tabs[key].classList.toggle('active', key === name);
    }
    if (name === 'meals') refresh();
  }
  tabs.weight.addEventListener('click', () => showTab('weight'));
  tabs.meals.addEventListener('click', () => showTab('meals'));

  // ---- OAuth (PKCE) ----
  function b64url(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function ensureClient() {
    let id = localStorage.getItem(LS.client);
    if (id) return id;
    const res = await fetch(`${origin}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'weight-dashboard', redirect_uris: [base], token_endpoint_auth_method: 'none' }),
    });
    id = (await res.json()).client_id;
    localStorage.setItem(LS.client, id);
    return id;
  }
  async function login() {
    const clientId = await ensureClient();
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    localStorage.setItem(LS.verifier, verifier);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const url = new URL(`${origin}/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: base,
      code_challenge: challenge, code_challenge_method: 'S256', state: 'dash', scope: 'meals',
    }).toString();
    location.href = url.toString();
  }
  async function exchangeToken(params) {
    const res = await fetch(`${origin}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) return false;
    const t = await res.json();
    localStorage.setItem(LS.token, t.access_token);
    if (t.refresh_token) localStorage.setItem(LS.refresh, t.refresh_token);
    return true;
  }
  async function handleCallback() {
    const q = new URLSearchParams(location.search);
    if (!q.get('code')) return;
    await exchangeToken({
      grant_type: 'authorization_code', code: q.get('code'), redirect_uri: base,
      client_id: localStorage.getItem(LS.client), code_verifier: localStorage.getItem(LS.verifier),
    });
    history.replaceState(null, '', base);
    showTab('meals');
  }
  async function rw(path, method, body) {
    const call = () =>
      fetch(`${origin}/rw/${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem(LS.token)}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let res = await call();
    if (res.status === 401 && localStorage.getItem(LS.refresh)) {
      const ok = await exchangeToken({
        grant_type: 'refresh_token', refresh_token: localStorage.getItem(LS.refresh),
        client_id: localStorage.getItem(LS.client),
      });
      if (ok) res = await call();
    }
    if (res.status === 401) {
      localStorage.removeItem(LS.token);
      updateAuthUi();
    }
    return res;
  }
  const loggedIn = () => Boolean(localStorage.getItem(LS.token));
  function updateAuthUi() {
    $('meals-auth').hidden = loggedIn();
    $('meal-add-form').hidden = !loggedIn();
    $('menus-manage').hidden = !loggedIn();
  }
  $('meals-login').addEventListener('click', login);

  // ---- データ表示 ----
  let menus = [];
  let selectedMenu = null;
  async function refresh() {
    updateAuthUi();
    const [mealsRes, menusRes] = await Promise.all([
      fetch(`${base}api/meals?days=1`),
      fetch(`${base}api/menus`),
    ]);
    const meals = (await mealsRes.json()).meals ?? [];
    menus = (await menusRes.json()).menus ?? [];
    const total = meals.reduce((a, m) => a + m.effective_calories, 0);
    $('meals-total').textContent = meals.length ? `${Math.round(total)} kcal` : '';
    $('meals-list').innerHTML = meals
      .map(
        (m) => `<li>${esc(m.menu_name)} ×${m.multiplier}（${Math.round(m.effective_calories)} kcal）
          ${loggedIn() ? `<button data-del="${m.id}" type="button">削除</button>` : ''}</li>`,
      )
      .join('');
    $('menus-list').innerHTML = menus
      .map((m) => `<li>${esc(m.name)}（${m.calories} kcal）<button data-arch="${m.id}" type="button">アーカイブ</button></li>`)
      .join('');
  }
  $('meals-list').addEventListener('click', async (e) => {
    const id = e.target.dataset?.del;
    if (id && confirm('この記録を削除しますか？')) {
      await rw(`meals/${id}`, 'DELETE');
      refresh();
    }
  });
  $('menus-list').addEventListener('click', async (e) => {
    const id = e.target.dataset?.arch;
    if (id) {
      await rw(`menus/${id}/archive`, 'POST');
      refresh();
    }
  });

  // ---- 記録フォーム ----
  $('meal-menu-search').addEventListener('input', () => {
    const q = $('meal-menu-search').value.trim();
    const hits = q ? menus.filter((m) => m.name.includes(q)) : menus;
    $('meal-menu-candidates').innerHTML = hits
      .slice(0, 8)
      .map((m) => `<li data-pick="${m.id}">${esc(m.name)}（${m.calories} kcal）</li>`)
      .join('');
  });
  $('meal-menu-candidates').addEventListener('click', (e) => {
    const id = e.target.dataset?.pick;
    if (!id) return;
    selectedMenu = menus.find((m) => m.id === id);
    $('meal-menu-search').value = selectedMenu.name;
    $('meal-menu-candidates').innerHTML = '';
  });
  $('meal-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedMenu) return alert('メニューを選択してください');
    const res = await rw('meals', 'POST', {
      menu_id: selectedMenu.id,
      multiplier: Number($('meal-multiplier').value) || 1,
      meal_type: $('meal-type').value || undefined,
    });
    if (!res.ok) alert(`記録に失敗: ${(await res.json()).error ?? res.status}`);
    selectedMenu = null;
    $('meal-menu-search').value = '';
    refresh();
  });
  $('menu-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const num = (id) => ($(id).value === '' ? undefined : Number($(id).value));
    const res = await rw('menus', 'POST', {
      name: $('menu-name').value.trim(),
      calories: Number($('menu-calories').value),
      protein_g: num('menu-protein'), fat_g: num('menu-fat'), carbs_g: num('menu-carbs'),
    });
    if (!res.ok) alert(`メニュー追加に失敗: ${(await res.json()).error ?? res.status}`);
    e.target.reset();
    refresh();
  });

  handleCallback();
  updateAuthUi();
})();
```

- [ ] **Step 4: dashboard.ts に配信ルートとASSET_VERSIONを追加**

```ts
import mealsJs from './dashboard/meals.js';
const serveMealsJs: Handler = (c) =>
  c.body(mealsJs, 200, noindexHeaders({ 'Content-Type': JS_CONTENT_TYPE, 'Cache-Control': STATIC_CACHE_CONTROL }));
```

両ルーターに `app.get('/meals.js', guarded(serveMealsJs))` / `'/:slug/meals.js'` を登録し、`ASSET_VERSION` を当日の値（例 `'2026-08-13-1'`）に更新。index.htmlの `{{ASSET_VERSION}}` 置換は既存の `serveIndex` がそのまま処理する。

- [ ] **Step 5: styles.css にタブ・フォームの最小スタイルを追加**

```css
.tabs { display: flex; gap: .5rem; margin-bottom: 1rem; }
.tab { padding: .4rem 1rem; border-radius: 6px; border: 1px solid var(--border, #ccc); background: transparent; cursor: pointer; }
.tab.active { background: var(--accent, #3b82f6); color: #fff; border-color: transparent; }
#panel-meals ul { list-style: none; padding: 0; }
#panel-meals li { padding: .3rem 0; border-bottom: 1px solid var(--border, #eee); }
#meal-menu-candidates li { cursor: pointer; }
#meal-add-form, #menu-form { display: flex; flex-wrap: wrap; gap: .5rem; margin: .5rem 0; }
```

既存のCSS変数名（--border等）はstyles.css内の実際の定義に合わせること。

- [ ] **Step 6: テスト・手動確認・Commit**

Run: `npm run typecheck && npx vitest run`
さらに `npm run dev` でローカル起動し、タブ切替・（ログイン無しでの）一覧表示を目視確認。OAuthログインの完全な手動確認は本番デプロイ後（Task 11）に行う。

```bash
git add src/dashboard/meals.js src/dashboard/index.html src/dashboard/styles.css src/dashboard.ts test/dashboard-root.test.ts
git commit -m "feat: meals tab UI with menu picker and OAuth PKCE login"
```

---

### Task 10: ドキュメント更新と全体検証

**Files:**
- Modify: `README.md`, `wrangler.toml.example`, `CLAUDE.md`（開発の基本にKV追記があれば）
- Test: 全スイート

- [ ] **Step 1: wrangler.toml.example にKVバインディング例を追記**

```toml
# OAuth 2.1（書き込みAPI用）のトークン保存先
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "YOUR_OAUTH_KV_NAMESPACE_ID"
```

secretsの説明コメントに `GOOGLE_OAUTH_CLIENT_ID` `GOOGLE_OAUTH_CLIENT_SECRET` `OWNER_EMAILS` を追記。

- [ ] **Step 2: README を更新**

- エンドポイント一覧表に公開3つ（/api/menus /api/meals /api/meals/daily）と `/rw/`（OAuth必須・食事の書き込み）、`/authorize` `/token` `/register`（OAuth）を追記
- 「AI から使う」節に: 書き込みは `https://weight.example.com/rw/mcp` をOAuthコネクタとして登録（ChatGPT: 認証=OAuth / Claude Code: `claude mcp add --transport http weight-rw https://weight.example.com/rw/mcp`（OAuthは接続時にブラウザが開く））
- セットアップ手順に: KVネームスペース作成、Google OAuthクライアント作成（承認済みリダイレクトURI = `https://<ドメイン>/authorize/callback`）、secrets 3つの登録

- [ ] **Step 3: 全体検証**

Run: `npm run typecheck && npx vitest run && npx wrangler deploy --dry-run --outdir "$TMPDIR/withings-dryrun"`
Expected: 全PASS + バンドル成功

- [ ] **Step 4: 実環境値の混入チェック**

Run: 本番ドメインの文字列（CLAUDE.md参照。この文書には書かない）を `git grep` で全追跡ファイルから検索する
Expected: ヒットなし（リポジトリ自身のGitHub URL `github.com/<owner>` はOK）

- [ ] **Step 5: Commit**

```bash
git add README.md wrangler.toml.example
git commit -m "docs: meal tracking endpoints, OAuth setup and KV requirements"
```

---

### Task 11: デプロイと本番検証（手作業を含む）

**Files:** なし（運用作業）

- [ ] **Step 1: KVネームスペースを作成し、wrangler.toml（ローカル実物）に追記**

```bash
npx wrangler kv namespace create OAUTH_KV
# 出力された id を、gitignore済みローカル wrangler.toml の [[kv_namespaces]] に記入
```

- [ ] **Step 2: GitHub Secret WRANGLER_TOML を更新（ユーザー確認の上で）**

```bash
gh secret set WRANGLER_TOML < wrangler.toml
```

- [ ] **Step 3: Google OAuthクライアント作成（ユーザー作業・ガイドする）**

Google Cloud Console → APIとサービス → 認証情報 → OAuthクライアントID（Webアプリ）。承認済みリダイレクトURIに `https://<本番ドメイン>/authorize/callback` を登録（実値はGoogle画面にのみ入力）。

- [ ] **Step 4: secretsを登録**

```bash
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
npx wrangler secret put OWNER_EMAILS   # 許可するGoogleアカウントのメール（カンマ区切り）
```

- [ ] **Step 5: push → CI（テスト→D1マイグレーション→デプロイ）を監視**

```bash
git push origin main
gh run watch $(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

- [ ] **Step 6: 本番検証**

- `GET /api/menus` → 200 `{menus: []}`
- ダッシュボードの食事タブ → ログイン → Google → メニュー登録 → 記録 → 一覧反映
- `POST /rw/meals`（トークン無し）→ 401
- Claude Code: `claude mcp add --transport http --scope local weight-rw https://<本番ドメイン>/rw/mcp` → OAuthブラウザ認証 → `log_meal` 実行
- ChatGPT: コネクタ追加（認証=OAuth）→ Googleログイン → 「昼に◯◯を食べた、記録して」で `log_meal` が動くこと
- `wrangler tail` を回して500が出ないこと（MCPクライアント互換問題の切り分けログ `[mcp] request` を活用）

- [ ] **Step 7: メモリ更新**

`withings-deployment.md` に食事API・OAuth構成（KV名・必要secrets）を追記する。

---

## Self-Review結果（作成時に実施済み）

- スペック全要件をタスクに対応付けた（メニューCRUD=T2/T6、記録=T3/T6、公開READ+summary=T4、OAuth=T1/T5、MCP=T7/T8、UI=T9、ドキュメント/導入=T10/T11）
- 循環import（rw.ts ⇔ mcp.ts）はTask 8 Step 4で対処を明記（バリデータをmeals.tsへ移動）
- 型名・関数名はタスク間で一致（MenuInput/MealLog/DailyIntake、parseMenuInput/parseMealFields）
- 未検証リスク: `workers-oauth-provider` の型と実挙動（apiHandler/fetchの型合わせ、/registerの201、PKCE検証）は Task 1/5 のテストで最初に洗う。ChatGPTコネクタとの実互換はTask 11で実機検証する
