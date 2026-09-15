/**
 * AIコーチング講評の生成ジョブ。GitHub Actions のスケジュール実行から呼ばれる。
 *
 * 1. bodylog 公開APIから直近データを取得（体重・食事・運動・目標・代謝推定＋前日までの講評7日分＋直近7日の運動ログ）
 * 2. Claude Agent SDK（CLAUDE_CODE_OAUTH_TOKEN = サブスク認証）で講評テキストを生成
 * 3. POST /api/coaching（Bearer: COACHING_API_SECRET）で保存 → WorkerがSlack配信・表示
 *
 * 環境変数:
 *   BODYLOG_BASE_URL        必須。ダッシュボード基点までのURL（末尾スラッシュ不要）。
 *                           DASHBOARD_SLUG設定時は https://weight.example.com/d/{slug}、空文字運用時は https://weight.example.com
 *   COACHING_API_SECRET     必須。POST /api/coaching のBearerトークン
 *   CLAUDE_CODE_OAUTH_TOKEN 必須（SDKが参照。COACHING_PROMPT_ONLY のときだけ不要）。`claude setup-token` で発行
 *   COACHING_MODEL          任意。既定 'opus'（Claude Codeの既定Opusに追従する別名）
 *   COACHING_TZ_OFFSET_HOURS 任意。既定 9（JST）
 *   COACHING_PROFILE        任意。本人の方針・ルーチン・固定メニュー・タンパク質目標などの自由記述、または
 *                           {"text": "...", "max_hard_streak": 6, "min_kcal": ..., "min_protein_g": ...} 形式の JSON。
 *                           個人情報なのでリポジトリには書かず Secret で渡す。プロンプトの評価軸・運動方針・食事方針は
 *                           これを最優先で参照する（解釈は prompt.mjs parseProfile）
 *   COACHING_DATE           任意。生成対象日 YYYY-MM-DD（ローカル日付、当日以前）。未設定なら実行時点の当日。
 *                           記録を後から足した日の講評を作り直す手動実行用（workflow_dispatch の date 入力）。
 *                           対象日を末尾とする直近 FETCH_DAYS 日を取得して生成する。直近7日平均・前週比は
 *                           対象日時点で導出し、基準日との差と実効消費推定（Worker が実行時点基準でしか
 *                           計算しない値）は過去日では使わない
 *   COACHING_SCHEDULED      任意。'true' のとき schedule 実行として扱い、COACHING_DATE が空なら
 *                           「直近の予定スロット（23:30 JST）が属する日」を対象にする。GitHub の
 *                           schedule 遅延が日付をまたいでも前日（本来の対象日）の講評を生成するため。
 *                           さらに「その夜のスロット以降に生成された講評」が既にあればスキップする
 *                           （schedule は Worker からの workflow_dispatch 起動のフォールバックのため。
 *                           古い講評＝未明の遅延実行や日中の手動再生成の残りは上書きする）
 *   COACHING_DRY_RUN        任意。'1' で再現評価モード: 排他claim・スキップ判定・保存を行わず、生成した本文を
 *                           COACHING_OUTPUT_FILE に書く（標準出力には出さない。Actions のログは公開されるため）
 *   COACHING_OUTPUT_FILE    DRY_RUN のとき必須。本文（PROMPT_ONLY ならプロンプト）の書き出し先。
 *                           リポジトリ内なら gitignore 済みの場所（coaching/out/ 等）でなければ拒否する
 *   COACHING_PROMPT_ONLY    任意。'1' で SDK を呼ばずプロンプトだけを COACHING_OUTPUT_FILE に書く（DRY_RUN 前提）
 *   COACHING_PREVIOUS_NOTES_FILE 任意（DRY_RUN 前提）。previous_notes を API の代わりにこのファイル
 *                           （{notes:[...]} または配列）から読む。再現評価で前日の再生成結果を連鎖させるため（replay.mjs が使う）
 *
 * 注意: パブリックリポのActionsログは公開されるため、講評本文や取得データはログに出さない。
 */
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  addDaysYmd,
  fetchRange,
  hasFreshDailyNote,
  localYmd,
  resolveTargetDate,
  scheduleTargetDate,
} from './dates.mjs';
import {
  DEFAULT_TREND_WINDOW_DAYS,
  PREVIOUS_NOTE_DAYS,
  SESSION_DAYS,
  deriveExerciseContext,
  deriveIntakeAvg,
  deriveTerms,
  deriveTrend,
  roundTo,
  selectPreviousNotes,
  summarizeSessions,
} from './derive.mjs';
import { assertSafeOutputPath, isOn, makeGetJson, requiredEnv } from './env.mjs';
import { POLICY, SYSTEM_PROMPT, buildPrompt, parseProfile } from './prompt.mjs';

const FETCH_DAYS = DEFAULT_TREND_WINDOW_DAYS + 1; // 前日分＋21日回帰（trend）を賄う取得幅

const dryRun = isOn(process.env.COACHING_DRY_RUN);
const promptOnly = isOn(process.env.COACHING_PROMPT_ONLY);
const outputFile = (process.env.COACHING_OUTPUT_FILE ?? '').trim();
const previousNotesFile = (process.env.COACHING_PREVIOUS_NOTES_FILE ?? '').trim();

const base = requiredEnv('BODYLOG_BASE_URL').replace(/\/+$/, '');
const secret = requiredEnv('COACHING_API_SECRET');
if (!promptOnly) requiredEnv('CLAUDE_CODE_OAUTH_TOKEN'); // SDKが読む。早期に未設定を検出するためだけに確認
if (dryRun && !outputFile) {
  console.error('COACHING_DRY_RUN requires COACHING_OUTPUT_FILE');
  process.exit(1);
}
if (promptOnly && !dryRun) {
  console.error('COACHING_PROMPT_ONLY requires COACHING_DRY_RUN=1');
  process.exit(1);
}
if (previousNotesFile && !dryRun) {
  console.error('COACHING_PREVIOUS_NOTES_FILE requires COACHING_DRY_RUN=1');
  process.exit(1);
}
// 書き出し先は講評本文・健康データ・profile を含むため、追跡対象になりうる場所を早期に拒否する
let outputPath = null;
if (dryRun) {
  try {
    outputPath = assertSafeOutputPath(outputFile);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
const model = process.env.COACHING_MODEL || 'opus';
const envTzOffsetHours = Number.isFinite(Number(process.env.COACHING_TZ_OFFSET_HOURS))
  ? Number(process.env.COACHING_TZ_OFFSET_HOURS)
  : 9;
const profile = parseProfile(process.env.COACHING_PROFILE);
const getJson = makeGetJson(base, secret);

const round1 = (v) => roundTo(v, 1);

function roundTriple(t) {
  return { weight: round1(t?.weight), fat_mass: round1(t?.fat_mass), fat_free_mass: round1(t?.fat_free_mass) };
}

const NULL_TRIPLE = { weight: null, fat_mass: null, fat_free_mass: null };

function readPreviousNotesFile(path) {
  const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
  const notes = Array.isArray(parsed) ? parsed : parsed?.notes;
  if (!Array.isArray(notes)) throw new Error('COACHING_PREVIOUS_NOTES_FILE must contain {notes: [...]} or an array');
  return { notes };
}

/** ログには固定の分類と先頭1行だけを出す（SDK の例外は CLI の stderr 末尾を連結するため、そのまま流さない） */
function briefError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0].split('. stderr:')[0].slice(0, 200);
}

/**
 * 対象日 date を末尾とする直近 FETCH_DAYS 日のデータを集める（date より後の日は含めない）。
 * /api/summary の直近7日平均・前週比・基準日差と /api/metabolism は Worker が実行時点基準でしか計算しないため、
 * 過去日（date !== today）では 7日平均・前週比を取得済みの日次系列から対象日時点で導出し、
 * 基準日差と実効消費推定は使わない（対象日より後のデータを講評の根拠にしないため）。
 */
async function collectData(date, today, tzOffsetHours) {
  const isPast = date !== today;
  const { from, to } = fetchRange(date, FETCH_DAYS);
  const range = `from=${from}&to=${to}`;
  const noteRange = `from=${addDaysYmd(date, -PREVIOUS_NOTE_DAYS)}&to=${addDaysYmd(date, -1)}`;
  const sessionRange = `from=${addDaysYmd(date, -(SESSION_DAYS - 1))}&to=${date}`;
  const warnUnavailable = (what, fallback) => (err) => {
    console.warn(`${what} unavailable, generating without it: ${briefError(err)}`);
    return fallback;
  };
  const [summary, measurements, meals, exercise, metabolism, coaching, logs, menus] = await Promise.all([
    getJson('/api/summary'),
    getJson(`/api/measurements?${range}`),
    getJson(`/api/meals/daily?${range}`),
    getJson(`/api/exercise/daily?${range}`),
    // 実効代謝は補助情報。取得失敗しても講評生成は続ける
    isPast ? Promise.resolve(null) : getJson('/api/metabolism').catch(() => null),
    // 直近の講評（前日まで）。取得できなくても生成は続けるが、無音にはしない（本文は出さない）
    previousNotesFile
      ? Promise.resolve(readPreviousNotesFile(previousNotesFile))
      : getJson(`/api/coaching?${noteRange}`).catch(warnUnavailable('previous notes', { notes: [] })),
    // 運動ログ（種目名・部位・メモ）と種目一覧（部位。アーカイブ済みも含めて引く）。無くても生成は続ける
    getJson(`/api/exercise/logs?${sessionRange}`).catch(warnUnavailable('exercise logs', { logs: [] })),
    getJson('/api/exercise/menus?archived=1').catch(warnUnavailable('exercise menus', { menus: [] })),
  ]);
  const days = measurements.days || [];
  const derived = deriveTerms(days, date);
  const terms = isPast ? derived : { recent7_avg: summary.recent7_avg, diff_vs_prev7: summary.diff_vs_prev7 };
  const exerciseDays = exercise.days || [];
  const intakeDays = meals.days || [];
  const muscleGroups = new Map((menus.menus || []).map((m) => [m.id, m.muscle_group ?? null]));
  return {
    policy: POLICY,
    // 本人の方針・ルーチン・固定メニュー・目標量・下限（COACHING_PROFILE）。未設定なら null
    profile,
    // 数値目標（kg）。未設定の指標はnull。到達点の目安であり、日々の評価軸には使わない（プロンプト側の規則）
    goal: summary.goal ?? { weight_kg: null, fat_mass_kg: null },
    // 直近28日の実測からの実効消費推定。status==='ok'のときだけ使う（過去日は null）
    metabolism: metabolism && metabolism.status === 'ok' ? metabolism : null,
    units: { mass: 'kg', energy: 'kcal', pfc: 'g' },
    // as_of=集計基準日。recent7_avg=直近7暦日の日平均の平均、diff_vs_prev7=その前7暦日との差、
    // recent7_n/prev7_n=各窓の実測日数、baseline.diff=基準日との差（過去日の再生成では算出できないので null）
    summary: {
      as_of: date,
      recent7_avg: roundTriple(terms.recent7_avg),
      diff_vs_prev7: roundTriple(terms.diff_vs_prev7),
      recent7_n: derived.recent7_n,
      prev7_n: derived.prev7_n,
      baseline: isPast ? { date: summary.baseline?.date ?? null, diff: NULL_TRIPLE } : summary.baseline,
    },
    // 直近21日の日次回帰（kg/週）。label は declining / rising / flat / uncertain
    trend: deriveTrend(days, date),
    // d=日付, weight=体重, fat=脂肪量, ffm=除脂肪体重（*_7dは7日移動平均）
    body: days.map((d) => ({
      d: d.d,
      weight: round1(d.weight),
      fat: round1(d.fat_mass),
      ffm: round1(d.fat_free_mass),
      weight_7d: round1(d.weight_7d_avg),
      fat_7d: round1(d.fat_mass_7d_avg),
      ffm_7d: round1(d.fat_free_mass_7d_avg),
    })),
    // kcal=摂取, p/f/c=PFCグラム（部分合計）。PFC比はP4/F9/C4換算で3者内正規化すること
    intake: intakeDays.map((d) => ({
      d: d.d,
      kcal: Math.round(d.calories),
      p: round1(d.protein_g),
      f: round1(d.fat_g),
      c: round1(d.carbs_g),
    })),
    // 直近7日（記録のある日）の平均摂取kcal。当日生成では対象日を含めない（夕食が未記録の可能性があるため）
    intake_7d_avg_kcal: deriveIntakeAvg(intakeDays, date, { excludeDate: !isPast }),
    // 直近の講評（対象日より前・PREVIOUS_NOTE_DAYS 日以内、日付昇順、各800字まで）。前日と矛盾しない評価・方針を書かせるため
    previous_notes: selectPreviousNotes(coaching?.notes, date),
    // bmr=基礎代謝推定, burn=運動消費kcal（内訳 cardio_kcal / strength_kcal）, volume=筋トレ総挙上（自重換算込み）,
    // weighted_volume=実荷重分, bodyweight_volume=自重換算分, cardio/strength=件数。総消費= bmr + burn
    exercise: exerciseDays.map((d) => ({
      d: d.d,
      bmr: d.bmr == null ? null : Math.round(d.bmr),
      burn: d.calories_burned == null ? null : Math.round(d.calories_burned),
      cardio_kcal: d.cardio_calories == null ? null : Math.round(d.cardio_calories),
      strength_kcal: d.strength_calories == null ? null : Math.round(d.strength_calories),
      volume: d.strength_volume == null ? null : Math.round(d.strength_volume),
      weighted_volume: d.weighted_volume == null ? null : Math.round(d.weighted_volume),
      bodyweight_volume: d.bodyweight_volume == null ? null : Math.round(d.bodyweight_volume),
      cardio: d.cardio_count,
      strength: d.strength_count,
    })),
    // 連続トレ日数など、回復提案の客観条件に使う導出値
    exercise_context: deriveExerciseContext(exerciseDays, date),
    // 直近7日の運動記録（種目名・時刻・分数・消費kcal・実荷重/自重ボリューム・部位・メモ）。サーキットは親1行
    sessions: summarizeSessions(logs.logs || [], tzOffsetHours, { muscleGroups }),
  };
}

async function generate(data, date) {
  const prompt = buildPrompt(data, date, { fetchDays: FETCH_DAYS });
  if (promptOnly) return { content: prompt, usedModel: 'prompt-only' };
  let result = null;
  for await (const message of query({
    prompt,
    options: {
      model,
      maxTurns: 1,
      tools: [], // ツール不要の純テキスト生成
      systemPrompt: SYSTEM_PROMPT,
    },
  })) {
    if (message.type === 'result') result = message;
  }
  if (!result || (result.subtype && result.subtype !== 'success') || typeof result.result !== 'string') {
    throw new Error(`generation failed: ${result ? result.subtype : 'no result message'}`);
  }
  // Worker側の上限（4000文字）に合わせて切り詰める（超過すると保存が400で失敗するため）
  const content = result.result.trim().slice(0, 4000);
  if (!content) throw new Error('generation returned empty content');
  // 実際に使われたモデル名を記録する。modelUsageには内部補助呼び出し（haiku等）も
  // 混ざるため、出力トークン数が最大のモデル＝本文を生成したモデルを選ぶ
  const usage = Object.entries(result.modelUsage ?? {});
  const usedModel =
    usage.sort((a, b) => (b[1]?.outputTokens ?? 0) - (a[1]?.outputTokens ?? 0))[0]?.[0] ?? model;
  if (usage.length > 1) console.log(`models used: ${usage.map(([k]) => k).join(', ')}`);
  return { content, usedModel };
}

async function save(kind, date, content, usedModel) {
  const res = await fetch(`${base}/api/coaching`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ kind, date, content, model: usedModel }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    // エラーレスポンスに本文の一部が含まれても、こちらの{error}はサーバー定義の定型文のみ
    const detail = await res.text().catch(() => '');
    throw new Error(`POST /api/coaching -> HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json();
}

const kind = 'daily'; // 週次の別枠は廃止（週間視点は毎日の総括に常に含める）

// 日付境界のオフセットはサーバー（/api/status の timezone_offset_hours）を正本とする。
// Worker と runner が別々の既定値を持つと、片方だけの変更で対象日がずれるため。
// 取得できない場合（旧Worker・一時障害）だけ従来の env 既定へフォールバックする
const tzOffsetHours = await (async () => {
  try {
    const status = await getJson('/api/status');
    if (Number.isFinite(Number(status?.timezone_offset_hours))) {
      return Number(status.timezone_offset_hours);
    }
  } catch (err) {
    console.warn(`failed to fetch server timezone offset: ${briefError(err)}`);
  }
  console.warn(`falling back to env timezone offset (${envTzOffsetHours})`);
  return envTzOffsetHours;
})();

const today = localYmd(Date.now(), tzOffsetHours);
// schedule 実行（date 入力なし）は「直近の予定スロットが属する日」を対象にする。GitHub の schedule が
// 遅延して日付をまたいだ場合に、当日扱いでほぼ空の翌日分を作って本来の対象日が欠けるのを防ぐ
const isScheduleRun =
  !dryRun && process.env.COACHING_SCHEDULED === 'true' && (process.env.COACHING_DATE ?? '').trim() === '';
const target = isScheduleRun
  ? { ok: true, date: scheduleTargetDate(Date.now(), tzOffsetHours) }
  : resolveTargetDate(process.env.COACHING_DATE, today);
if (!target.ok) {
  console.error(target.error);
  process.exit(1);
}
const date = target.date;
console.log(
  `kind=${kind} date=${date} today=${today} model=${model} tz=${tzOffsetHours} profile=${profile ? 'set' : 'none'}${dryRun ? ' dry-run' : ''}${promptOnly ? ' prompt-only' : ''}`,
);

if (isScheduleRun) {
  // schedule 実行は Worker からの workflow_dispatch 起動（対象日を明示）や手動実行のフォールバック。
  // 「その夜のスロット（23:30ローカル）以降に生成された講評」がある場合だけスキップして二重生成を避ける。
  // 単なる存在チェックだと、未明の遅延実行が残した空データ講評や日中の手動再生成が夜の上書きを
  // 妨げてしまう（2026-08-28 に実際に起きた）。dispatch 経由の実行はこのチェックを通らず常に生成・上書きする
  const existing = await getJson(`/api/coaching?from=${date}&to=${date}`).catch(() => null);
  if (hasFreshDailyNote(existing?.notes, date, tzOffsetHours)) {
    console.log(`daily note for ${date} already generated after the slot; skipping (schedule fallback)`);
    process.exit(0);
  }
}

/**
 * 生成の排他claim。schedule と workflow_dispatch が同時に走ったとき、同一対象日の
 * SDK実行コストと外部送信を1回に抑える（lease 15分、失敗runは best-effort で解放）。
 * 旧Worker（endpoint未実装=404）の期間は claim なしで従来どおり動く
 */
async function claimGeneration(d) {
  const res = await fetch(`${base}/api/coaching/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: d }),
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => {
    console.warn(`claim request failed; continuing without claim: ${briefError(err)}`);
    return null;
  });
  if (res === null || res.status === 404) return 'unavailable';
  if (res.status === 409) return 'held';
  if (!res.ok) {
    console.warn(`claim -> HTTP ${res.status}; continuing without claim`);
    return 'unavailable';
  }
  return 'claimed';
}

async function releaseGeneration(d) {
  await fetch(`${base}/api/coaching/claim`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: d }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {});
}

// dry-run は保存も外部送信もしないので claim を取らない（本番の生成と競合させない）
const claim = dryRun ? 'unavailable' : await claimGeneration(date);
if (claim === 'held') {
  console.log(`another run holds the generation claim for ${date}; skipping`);
  process.exit(0);
}

try {
  const data = await collectData(date, today, tzOffsetHours);
  console.log(
    `data: body=${data.body.length}d intake=${data.intake.length}d exercise=${data.exercise.length}d sessions=${data.sessions.length} previous_notes=${data.previous_notes.length}`,
  );
  const { content, usedModel } = await generate(data, date);
  console.log(`generated: ${content.length} chars (model=${usedModel})`);
  if (dryRun) {
    fs.writeFileSync(outputPath, content);
    console.log(`dry-run: written to ${outputPath} (not saved)`);
  } else {
    const saved = await save(kind, date, content, usedModel);
    console.log(`saved: id=${saved.id}`);
  }
} catch (err) {
  console.error('coaching job failed:', briefError(err));
  if (claim === 'claimed') await releaseGeneration(date);
  process.exit(1);
}
