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
  /** 読み取りアクセス制御: 'public'（既定）=無認証読み取り / 'private'=データ系読み取りをオーナー認証必須に */
  READ_ACCESS?: string;
  // Secrets（未設定でもWorker自体は起動できるようoptionalにし、使用箇所で明示エラーにする）
  WITHINGS_CLIENT_ID?: string;
  WITHINGS_CLIENT_SECRET?: string;
  SLACK_WEBHOOKS?: string;
  SETUP_SECRET?: string;
  ADMIN_SLACK_WEBHOOK?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  OWNER_EMAILS?: string; // カンマ区切りの許可メール
  COACHING_API_SECRET?: string; // POST /api/coaching（AI講評保存）のサーバー間Bearer認証。未設定なら機能無効
  OG_ACCESS_TOKEN?: string; // READ_ACCESS=private時、Slack埋め込み用に og.png?key= を通す任意トークン
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

/** 計測明細（/api/raw）の1行。idは手動記録の削除（DELETE /api/weight/:id）に使う */
export interface RawMeasurement extends LatestMeasurement {
  id: number; // measurements.id（内部計測ID。負値は主キー再設計前に手動記録された既存行のみ）
  source: string; // 'withings' | 'manual'
}

/** 目標（体重・脂肪量、kg）。どちらも任意で未設定はnull。MCPツール set_goal で設定する */
export interface Goal {
  weight_kg: number | null;
  fat_mass_kg: number | null;
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
  intake_today: DailyIntake | null; // 今日のローカル日付の食事摂取量（記録がなければ null）
  goal: Goal; // 目標（未設定の指標は null）
}

export interface ImportStatus {
  import_status: string | null; // pending / running / done / error
  import_error: string | null;
  last_sync_at: string | null;
  latest_measured_at: string | null;
}

export type IngestContext = 'webhook' | 'import' | 'backfill';

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

// ---- 運動記録 ----

export type ExerciseCategory = 'cardio' | 'strength';

export interface ExerciseMenu {
  id: string;
  name: string;
  category: ExerciseCategory;
  mets: number | null; // cardio用（安静時比の運動強度）
  muscle_group: string | null; // strength任意
  is_bodyweight: boolean; // strength用（自重種目）
  bodyweight_factor: number; // 自重種目のボリューム補正係数 0〜1（既定1.0。実効重量=追加重量+体重×係数）
  note: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface ExerciseMenuInput {
  name: string;
  category: ExerciseCategory;
  mets?: number | null;
  muscle_group?: string | null;
  is_bodyweight?: boolean;
  bodyweight_factor?: number;
  note?: string | null;
}

/** 筋トレ1セット（実効重量・ボリュームは読み取り時に算出） */
export interface ExerciseSet {
  set_index: number;
  reps: number;
  weight_kg: number | null; // 追加/バーの重量。null/0 = 純自重
  effective_weight_kg: number; // weight_kg + (自重種目なら記録時の体重)
  volume: number; // reps * effective_weight_kg
}

export interface ExerciseLog {
  id: string;
  menu_id: string;
  performed_at: string; // ISO8601 UTC
  category: ExerciseCategory;
  menu_name: string; // スナップショット
  note: string | null;
  is_bodyweight: boolean; // スナップショット
  bodyweight_factor: number; // スナップショット（自重種目の体重算入係数）
  duration_min: number | null; // cardio
  mets: number | null; // cardio スナップショット
  body_weight_kg: number | null; // スナップショット（cardio消費kcal / 自重ボリューム用）
  calories: number | null; // cardio 消費kcal（算出結果）
  created_at: string;
  sets: ExerciseSet[]; // strengthのみ（cardioは空配列）
  total_volume: number | null; // strengthのみ（Σ volume）
}

/**
 * 運動・エネルギーの日次集計。期間内の全日が返る（運動が無い日も、bmrが算出できれば意味を持つ）。
 * bmr は Katch-McArdle（370 + 21.6 × 除脂肪体重）による推定。その日以前で最新の実測FFMを使い、
 * 実測が一度も無い期間は null。総消費 = bmr + (calories_burned ?? 0)。
 */
export interface DailyExercise {
  d: string; // ローカル日付 YYYY-MM-DD
  bmr: number | null; // 基礎代謝の推定kcal（Katch-McArdle）
  calories_burned: number | null; // cardioの消費kcal合計（運動なしはnull）
  strength_volume: number | null; // strengthの総ボリューム合計（なしはnull）
  cardio_count: number;
  strength_count: number;
}
