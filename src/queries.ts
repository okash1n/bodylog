import type {
  DayPoint,
  Env,
  ImportStatus,
  LatestMeasurement,
  MetricTriple,
  NotificationStats,
  RawMeasurement,
  WeightSummary,
} from './types';
import { getIntakeForDay } from './meals';
import { getGoal } from './goals';
import { isoNow, localToday, offsetHours, tzModifier } from './util';

function diffTriple(a: MetricTriple, b: MetricTriple): MetricTriple {
  return {
    weight: a.weight !== null && b.weight !== null ? a.weight - b.weight : null,
    fat_mass: a.fat_mass !== null && b.fat_mass !== null ? a.fat_mass - b.fat_mass : null,
    fat_free_mass:
      a.fat_free_mass !== null && b.fat_free_mass !== null
        ? a.fat_free_mass - b.fat_free_mass
        : null,
  };
}

export async function getDailySeries(env: Env, from: string, to: string): Promise<DayPoint[]> {
  // tzはユーザー入力ではなくutil経由の固定値のみ埋め込む。
  // 表示期間先頭でも7日移動平均が成立するよう、集計対象は from-6日 から取る。
  const tz = tzModifier(env);
  // 脂肪量 = weight - fat_free_mass（どちらか欠けた計測はNULLになりAVGから除外される）
  // 7日移動平均は相関サブクエリではなく窓関数で出す（1年レンジで約20倍速い）。
  // ROWSではなくjulianday上のRANGEを使うことで「暦日7日窓」の意味を保つ
  // （ROWSだと欠測日がある区間で窓の意味が変わる）。WHERE d >= ?1 は窓計算の後段に置く必要が
  // あるため2段目のCTEに分ける。
  const sql = `
WITH daily AS (
  SELECT date(measured_at, '${tz}') AS d,
         AVG(weight) AS weight, AVG(weight - fat_free_mass) AS fat_mass, AVG(fat_free_mass) AS fat_free_mass
  FROM measurements
  WHERE date(measured_at, '${tz}') BETWEEN date(?1, '-6 days') AND ?2
  GROUP BY 1
),
rolled AS (
  SELECT d, weight, fat_mass, fat_free_mass,
    AVG(weight)        OVER w AS weight_7d_avg,
    AVG(fat_mass)      OVER w AS fat_mass_7d_avg,
    AVG(fat_free_mass) OVER w AS fat_free_mass_7d_avg
  FROM daily
  WINDOW w AS (ORDER BY julianday(d) RANGE BETWEEN 6 PRECEDING AND CURRENT ROW)
)
SELECT d, weight, fat_mass, fat_free_mass, weight_7d_avg, fat_mass_7d_avg, fat_free_mass_7d_avg
FROM rolled
WHERE d >= ?1
ORDER BY d`;
  const res = await env.DB.prepare(sql).bind(from, to).all<DayPoint>();
  return res.results;
}

interface TermRow {
  recent_weight: number | null;
  recent_fat_mass: number | null;
  recent_fat_free_mass: number | null;
  prev_weight: number | null;
  prev_fat_mass: number | null;
  prev_fat_free_mass: number | null;
}

interface TermStats {
  recent7: MetricTriple;
  prev7: MetricTriple;
}

interface BaselineInfo {
  baselineDate: string | null;
  baselineValue: MetricTriple | null;
}

/**
 * recent7(asOf-6日〜asOf)とprev7(asOf-13日〜asOf-7日)を1クエリで集計（D1クエリ予算のため）。latestに依存しない。
 * asOf はローカル日付 YYYY-MM-DD（通常は今日。過去日のダイジェストを送り直すときはその日を基準にする）
 */
async function getTermStats(env: Env, asOf: string): Promise<TermStats> {
  const tz = tzModifier(env);
  const termRow = await env.DB.prepare(
    `
WITH daily AS (
  SELECT date(measured_at, '${tz}') AS d,
         AVG(weight) AS weight, AVG(weight - fat_free_mass) AS fat_mass, AVG(fat_free_mass) AS fat_free_mass
  FROM measurements
  WHERE date(measured_at, '${tz}') BETWEEN date(?1, '-13 days') AND ?1
  GROUP BY 1
)
SELECT
  AVG(CASE WHEN d >= date(?1, '-6 days') THEN weight END) AS recent_weight,
  AVG(CASE WHEN d >= date(?1, '-6 days') THEN fat_mass END) AS recent_fat_mass,
  AVG(CASE WHEN d >= date(?1, '-6 days') THEN fat_free_mass END) AS recent_fat_free_mass,
  AVG(CASE WHEN d < date(?1, '-6 days') THEN weight END) AS prev_weight,
  AVG(CASE WHEN d < date(?1, '-6 days') THEN fat_mass END) AS prev_fat_mass,
  AVG(CASE WHEN d < date(?1, '-6 days') THEN fat_free_mass END) AS prev_fat_free_mass
FROM daily`,
  )
    .bind(asOf)
    .first<TermRow>();
  return {
    recent7: {
      weight: termRow?.recent_weight ?? null,
      fat_mass: termRow?.recent_fat_mass ?? null,
      fat_free_mass: termRow?.recent_fat_free_mass ?? null,
    },
    prev7: {
      weight: termRow?.prev_weight ?? null,
      fat_mass: termRow?.prev_fat_mass ?? null,
      fat_free_mass: termRow?.prev_fat_free_mass ?? null,
    },
  };
}

/** 基準日設定と基準値（基準日の日平均、無ければ基準日以降最初の計測値）。latestに依存しない */
async function getBaseline(env: Env): Promise<BaselineInfo> {
  const tz = tzModifier(env);
  const baselineRow = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'baseline_date'`)
    .first<{ value: string | null }>();
  const baselineDate = baselineRow?.value ?? null;
  if (baselineDate === null) return { baselineDate: null, baselineValue: null };
  const base = await env.DB.prepare(
    `
WITH base_day AS (
  SELECT COUNT(*) AS n, AVG(weight) AS weight, AVG(weight - fat_free_mass) AS fat_mass, AVG(fat_free_mass) AS fat_free_mass
  FROM measurements
  WHERE date(measured_at, '${tz}') = ?1
),
first_after AS (
  SELECT weight, (weight - fat_free_mass) AS fat_mass, fat_free_mass
  FROM measurements
  WHERE date(measured_at, '${tz}') >= ?1
  ORDER BY measured_at
  LIMIT 1
)
SELECT
  CASE WHEN (SELECT n FROM base_day) > 0 THEN (SELECT weight FROM base_day) ELSE (SELECT weight FROM first_after) END AS weight,
  CASE WHEN (SELECT n FROM base_day) > 0 THEN (SELECT fat_mass FROM base_day) ELSE (SELECT fat_mass FROM first_after) END AS fat_mass,
  CASE WHEN (SELECT n FROM base_day) > 0 THEN (SELECT fat_free_mass FROM base_day) ELSE (SELECT fat_free_mass FROM first_after) END AS fat_free_mass`,
  )
    .bind(baselineDate)
    .first<MetricTriple>();
  return { baselineDate, baselineValue: base ?? null };
}

/**
 * getNotificationStatsのクエリ部分だけを先に取る（latest不要。呼び出し側のPromise.allに畳むため）。
 * asOf は7日平均の基準日（既定は今日。過去日のダイジェストはその日を渡す）
 */
export async function getStatsParts(
  env: Env,
  asOf: string = localToday(env),
): Promise<{ terms: TermStats; baseline: BaselineInfo }> {
  const [terms, baseline] = await Promise.all([getTermStats(env, asOf), getBaseline(env)]);
  return { terms, baseline };
}

/** terms/baseline と latest から通知用の差分統計を組み立てる（純関数） */
export function composeStats(
  latest: LatestMeasurement,
  terms: TermStats,
  baseline: BaselineInfo,
): NotificationStats {
  const baselineDiff = baseline.baselineValue
    ? diffTriple(
        { weight: latest.weight, fat_mass: latest.fat_mass, fat_free_mass: latest.fat_free_mass },
        baseline.baselineValue,
      )
    : nullTriple();
  return {
    recent7: terms.recent7,
    diff7: diffTriple(terms.recent7, terms.prev7),
    baselineDate: baseline.baselineDate,
    baselineDiff,
  };
}

export async function getNotificationStats(
  env: Env,
  latest: LatestMeasurement,
): Promise<NotificationStats> {
  // termsとbaselineは互いに独立なので並列に取る（Slack通知経路の往復削減）
  const parts = await getStatsParts(env);
  return composeStats(latest, parts.terms, parts.baseline);
}

/** 計測1回ごとの明細（新しい順）。表の「計測明細」モード用。id/sourceは手動記録の識別・削除に使う */
export async function getRawMeasurements(
  env: Env,
  from: string,
  to: string,
): Promise<RawMeasurement[]> {
  const tz = tzModifier(env);
  const res = await env.DB.prepare(
    `SELECT id, source, measured_at, weight, (weight - fat_free_mass) AS fat_mass, fat_free_mass, fat_ratio
FROM measurements
WHERE date(measured_at, '${tz}') BETWEEN ?1 AND ?2
ORDER BY measured_at DESC
LIMIT 2000`,
  )
    .bind(from, to)
    .all<RawMeasurement>();
  return res.results;
}

export async function getLatestForBatch(
  env: Env,
  batchId: string,
): Promise<{ latest: LatestMeasurement; count: number } | null> {
  const row = await env.DB.prepare(
    `
SELECT m.measured_at AS measured_at, m.weight AS weight, (m.weight - m.fat_free_mass) AS fat_mass, m.fat_free_mass AS fat_free_mass, m.fat_ratio AS fat_ratio,
       COUNT(*) OVER () AS cnt
FROM notification_batch_items i
JOIN measurements m ON m.id = i.measurement_id
WHERE i.batch_id = ?1
ORDER BY m.measured_at DESC, m.id DESC
LIMIT 1`,
  )
    .bind(batchId)
    .first<{
      measured_at: string;
      weight: number | null;
      fat_mass: number | null;
      fat_free_mass: number | null;
      fat_ratio: number | null;
      cnt: number;
    }>();
  if (!row) return null;
  return {
    latest: {
      measured_at: row.measured_at,
      weight: row.weight,
      fat_mass: row.fat_mass,
      fat_free_mass: row.fat_free_mass,
      fat_ratio: row.fat_ratio,
    },
    count: row.cnt,
  };
}

/** 指定ローカル日付の計測回数（日次ダイジェストの件数表示用） */
export async function getDayMeasurementCount(env: Env, ymd: string): Promise<number> {
  const tz = tzModifier(env);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM measurements WHERE date(measured_at, '${tz}') = ?1`,
  )
    .bind(ymd)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 全期間で最新の計測1件。計測が1件もなければ null */
export async function getLatestMeasurement(env: Env): Promise<LatestMeasurement | null> {
  const row = await env.DB.prepare(
    `SELECT measured_at, weight, (weight - fat_free_mass) AS fat_mass, fat_free_mass, fat_ratio
FROM measurements
ORDER BY measured_at DESC, id DESC
LIMIT 1`,
  ).first<LatestMeasurement>();
  return row ?? null;
}

function nullTriple(): MetricTriple {
  return { weight: null, fat_mass: null, fat_free_mass: null };
}

/** /api/summary・MCP get_weight_summary の本体。集計はSlack通知と同じロジックを使う */
export async function getSummary(env: Env): Promise<WeightSummary> {
  // 直列依存は getBaseline 内部（baseline_date を読んでから基準値を引く）だけなので、
  // 残りは1ラウンドに並列化する（従来はD1往復7回の直列だった）
  const [latest, terms, baseline, lastSync, intakeToday, goal] = await Promise.all([
    getLatestMeasurement(env),
    getTermStats(env, localToday(env)),
    getBaseline(env),
    env.DB.prepare(`SELECT value FROM settings WHERE key = 'last_sync_at'`).first<{
      value: string | null;
    }>(),
    getIntakeForDay(env, localToday(env)),
    getGoal(env),
  ]);
  const stats = latest ? composeStats(latest, terms, baseline) : null;
  return {
    as_of: isoNow(),
    units: { mass: 'kg', fat_ratio: 'percent' },
    timezone_offset_hours: offsetHours(env),
    latest,
    recent7_avg: stats?.recent7 ?? nullTriple(),
    diff_vs_prev7: stats?.diff7 ?? nullTriple(),
    baseline: { date: stats?.baselineDate ?? null, diff: stats?.baselineDiff ?? nullTriple() },
    last_sync_at: lastSync?.value ?? null,
    intake_today: intakeToday,
    goal,
  };
}

export async function getImportStatus(env: Env): Promise<ImportStatus> {
  const row = await env.DB.prepare(
    `
SELECT
  (SELECT value FROM settings WHERE key = 'import_status') AS import_status,
  (SELECT value FROM settings WHERE key = 'import_error') AS import_error,
  (SELECT value FROM settings WHERE key = 'last_sync_at') AS last_sync_at,
  (SELECT MAX(measured_at) FROM measurements) AS latest_measured_at`,
  ).first<ImportStatus>();
  return (
    row ?? { import_status: null, import_error: null, last_sync_at: null, latest_measured_at: null }
  );
}
