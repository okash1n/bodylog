import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import type { Env } from '../src/types';
import { offsetHours, ymdWithOffset } from '../src/util';

export const testEnv = env as unknown as Env;

/** 各テスト前に呼び、関連テーブルを全て空にする */
export async function resetTables(): Promise<void> {
  const tables = [
    'meal_logs',
    'menus',
    'measurements',
    'tokens',
    'settings',
    'webhook_inbox',
    'notification_batch_items',
    'notification_batches',
  ];
  await testEnv.DB.batch(tables.map((t) => testEnv.DB.prepare(`DELETE FROM ${t}`)));
}

export async function insertMeasurement(m: {
  grpid: number;
  measured_at: string;
  weight?: number | null;
  fat_ratio?: number | null;
  fat_free_mass?: number | null;
}): Promise<void> {
  await testEnv.DB.prepare(
    'INSERT INTO measurements (grpid, measured_at, weight, fat_ratio, fat_free_mass, raw_json) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(m.grpid, m.measured_at, m.weight ?? null, m.fat_ratio ?? null, m.fat_free_mass ?? null, '{}')
    .run();
}

export async function setSetting(key: string, value: string): Promise<void> {
  await testEnv.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
    .bind(key, value)
    .run();
}

/**
 * tokens 行（id=1）を作る。expiresInSec が負なら失効済みトークンになる。
 * refresh_lease_until は datetime('now') と比較可能な形式で保存するため SQL 側で組み立てる。
 */
export async function insertTokenRow(t: {
  userid?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresInSec: number;
  leaseOwner?: string;
  leaseUntilOffsetSec?: number;
}): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO tokens (id, userid, access_token, refresh_token, expires_at, refresh_lease_owner, refresh_lease_until)
     VALUES (1, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ? || ' seconds') END)`,
  )
    .bind(
      t.userid ?? '42',
      t.accessToken ?? 'at-current',
      t.refreshToken ?? 'rt-current',
      new Date(Date.now() + t.expiresInSec * 1000).toISOString(),
      t.leaseOwner ?? null,
      t.leaseUntilOffsetSec ?? null,
      String(t.leaseUntilOffsetSec ?? 0),
    )
    .run();
}

/** now から daysAgo 日前のローカル日付（YYYY-MM-DD）。負なら未来 */
export function localYmdDaysAgo(daysAgo: number): string {
  return ymdWithOffset(new Date(Date.now() - daysAgo * 86_400_000).toISOString(), offsetHours(testEnv));
}

export interface StubRoute {
  host?: string;
  path?: string | RegExp;
  method?: string;
  /** 応答できる回数。省略時は無制限 */
  times?: number;
  reply: (req: Request, url: URL) => Response | Promise<Response>;
}

export interface FetchStub {
  on(route: StubRoute): FetchStub;
  requests(filter?: { host?: string; path?: string | RegExp }): { method: string; url: string; body: string }[];
  assertAllConsumed(): void;
}

/**
 * globalThis.fetch を差し替える宣言的スタブ。
 * 未登録のリクエストは throw する（外部ネットワーク遮断と同等）。
 * 後始末は各テストファイルの afterEach で vi.unstubAllGlobals() を呼ぶこと。
 */
export function stubFetch(): FetchStub {
  interface InternalRoute extends StubRoute {
    remaining: number;
  }
  const routes: InternalRoute[] = [];
  const log: { method: string; url: string; body: string }[] = [];

  const pathMatches = (pattern: string | RegExp | undefined, pathname: string): boolean => {
    if (pattern === undefined) return true;
    return typeof pattern === 'string' ? pattern === pathname : pattern.test(pathname);
  };

  vi.stubGlobal('fetch', async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const req =
      typeof input === 'string' || input instanceof URL
        ? new Request(String(input), init)
        : init
          ? new Request(input, init)
          : input;
    const url = new URL(req.url);
    const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.clone().text();
    log.push({ method: req.method, url: req.url, body });
    const route = routes.find(
      (r) =>
        r.remaining > 0 &&
        (r.host === undefined || r.host === url.host) &&
        (r.method === undefined || r.method.toUpperCase() === req.method) &&
        pathMatches(r.path, url.pathname),
    );
    if (!route) throw new Error(`[test] unexpected fetch: ${req.method} ${req.url}`);
    route.remaining -= 1;
    return route.reply(req, url);
  });

  const stub: FetchStub = {
    on(route) {
      routes.push({ ...route, remaining: route.times ?? Number.POSITIVE_INFINITY });
      return stub;
    },
    requests(filter) {
      if (!filter) return [...log];
      return log.filter((e) => {
        const u = new URL(e.url);
        return (filter.host === undefined || u.host === filter.host) && pathMatches(filter.path, u.pathname);
      });
    },
    assertAllConsumed() {
      const leftover = routes.filter((r) => Number.isFinite(r.remaining) && r.remaining > 0);
      if (leftover.length > 0) {
        throw new Error(`[test] ${leftover.length} stub route(s) not fully consumed`);
      }
    },
  };
  return stub;
}

/** Withings API 形式（HTTP 200 + {status, body}）の応答を作る */
export function withingsReply(body: unknown, status = 0): Response {
  return Response.json({ status, body });
}
