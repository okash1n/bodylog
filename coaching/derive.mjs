/**
 * 過去日の講評を作り直すときに、/api/summary の代わりに日次系列から対象日時点の集計を導出する純粋関数。
 * Worker 側（src/queries.ts getTermStats）と同じ定義:
 *   recent7 = 対象日を含む直近7暦日（D-6〜D）の日平均の平均、prev7 = その前の7暦日（D-13〜D-7）。
 *   日平均が無い日は平均に含めない（SQL の AVG と同じく NULL を無視）。
 */
import { addDaysYmd } from './dates.mjs';

const METRICS = ['weight', 'fat_mass', 'fat_free_mass'];

function average(rows, key) {
  const values = rows.map((r) => r[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function triple(rows) {
  return Object.fromEntries(METRICS.map((k) => [k, average(rows, k)]));
}

/**
 * @param days /api/measurements の days（{d, weight, fat_mass, fat_free_mass, ...} の配列。日付順でなくてよい）
 * @param date 対象日 YYYY-MM-DD
 * @returns {{ recent7_avg: MetricTriple, diff_vs_prev7: MetricTriple }} 該当日が無い指標は null
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
  const recent7 = triple(recent);
  const prev7 = triple(prev);
  const diff = Object.fromEntries(
    METRICS.map((k) => [k, recent7[k] != null && prev7[k] != null ? recent7[k] - prev7[k] : null]),
  );
  return { recent7_avg: recent7, diff_vs_prev7: diff };
}

/**
 * 直近の講評（previous_notes）を選ぶ: 対象日より前の daily だけを日付昇順にし、本文は maxChars で切る。
 * 前日の講評と矛盾しない総括を書かせるためにプロンプトへ渡す（トークン節約のため上限つき）。
 * @param notes /api/coaching の notes（{kind, date, content} の配列。順序は問わない）
 * @param date 対象日 YYYY-MM-DD（この日以降の講評は除く＝過去日の再生成でも未来を見ない）
 */
export function selectPreviousNotes(notes, date, { maxChars = 800 } = {}) {
  return (notes ?? [])
    .filter(
      (n) => n && n.kind === 'daily' && typeof n.date === 'string' && n.date < date && typeof n.content === 'string',
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((n) => ({
      date: n.date,
      content: n.content.length > maxChars ? `${n.content.slice(0, maxChars)}…` : n.content,
    }));
}
