import type {
  DayPoint,
  Env,
  ImportStatus,
  LatestMeasurement,
  MetricTriple,
  NotificationStats,
  WeightSummary,
} from './types';
import { getIntakeForDay } from './meals';
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
  const sql = `
WITH daily AS (
  SELECT date(measured_at, '${tz}') AS d,
         AVG(weight) AS weight, AVG(weight - fat_free_mass) AS fat_mass, AVG(fat_free_mass) AS fat_free_mass
  FROM measurements
  WHERE date(measured_at, '${tz}') BETWEEN date(?1, '-6 days') AND ?2
  GROUP BY 1
)
SELECT d, weight, fat_mass, fat_free_mass,
  (SELECT AVG(d2.weight) FROM daily d2 WHERE d2.d BETWEEN date(daily.d, '-6 days') AND daily.d) AS weight_7d_avg,
  (SELECT AVG(d2.fat_mass) FROM daily d2 WHERE d2.d BETWEEN date(daily.d, '-6 days') AND daily.d) AS fat_mass_7d_avg,
  (SELECT AVG(d2.fat_free_mass) FROM daily d2 WHERE d2.d BETWEEN date(daily.d, '-6 days') AND daily.d) AS fat_free_mass_7d_avg
FROM daily
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

export async function getNotificationStats(
  env: Env,
  latest: LatestMeasurement,
): Promise<NotificationStats> {
  const tz = tzModifier(env);
  // recent7(-6日〜今日)とprev7(-13日〜-7日)を1クエリで集計（D1クエリ予算のため）
  const termRow = await env.DB.prepare(
    `
WITH daily AS (
  SELECT date(measured_at, '${tz}') AS d,
         AVG(weight) AS weight, AVG(weight - fat_free_mass) AS fat_mass, AVG(fat_free_mass) AS fat_free_mass
  FROM measurements
  WHERE date(measured_at, '${tz}') BETWEEN date('now', '${tz}', '-13 days') AND date('now', '${tz}')
  GROUP BY 1
)
SELECT
  AVG(CASE WHEN d >= date('now', '${tz}', '-6 days') THEN weight END) AS recent_weight,
  AVG(CASE WHEN d >= date('now', '${tz}', '-6 days') THEN fat_mass END) AS recent_fat_mass,
  AVG(CASE WHEN d >= date('now', '${tz}', '-6 days') THEN fat_free_mass END) AS recent_fat_free_mass,
  AVG(CASE WHEN d < date('now', '${tz}', '-6 days') THEN weight END) AS prev_weight,
  AVG(CASE WHEN d < date('now', '${tz}', '-6 days') THEN fat_mass END) AS prev_fat_mass,
  AVG(CASE WHEN d < date('now', '${tz}', '-6 days') THEN fat_free_mass END) AS prev_fat_free_mass
FROM daily`,
  ).first<TermRow>();

  const recent7: MetricTriple = {
    weight: termRow?.recent_weight ?? null,
    fat_mass: termRow?.recent_fat_mass ?? null,
    fat_free_mass: termRow?.recent_fat_free_mass ?? null,
  };
  const prev7: MetricTriple = {
    weight: termRow?.prev_weight ?? null,
    fat_mass: termRow?.prev_fat_mass ?? null,
    fat_free_mass: termRow?.prev_fat_free_mass ?? null,
  };

  const baselineRow = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'baseline_date'`)
    .first<{ value: string | null }>();
  const baselineDate = baselineRow?.value ?? null;

  let baselineDiff: MetricTriple = { weight: null, fat_mass: null, fat_free_mass: null };
  if (baselineDate !== null) {
    // 基準値 = 基準日の日平均。基準日に計測がなければ基準日以降最初の計測値
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
    if (base) {
      baselineDiff = diffTriple(
        { weight: latest.weight, fat_mass: latest.fat_mass, fat_free_mass: latest.fat_free_mass },
        base,
      );
    }
  }

  return { recent7, diff7: diffTriple(recent7, prev7), baselineDate, baselineDiff };
}

/** 計測1回ごとの明細（新しい順）。表の「計測明細」モード用 */
export async function getRawMeasurements(
  env: Env,
  from: string,
  to: string,
): Promise<LatestMeasurement[]> {
  const tz = tzModifier(env);
  const res = await env.DB.prepare(
    `SELECT measured_at, weight, (weight - fat_free_mass) AS fat_mass, fat_free_mass, fat_ratio
FROM measurements
WHERE date(measured_at, '${tz}') BETWEEN ?1 AND ?2
ORDER BY measured_at DESC
LIMIT 2000`,
  )
    .bind(from, to)
    .all<LatestMeasurement>();
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
JOIN measurements m ON m.grpid = i.grpid
WHERE i.batch_id = ?1
ORDER BY m.measured_at DESC, m.grpid DESC
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
ORDER BY measured_at DESC, grpid DESC
LIMIT 1`,
  ).first<LatestMeasurement>();
  return row ?? null;
}

function nullTriple(): MetricTriple {
  return { weight: null, fat_mass: null, fat_free_mass: null };
}

/** /api/summary・MCP get_weight_summary の本体。集計はSlack通知と同じロジックを使う */
export async function getSummary(env: Env): Promise<WeightSummary> {
  const latest = await getLatestMeasurement(env);
  const stats = latest ? await getNotificationStats(env, latest) : null;
  const lastSync = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'last_sync_at'`)
    .first<{ value: string | null }>();
  const intakeToday = await getIntakeForDay(env, localToday(env));
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
