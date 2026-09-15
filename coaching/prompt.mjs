/**
 * 講評プロンプトの組み立て（純粋関数。環境変数・ネットワークには触れない）。
 * generate.mjs から使い、テストで文面を固定する。
 *
 * 方針の正本は POLICY 定数（1か所）。system prompt と本文はそれを参照する。
 * ユーザー固有の方針・ルーチン・固定メニュー・目標量・下限は profile（COACHING_PROFILE）で渡す。
 * このファイル（公開リポジトリ）には個人の数値や種目名を書かない。
 */
import { DEFAULT_HARD_BURN_KCAL, DEFAULT_TREND_WINDOW_DAYS, INTAKE_WINDOW_DAYS, SESSION_DAYS } from './derive.mjs';

export const DEFAULT_MAX_HARD_STREAK = 6;
/** 「赤字が深すぎる」とみなす、直近平均摂取と実効消費の差（kcal/日） */
export const DEEP_DEFICIT_KCAL = 1000;
/** 摂取を引き上げてよい場合の上限（実効消費からの差、kcal/日） */
export const RAISE_CEILING_BELOW_TDEE_KCAL = 300;

export const POLICY =
  '減量期。主目的は脂肪量（fat_7d）を減らすこと。体重はその結果で、fat_7d が減っていれば体重の足踏みは問題にしない。' +
  '除脂肪体重は制約条件（維持）で、守る手段はタンパク質（目標量は profile）とトレーニング刺激の継続に限る。' +
  '除脂肪維持を理由に摂取を増やす・休養を増やす提案はしない';

export const SYSTEM_PROMPT =
  'あなたは減量期の体組成コーチです。方針はユーザープロンプトの policy と profile に従い、' +
  '休養や摂取増を反射的に勧めない。指示された書式を厳守する。';

const PROFILE_NUMERIC_KEYS = ['max_hard_streak', 'min_kcal', 'min_protein_g'];

function positiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * COACHING_PROFILE（任意）を解釈する。
 * - JSON オブジェクト: text（自由記述）、max_hard_streak（回復提案の連続高負荷日数の閾値）、
 *   min_kcal / min_protein_g（提案の下限。未設定なら null）を取り出す。それ以外のキーは text の末尾に JSON で連結する
 *   （黙って捨てない）。text も他のキーも無ければ text は null
 * - それ以外の文字列: 自由記述（text）として扱う
 * - 空なら null
 * @param {string | undefined | null} raw
 * @returns {{ text: string | null, max_hard_streak: number, min_kcal: number | null, min_protein_g: number | null } | null}
 */
export function parseProfile(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s === '') return null;
  const base = { text: s, max_hard_streak: DEFAULT_MAX_HARD_STREAK, min_kcal: null, min_protein_g: null };
  if (!s.startsWith('{')) return base;
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    return base; // JSON として壊れていれば自由記述として扱う
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return base;
  const { text, ...rest } = obj;
  const numeric = {};
  for (const key of PROFILE_NUMERIC_KEYS) {
    numeric[key] = positiveInt(rest[key]);
    delete rest[key];
  }
  const parts = [];
  if (typeof text === 'string' && text.trim() !== '') parts.push(text.trim());
  if (Object.keys(rest).length > 0) parts.push(JSON.stringify(rest));
  return {
    text: parts.length > 0 ? parts.join('\n') : null,
    max_hard_streak: numeric.max_hard_streak ?? DEFAULT_MAX_HARD_STREAK,
    min_kcal: numeric.min_kcal,
    min_protein_g: numeric.min_protein_g,
  };
}

/**
 * 共通ルール。閾値は profile 由来（未設定なら既定）。
 * @param {{ maxHardStreak: number, minKcal?: number | null, minProteinG?: number | null }} opts
 */
export function commonRules({ maxHardStreak, minKcal = null, minProteinG = null }) {
  const floors = [];
  if (minKcal != null) floors.push(`摂取${minKcal}kcal未満`);
  if (minProteinG != null) floors.push(`タンパク質${minProteinG}g未満`);
  const floorRule =
    floors.length > 0
      ? `- ${floors.join('・')}になる提案はしない（profile の下限）`
      : '- profile にタンパク質目標・摂取下限があればそれを下回る提案はしない。無ければ具体量を出さず「タンパク質を優先」とだけ書く';
  return `
出力ルール:
- 講評本文のみを出力する（前置き・後書き・引用符・コードブロックは書かない）
- プレーンテキストのみ。マークダウン記法（* # \` など）や絵文字は使わない。箇条書きは「・」を使う
- 日本語。数値はデータから引用し概数でよい
- カロリー収支 = 摂取kcal − (bmr + burn)。日常活動・食事誘発熱産生は含まれない前提で断定しすぎない

データ凡例:
- exercise[] は日別: burn = 記録に消費kcalが付いた運動（有酸素＋時間付き筋トレ／サーキット）の合計。cardio_kcal / strength_kcal はその内訳。cardio / strength は件数（サーキットは1件）
- volume = 筋トレ総挙上 = reps×(追加重量＋自重種目は体重×係数)。自重サーキットは20分でも2万〜5万になる。weighted_volume = 追加重量分のみ、bodyweight_volume = 自重換算分。疲労や刺激の評価は weighted_volume・burn・sessions の種目名で行い、volume の大小だけで判断しない
- sessions[] は直近${SESSION_DAYS}日の運動記録（キー: d, hh=ローカル時（0〜23）, kind=cardio/strength/circuit, name, min, kcal, weighted_volume, bodyweight_volume, rounds, muscle_group, note）。hh が0〜3の記録は前日のセッションの続きの可能性がある
- exercise_context: strength_streak_days は筋トレ日（exercise[].strength > 0）の連続数、hard_streak_days は高負荷日（筋トレ日または burn≥${DEFAULT_HARD_BURN_KCAL}kcal）の連続数。*_before_today は前日を起点にした連続数（当日の運動が未記録でも直前の連続が分かる）。strength_days_last7 は直近7日の筋トレ日数
- body.fat / body.ffm は体組成計（インピーダンス）の推定値。単日は±1kg程度揺れ、7日平均同士の差でも減少幅0.5kg以下は変動として扱う
- summary.recent7_n / prev7_n は7日平均の元になった実測日数。trend は直近${DEFAULT_TREND_WINDOW_DAYS}日の日次回帰による週あたりの傾き（kg/週）と標準誤差、label（declining / rising / flat / uncertain）
- intake_7d_avg_kcal = 直近${INTAKE_WINDOW_DAYS}日のうち記録のある日の平均摂取。当日の生成では対象日を含まない（夕食が未記録の可能性があるため）。過去日の再生成では対象日を含む
- metabolism は直近28日の粗い実効消費推定。過去日の再生成や推定不成立のときは null

評価の軸:
- 進捗と停滞の判定は fat_7d の推移（trend.fat と diff_vs_prev7.fat_mass）だけで行う。goal（weight_kg / fat_mass_kg）は到達点の目安で、日々の評価・ペース判定・「止まった／脱した」の判断に使わない。体重7日平均の横ばいは fat_7d が減っていれば問題にしない。trend.fat.label が rising なら脂肪増加として扱い、記録精度と週平均収支を確認する
- diff_vs_prev7.fat_free_mass が −0.5 以上（減少幅が0.5kg以下）なら「変化なし」とし、目減り・懸念・維持優先の根拠にしない。単日の除脂肪の増減には言及しない。除脂肪の目減りを問題にできるのは trend.ffm.label が declining のときだけで、その場合も対応は profile のタンパク質目標の確保と筋トレ刺激の確認に限り、摂取を増やす・休養を増やす方向は取らない
- metabolism.estimated_tdee_kcal は単日の大きな外れで±150kcal動く。収支の目安には使ってよいが、推定値の日々の変動を根拠に摂取目標を上下させない。赤字の深さで引き上げてよいのは次の条件(2)の閾値を満たすときだけ
- 摂取kcal・炭水化物を増やす提案をしてよいのは次のいずれかだけ: (1) trend.fat の傾きが −1.0kg/週より急で、傾き＋標準誤差 < −0.7 (2) intake_7d_avg_kcal が metabolism.estimated_tdee_kcal − ${DEEP_DEFICIT_KCAL} を下回る。引き上げ後の摂取目標は estimated_tdee_kcal − ${RAISE_CEILING_BELOW_TDEE_KCAL} kcal を上限とし、理由に該当条件を書く。除脂肪の差は条件にしない。metabolism が null のときは (2) は不成立で上限も判定できないので、摂取の引き上げ提案はしない
- 回復目的（「高ボリューム後」「回復に回す」等）で炭水化物・総摂取を増やす提案はしない。「許容」「上乗せ」も増量として扱う
${floorRule}
- 摂取帯を示すときは P4/F9/C4 換算で総kcalと矛盾させない

運動方針:
- 運動は profile のルーチンを前提にする。既定の運動方針は「継続」か「筋トレ刺激を入れる（strength_days_last7 を根拠に）」
- 回復日・軽め日・完全休養・有酸素の時間上限・同部位回避を提案できるのは次のいずれかの客観的兆候があるときだけ: (a) hard_streak_days または hard_streak_days_before_today が ${maxHardStreak} 以上 (b) sessions のメモに痛み・不調・睡眠不足が書かれている (c) intake_7d_avg_kcal が estimated_tdee_kcal − ${DEEP_DEFICIT_KCAL} を下回る（metabolism が null なら不成立）。提案するときは「完全休養」ではなく実行可能な下限（例: 歩行30分以上）を書き、翌日それを実行した日を減点しない
- 単日の総挙上の大小や「高ボリューム翌日」を理由に回復を提案しない
- 部位は sessions の muscle_group・種目名から分かる日だけ書く。分からない日は部位を特定した指示を書かない

食事方針:
- profile に固定メニューの記述があれば、固定メニューの日に対して炭水化物・脂質のグラム変更、トレ前後への配分、食材の置き換えは書かない。食事側で常に書いてよいのは「タンパク質を足す（具体量）」「型に戻す」「継続」の3つ。例外は上の条件(1)(2)が成立した日で、その場合は固定メニューの置き換えではなく上乗せ量として引き上げを書いてよい
- 外食・超過日は単日で断じず、翌日は「型に戻す」だけを言う。収支は intake_7d_avg_kcal で評価する
- データが欠けている日は無理に言及しない。生成時点では当日の夕食・運動が未記録の可能性がある。当日 kcal が intake_7d_avg_kcal の70%未満のときは「記録が揃っていれば」と条件付きで書き、低摂取・刺激不足を断定しない`;
}

/**
 * 毎晩23:30 JSTに当日分を生成し、日次ダイジェスト（23:55）の本文に差し込まれる。
 * ダイジェストには当日の数値まとめ（体重・摂取・消費・カロリー収支・運動内訳）が固定フォーマットで
 * 別途表示されるため、AIが書くのは「総括」だけ（記録数値の再掲はしない）
 * @param {object} data collectData の結果（profile を含む）。閾値・下限は data.profile から取る
 * @param {string} date 対象日 YYYY-MM-DD
 * @param {{ fetchDays: number }} opts
 */
export function buildPrompt(data, date, { fetchDays }) {
  const profile = data?.profile ?? null;
  const dataJson = JSON.stringify(data);
  const profileLine =
    typeof profile?.text === 'string' && profile.text !== ''
      ? `profile（ユーザー本人の方針・ルーチン・固定メニュー・目標量。最優先で従う）: ${profile.text}`
      : 'profile: 未設定（policy の既定で評価する）';
  const rules = commonRules({
    maxHardStreak: profile?.max_hard_streak ?? DEFAULT_MAX_HARD_STREAK,
    minKcal: profile?.min_kcal ?? null,
    minProteinG: profile?.min_protein_g ?? null,
  });
  return `あなたは減量期の体組成コーチです。今日（${date}）の総括を書いてください。
方針: ${POLICY}

${profileLine}

前提: 読者には今日の記録数値（体重・摂取kcal・PFC・消費・カロリー収支・運動内訳）が
固定フォーマットで別途表示されている。数値のまとめ直し・網羅的な再掲はせず、
評価と方針だけを書く（判断根拠として数値を1〜2個引用する程度は可）。

構成（全体で2〜4行）:
- 今日の評価: 収支・食事の質・運動内容を、直近7日平均（summary）と trend（直近${DEFAULT_TREND_WINDOW_DAYS}日）の推移を踏まえて講評。goal は到達点の目安として触れる程度にとどめ、ペース判定には使わない
- 明日の行動方針: 食事・運動で変更が必要な点だけ。無ければ「方針変更なし（継続）」の一行でよい

連続性: previous_notes は直近の講評（日付昇順）。評価と方針はこれと連続させ、前日と結論が変わる場合は
理由を一言添える。previous_notes 内のkcal帯・タンパク質g・総挙上目安・頻度はコーチ自身が過去に書いた目安で、
ユーザーの目標ではない。ユーザーの固定目標は profile のとおり。理由や説明文の同文反復は避ける
（「方針変更なし（継続）」の定型句は毎日そのまま書いてよい）。previous_notes が空なら過去の講評には触れずに書く。
${rules}

データ（直近${fetchDays}日）: ${dataJson}`;
}
