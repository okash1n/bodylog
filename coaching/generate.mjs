/**
 * AIコーチング講評の生成ジョブ。GitHub Actions のスケジュール実行から呼ばれる。
 *
 * 1. bodylog 公開APIから直近データを取得
 * 2. Claude Agent SDK（CLAUDE_CODE_OAUTH_TOKEN = サブスク認証）で講評テキストを生成
 * 3. POST /api/coaching（Bearer: COACHING_API_SECRET）で保存 → WorkerがSlack配信・表示
 *
 * 環境変数:
 *   BODYLOG_BASE_URL        必須。例 https://weight.example.com（末尾スラッシュ不要）
 *   COACHING_API_SECRET     必須。POST /api/coaching のBearerトークン
 *   CLAUDE_CODE_OAUTH_TOKEN 必須（SDKが参照）。`claude setup-token` で発行
 *   COACHING_MODEL          任意。既定 'opus'（Claude Codeの既定Opusに追従する別名）
 *   COACHING_TZ_OFFSET_HOURS 任意。既定 9（JST）
 *   KIND                    任意。'daily' | 'weekly' | ''/'auto'（自動判定）
 *
 * 注意: パブリックリポのActionsログは公開されるため、講評本文や取得データはログに出さない。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

const FETCH_DAYS = 15; // 前日分＋14日トレンドを賄う取得幅

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

/** ローカル日付 YYYY-MM-DD（UTC+offset） */
function localYmd(daysAgo = 0) {
  const t = Date.now() + tzOffsetHours * 3_600_000 - daysAgo * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** ローカル曜日（0=日 ... 1=月） */
function localWeekday() {
  return new Date(Date.now() + tzOffsetHours * 3_600_000).getUTCDay();
}

function resolveKind() {
  const argIdx = process.argv.indexOf('--kind');
  const raw = (argIdx >= 0 ? process.argv[argIdx + 1] : process.env.KIND) || 'auto';
  if (raw === 'daily' || raw === 'weekly') return raw;
  if (raw === 'auto' || raw === '') return localWeekday() === 1 ? 'weekly' : 'daily';
  console.error(`invalid kind: ${raw} (daily | weekly | auto)`);
  process.exit(1);
}

async function getJson(path) {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

/** 数値をトークン節約のため丸める（null維持） */
function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}

async function collectData() {
  const [summary, measurements, meals, exercise, metabolism] = await Promise.all([
    getJson('/api/summary'),
    getJson(`/api/measurements?days=${FETCH_DAYS}`),
    getJson(`/api/meals/daily?days=${FETCH_DAYS}`),
    getJson(`/api/exercise/daily?days=${FETCH_DAYS}`),
    // 実効代謝は補助情報。取得失敗しても講評生成は続ける
    getJson('/api/metabolism').catch(() => null),
  ]);
  return {
    policy: '体組成改善（脂肪量を減らし、除脂肪体重を維持・増加させる）',
    // 数値目標（kg）。未設定の指標はnull。設定されていれば講評の評価軸に使う
    goal: summary.goal ?? { weight_kg: null, fat_mass_kg: null },
    // 直近28日の実測からの実効消費推定。status==='ok'のときだけ使う
    metabolism: metabolism && metabolism.status === 'ok' ? metabolism : null,
    units: { mass: 'kg', energy: 'kcal', pfc: 'g' },
    summary: {
      recent7_avg: summary.recent7_avg,
      diff_vs_prev7: summary.diff_vs_prev7,
      baseline: summary.baseline,
    },
    // d=日付, weight=体重, fat=脂肪量, ffm=除脂肪体重（*_7dは7日移動平均）
    body: (measurements.days || []).map((d) => ({
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
- ネット収支 = 摂取kcal − (bmr + burn)。日常活動・食事誘発熱産生は含まれない前提で断定しすぎない
- goalに数値目標（体重・脂肪量）が設定されていれば、目標との差を講評の評価軸に使う（未設定ならpolicyの方針で評価する）
- metabolismがあれば、実効消費（estimated_tdee_kcal）をモデル値より優先して摂取量の提案に使う。ただし7700kcal/kg換算の参考値なので断定はしない
- データが欠けている日は無理に言及しない`;

function buildPrompt(kind, data) {
  const dataJson = JSON.stringify(data);
  if (kind === 'daily') {
    return `あなたは体組成改善（脂肪を減らし除脂肪体重を維持・増加）を支援するコーチです。
昨日（${localYmd(1)}）の記録を中心に、直近トレンドも踏まえて日次講評を書いてください。

構成（合計1〜3行、簡潔に）:
- 昨日の食事（カロリー収支・PFCバランス）と運動の講評
- 今日の具体的な一手（食事または運動の提案）
${COMMON_RULES}

データ（直近${FETCH_DAYS}日）: ${dataJson}`;
  }
  return `あなたは体組成改善（脂肪を減らし除脂肪体重を維持・増加）を支援するコーチです。
直近14日のデータを分析し、週次の総括を書いてください。

構成（全体で3〜8行）:
- 体組成トレンド（体重・脂肪量・除脂肪体重の7日平均の動き）の評価
- 摂取と消費のバランス、PFC傾向の評価
- 運動（有酸素・筋トレ）の量・頻度の評価
- 来週に向けた具体的な提案（1〜2個）
${COMMON_RULES}

データ（直近${FETCH_DAYS}日）: ${dataJson}`;
}

async function generate(kind, data) {
  const prompt = buildPrompt(kind, data);
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

const kind = resolveKind();
const date = localYmd(0);
console.log(`kind=${kind} date=${date} model=${model}`);

try {
  const data = await collectData();
  console.log(
    `data: body=${data.body.length}d intake=${data.intake.length}d exercise=${data.exercise.length}d`,
  );
  const { content, usedModel } = await generate(kind, data);
  console.log(`generated: ${content.length} chars (model=${usedModel})`);
  const saved = await save(kind, date, content, usedModel);
  console.log(`saved: id=${saved.id} queued=${saved.queued}`);
} catch (err) {
  console.error('coaching job failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
