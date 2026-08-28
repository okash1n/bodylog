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

/**
 * schedule 実行の生成対象日: 実行時刻から見て「直近の予定スロットが属するローカル日付」を返す。
 * スロットは既定 14:30 UTC（= 23:30 JST。coaching.yml の cron と対で保つこと）。
 * 予定どおり〜同日内の遅延では当日、GitHub の遅延で日付をまたいで起動した場合は前日になる
 * （実事例: 2026-08-27 の 23:30 予定が翌 03:14 JST 開始になり、当日扱いだと対象日が 08-28 にずれた）。
 */
export function scheduleTargetDate(nowMs, tzOffsetHours, slotUtcMinutes = 14 * 60 + 30) {
  const dayMs = 86_400_000;
  const sinceMidnightUtc = ((nowMs % dayMs) + dayMs) % dayMs;
  const todaySlotMs = nowMs - sinceMidnightUtc + slotUtcMinutes * 60_000;
  const lastSlotMs = todaySlotMs <= nowMs ? todaySlotMs : todaySlotMs - dayMs;
  return localYmd(lastSlotMs, tzOffsetHours);
}

/**
 * 指定ローカル日付の予定スロット時刻（エポックms）。scheduleTargetDate の逆で、
 * scheduleTargetDate(slotTimeForDate(d, tz), tz) === d が常に成り立つ。
 * fallback のスキップ判定（「その夜のスロット以降に生成された講評か」）に使う。
 */
export function slotTimeForDate(ymd, tzOffsetHours, slotUtcMinutes = 14 * 60 + 30) {
  const dayMs = 86_400_000;
  const localMidnightUtcMs = Date.parse(`${ymd}T00:00:00Z`) - tzOffsetHours * 3_600_000;
  const sinceMidnightUtc = ((localMidnightUtcMs % dayMs) + dayMs) % dayMs;
  let slotMs = localMidnightUtcMs - sinceMidnightUtc + slotUtcMinutes * 60_000;
  if (slotMs < localMidnightUtcMs) slotMs += dayMs;
  return slotMs;
}

/**
 * coaching_notes.created_at をエポックmsにする。D1 の datetime('now') 形式
 * （'YYYY-MM-DD HH:MM:SS'、UTC・タイムゾーン表記なし）と ISO 8601 の両方を受け、
 * タイムゾーン表記が無ければ UTC とみなす。解釈できなければ NaN
 */
export function parseCreatedAtUtc(s) {
  if (typeof s !== 'string') return NaN;
  const t = s.includes('T') ? s : s.replace(' ', 'T');
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(t);
  return Date.parse(hasTz ? t : `${t}Z`);
}

/**
 * 「その夜のスロット以降に生成された対象日の daily 講評」が notes に含まれるか。
 * schedule 実行（フォールバック）のスキップ判定に使う。単なる存在チェックにしないのは、
 * 未明の遅延実行が残した空データ講評や日中の手動再生成を、夜の実行で上書きできるようにするため
 * （2026-08-28 の事象）。created_at が解釈できない場合は「生成済みでない」= 再生成に倒す
 */
export function hasFreshDailyNote(notes, ymd, tzOffsetHours, slotUtcMinutes = 14 * 60 + 30) {
  if (!Array.isArray(notes)) return false;
  const slotMs = slotTimeForDate(ymd, tzOffsetHours, slotUtcMinutes);
  return notes.some(
    (n) => n && n.kind === 'daily' && n.date === ymd && parseCreatedAtUtc(n.created_at) >= slotMs,
  );
}
