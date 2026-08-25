# 筋トレ種目の自己ベスト（exercise records）設計

日付: 2026-08-26
ステータス: 承認済み（実装へ）

## 目的

トレーニング中に ChatGPT / Claude から「ベンチプレスの今までの最大は？」「5 回だと何 kg まで挙げた？」「前回何をやった？」に **1 回のツール呼び出しで**答えられるようにする。現状は `get_exercise_logs` で全記録を渡して推論に任せるしかなく、毎回トークンを浪費する。

## 決定事項（設計時の Q&A の結論）

| 論点 | 決定 | 理由 |
|---|---|---|
| 持ち方 | **都度集計**（新テーブル・新列・ビューなし） | 記録の削除・過去日付の追記でも常に正しい。マイグレーション・バックフィル不要。個人 1 人分（年 600 セット程度）なら集計は数 ms |
| 最大重量 | REP 数問わずの最大 ＋ **REP 数ごとの最大（レップマックス表）** ＋ **推定 1RM（Epley）** | 「N 回なら何 kg」に即答できる。1RM は実測が無くても比較できる目安 |
| 最大ボリューム | **セット単位（reps×実効重量）とセッション単位（1 log の総ボリューム）の両方** | セット単位は依頼どおり、セッション総量は既存 `total_volume` と同じ定義で漸進性過負荷の目安 |
| MCP の形 | 新ツール **`get_exercise_records`** | 質問 1 つ＝呼び出し 1 回。既存の検索ツールを肥大化させない |
| 付随機能 | `log_exercise` の応答に**自己ベスト更新フラグ**、`get_exercise_records` に**前回セッション**、**REST** `GET /api/exercise/records` | いずれも小さく、トレーニング中の用途に直結。REST は MCP 読み取りに必ず REST 対応を置くリポジトリの慣例 |

トークン節約は「ツールが最大値だけを返す」ことで得られ、DB に保持するかどうかとは独立である（この点を確認した上で都度集計を選んだ）。

## 集計の定義

### 入力

1 種目の全セットを 1 クエリで取る（`exercise_logs ⋈ exercise_sets`、`menu_id` で絞り、`category='strength'`、`performed_at, set_index` 昇順）。行には log のスナップショット（`is_bodyweight` / `bodyweight_factor` / `body_weight_kg`）を含め、実効重量は既存の `toSet` と同じ式で出す:

```
実効重量 = COALESCE(weight_kg, 0) + (is_bodyweight ? COALESCE(body_weight_kg, 0) × bodyweight_factor : 0)
セットのボリューム = reps × 実効重量
```

### 出力 `ExerciseRecords`

| 項目 | 定義 | 重量の基準 |
|---|---|---|
| `menu` | `id / name / category / muscle_group / is_bodyweight / bodyweight_factor` | — |
| `sessions` / `first_performed_at` / `last_performed_at` | 記録した log 数と期間（0 件なら `0 / null / null`） | — |
| `max_weight` | 1 セットの `weight_kg` の最大。`{ weight_kg, reps, performed_at, log_id }` | **追加重量**（`weight_kg`）。null/0 のセットは対象外 → 純自重のみなら `null` |
| `rep_maxes[]` | `reps` ごとの `weight_kg` の最大。`{ reps, weight_kg, performed_at, log_id }` を `reps` 昇順 | 同上（該当セットが無い reps は載せない） |
| `estimated_1rm` | Epley `weight_kg × (1 + reps / 30)` の最大。`{ value_kg（小数1桁）, weight_kg, reps, performed_at, log_id }` | 追加重量。**`reps ≤ 12` のセットのみ**（高 rep では式が信頼できない）。**自重種目（`is_bodyweight`）は常に `null`** |
| `max_reps` | 1 セットの `reps` の最大。`{ reps, weight_kg, performed_at, log_id }` | — |
| `max_set_volume` | 1 セットの `reps × 実効重量` の最大。`{ volume, reps, effective_weight_kg, performed_at, log_id }` | **実効重量**（既存 `ExerciseSet.volume` と同じ） |
| `max_session_volume` | 1 log の総ボリュームの最大。`{ volume, sets, performed_at, log_id }` | 実効重量（既存 `ExerciseLog.total_volume` と同じ） |
| `last_session` | `last_performed_at` の log。`{ performed_at, log_id, total_volume, sets: ExerciseSet[] }` | — |

- 最大重量だけ「追加重量」、ボリュームは「実効重量」という非対称は意図的: 重量は「バーに載せる数字」として答える必要があり、自重種目で体重込みにすると太っただけで記録更新になる。ボリュームは既存の表示指標との整合を優先する
- **同値のタイブレークは「最初に達成した日」**（`performed_at` 昇順、同一 log 内は `set_index` 昇順で先勝ち。比較は厳密な `>`）
- セットのボリュームとセッションの総ボリュームは **0.001 kg·rep に丸めてから**比較・出力する（体重スナップショットが 50.2 のような二進で表せない値だと、同じ総量でもセット分割で float の合計が 1ulp ずれて「更新」扱いになるため）。既存の `ExerciseSet.volume` / `ExerciseLog.total_volume` も同じ丸めに揃える
- 取得順は `julianday(performed_at)` による時刻順（`performed_at` は入力の ISO8601 文字列をそのまま保存しているため、`Z` と `+09:00` が混在すると文字列順は時系列と一致しない）
- 集計は純関数 `computeRecords(menu, rows)`（`src/exercise-records.ts`）で行い、DB から切り離してテストする。SQL に 6 本の MAX を並べるより、タイブレーク・レップマックス表・推定 1RM を 1 か所で扱える
- 有酸素種目は対象外（REST 400 / MCP エラー）。記録 0 件の筋トレ種目は各項目 `null`、`rep_maxes: []`、`sessions: 0`

## 自己ベスト更新フラグ（`logExercise`）

筋トレ記録時に、**挿入前の記録 → 挿入 → 挿入後の記録**を比較し、更新した項目を返す:

```ts
interface RecordBroken {
  kind: 'max_weight' | 'rep_max' | 'estimated_1rm' | 'max_reps' | 'max_set_volume' | 'max_session_volume';
  reps?: number;          // kind === 'rep_max' のとき、どの REP 数の記録か
  previous: number | null; // 更新前の値（初回は null）
  current: number;
}
```

- 判定は「挿入後の値 > 挿入前の値」（同値は更新扱いにしない）。`rep_max` は挿入後の `rep_maxes` の各 reps について、挿入前に無い or 低い場合に 1 件ずつ
- 初回記録は全項目が `previous: null` で更新扱い
- `ExerciseLog` に任意フィールド `records_broken?: RecordBroken[]` を追加し、**`logExercise` の戻り値にだけ**載せる（`getExerciseLog` / `listExerciseLogs` には付けない）。`POST /api/exercise/logs` と MCP `log_exercise` の応答に含まれる。有酸素は `[]`
- 集計を 2 回（前後）走らせるコストは筋トレ記録ごとに数 ms で許容

## API / MCP

### REST（公開読み取り、`READ_ROUTES` に追加）

`GET {base}/api/exercise/records?menu_id={id}`

| 条件 | 応答 |
|---|---|
| 正常 | 200 `ExerciseRecords` |
| `menu_id` 無し / 空 | 400 `{ error: 'menu_id is required' }` |
| 種目が存在しない | 404 `{ error: 'menu not found' }` |
| 有酸素種目 | 400 `{ error: 'records are only available for strength menus' }` |

- `READ_ACCESS=private` の保護は `api/*` の GET として自動的に掛かる
- openapi.json に path と `menu_id`（`required: true`）を追加。llms.txt にも 1 行追加
- openapi ドリフトテスト（「全 path が実ルータで 200」）は、**`days` 以外の必須クエリを持つ path はパラメータ無しの 400 を「配信されている」とみなす**よう 1 条件を足す（既存 path の 200 期待は変えない）

### MCP（13 → 14 ツール）

`get_exercise_records`（読み取り）

- 引数: `menu_id`（任意）/ `menu_name`（任意。`log_exercise` と同じ `resolveIdByName`: 完全一致 → 一意な部分一致。曖昧なら候補付きエラー）。どちらも無ければエラー
- 応答: `ExerciseRecords` の JSON
- `instructions` に「自己ベスト・前回のセット内容は `get_exercise_records` で引く（`get_exercise_logs` で全記録を取らない）」を追記。`log_exercise` の説明に「応答の `records_broken` に自己ベスト更新が入る」を追記

## テスト方針

- `test/exercise-records.test.ts`: `computeRecords` の純関数テスト（空 / 純自重 / 自重＋追加重量 / タイブレーク（先勝ち）/ rep ≤ 12 の 1RM 制限 / レップマックス表の昇順 / 前回セッション）と、DB 経由の `getExerciseRecords`（cardio 拒否・未知 menu）
- `test/exercise.test.ts`: `logExercise` の `records_broken`（初回 = 全項目 / 一部更新 / 更新なし = 空 / 有酸素 = 空）
- `test/exercise-api.test.ts`: REST の 400 / 404 / 200 と、`READ_ACCESS=private` で 401
- `test/mcp.test.ts`: ツール数 14、`menu_name` 解決、曖昧・未知のエラー、cardio エラー
- `test/ai-api.test.ts`: ドリフトテストの条件追加（必須クエリを持つ path）

## セキュリティ / 公開リポジトリ配慮

- 読み取り専用の集計で新しい書き込み経路は無い。`READ_ACCESS` の既存ポリシーに従う
- 実値（本番ドメイン・ID・計測値）をテスト・ドキュメントに書かない

## やらないこと（YAGNI / スコープ外）

- DB への記録保持（列・テーブル・ビュー）と、それに伴うバックフィル
- ダッシュボードへの自己ベスト表示、Slack ダイジェストへの掲載
- 全種目の自己ベスト一覧（`menu_id` 無しで全件返す API）
- 有酸素種目の記録（最長時間・最大消費 kcal など）
- 推定 1RM の式の選択肢（Brzycki 等）や、自重種目の実効重量ベース 1RM
