# AIコーチング（定期講評の生成・配信・表示）設計

> **2026-08-15 更新**: Slackの配信を日次ダイジェストへ統合した。AI講評の単独Slackメッセージと
> notification_batches 経由の配信（coaching-プレフィックス）は廃止し、生成を毎晩23:30 JSTに変更
> （当日分を生成し、23:55のダイジェスト本文に差し込む）。週次（weekly）の定期生成も廃止し、
> 週間トレンド視点は毎日の総括に常に含める（kind='weekly' はスキーマ・API上は残置）。
> 以下の記述のうち配信・頻度に関する部分は当時の設計。
>
> **2026-08-28 更新**: GitHub の schedule 遅延が日付をまたいだ場合（実事例: 2026-08-27 の 23:30 予定が
> 翌 03:14 JST 開始）、当日扱いだと対象日がずれて本来の日の講評が欠けるため、schedule 実行では
> 「直近の予定スロット（23:30 JST）が属する日」を対象にするガードを generate.mjs / dates.mjs に追加した。
> あわせて起動の主経路を Worker（Cloudflare cron、23:30 JST、`src/coaching-dispatch.ts`）からの
> workflow_dispatch（対象日を `date` 入力で明示。`GITHUB_DISPATCH_TOKEN` / `GITHUB_DISPATCH_REPO`
> 設定時のみ）に変更。GitHub の schedule はフォールバックとして残し、対象日の講評が既にあればスキップする。
>
> **2026-08-29 更新**: 8/28 は GitHub が schedule を発火させず、未明の遅延実行（8/28 03:14）が残した
> 空データの 8/28 分講評が上書きされないままダイジェストに載った。対策として schedule を
> 23:30 / 23:50 JST の2本に冗長化し、fallback のスキップ条件を「講評が存在する」から
> 「その夜のスロット（23:30 ローカル）以降に生成された講評が存在する」（`slotTimeForDate` /
> `parseCreatedAtUtc`）に修正した。

## 目的

体重・体組成・食事PFC・運動の記録に対して、AIによる定期講評（コーチング）を追加する。

- **方針**: 体組成改善（脂肪量を減らし、除脂肪体重を維持・増加）。数値目標は設けない
- **頻度**: 毎日ライト講評（前日分、1〜3行）＋ 週次深掘り総括（月曜、直近14日を分析）
- **配信**: Slack（既存のWebhook配信基盤）とダッシュボードの「AIコーチ」カード
- **コスト制約**: AI推論はClaudeサブスクリプション範囲内（`claude setup-token` のOAuthトークン）。
  APIの従量課金・Cloudflare有料プランは使わない

## 全体構成

```
GitHub Actions schedule（毎日 21:00 UTC = 06:00 JST、workflow_dispatchで手動実行可）
  → coaching/generate.mjs
     1. bodylog 公開APIから直近14日のデータ取得
        （/api/measurements, /api/meals/daily, /api/exercise/daily, /api/summary）
     2. Claude Agent SDK の query() で講評テキストを生成
        （CLAUDE_CODE_OAUTH_TOKEN、ツールなし・1ターン）
     3. POST /api/coaching に保存（Bearer: COACHING_API_SECRET）
  → Worker（保存時）:
     - coaching_notes へ upsert
     - notification_batches に batch_id "coaching-{kind}-{date}" を投入し
       既存のリトライ機構で daily/both モードのSlack宛先へ配信
  → ダッシュボード: GET /api/coaching/latest を表示（AI呼び出しなし）
```

実行環境の選定経緯: Cloudflare Containers案はWorkers Paidプランが必要なため見送り。
GitHub Actions は追加費用ゼロで、Claudeサブスクトークンを使うCI実行は公式サポートの
パターン（claude-code-action と同じ認証方式）。

## データモデル

`migrations/0004_coaching.sql`

```sql
CREATE TABLE coaching_notes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'weekly')),
  date TEXT NOT NULL,             -- 生成対象のローカル日付 YYYY-MM-DD（生成日）
  content TEXT NOT NULL,          -- 講評本文（プレーンテキスト、Slack mrkdwn互換の軽い装飾可）
  model TEXT,                     -- 生成に使ったモデル名（参考情報）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, date)             -- 同日再実行はupsert
);
```

## API

### GET /api/coaching/latest（公開読み取り）

`READ_ROUTES` に追加（openapi.json / llms.txt にも記載。整合テストの対象）。

```json
{
  "daily":  { "kind": "daily",  "date": "2026-08-14", "content": "...", "model": "...", "created_at": "..." },
  "weekly": null
}
```

各kindの最新1件（なければ null）。`Cache-Control: no-store`。

### POST /api/coaching（書き込み・専用Bearer認証）

- 認証: `Authorization: Bearer {COACHING_API_SECRET}`（Workerシークレット）。
  既存のOAuth書き込み（withAuth）とは独立したサーバー間認証。secret未設定時は404相当で無効化
- ボディ: `{ "kind": "daily" | "weekly", "date": "YYYY-MM-DD", "content": string, "model"?: string }`
  - content は 1〜4000 文字。date は形式検証
- 動作: upsert → daily/bothモードの各Slack宛先へ notification_batches 投入 →
  processNotificationBatches を waitUntil で実行 → 201 で保存内容を返す
- Slackブロック: 見出し「AIコーチ（日次 / 週次・{date}）」＋本文＋ダッシュボードリンク

## 生成側（coaching/ ディレクトリ）

- `coaching/package.json`: 依存は `@anthropic-ai/claude-agent-sdk` のみ（lockfileでピン）
- `coaching/generate.mjs`:
  1. `BODYLOG_BASE_URL` から直近14日のデータをJSONで取得
  2. kind決定: JSTの月曜なら weekly、他は daily（`--kind` 引数で上書き可）
  3. プロンプト組み立て（日本語）: 体組成改善の方針、出力書式
     （daily: 1〜3行・前日の講評と今日の一手 / weekly: 見出し＋箇条書きでトレンド分析と提案）、
     データはコンパクトなJSONで同梱
  4. Agent SDK `query()`: ツール不許可・1ターン・テキストのみ受け取り
  5. `POST {BODYLOG_BASE_URL}/api/coaching` へ保存。失敗時は非0終了（Actionsの失敗通知で気付ける）
  - ログには講評本文・データを出力しない（パブリックリポのActionsログは公開されるため）
  - **2026-08-26 更新**: 前日までの講評 7 日分（daily、各 800 字まで、日付昇順）を `previous_notes` としてプロンプトに渡し、「評価・方針を直近の講評と連続させる／結論が変わるなら理由を添える／同じ助言の繰り返しを避ける」を出力ルールに加えた（日ごとに言うことが変わるのを防ぐ）。過去日の再生成（`COACHING_DATE`）でもその日より前の講評だけを参照する

## GitHub Actions（.github/workflows/coaching.yml）

- `on.schedule: cron "0 21 * * *"`（=06:00 JST）と `workflow_dispatch`（inputs.kind で手動指定可）
- Secrets: `CLAUDE_CODE_OAUTH_TOKEN`（ユーザーが `claude setup-token` で発行、約1年有効）、
  `COACHING_API_SECRET`、`BODYLOG_BASE_URL`（本番URLはパブリックリポに書かないためSecretで渡す）
- concurrency で多重実行防止。タイムアウト10分
- 注意: パブリックリポのscheduleは60日間コミットが無いと自動停止する（GitHub仕様）

## ダッシュボード

- ホームタブのサマリー直下に「AIコーチ」カードを追加
- `/api/coaching/latest` を取得し、日次講評（date付き）と週次総括（折りたたみ表示）を表示。
  未生成ならカードごと非表示
- ライト/ダークテーマ対応。ASSET_VERSION を bump

## エラーハンドリング

- 生成失敗（SDK認証切れ・API不達）: Actionsのjob失敗 → GitHubの失敗通知。
  トークン失効時は `claude setup-token` を再発行して Secret を更新する（年1回程度）
- Slack配信失敗: 既存の notification_batches のリトライ／dead化＋管理者アラートに乗る
- POST 認証失敗: 401（missing/invalid）。COACHING_API_SECRET 未設定環境では 404

## テスト

- coaching_notes の upsert / latest 取得
- POST /api/coaching: 認証（missing/wrong → 401、secret未設定 → 404）、
  バリデーション（kind/date/content）、成功時に notification_batches が投入されること
- GET /api/coaching/latest: 空状態 / daily・weekly混在
- openapi.json 整合（既存driftテストが新ルートを自動検出）
- ダッシュボードHTMLに ai-coach 要素が含まれること
- Slackブロック整形のスナップショット的検証

## セキュリティ（パブリックリポ運用）

- 本番URL・シークレット値はリポに書かない（workflowはすべて Secrets 参照）
- Actionsログに講評本文・健康データを出力しない
- COACHING_API_SECRET は 32byte hex を生成し、Workerシークレットと GitHub Secret の両方に登録
