# 運動記録モデル v2（ハイブリッド運動・サーキット/AMRAP・ボリューム内訳）設計

日付: 2026-08-31（論点確定: 2026-09-01）
ステータス: 承認済み（実装へ）

## 背景

MCP クライアント（ChatGPT）から、Cindy（20分 AMRAP: アシスト懸垂5・腕立て10・スクワット15 を1ラウンド）のようなサーキット/ハイブリッド運動を自然に記録できないというフィードバックを受けた。換算ボリュームを表現するには「600kg×30回」のような実際に行っていない入力が必要になる、という指摘である。

フィードバックは MCP ツールスキーマだけを見た外部視点のため、実装検証を行った。結果:

- **正しい指摘**: weight_kg 上限1000 / strength に duration_min・calories を持てない / rounds・circuit・distance の概念が無い / ボリュームが実荷重と自重換算の合算単一値 / volume_override 相当は全層に存在しない。
- **不正確な前提**: 「重量0でボリューム0」は非自重種目のみの話（自重種目は体重スナップショット×bodyweight_factor でボリュームが立つ）。「体重×factor×reps」は追加重量の加算項を欠く（加重懸垂は表現できる）。アシスト懸垂は bodyweight_factor で比例近似が現行でも可能。
- **設計上重要な発見**: exercise_logs には duration_min / mets / calories 列が既に存在し、strength では書き込み時に NULL 固定しているだけ（ハイブリッド対応の大半にマイグレーション不要）。カテゴリ外フィールドはエラーにならず黙殺される（rounds を送っても無言でデータが失われる）。制約の実体は REST/MCP 共有のアプリ層バリデータで、DB に CHECK は無い。

フィードバックの根本原則「**ユーザーが入力する事実と、システムが算出する評価指標を分離する**」は本設計の第一原理として採用する。

## 決定事項

| 論点 | 決定 | 理由 |
|---|---|---|
| D1: ハイブリッド運動（筋トレ+心肺） | 第3カテゴリは作らない。strength ログで既存の duration_min/mets/calories 列を開放し、menu.mets（strength でも任意設定可に変更）× duration_min × 体重スナップショットが揃うときだけ cardio と同一式で calories をサーバ算出・凍結する。kcal の手動入力は導入しない | 列は migration 0003 で作成済み（マイグレーション0件）。kcal 入力可能化は事実/算出の分離原則に反する。過去 strength ログは calories NULL のままで遡及変化ゼロ |
| D2: サーキット/複合メニュー | 第3カテゴリ・正規化テーブルは作らない。exercise_menus.circuit_json（1ラウンド分の構成 = 既存 strength 種目への参照 + 回数）と exercise_logs.group_id の 2 ALTER のみ。記録時にサーバが「親ログ + 構成種目ごとの通常 strength 子ログ（1ラウンド=1セットで exercise_sets に展開）」へ展開して1バッチで挿入する | 展開結果そのものがスナップショット（circuit_json を後日編集しても過去ログは構造的に不変）。実効重量式の TS/SQL 二重実装に触れず、第3の導出経路も category 分岐の増殖も無い。構成種目の自己ベスト・日次集計が既存機構のまま無料で積み上がる。group_id によりラウンド数・内訳・帰属が全て遡及再計算可能（無損失） |
| D3: rounds | DB 列にしない。log_exercise の入力フィールド rounds（1..50 = MAX_SETS 連動）として受け、1ラウンド=1セットで展開する。表示・応答の rounds は子ログのセット数から復元する | 「15ラウンド×5回」と「15セット×5レップ」は情報として同一。導出可能な値を保存しないのは volume 非保存の既存流儀と同じ |
| D4: volume_override | 導入しない | 導出値の入力化は「volume は DB 非保存の導出値」という不変条件と自己ベストの比較可能性（実効重量ベース・先勝ち・0.001丸め）を汚染し、フィードバック自身の分離原則にも矛盾する。P1 の実需要「Cindy を虚偽なしで記録したい」は D2/D3 が根本原因ごと除去する（3設計案・3審査とも全会一致） |
| D5: アシスト付き自重・係数 | スキーマは何も足さない。bodyweight_factor の運用を「文献調査に基づく推奨係数表」（後述の節）で規律する: 係数の定義を「対応する外部負荷種目の kg 数への等価換算」に固定し、上半身は研究由来・下半身/コアは規約値の2層構造とする。自重種目の登録時は係数の明示を促す（デフォルト1.0 の黙示適用をやめる）。アシスト付き自重は factor ≒ (種目の係数 × 体重 − アシスト kg) / 体重 の比例近似ガイドを MCP describe に明記する。固定 kg 差し引きの需要が実証されたら assist_kg 独立フィールド（NULL=恒等、実効重量 = max(0, weight_kg + 体重×factor − assist_kg)）を導入する（予約設計。負 weight_kg 案は「追加重量」列の意味と自己ベストの weight_kg>0 条件を汚すため不採用） | 換算計算を行うのは会話 AI であってユーザーではない。実効重量式は TS/SQL に二重実装されており、式変更は過去全履歴の表示に波及する最重リスク面。実証需要1件（アシスト懸垂）で今払うリスクではない。係数のデフォルト1.0（全体重）は文献実測（腕立て 0.6 台等）に照らして過大評価であり、案内なしでは是正されないため |
| D6: ボリューム内訳 | volume_type は保存しない。読み取り時に weighted_volume（実荷重分 = Σ reps × COALESCE(weight_kg,0)）を追加算出し、bodyweight_volume = strength_volume − weighted_volume（下限0）を差分導出する。既存の strength_volume の SUM は無改変（合算値が過去とビット同一に保たれ、浮動小数の加算順問題を回避）。ダッシュボードは2色積み上げ bar。Slack・AI コーチング payload は当面合算のまま | セット明細に weight_kg と effective_weight_kg が別々に返るため内訳は過去分も遡及算出できる（保存は式変更時の不整合リスクしか足さない）。サーキット由来の第3内訳は group_id で後から遡及再集計できるため今は作らない |
| D7: サーキットと自己ベスト | サーキット展開の子セットは構成種目の自己ベスト集計から**除外**する（fetchRecordRows に `group_id IS NULL` 条件を追加）。サーキット記録の応答の records_broken は常に `[]`（cardio と同じ扱い）。除外は自己ベストのみで、日次ボリューム集計・グラフにはサーキット分も従来どおり算入する。get_exercise_records の describe に「自己ベストは単独トレーニングのみ対象（サーキット内の実績は含まない）」と明記する | 「自己ベスト = 単独トレの記録」という意味論を守るため。高ボリュームなサーキット（Cindy の懸垂 75 回等）が単独トレの max_reps / volume 系 PR を上書きするのを避ける。実装は WHERE 句 1 条件で済み、外部 AI の誤読は describe の明記で緩和する |
| D8: 黙殺の全面廃止 | 宣言済みフィールドのカテゴリ不一致（cardio×sets / 非 circuit×rounds / circuit×sets 等）は Phase 0 で**全面的に明示エラー化**する。種目登録も同様（cardio×muscle_group/is_bodyweight/bodyweight_factor、is_bodyweight 無しの bodyweight_factor を拒否。既定値と同義の指定は許容）。エラー文は種目名 + 正しい呼び方入り（例: `sets is not allowed for cardio menu "ランニング" — pass duration_min`）。スキーマに無い完全な未知フィールドは MCP の仕組み上ハンドラ到達前に落ちるため対象外 | 「送ったのに無言でデータが消える」ことが、MCP スキーマしか見えない外部 AI の誤解の最大要因のため。既存クライアントの呼び出しを壊す破壊的変更だが、個人利用でクライアントは会話 AI であり、エラー文からの自己修正 1 回で済む。データの無言消失の方が実害が大きい |

## 自重種目の推奨係数（bodyweight_factor の目安表）

2026-08-31 の文献調査（フォースプレート実測・体節係数モデル・1RM 等価研究・既存アプリ慣例の4系統）に基づく。

### 係数の定義

候補は3つある: (a) 支持面にかかる力の実測（% BW）、(b) 移動する体節質量の割合、(c) 対応する外部負荷種目の kg 数への等価換算。**採用は (c)**。バーベル種目が「バー重量のみ」を記録する体系である以上、比較可能性にはこの定義しか整合しないため。上半身プッシュ/プル系では (a) ≒ (c) が成立する（ベンチプレスのバー重量はまさに手が支える外部荷重）ので実測値をそのまま使えるが、下半身は成立しない（後述）。

### 目安表

| 種目 | 係数 | 確度 | 根拠 |
|---|---|---|---|
| 腕立て（標準） | 0.60 | 高（研究由来） | フォースプレート実測5研究が収束: 動的ピーク 0.64±0.04（Ebben 2011）、静的 0.62〜0.75（Suprak 2011 / Gouvali 2005 / Alizadeh 2020）。同負荷ならベンチより反復しやすい分を割り引き下限丸め。腕立ての負荷-速度から予測した 1RM はベンチ実測 1RM と r=0.93 で一致 |
| 膝つき腕立て | 0.45 | 高（研究由来） | 実測 0.49〜0.62（同上）を同幅で下方調整 |
| 足上げ腕立て | 0.65 | 中 | 実測 0.70〜0.74（Ebben 2011） |
| インクライン腕立て（手上げ） | 0.40 | 中 | 実測 0.41〜0.55（Ebben 2011）。台の高さ依存のため下限 |
| 懸垂（順手/逆手） | 0.80 | 中（等価研究由来） | ラットプルダウン 1RM 等価: 男性 0.80×BW（Johnson 2009, r=0.78）。体節モデル上限は 0.955（de Leva 1996）だが等価研究を優先。バーへの瞬間ピーク力は 148〜154% BW（Emerson 2014）で、これは加速成分込みのため係数には使わない |
| ディップス | 0.85 | 低（推定） | 直接測定・等価研究とも不在。移動質量 0.95 に懸垂と同程度の割引を適用した推定 |
| 自重スクワット | 0.40 | 低（**規約値**） | 研究値（移動質量 0.88 / トルク実効 0.77）はバーベル整合性の問題で採用不可。実務慣例と感覚値の間に規約として固定 |
| ランジ / ブルガリアン | 0.50 | 低（**規約値**） | 前脚荷重 84%の実測（Helme 2020）が「スクワットより高め」を裏付け。絶対値は規約 |
| シットアップ | 0.35 | 低（推定） | 移動質量 0.58〜0.60 のトルク割引。直接研究なし |
| クランチ | 0.20 | 低（推定） | 頭+体幹上部 ≈ 0.23 BW（de Leva 1996） |
| レッグレイズ | 0.30 | 低（推定） | 両脚質量 0.32〜0.40 の保守側 |

アシスト付き（マシン懸垂等）: 実効負荷 = 係数 × 体重 − アシスト重量。現行スキーマでは factor ≒ (係数 × 体重 − アシスト kg) / 体重 の比例近似で設定する（例: 懸垂 0.80・体重 70kg・アシスト 20kg → factor ≒ (56−20)/70 ≒ 0.51）。この換算は会話 AI が行い、ユーザーは「アシスト 20kg」とだけ言えばよい。

### スクワット系だけ規約値である理由（構造的非整合）

バーベルスクワットの挙上者は自分の体重の約88%も一緒に動かしているのに、記録はバー重量のみ。ここで自重スクワットに移動質量ベースの 0.88 を与えると「自重スクワット1回（体重83kgなら 73kg 換算）> 60kg バーベルスクワット1回」という逆転が起きる。厳密に整合させると係数 0 になり自重トレの記録が無意味になるため、どの値も規約でしかない。比較可能性を優先して 0.40 に固定し、規約値であることを本表と MCP describe に明記する。

### 運用原則

- **一度決めたら変えない**。下半身・コアの絶対値は研究で正当化できない規約値であり、価値の源泉は一貫性にある。ログはスナップショット凍結のため過去記録は不変だが、係数変更時点でグラフ系列の意味が切り替わる。既存メニューの係数是正は本設計の適用時に一度だけ行う。
- **登録時に係数の明示を促す**。MCP の create_exercise_menu describe に「自重種目は本目安表から係数を指定する」と明記し、ダッシュボード UI は係数欄の空欄時に目安表を提示する。デフォルト 1.0 の黙示適用をやめる（既存種目は変更しない）。
- 等尺性種目（プランク等）は回数×係数モデルに馴染まないため本表の対象外。時間の記録は Phase 1 の duration_min で可能。

主な出典: Ebben et al. 2011 (J Strength Cond Res 25(10)) / Suprak et al. 2011 (JSCR 25(2)) / Gouvali & Boudolos 2005 (JSCR 19(1)) / Alizadeh et al. 2020 (J Sports Sci Med) / Johnson et al. 2009 (JSCR 23(3)) / Emerson et al. 2014 (ISBS) / de Leva 1996 (J Biomech 29(9)) / Cormie et al. 2007 (JSCR 21(4)) / Helme et al. 2020。

## データモデル

migration 0009（Phase 2 で追加。Phase 1 はマイグレーション0件）:

```sql
-- サーキット/複合メニュー: 1ラウンド分の構成（既存 strength 種目への参照 + ラウンドあたり回数）。
-- NULL = 通常種目。記録時にサーバが構成種目の通常ログ + セットへ展開して凍結するため、
-- この定義を後から編集しても過去ログは一切変わらない（スナップショット不変性は展開結果が担う）。
ALTER TABLE exercise_menus ADD COLUMN circuit_json TEXT; -- '[{"menu_id":"…","reps":5},…]'

-- 同一実施を束ねるグループ（親ログの id）。NULL = 単独記録。
ALTER TABLE exercise_logs ADD COLUMN group_id TEXT;

CREATE INDEX idx_exercise_logs_group ON exercise_logs (group_id);
```

### サーキットの展開（書き込み時）

`circuit_json` を持つメニューへの log_exercise は、1バッチで以下を挿入する:

- **親ログ**: category='strength'、menu_id/menu_name = サーキットメニュー自身、duration_min / mets（menu 由来）/ calories（算出値）/ note を担う。group_id = 自身の id。sets は持たない。is_bodyweight=0 / bodyweight_factor=1 で凍結（親自身はボリュームに寄与しない）。
- **子ログ**（構成種目ごとに1件）: 通常の strength ログとして、構成種目の menu_name / is_bodyweight / bodyweight_factor / body_weight_kg を従来経路で凍結。group_id = 親の id。exercise_sets に rounds 個のセット（各 reps = 構成の reps、weight_kg = NULL）を展開。
- ステートメント数上限: 1 + items(≤10) + items×rounds(≤500) ≒ 511。D1 の batch 上限は実装時に実機確認する（超過時は 400 エラーで原子性を守る）。

削除は親 id 指定で group_id 一致の全ログ+セットを一括削除（既存どおり CASCADE 非依存の明示削除）。子ログの個別削除も技術的には可能だが、MCP describe で親 id 削除を案内する。

## API / MCP の変更

### Phase 0（スキーマ衛生。他フェーズと独立に出荷可）

- MCP zod スキーマに実上限を反映: duration_min `.max(1440)`、reps `.max(1000)`、weight_kg `.max(1000)`、sets `.max(50)`、mets `.max(30)`。現状は上限がエラーメッセージ経由でしか見えない。
- describe 全面見直し: 実効重量の式、「自重種目は体重が自動算入される」「換算ボリュームはサーバが算出する。クライアント側で計算・入力しない」、bodyweight_factor の推奨係数表（要約版）とアシスト近似ガイド（D5）を明記。
- 黙殺の全面廃止（D8 で決定）: 宣言済みフィールドのカテゴリ不一致をすべて明示エラー化する。エラー文は種目名 + 正しい呼び方入り（例: `sets is not allowed for cardio menu "ランニング" — pass duration_min`）。

### Phase 1（ハイブリッド開放 = フィードバック P2）

- parseExerciseMenuInput / Patch: strength でも mets を任意許可（0 < mets ≤ 30。現状は NULL に落としている）。
- logExercise strength 分岐: input.duration_min を保存（現状 NULL 固定）。menu.mets ≠ NULL かつ duration_min があるとき estimateCalories(mets, 体重, duration_min) を算出して凍結（体重が無ければ cardio と同文言のエラー）。mets 無しなら時間のみ保存し calories は NULL。
- getDailyExercise: calories_burned を `SUM(CASE WHEN category='cardio' …)` から「calories IS NOT NULL の全ログ合計」へ変更。calories を持つログがある日は cardio_count=0 でも非 NULL。
- Slack ダイジェスト: 筋トレ側に kcal があれば「筋トレ N件 (Vol X, Y kcal)」。
- OpenAPI / types: calories_burned の説明を「運動全体の消費 kcal 合計」に更新。
- AI コーチング: 生成プロンプト（coaching/generate.mjs）に「Phase 1 導入日以降は筋トレの消費 kcal も burn に含まれる。それ以前との burn 比較は割り引くこと」の注記を 1 文追加（2026-09-01 決定。過去の筋トレログは mets/duration とも NULL のため遡及は起きず、段差は新記録からの漸進。数値側の歪みは 28 日窓の通過で自然解消するため payload 契約は変更しない）。

### Phase 2（circuit + rounds = フィードバック P1/P3/P4）

- create_exercise_menu / update_exercise_menu に `circuit`: 構成配列（menu_id または menu_name で既存 strength 種目を参照、reps 1..1000、1..10 件）。category は strength のみ。参照先は作成/更新時に存在・strength・**自重（is_bodyweight）**・非 archived・非入れ子を検証し、記録時にも再検証する（2026-09-01 レビュー反映: 非自重種目は展開セットが weight_kg NULL で入りボリュームが黙って 0 になるため拒否。被参照種目への circuit 付与も逆方向の入れ子として拒否）。
- log_exercise に `rounds`: int 1..50。circuit メニュー → rounds 必須・sets 禁止（明示エラー）。非 circuit メニューへの rounds は明示エラー（例: `rounds is only valid for circuit menus — "ベンチプレス" is strength, pass sets: [{reps, weight_kg?}]`）。
- 構成種目にアーカイブ済みが含まれるサーキットの記録は 400 エラー（2026-09-01 決定。「アーカイブ = 記録不可」の意味論を全層で一貫させる）。エラー文に該当種目名を示し、unarchive か構成変更を案内する。
- 応答に導出節を追加: rounds（事実）と per_movement（種目別 総レップ・実効重量・ボリューム）・total_reps・total_volume・calories（導出値）をフィールドレベルで分離して返す。records_broken は常に `[]`（D7: 子セットは自己ベスト対象外のため。fetchRecordRows に `group_id IS NULL` を追加し、get_exercise_records の describe に単独トレ限定を明記）。
- get_exercise_logs 応答に group_id を含め、親ログには rounds（子セット数からの復元値）を付す。
- getDailyExercise の strength_count を `COUNT(DISTINCT COALESCE(group_id, id))` に変更（1サーキット=1件）。

### Phase 3（ボリューム内訳 = フィードバック P8）

- getDailyExercise に weighted_volume の SUM を追加（既存 strength_volume の SUM は無改変）。bodyweight_volume は TS 側で差分導出（下限0）。
- DailyExercise 型に weighted_volume / bodyweight_volume (number | null) を追加。REST /api/exercise/daily に自然露出。
- ダッシュボードの筋トレボリューム bar を2色積み上げに変更（合計値は従来と同一なのでチャートの連続性は保たれる）。

## ダッシュボード UI

手動記録はダッシュボードが MCP と対等の入力経路であり、サーバ側は同一のバリデータ・書き込み処理を通る（変更不要）。UI 側はフォームと表示の追随が必要で、これが無いと手動ユーザーは新機能に触れられない。現行 UI は種目の category でフィールドを出し分ける構造（cardio = 時間、strength = セット行。`exercise.js` の syncRecordFields / syncMenuFormFields）を持ち、これを拡張する。

### Phase 1（ハイブリッド開放）

- 記録フォーム: strength 種目選択時に任意の「時間（分）」欄を追加（現状は cardio 専用の #exercise-duration のみ）。種目に METs があれば cardio と同じ kcal プレビューを表示する。
- 種目登録フォーム: METs 欄を strength でも表示する（現状 syncMenuFormFields が cardio のみ表示）。任意であることをプレースホルダで示す。
- 履歴テーブル: 筋トレ行の kcal 列に値を表示（現状は「—」固定）。日付ヘッダの「消費 N kcal」は集計変更（calories IS NOT NULL 合計）に自動追随する。
- 係数欄: 空欄時に推奨係数の目安表を提示し、既存の title ヒント文言（懸垂1.0 / 腕立て0.65 / コア系0.1〜0.4）を本設計の推奨表（懸垂0.8 / 腕立て0.6 / スクワット0.4 等）に更新する。

### Phase 2（circuit + rounds）

- 種目登録フォーム: サーキット構成エディタを追加。既存の種目ピッカーを流用した「構成種目 + ラウンドあたり回数」の行（1..10 行、＋ボタンで追加）。構成種目は strength のみ選択可。
- 記録フォーム: circuit 種目選択時はセット行の代わりに「ラウンド数」+「時間（分）」を表示する（syncRecordFields に第3の出し分けを追加）。
- 履歴テーブル: **group_id での畳み込み表示**。1回のサーキットは内部的に親1 + 子N のログになるため、そのまま描くと1回の Cindy が4行に散らばる。group_id を持つログ群は1行「Cindy 15R / 20分 / Vol 26,512 / 196kcal」に畳み、行の展開で子明細（種目別レップ）を表示する。削除ボタンは親 id の DELETE（グループ全体削除）。これが「sets を持たない strength 親ログが既存表示を壊さないか」という出荷ゲートの UI 側の解でもある（畳み込みにより親ログ単体が素で描画される経路を無くす）。
- 種目管理一覧: menuMeta にサーキットバッジ（「サーキット · 3種目」）を追加。

### Phase 3（ボリューム内訳）

「API / MCP の変更」の Phase 3 に記載のとおり（筋トレボリューム bar の2色積み上げ化）。凡例に「実重量」「自重換算」のラベルを付ける。

## Cindy のウォークスルー（Phase 2 出荷後）

前提: 実測体重 70.0kg。構成種目は一度だけ登録（アシスト懸垂 is_bodyweight=1, factor=0.75 ≒ (70−17.5)/70、腕立て factor=0.65、スクワット factor=1.0）。次に `create_exercise_menu { name:"Cindy", category:"strength", mets:8, circuit:[{menu_name:"アシスト懸垂",reps:5},{menu_name:"腕立て伏せ",reps:10},{menu_name:"スクワット",reps:15}] }`。

日々の記録はユーザーの発話「Cindy 15ラウンド、20分」→ AI が `log_exercise { menu_name:"Cindy", rounds:15, duration_min:20 }` を1回呼ぶだけ。サーバが親ログ（20分・196kcal 凍結）+ 子ログ3件（各15セット展開）を挿入し、応答で 15ラウンド / 20分 / 種目別レップ 75・150・225 / 総レップ450 / 換算ボリューム（システム算出）を返す。ユーザーは換算値もセット明細も一切入力しない。構成種目の自己ベストには影響しない（D7。records_broken は空）。

## テスト方針

- Phase 1: 「calories NULL 時代の既存 strength ログが集計 0 のまま」を固定する回帰テスト（デグレ防止の要）。mets 付き strength 記録の kcal 凍結・体重欠如エラー・mets 無し時の時間のみ保存。
- Phase 2: 展開の原子性（batch 失敗時に親子とも入らない）、rounds×circuit の相互必須/禁止エラー、circuit_json 編集後の過去ログ不変、親 id 削除での全消し、サーキット記録が構成種目の自己ベストに影響しないこと（D7: 記録前後で get_exercise_records が不変・records_broken が空）、strength_count の畳み込み。
- Phase 3: TS/SQL クロスチェック（同一ログ集合を両実装で計算して weighted+bodyweight = strength_volume が一致）、weight_kg NULL / 0 / 加重自重混在の境界。
- UI: 新フォーム要素（strength の時間欄・ラウンド数欄・構成エディタ）の存在確認を test/dashboard-root.test.ts の流儀で追加。畳み込み表示のロジックはクライアント JS のため手動確認を基本とし、親子ログを含む API 応答の形はサーバ側テストで固定する。
- 日付 seed は既存規約どおり固定時刻 `${ymd}T03:00:00Z`。

## やらないこと

- **volume_override**: 上記 D4。MCP describe に「換算ボリュームは算出値で直接指定不可」と明記して期待値を揃える。
- **load_calculation_mode（5モード enum）**: 既存プリミティブで全被覆できるため。full_body_weight = factor 1.0 / bodyweight_factor = 既存 / fixed_effective_load = is_bodyweight:0 + weight_kg / bodyweight_minus_assist = 将来の assist_kg / manual = D4 で拒否。
- **第3カテゴリ（circuit / hybrid）**: category はログにスナップショット凍結され全消費側の分岐に波及する。一度出荷したら外せない永続コミットであり、展開方式で不要。
- **rounds / circuit 構成のログ列保存**: 展開結果（セット明細 + group_id）から無損失で導出可能。
- **distance・実測 kcal 入力**: 今回のスコープ外。実測 kcal は「実測された事実」なので、将来 measured_calories として METs 推定と区別して受ける案をメモとして残す。
- **50ラウンド超の AMRAP・端数ラウンド**（15ラウンド+7レップ等）: rounds 上限は MAX_SETS=50 に連動。端数は構成種目への通常 sets 追記か note で退避（→未解決の論点 4）。
- **既存の近似記録（bodyweight_factor<1 の単一種目サーキット）の移行**: 当時の事実のまま残す（スナップショット不変性と整合。PATCH 無し・削除→再記録のみの現行方針とも整合）。
- **サーキット構成への種目別外部荷重（per-item weight_kg）**: 構成は自重種目のみ許可。ケトルベル等の外部荷重種目は展開モデルで表現できない（weight_kg NULL で展開されボリュームが黙って 0 になる）ため明示エラーで拒否し、単独の sets 記録へ誘導する。実需要が出たら構成項目への weight_kg 追加を検討する。

## 論点の決定記録と残課題

当初「未解決の論点」として挙げた 5 件は 2026-09-01 にすべて決定した:

1. サーキット子セットの自己ベスト算入 → **除外する**（D7 に昇格）
2. 黙殺のエラー化範囲 → **全面エラー化**（D8 に昇格）
3. アーカイブ済み構成種目を含むサーキットの記録 → **拒否**（Phase 2 仕様に記載）
4. rounds 上限 → **50 のまま**（MAX_SETS 連動。50 超の実需要が出たら定数変更 + D1 batch 上限の実機確認で引き上げ）
5. burn 段差の扱い → **コーチングプロンプトへの注記 1 文**（Phase 1 仕様に記載）

残課題（決定不要・実装時/将来の注意事項）:

- **推奨係数の証拠の弱い箇所**: ディップス 0.85 は直接研究不在の推定、下半身・コア（0.20〜0.50）は査読研究で正当化できない規約値。Johnson 2009（懸垂等価 0.75〜0.80）は有料原文のため抄録由来の数値。より良い一次研究が見つかれば見直すが、運用原則（一度決めたら変えない）に従い、変更は既存記録の系列断絶と引き換えであることを認識して行う。
- **D1 batch のステートメント上限**（最大約 511 文）は Phase 2 実装時に実機確認する。
- **sets を持たない strength 親ログ**の既存コンシューマ全数監査は Phase 2 の出荷ゲート（UI 側は履歴の畳み込み表示が解）。
