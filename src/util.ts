import type { Env } from './types';

/** 処理量の上限。D1無料枠（50クエリ/invocation）とwaitUntil 30秒に収める予算 */
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

/** YYYY-MM-DD の厳格チェック（実在日か含む） */
export function isValidYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
