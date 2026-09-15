/**
 * 再現評価（replay.mjs）の集計部分。純粋関数のみ（Node の API に触れない）にして、
 * Workers プールで動くテストから読み込めるようにしている。
 */

/**
 * 講評本文の粗い傾向指標。行動方針欄（「明日の行動方針」以降。無ければ全文）のキーワード一致で
 * 0/1 を立てる。代表例は test/coaching-replay.test.ts を参照
 */
export function scoreNote(content) {
  const text = content ?? '';
  const plan = text.includes('明日の行動方針') ? text.slice(text.indexOf('明日の行動方針')) : text;
  const test = (re, s) => (re.test(s) ? 1 : 0);
  return {
    rest: test(/回復を優先|回復に充て|回復側|完全休養|休養に留め|軽め(の|に)|連投は避け|同部位/, plan),
    cardio_cap: test(/有酸素[^。]{0,12}(留め|で十分|足りて)/, plan),
    carb_up: test(
      /炭水化物[^。]{0,20}(引き上げ|上乗せ|許容|増や)|増やす分は[^。]{0,10}炭水化物|総量[^。]{0,8}(引き上げ|\d{4}\s*kcal)/,
      plan,
    ),
    ffm_reason: test(/除脂肪[^。]{0,30}(目減り|減っ|減少|落ち)/, text),
    gram_change: test(/(炭水化物|脂質)[^。]{0,12}\d{2,3}g/, plan),
    no_change: test(/方針変更なし/, plan),
    chars: text.length,
  };
}

/** 期間の集計（rows は {date, original, regenerated} の配列） */
export function summarizeRows(rows, { from, to, promptOnly }) {
  const fields = ['rest', 'cardio_cap', 'carb_up', 'ffm_reason', 'gram_change', 'no_change'];
  const sum = (key, field) => rows.reduce((a, r) => a + (r[key]?.[field] ?? 0), 0);
  return {
    from,
    to,
    days: rows.length,
    with_original: rows.filter((r) => r.original).length,
    original: Object.fromEntries(fields.map((f) => [f, sum('original', f)])),
    regenerated: promptOnly ? null : Object.fromEntries(fields.map((f) => [f, sum('regenerated', f)])),
    rows,
  };
}
