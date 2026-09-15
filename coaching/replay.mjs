/**
 * 再現評価: 過去の連続日を新しいプロンプトで作り直し（保存はしない）、実際に配信された講評と
 * 助言の傾向を比べる。前日の再生成結果を previous_notes に差し替えて順に生成するので、
 * 連続性ルールの効果も含めて評価できる。
 *
 * 使い方（本番 API とサブスク認証が要る。ローカルで実行する。出力先は gitignore 済みの coaching/out/ か
 * リポジトリ外にする。それ以外は拒否される）:
 *   BODYLOG_BASE_URL=... COACHING_API_SECRET=... CLAUDE_CODE_OAUTH_TOKEN=... COACHING_PROFILE='...' \
 *   COACHING_REPLAY_FROM=2026-09-05 COACHING_REPLAY_TO=2026-09-14 COACHING_OUTPUT_DIR=coaching/out/replay \
 *   node replay.mjs
 *
 *   COACHING_PROMPT_ONLY=1 を付けると SDK を呼ばずプロンプトだけを出力する（差し替え内容の確認用）。
 *
 * 制約: 過去日の生成では metabolism（実効消費推定）が null になるため、TDEE に依存する規則
 * （摂取引き上げ条件(2)・回復条件(c)）は本番と同じ挙動にならない。TO を当日にした場合だけ当日分は本番相当。
 *
 * 出力: <dir>/<date>.txt（再生成本文）、<dir>/<date>.original.txt（配信済み本文）、<dir>/previous-<date>.json
 * （渡した previous_notes）、<dir>/summary.json（集計）。
 * 標準出力には件数だけを出し、本文は出さない（Actions 上で走らせた場合にログへ漏らさないため）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDaysYmd, isValidYmd } from './dates.mjs';
import { PREVIOUS_NOTE_DAYS } from './derive.mjs';
import { assertSafeOutputPath, isOn, makeGetJson, requiredEnv } from './env.mjs';
import { scoreNote, summarizeRows } from './replay-score.mjs';

function runGenerate(date, previousNotesPath, outputPath, promptOnly) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const env = {
    ...process.env,
    COACHING_DATE: date,
    COACHING_DRY_RUN: '1',
    COACHING_OUTPUT_FILE: outputPath,
    COACHING_PREVIOUS_NOTES_FILE: previousNotesPath,
    ...(promptOnly ? { COACHING_PROMPT_ONLY: '1' } : {}),
  };
  // generate.mjs の標準出力は件数・日付・モデル名だけ（本文は出さない設計）なので、そのまま流してよい
  const r = spawnSync(process.execPath, [path.join(here, 'generate.mjs')], { env, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`generate.mjs failed for ${date} (exit ${r.status})`);
}

const base = requiredEnv('BODYLOG_BASE_URL').replace(/\/+$/, '');
const secret = requiredEnv('COACHING_API_SECRET');
const from = requiredEnv('COACHING_REPLAY_FROM');
const to = requiredEnv('COACHING_REPLAY_TO');
const promptOnly = isOn(process.env.COACHING_PROMPT_ONLY);
if (!isValidYmd(from) || !isValidYmd(to) || from > to) {
  console.error('COACHING_REPLAY_FROM / COACHING_REPLAY_TO must be valid YYYY-MM-DD with FROM <= TO');
  process.exit(1);
}
let outDir;
try {
  outDir = assertSafeOutputPath(path.join(requiredEnv('COACHING_OUTPUT_DIR'), 'summary.json'));
  outDir = path.dirname(outDir);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const getJson = makeGetJson(base, secret);

// 配信済みの講評（from の PREVIOUS_NOTE_DAYS 日前から to まで）。from より前は previous_notes の種、from 以降は比較対象
const originals = (await getJson(`/api/coaching?from=${addDaysYmd(from, -PREVIOUS_NOTE_DAYS)}&to=${to}`)).notes ?? [];
const originalDaily = originals.filter((n) => n.kind === 'daily');
const regenerated = [];
const rows = [];
for (let date = from; date <= to; date = addDaysYmd(date, 1)) {
  // 窓（PREVIOUS_NOTE_DAYS 日）は generate.mjs 側の selectPreviousNotes が揃えるので、ここでは種と連鎖分を渡すだけ
  const seed = originalDaily.filter((n) => n.date < from);
  const chained = regenerated.filter((n) => n.date < date);
  const previousPath = path.join(outDir, `previous-${date}.json`);
  fs.writeFileSync(previousPath, JSON.stringify({ notes: [...seed, ...chained] }, null, 1));
  const outputPath = path.join(outDir, `${date}.txt`);
  runGenerate(date, previousPath, outputPath, promptOnly);
  const content = fs.readFileSync(outputPath, 'utf8');
  if (!promptOnly) regenerated.push({ kind: 'daily', date, content });
  const original = originalDaily.find((n) => n.date === date)?.content ?? null;
  if (original != null) fs.writeFileSync(path.join(outDir, `${date}.original.txt`), original);
  rows.push({
    date,
    original: original == null ? null : scoreNote(original),
    regenerated: promptOnly ? null : scoreNote(content),
  });
}
const summary = summarizeRows(rows, { from, to, promptOnly });
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(`replay ${from}..${to}: ${rows.length} days (originals: ${summary.with_original})`);
console.log(`original    : ${JSON.stringify(summary.original)}`);
if (!promptOnly) console.log(`regenerated : ${JSON.stringify(summary.regenerated)}`);
console.log(`details: ${path.join(outDir, 'summary.json')}`);
