/**
 * AIコーチング講評の生成ジョブ。GitHub Actions のスケジュール実行から呼ばれる。
 *
 * 1. bodylog 公開APIから直近データを取得（体重・食事・運動・目標・代謝推定＋前日までの講評7日分）
 * 2. Claude Agent SDK（CLAUDE_CODE_OAUTH_TOKEN = サブスク認証）で講評テキストを生成
 * 3. POST /api/coaching（Bearer: COACHING_API_SECRET）で保存 → WorkerがSlack配信・表示
 *
 * 環境変数:
 *   BODYLOG_BASE_URL        必須。ダッシュボード基点までのURL（末尾スラッシュ不要）。
 *                           DASHBOARD_SLUG設定時は https://weight.example.com/d/{slug}、空文字運用時は https://weight.example.com
 *   COACHING_API_SECRET     必須。POST /api/coaching のBearerトークン
 *   CLAUDE_CODE_OAUTH_TOKEN 必須（SDKが参照）。`claude setup-token` で発行
 *   COACHING_MODEL          任意。既定 'opus'（Claude Codeの既定Opusに追従する別名）
 *   COACHING_TZ_OFFSET_HOURS 任意。既定 9（JST）
 *   COACHING_DATE           任意。生成対象日 YYYY-MM-DD（ローカル日付、当日以前）。未設定なら実行時点の当日。
 *                           記録を後から足した日の講評を作り直す手動実行用（workflow_dispatch の date 入力）。
 *                           対象日を末尾とする直近 FETCH_DAYS 日を取得して生成する。直近7日平均・前週比は
 *                           対象日時点で導出し、基準日との差と実効消費推定（Worker が実行時点基準でしか
 *                           計算しない値）は過去日では使わない
 *
 * 注意: パブリックリポのActionsログは公開されるため、講評本文や取得データはログに出さない。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { addDaysYmd, fetchRange, localYmd, resolveTargetDate } from './dates.mjs';
import { deriveTerms, selectPreviousNotes } from './derive.mjs';

const FETCH_DAYS = 15; // 前日分＋14日トレンドを賄う取得幅
const PREVIOUS_NOTE_DAYS = 7; // 前日までの講評を何日分プロンプトに渡すか（矛盾防止用）

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

const base = requiredEnv('BODYLOG_BASE_URL').replace(/\/+$/, '');
const secret = requiredEnv('COACHING_API_SECRET');
requiredEnv('CLAUDE_CODE_OAUTH_TOKEN'); // SDKが読む。早期に未設定を検出するためだけに確認
const model = process.env.COACHING_MODEL || 'opus';
const tzOffsetHours = Number.isFinite(Number(process.env.COACHING_TZ_OFFSET_HOURS))
  ? Number(process.env.COACHING_TZ_OFFSET_HOURS)
  : 9;

async function getJson(path) {
  // READ_ACCESS=private のWorkerでも読めるよう常にBearerを付ける（publicモードでは無視される）
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

/** 数値をトークン節約のため丸める（null維持） */
function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}

function roundTriple(t) {
  return { weight: round1(t?.weight), fat_mass: round1(t?.fat_mass), fat_free_mass: round1(t?.fat_free_mass) };
}

const NULL_TRIPLE = { weight: null, fat_mass: null, fat_free_mass: null };

/**
 * 対象日 date を末尾とする直近 FETCH_DAYS 日のデータを集める（date より後の日は含めない）。
 * /api/summary の直近7日平均・前週比・基準日差と /api/metabolism は Worker が実行時点基準でしか計算しないため、
 * 過去日（date !== today）では 7日平均・前週比を取得済みの日次系列から対象日時点で導出し、
 * 基準日差と実効消費推定は使わない（対象日より後のデータを講評の根拠にしないため）。
 */
async function collectData(date, today) {
  const isPast = date !== today;
  const { from, to } = fetchRange(date, FETCH_DAYS);
  const range = `from=${from}&to=${to}`;
  const noteRange = `from=${addDaysYmd(date, -PREVIOUS_NOTE_DAYS)}&to=${addDaysYmd(date, -1)}`;
  const [summary, measurements, meals, exercise, metabolism, coaching] = await Promise.all([
    getJson('/api/summary'),
    getJson(`/api/measurements?${range}`),
    getJson(`/api/meals/daily?${range}`),
    getJson(`/api/exercise/daily?${range}`),
    // 実効代謝は補助情報。取得失敗しても講評生成は続ける
    isPast ? Promise.resolve(null) : getJson('/api/metabolism').catch(() => null),
    // 直近の講評（前日まで）。無くても生成は続ける
    getJson(`/api/coaching?${noteRange}`).catch(() => ({ notes: [] })),
  ]);
  const days = measurements.days || [];
  const terms = isPast
    ? deriveTerms(days, date)
    : { recent7_avg: summary.recent7_avg, diff_vs_prev7: summary.diff_vs_prev7 };
  return {
    policy: '体組成改善（脂肪量を減らし、除脂肪体重を維持・増加させる）',
    // 数値目標（kg）。未設定の指標はnull。設定されていれば講評の評価軸に使う
    goal: summary.goal ?? { weight_kg: null, fat_mass_kg: null },
    // 直近28日の実測からの実効消費推定。status==='ok'のときだけ使う
    metabolism: metabolism && metabolism.status === 'ok' ? metabolism : null,
    units: { mass: 'kg', energy: 'kcal', pfc: 'g' },
    // as_of=集計基準日。recent7_avg=直近7暦日の日平均の平均、diff_vs_prev7=その前7暦日との差、
    // baseline.diff=基準日との差（過去日の再生成では算出できないので null）
    summary: {
      as_of: date,
      recent7_avg: roundTriple(terms.recent7_avg),
      diff_vs_prev7: roundTriple(terms.diff_vs_prev7),
      baseline: isPast ? { date: summary.baseline?.date ?? null, diff: NULL_TRIPLE } : summary.baseline,
    },
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
    intake: (meals.days || []).map((d) => ({
      d: d.d,
      kcal: Math.round(d.calories),
      p: round1(d.protein_g),
      f: round1(d.fat_g),
      c: round1(d.carbs_g),
    })),
    // 直近の講評（対象日より前、日付昇順、各800字まで）。前日と矛盾しない評価・方針を書かせるため
    previous_notes: selectPreviousNotes(coaching?.notes, date),
    // bmr=基礎代謝推定, burn=有酸素消費kcal, volume=筋トレ総ボリューム。総消費= bmr + burn
    exercise: (exercise.days || []).map((d) => ({
      d: d.d,
      bmr: d.bmr == null ? null : Math.round(d.bmr),
      burn: d.calories_burned == null ? null : Math.round(d.calories_burned),
      volume: d.strength_volume == null ? null : Math.round(d.strength_volume),
      cardio: d.cardio_count,
      strength: d.strength_count,
    })),
  };
}

const COMMON_RULES = `
出力ルール:
- 講評本文のみを出力する（前置き・後書き・引用符・コードブロックは書かない）
- プレーンテキストのみ。マークダウン記法（* # \` など）や絵文字は使わない。箇条書きは「・」を使う
- 日本語。数値はデータから引用し概数でよい
- カロリー収支 = 摂取kcal − (bmr + burn)。日常活動・食事誘発熱産生は含まれない前提で断定しすぎない
- goalに数値目標（体重・脂肪量）が設定されていれば、目標との差を講評の評価軸に使う（未設定ならpolicyの方針で評価する）
- metabolismがあれば、実効消費（estimated_tdee_kcal）をモデル値より優先して摂取量の提案に使う。ただし7700kcal/kg換算の参考値なので断定はしない
- データが欠けている日は無理に言及しない`;

/**
 * 毎晩23:30 JSTに当日分を生成し、日次ダイジェスト（23:55）の本文に差し込まれる。
 * ダイジェストには当日の数値まとめ（体重・摂取・消費・カロリー収支・運動内訳）が固定フォーマットで
 * 別途表示されるため、AIが書くのは「総括」だけ（記録数値の再掲はしない）
 */
function buildPrompt(data, date) {
  const dataJson = JSON.stringify(data);
  return `あなたは体組成改善（脂肪を減らし除脂肪体重を維持・増加）を支援するコーチです。
今日（${date}）の総括を書いてください。

前提: 読者には今日の記録数値（体重・摂取kcal・PFC・消費・カロリー収支・運動内訳）が
固定フォーマットで別途表示されている。数値のまとめ直し・網羅的な再掲はせず、
評価と方針だけを書く（判断根拠として数値を1〜2個引用する程度は可）。

構成（全体で2〜4行）:
- 今日の評価: 収支・食事の質・運動内容を、直近7〜14日のトレンドと目標との位置関係を踏まえて講評
- 明日の行動方針: 食事・運動で具体的に1〜2個

連続性: previous_notes は直近の講評（日付昇順）。評価と方針はこれと連続させ、前日と結論が変わる場合は
理由を一言添える。同じ助言の言い回しの繰り返しは避け、継続中の方針は「継続」と明示する。
previous_notes が空なら初回として書く。
${COMMON_RULES}

データ（直近${FETCH_DAYS}日）: ${dataJson}`;
}

async function generate(data, date) {
  const prompt = buildPrompt(data, date);
  let result = null;
  for await (const message of query({
    prompt,
    options: {
      model,
      maxTurns: 1,
      tools: [], // ツール不要の純テキスト生成
      systemPrompt: 'あなたは簡潔で実践的なボディメイクコーチです。指示された書式を厳守してください。',
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
const today = localYmd(Date.now(), tzOffsetHours);
const target = resolveTargetDate(process.env.COACHING_DATE, today);
if (!target.ok) {
  console.error(target.error);
  process.exit(1);
}
const date = target.date;
console.log(`kind=${kind} date=${date} today=${today} model=${model}`);

try {
  const data = await collectData(date, today);
  console.log(
    `data: body=${data.body.length}d intake=${data.intake.length}d exercise=${data.exercise.length}d`,
  );
  const { content, usedModel } = await generate(data, date);
  console.log(`generated: ${content.length} chars (model=${usedModel})`);
  const saved = await save(kind, date, content, usedModel);
  console.log(`saved: id=${saved.id}`);
} catch (err) {
  console.error('coaching job failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
