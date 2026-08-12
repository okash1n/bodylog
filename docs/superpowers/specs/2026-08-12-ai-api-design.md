# AI向けAPI（REST拡張 + OpenAPI + MCP）設計

日付: 2026-08-12
ステータス: 承認済み（実装へ）

## 目的

ChatGPT・Claude などのAIクライアントから、このWorkerが配信する体重データを照会できるようにする。
「最近の体重推移を見て」という問いに、AIが自律的にAPIを叩いて答えられる状態がゴール。

このドキュメント内のURL例は `weight.example.com` を使う（実環境の設定値はこのリポジトリに書かない）。

## 決定事項

- 統合レベル: REST整備 + OpenAPI配信 + リモートMCPサーバーの全部を作る
- 認証: なし（読み取り専用の公開API。既存ダッシュボード・APIの公開方針と一貫。必要になれば Cloudflare Access を後付け）
- MCP実装: `@hono/mcp` + 公式 `@modelcontextprotocol/sdk` のステートレス Streamable HTTP 構成（Durable Objects 不使用）

## スコープ

すべて読み取り専用。書き込み系・認証・レート制限・ChatGPT非開発者モードコネクタ用の `search`/`fetch` ツールはスコープ外。
wrangler.toml のバインディング変更なし。依存追加は `@hono/mcp` / `@modelcontextprotocol/sdk` / `zod` の3つ。

## REST層

### 相対期間指定 `days`

`GET /api/measurements` と `GET /api/raw` に `?days=N` を追加する。

- `days=N`: ローカル今日を末尾とする直近N日（当日含む）。`to`=今日、`from`=今日−(N−1)日
- 範囲: 整数 1〜731（`LIMITS.API_MAX_RANGE_DAYS` と同値）
- `days` と `from`/`to` の併用は 400
- `days` 未指定時は現行どおり `from`/`to` 必須（検証も現行踏襲）
- 期間解決ロジックは純粋関数 `resolveRange` として `src/util.ts` に切り出し、RESTとMCPで共用する

### 要約エンドポイント `GET /api/summary`

1回の呼び出しで推移の要点を返す。レスポンス（単位はkg、`fat_ratio` のみ%、日付境界はJSTローカル）:

```json
{
  "as_of": "ISO8601 UTC",
  "units": { "mass": "kg", "fat_ratio": "percent" },
  "timezone_offset_hours": 9,
  "latest": { "measured_at": "...", "weight": 0, "fat_mass": 0, "fat_free_mass": 0, "fat_ratio": 0 },
  "recent7_avg": { "weight": 0, "fat_mass": 0, "fat_free_mass": 0 },
  "diff_vs_prev7": { "weight": 0, "fat_mass": 0, "fat_free_mass": 0 },
  "baseline": { "date": "YYYY-MM-DD | null", "diff": { "weight": 0, "fat_mass": 0, "fat_free_mass": 0 } },
  "last_sync_at": "ISO8601 | null"
}
```

- `recent7_avg` / `diff_vs_prev7` / `baseline.diff` は Slack通知と同じ `getNotificationStats` を再利用
- 計測が1件もない場合は `latest: null`・各値 null で 200 を返す
- Cache-Control: no-store

### AI向け案内 `GET /llms.txt`

サービス概要・エンドポイント一覧とURL例・単位とタイムゾーンの注意を Markdown プレーンテキストで配信。
Content-Type: text/plain、Cache-Control: public, max-age=3600。

### OpenAPI `GET /openapi.json`

measurements / raw / summary / status の4エンドポイントを記述した OpenAPI 3.1 を配信。
TS内の静的オブジェクトで管理し、`servers` はリクエストオリジンから導出。カスタムGPTのActionsにこのURLをインポートして使う。

## MCPサーバー（`/mcp`）

- `src/mcp.ts` に集約。リクエストごとに `McpServer` + `StreamableHTTPTransport`（`@hono/mcp`）を生成するステートレス構成（セッションIDなし）
- サーバー `instructions` に単位（kg）・タイムゾーン（JST）・データの性質を明記

ツール（読み取り専用の3つ）:

| ツール | 引数 | 返すもの |
|---|---|---|
| `get_weight_summary` | なし | `/api/summary` と同じ要約 |
| `get_daily_series` | `days` または `from`/`to` | 日次平均 + 7日移動平均 |
| `get_raw_measurements` | `days` または `from`/`to` | 計測1回ごとの明細（最大2000件） |

- 引数スキーマは zod。期間検証は REST と同じ `resolveRange` を通す
- 結果は JSON文字列の text コンテンツ
- 期間範囲エラーは `isError: true` のツール結果で返す

## ルーティング

既存の2ルーター（`/d/{slug}/` 配下・ドメイン直下）の両方に、既存のguardedパターンで追加する:
`api/summary`・`llms.txt`・`openapi.json`・`mcp`（mcpのみ `app.all`）。

## エラー処理

- REST: 現行踏襲（バリデーション 400 + `{error}`、内部エラー console.error + 500）
- MCP: スキーマ違反はSDKが弾き、範囲エラーは isError ツール結果、内部エラーは JSON-RPC エラー

## テスト

既存の vitest + @cloudflare/vitest-pool-workers に追加:

- `days` の正常系・境界（1, 731）・不正（0, 732, 非整数, from/to併用）
- `/api/summary` の形（基準日あり/なし・データ空）
- MCP: initialize → tools/list（3ツール）→ tools/call ×3 + 範囲エラー時の isError
- `llms.txt` / `openapi.json` の配信と内容（オリジン展開、パス網羅）
- slugモード時のガード（不一致404）

## デプロイ

main への push で GitHub Actions（テスト → D1マイグレーション → wrangler deploy）。新規マイグレーションなし。

## 既知の制約・リスク

- ChatGPTの通常コネクタ（開発者モード外）は `search`/`fetch` ツール必須のため対象外。ChatGPTからは「カスタムGPT Actions」または「開発者モードのMCPコネクタ」を使う
- `@modelcontextprotocol/sdk` が workerd で node 組み込みモジュールを要求した場合、`nodejs_compat` フラグの追加が必要になる可能性がある（その場合は wrangler.toml.example・ローカル wrangler.toml・GitHub Secret `WRANGLER_TOML` の3箇所を更新する）
- データは従来どおり認証なし公開（露出度は既存APIと同じ）
