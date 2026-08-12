/**
 * モジュール間の共有契約。各モジュールはここで定義された型に従って実装する。
 */

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

/** immediate=計測ごとに通知（既定） / daily=日次ダイジェストのみ / both=両方 */
export type NotifyMode = 'immediate' | 'daily' | 'both';

/** ダイジェストの対象日: same=送信時刻の当日（既定） / previous=前日（朝に前日まとめを送る用途） */
export type DigestTarget = 'same' | 'previous';

export interface SlackDestination {
  id: string;
  url: string;
  mode: NotifyMode;
  /** ダイジェスト送信時刻（ローカル、分）。nullは全体設定（settings.digest_time、既定23:55）に従う */
  digestTimeMinutes: number | null;
  digestTarget: DigestTarget;
}

export interface TokenRow {
  userid: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null; // ISO8601 UTC
  refresh_lease_owner: string | null;
  refresh_lease_until: string | null; // datetime('now') と比較可能なUTC文字列
}

/** Withings getmeas の measuregrp */
export interface MeasureGroup {
  grpid: number;
  date: number; // epoch秒
  category: number; // 1 = 実測
  attrib: number;
  measures: { value: number; type: number; unit: number }[];
}

export interface GetMeasPage {
  groups: MeasureGroup[];
  more: boolean;
  offset: number;
}

export interface MeasurementUpsert {
  grpid: number;
  measured_at: string; // ISO8601 UTC
  weight: number | null;
  fat_ratio: number | null;
  fat_free_mass: number | null;
  raw_json: string;
}

/**
 * 日単位集計 + 7日移動平均の1日分。
 * fat_mass（脂肪量kg）はD1に保存せず、weight - fat_free_mass から導出する
 * （体脂肪率の差分は解釈しづらいため、表示・通知はすべて脂肪量で扱う）
 */
export interface DayPoint {
  d: string; // ローカル日付 YYYY-MM-DD
  weight: number | null;
  fat_mass: number | null;
  fat_free_mass: number | null;
  weight_7d_avg: number | null;
  fat_mass_7d_avg: number | null;
  fat_free_mass_7d_avg: number | null;
}

export interface MetricTriple {
  weight: number | null;
  fat_mass: number | null;
  fat_free_mass: number | null;
}

export interface NotificationStats {
  recent7: MetricTriple; // 直近7暦日の日平均の平均
  diff7: MetricTriple; // recent7 - prev7（前タームなしは null）
  baselineDate: string | null; // settings.baseline_date
  baselineDiff: MetricTriple; // 今回計測 - 基準日値（基準なしは null）
}

export interface LatestMeasurement {
  measured_at: string;
  weight: number | null;
  fat_mass: number | null; // weight - fat_free_mass（SQL側で導出）
  fat_free_mass: number | null;
  fat_ratio: number | null; // 計測時点の参考値（通知の計測結果行にのみ表示）
}

/** /api/summary と MCP get_weight_summary のレスポンス */
export interface WeightSummary {
  as_of: string; // ISO8601 UTC
  units: { mass: 'kg'; fat_ratio: 'percent' };
  timezone_offset_hours: number;
  latest: LatestMeasurement | null; // 計測が1件もなければ null
  recent7_avg: MetricTriple; // 直近7暦日の日平均の平均
  diff_vs_prev7: MetricTriple; // recent7 - その前の7暦日
  baseline: { date: string | null; diff: MetricTriple }; // 最新計測 - 基準日値
  last_sync_at: string | null;
}

export interface ImportStatus {
  import_status: string | null; // pending / running / done / error
  import_error: string | null;
  last_sync_at: string | null;
  latest_measured_at: string | null;
}

export type IngestContext = 'webhook' | 'import' | 'backfill';
