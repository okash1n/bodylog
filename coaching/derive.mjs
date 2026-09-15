/**
 * 講評生成の入力データを整形する純粋関数（環境変数・ネットワーク・現在時刻には触れない）。
 * - deriveTerms: 過去日の講評を作り直すときに /api/summary の代わりに日次系列から対象日時点の集計を導出する。
 *   Worker 側（src/queries.ts getTermStats）と同じ定義:
 *   recent7 = 対象日を含む直近7暦日（D-6〜D）の日平均の平均、prev7 = その前の7暦日（D-13〜D-7）。
 *   日平均が無い日は平均に含めない（SQL の AVG と同じく NULL を無視）。
 * - deriveTrend: 直近21日の日次回帰で週あたりの傾きと標準誤差を出し、ノイズを踏まえたラベルを付ける。
 * - deriveIntakeAvg: 直近7日の平均摂取（収支の評価単位）。
 * - deriveExerciseContext: 連続トレ日数など、回復提案の客観条件に使う導出値。
 * - summarizeSessions: 運動ログを講評向けに圧縮する（サーキットは親1行に畳む）。
 * - selectPreviousNotes: 前日までの講評の選択。
 */
import { addDaysYmd, localYmd } from './dates.mjs';

/** 高負荷日とみなす運動消費 kcal の既定値（deriveExerciseContext とプロンプトの凡例で共用） */
export const DEFAULT_HARD_BURN_KCAL = 500;
/** trend の回帰窓（日）。generate.mjs の取得幅はこれ＋1日 */
export const DEFAULT_TREND_WINDOW_DAYS = 21;
/** 運動ログ（種目名つき）をプロンプトへ渡す日数 */
export const SESSION_DAYS = 7;
/** 前日までの講評をプロンプトへ渡す日数（矛盾防止用）。API 経路・ファイル経路の両方に効く */
export const PREVIOUS_NOTE_DAYS = 7;
/** 収支を評価する直近日数 */
export const INTAKE_WINDOW_DAYS = 7;

const METRICS = ['weight', 'fat_mass', 'fat_free_mass'];

/** 小数 digits 桁に丸める（null 維持） */
export function roundTo(v, digits) {
  if (v == null) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function average(rows, key) {
  const values = rows.map((r) => r[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function count(rows, key) {
  return rows.filter((r) => typeof r[key] === 'number' && Number.isFinite(r[key])).length;
}

function triple(rows, fn) {
  return Object.fromEntries(METRICS.map((k) => [k, fn(rows, k)]));
}

/**
 * @param days /api/measurements の days（{d, weight, fat_mass, fat_free_mass, ...} の配列。日付順でなくてよい）
 * @param date 対象日 YYYY-MM-DD
 * @returns {{ recent7_avg: MetricTriple, diff_vs_prev7: MetricTriple, recent7_n: MetricTriple, prev7_n: MetricTriple }}
 *   該当日が無い指標は null。*_n は各窓で値のあった日数（ノイズ判断用）
 */
export function deriveTerms(days, date) {
  const recentFrom = addDaysYmd(date, -6);
  const prevFrom = addDaysYmd(date, -13);
  const recent = [];
  const prev = [];
  for (const row of days) {
    if (typeof row?.d !== 'string' || row.d > date || row.d < prevFrom) continue;
    (row.d >= recentFrom ? recent : prev).push(row);
  }
  const recent7 = triple(recent, average);
  const prev7 = triple(prev, average);
  const diff = Object.fromEntries(
    METRICS.map((k) => [k, recent7[k] != null && prev7[k] != null ? recent7[k] - prev7[k] : null]),
  );
  return {
    recent7_avg: recent7,
    diff_vs_prev7: diff,
    recent7_n: triple(recent, count),
    prev7_n: triple(prev, count),
  };
}

/** 最小二乗の傾きと標準誤差（x は日数、y は kg）。点が少なければ null */
function regression(points) {
  const n = points.length;
  if (n < 3) return { slope: null, se: null, n };
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  if (sxx === 0) return { slope: null, se: null, n };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const sse = points.reduce((s, p) => s + (p.y - (intercept + slope * p.x)) ** 2, 0);
  const se = Math.sqrt(sse / (n - 2) / sxx);
  return { slope, se, n };
}

/**
 * 週あたりの傾き（kg/週）と標準誤差からラベルを決める。
 * declining: 傾き ≤ −0.15 かつ 傾き + 2SE < 0（減少がノイズで説明できない）
 * rising:    傾き ≥ +0.15 かつ 傾き − 2SE > 0（増加がノイズで説明できない）
 * flat:      |傾き| < 0.15 かつ 傾き − 2SE > −0.4 かつ 傾き + 2SE < +0.4（±0.4kg/週の変化をノイズで説明できない）
 * それ以外は uncertain（判断保留）
 */
export function trendLabel(slopePerWeek, sePerWeek) {
  if (slopePerWeek == null || sePerWeek == null) return 'uncertain';
  if (slopePerWeek <= -0.15 && slopePerWeek + 2 * sePerWeek < 0) return 'declining';
  if (slopePerWeek >= 0.15 && slopePerWeek - 2 * sePerWeek > 0) return 'rising';
  if (
    Math.abs(slopePerWeek) < 0.15 &&
    slopePerWeek - 2 * sePerWeek > -0.4 &&
    slopePerWeek + 2 * sePerWeek < 0.4
  ) {
    return 'flat';
  }
  return 'uncertain';
}

/**
 * 直近 windowDays 日（対象日を含む）の日次値に線形回帰をあて、週あたりの傾きを出す。
 * @param days /api/measurements の days
 * @param date 対象日 YYYY-MM-DD
 * @returns {{ window_days: number, weight: TrendMetric, fat: TrendMetric, ffm: TrendMetric }}
 *   TrendMetric = { slope_kg_per_week, se_kg_per_week, n, label }。点が minPoints 未満なら傾きは null・uncertain
 */
export function deriveTrend(days, date, { windowDays = DEFAULT_TREND_WINDOW_DAYS, minPoints = 8 } = {}) {
  const from = addDaysYmd(date, -(windowDays - 1));
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const keys = { weight: 'weight', fat: 'fat_mass', ffm: 'fat_free_mass' };
  const out = { window_days: windowDays };
  for (const [name, key] of Object.entries(keys)) {
    const points = [];
    for (const row of days) {
      if (typeof row?.d !== 'string' || row.d > date || row.d < from) continue;
      const y = row[key];
      if (typeof y !== 'number' || !Number.isFinite(y)) continue;
      points.push({ x: (Date.parse(`${row.d}T00:00:00Z`) - fromMs) / 86_400_000, y });
    }
    if (points.length < minPoints) {
      out[name] = { slope_kg_per_week: null, se_kg_per_week: null, n: points.length, label: 'uncertain' };
      continue;
    }
    const { slope, se, n } = regression(points);
    const slopeW = slope == null ? null : slope * 7;
    const seW = se == null ? null : se * 7;
    out[name] = {
      slope_kg_per_week: roundTo(slopeW, 2),
      se_kg_per_week: roundTo(seW, 2),
      n,
      label: trendLabel(slopeW, seW),
    };
  }
  return out;
}

/**
 * 直近 windowDays 日のうち記録のある日の平均摂取 kcal（四捨五入。該当日が無ければ null）。
 * excludeDate=true のときは対象日を窓に含めない（D-7〜D-1）。当日 23:30 の生成では夕食が未記録の
 * 可能性があり、部分記録の当日を含めると平均が下振れして「赤字が深い」判定を誤成立させるため。
 * @param days /api/meals/daily の days（{d, count, calories}）
 * @param date 対象日 YYYY-MM-DD
 */
export function deriveIntakeAvg(days, date, { windowDays = INTAKE_WINDOW_DAYS, excludeDate = false } = {}) {
  const to = excludeDate ? addDaysYmd(date, -1) : date;
  const from = addDaysYmd(to, -(windowDays - 1));
  const values = [];
  for (const row of days ?? []) {
    if (typeof row?.d !== 'string' || row.d < from || row.d > to) continue;
    if (!(Number(row.count) > 0)) continue; // 防御的: API の集計行は常に count ≥ 1
    if (typeof row.calories !== 'number' || !Number.isFinite(row.calories)) continue;
    values.push(row.calories);
  }
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * 回復提案の客観条件に使う導出値。
 * 筋トレ日 = strength_count > 0 の日（有酸素のみの日は含めない）。高負荷日 = 筋トレ日 または calories_burned ≥ hardBurnKcal。
 * *_before_today は D-1 を起点にした連続数（当日 23:30 の生成では当日の運動が未記録の可能性があるため）。
 * @param exerciseDays /api/exercise/daily の days（{d, strength_count, calories_burned}）
 * @param date 対象日 YYYY-MM-DD
 */
export function deriveExerciseContext(exerciseDays, date, { hardBurnKcal = DEFAULT_HARD_BURN_KCAL } = {}) {
  const byDate = new Map();
  for (const row of exerciseDays ?? []) {
    if (typeof row?.d !== 'string' || row.d > date) continue;
    const strength = Number(row.strength_count ?? 0) || 0;
    const burn = Number(row.calories_burned ?? 0) || 0;
    byDate.set(row.d, { strength: strength > 0, hard: strength > 0 || burn >= hardBurnKcal });
  }
  const streak = (flag, start) => {
    let k = 0;
    while (byDate.get(addDaysYmd(start, -k))?.[flag]) k++;
    return k;
  };
  const yesterday = addDaysYmd(date, -1);
  let last7 = 0;
  for (let k = 0; k < 7; k++) if (byDate.get(addDaysYmd(date, -k))?.strength) last7++;
  let since = null;
  const dates = [...byDate.entries()].filter(([, e]) => e.strength).map(([d]) => d);
  if (dates.length > 0) {
    const last = dates.sort().at(-1);
    since = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000);
  }
  return {
    strength_streak_days: streak('strength', date),
    hard_streak_days: streak('hard', date),
    strength_streak_days_before_today: streak('strength', yesterday),
    hard_streak_days_before_today: streak('hard', yesterday),
    strength_days_last7: last7,
    days_since_last_strength: since,
  };
}

/**
 * 運動ログを講評向けに圧縮する。サーキット（group_id で束ねられた親子）は親1行に畳み、子のボリュームを合算する。
 * @param logs /api/exercise/logs の logs（ExerciseLog[]。performed_at は ISO8601。オフセット形式は問わない）
 * @param tzOffsetHours ローカル日付・時刻の算出用
 * @param opts.muscleGroups menu_id → 部位（/api/exercise/menus から作る。無ければ省略）
 * @returns {SessionSummary[]}（時刻順。hh はローカル時（0〜23）。深夜の記録を前日の続きと読む材料）
 */
export function summarizeSessions(logs, tzOffsetHours, { muscleGroups } = {}) {
  const rows = (logs ?? []).filter((l) => l && typeof l.performed_at === 'string');
  const setVolumes = (l) => {
    const sets = Array.isArray(l.sets) ? l.sets : [];
    const weighted = sets.reduce((s, x) => s + (Number(x.reps) || 0) * (Number(x.weight_kg) || 0), 0);
    const total = sets.reduce((s, x) => s + (Number(x.volume) || 0), 0);
    return { weighted, bodyweight: Math.max(0, total - weighted) };
  };
  const parents = new Map();
  const out = [];
  for (const l of rows) {
    const isChild = l.group_id != null && l.group_id !== l.id;
    if (isChild) continue;
    const v = setVolumes(l);
    const ms = Date.parse(l.performed_at);
    const row = {
      t: ms,
      d: localYmd(ms, tzOffsetHours),
      hh: new Date(ms + tzOffsetHours * 3_600_000).getUTCHours(),
      kind: l.group_id != null && l.group_id === l.id ? 'circuit' : l.category,
      name: l.menu_name,
      min: l.duration_min ?? null,
      kcal: l.calories == null ? null : Math.round(l.calories),
      weighted_volume: Math.round(v.weighted),
      bodyweight_volume: Math.round(v.bodyweight),
      rounds: l.rounds ?? null,
      muscle_group: muscleGroups?.get?.(l.menu_id) ?? null,
      note: typeof l.note === 'string' && l.note.trim() !== '' ? l.note.trim() : null,
    };
    out.push(row);
    if (row.kind === 'circuit') parents.set(l.id, row);
  }
  for (const l of rows) {
    const isChild = l.group_id != null && l.group_id !== l.id;
    if (!isChild) continue;
    const parent = parents.get(l.group_id);
    if (!parent) continue;
    const v = setVolumes(l);
    parent.weighted_volume += Math.round(v.weighted);
    parent.bodyweight_volume += Math.round(v.bodyweight);
  }
  out.sort((a, b) => a.t - b.t);
  return out.map(({ t, ...rest }) => rest);
}

/**
 * 直近の講評（previous_notes）を選ぶ: 対象日より前（minDate 以降）の daily だけを日付昇順にし、本文は maxChars で切る。
 * 前日の講評と矛盾しない総括を書かせるためにプロンプトへ渡す（トークン節約のため上限つき）。
 * @param notes /api/coaching の notes（{kind, date, content} の配列。順序は問わない）
 * @param date 対象日 YYYY-MM-DD（この日以降の講評は除く＝過去日の再生成でも未来を見ない）
 * @param opts.minDate これより前の講評は除く（既定は PREVIOUS_NOTE_DAYS 日前。API 経路とファイル経路で窓を揃える）
 */
export function selectPreviousNotes(notes, date, { maxChars = 800, minDate = addDaysYmd(date, -PREVIOUS_NOTE_DAYS) } = {}) {
  return (notes ?? [])
    .filter(
      (n) =>
        n &&
        n.kind === 'daily' &&
        typeof n.date === 'string' &&
        n.date < date &&
        n.date >= minDate &&
        typeof n.content === 'string',
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((n) => ({
      date: n.date,
      content: n.content.length > maxChars ? `${n.content.slice(0, maxChars)}…` : n.content,
    }));
}
