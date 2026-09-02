import type { Context } from 'hono';
import type { Env } from './types';

/**
 * 処理量の上限。Workers Free プランのサブリクエスト上限（50/invocation。D1 は DB 呼び出し
 * 1回 = 1消費で、DB.batch() は複数SQL文でも1呼び出し）と waitUntil 30秒に収める予算。
 * 「50 = SQL文数の上限」ではない点に注意（文数の実測・予算化は基準計測で行う）
 */
export const LIMITS = {
  INBOX_PER_RUN: 3,
  IMPORT_PAGES_PER_RUN: 5,
  NOTIFY_PER_RUN: 6,
  MAX_NOTIFY_ATTEMPTS: 8,
  MAX_INBOX_ATTEMPTS: 5,
  WEBHOOK_MAX_RANGE_DAYS: 31,
  LEASE_SECONDS: 30,
  LEASE_WAIT_MS: 10_000,
  CLEANUP_AFTER_DAYS: 30,
  API_MAX_RANGE_DAYS: 731,
} as const;

/** TZ_OFFSET_HOURS を数値で返す（不正値・未設定は 9 = JST） */
export function offsetHours(env: Env): number {
  const raw = Number(env.TZ_OFFSET_HOURS ?? '9');
  if (!Number.isFinite(raw)) return 9;
  return Math.max(-14, Math.min(14, raw));
}

/** SQLiteの日時modifier（例 '+540 minutes'）。TZ_OFFSET_HOURSから組み立てる */
export function tzModifier(env: Env): string {
  const minutes = Math.round(offsetHours(env) * 60);
  return `${minutes >= 0 ? '+' : '-'}${Math.abs(minutes)} minutes`;
}

/** ISO8601(UTC) をローカル日付 YYYY-MM-DD に変換 */
export function ymdWithOffset(iso: string, offset: number): string {
  const t = new Date(iso).getTime() + offset * 3_600_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

/**
 * READ_ACCESS=private（データ系読み取りをオーナー認証必須にするモード）か。
 * public 側を明示列挙し、タイポ等の未知値は安全側（private）に倒す（fail-closed）。
 * 未設定・空文字は既定 public のまま（既存デプロイとの後方互換）
 */
export function isPrivateRead(env: Env): boolean {
  const v = env.READ_ACCESS ?? 'public';
  return v !== 'public' && v !== '';
}

/**
 * settings.public_origin が未設定なら初期化する（設定済みは上書きしない）。
 * 通知系の起点originはWithings認証時にしか入らなかったため、認証済み書き込みの
 * 到着時にも初期化してWithings無し運用でもダイジェストが動くようにする。
 */
export async function ensurePublicOrigin(env: Env, origin: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('public_origin', ?1) ON CONFLICT(key) DO NOTHING",
  )
    .bind(origin)
    .run();
}

/** Withingsレスポンス共通: HTTP 200でも status !== 0 はエラーとして扱う */
export class WithingsApiError extends Error {
  constructor(
    public apiStatus: number,
    message: string,
  ) {
    super(`Withings API error status=${apiStatus}: ${message}`);
    this.name = 'WithingsApiError';
  }
}

export function assertSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not configured (wrangler secret put ${name})`);
  return value;
}

/**
 * ダッシュボードの基点パス。DASHBOARD_SLUG が空文字ならドメイン直下（'/'）で配信する
 * （専用ドメイン運用）。非空なら '/d/{slug}/'。
 */
export function dashboardBase(env: Env): string {
  return env.DASHBOARD_SLUG ? `/d/${env.DASHBOARD_SLUG}/` : '/';
}

export function noindexHeaders(extra?: Record<string, string>): Record<string, string> {
  return { 'X-Robots-Tag': 'noindex, nofollow', ...extra };
}

/** LIKE句のワイルドカード（%, _）とエスケープ文字自身（\）をリテラル一致させるためエスケープする */
export function escapeLikeValue(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function isPositiveFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** YYYY-MM-DD の厳格チェック（実在日か含む） */
export function isValidYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** ローカル日付 YYYY-MM-DD に日数を加算する（負なら過去） */
export function addDaysYmd(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** from〜to の日数（両端含む） */
export function inclusiveDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** 現在時刻のローカル日付 YYYY-MM-DD */
export function localToday(env: Env): string {
  return ymdWithOffset(isoNow(), offsetHours(env));
}

export interface RangeInput {
  days?: string | number;
  from?: string;
  to?: string;
}

export type RangeResult = { ok: true; from: string; to: string } | { ok: false; error: string };

/**
 * days（ローカル今日を末尾とする直近N日、当日含む）または from/to を検証して期間に解決する。
 * REST（クエリ文字列）とMCP（ツール引数）の両方から使うため、daysは文字列と数値を受ける。
 */
export function resolveRange(input: RangeInput, today: string): RangeResult {
  const hasDays = input.days !== undefined && input.days !== '';
  const hasFromTo = Boolean(input.from) || Boolean(input.to);
  if (hasDays && hasFromTo) {
    return { ok: false, error: 'days cannot be combined with from/to' };
  }
  if (hasDays) {
    const n =
      typeof input.days === 'number'
        ? input.days
        : /^\d+$/.test(input.days ?? '')
          ? Number(input.days)
          : Number.NaN;
    if (!Number.isInteger(n) || n < 1 || n > LIMITS.API_MAX_RANGE_DAYS) {
      return { ok: false, error: `days must be an integer between 1 and ${LIMITS.API_MAX_RANGE_DAYS}` };
    }
    return { ok: true, from: addDaysYmd(today, -(n - 1)), to: today };
  }
  const from = input.from ?? '';
  const to = input.to ?? '';
  if (!isValidYmd(from) || !isValidYmd(to)) {
    return { ok: false, error: 'from/to must be valid YYYY-MM-DD' };
  }
  if (from > to) {
    return { ok: false, error: 'from must be on or before to' };
  }
  if (to > today) {
    return { ok: false, error: 'to must not be a future date' };
  }
  if (inclusiveDays(from, to) > LIMITS.API_MAX_RANGE_DAYS) {
    return { ok: false, error: `range must be within ${LIMITS.API_MAX_RANGE_DAYS} days` };
  }
  return { ok: true, from, to };
}

/**
 * REST公開エンドポイント共通のHTTPレイヤ検証。Honoの Context からクエリ（days/from/to）を読んで
 * resolveRange に渡し、不正なら 400 + {error} の Response を返す。
 * dashboard.ts と meals-api.ts の両方から使う（重複実装を避けるための共通化）。
 */
export function resolveRangeFromQuery(
  c: Context<{ Bindings: Env }>,
  headers: Record<string, string>,
): { from: string; to: string } | Response {
  const result = resolveRange(
    { days: c.req.query('days'), from: c.req.query('from'), to: c.req.query('to') },
    localToday(c.env),
  );
  if (!result.ok) return c.json({ error: result.error }, 400, headers);
  return { from: result.from, to: result.to };
}

/** 期間クエリ付き公開READハンドラの共通枠（検証エラーは400 Responseをそのまま返す） */
export function withRange(
  c: Context<{ Bindings: Env }>,
  fn: (from: string, to: string) => Promise<Response>,
): Promise<Response> | Response {
  const headers = noindexHeaders({ 'Cache-Control': 'no-store' });
  const range = resolveRangeFromQuery(c, headers);
  if (range instanceof Response) return range;
  return fn(range.from, range.to);
}
