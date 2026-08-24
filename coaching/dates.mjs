/**
 * 講評ジョブの日付ヘルパー。generate.mjs とテストから共用する純粋関数のみ
 * （環境変数・ネットワーク・現在時刻には触れない）。日付は全て YYYY-MM-DD のローカル日付（UTC+offset）。
 */

/** ローカル日付 YYYY-MM-DD（UTC+offset）。nowMs は Date.now() 相当のエポックms */
export function localYmd(nowMs, tzOffsetHours) {
  return new Date(nowMs + tzOffsetHours * 3_600_000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD の厳格チェック（実在日か含む。Worker側 src/util.ts の isValidYmd と同じ規則） */
export function isValidYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** ローカル日付に日数を加算する（負なら過去） */
export function addDaysYmd(ymd, days) {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 生成対象日を決める。raw（環境変数 COACHING_DATE）が未設定・空なら today（=schedule実行の通常動作）。
 * 指定があれば YYYY-MM-DD の実在日かつ today 以前であることを要求する
 * （Worker側の POST /api/coaching は形式しか検証しないため、未来日はここで落とす）。
 */
export function resolveTargetDate(raw, today) {
  const v = (raw ?? '').trim();
  if (v === '') return { ok: true, date: today };
  if (!isValidYmd(v)) return { ok: false, error: `COACHING_DATE must be a valid YYYY-MM-DD (got "${v}")` };
  if (v > today) return { ok: false, error: `COACHING_DATE must not be a future date (${v} > ${today})` };
  return { ok: true, date: v };
}

/** 対象日を末尾とする直近 days 日の from/to（両端含む）。days=1 なら from=to=date */
export function fetchRange(date, days) {
  return { from: addDaysYmd(date, -(days - 1)), to: date };
}
