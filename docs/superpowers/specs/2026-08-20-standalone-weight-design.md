# スタンドアロン化: Withings任意化＋手動体重記録 設計

日付: 2026-08-20
ステータス: 実装済み。**このスペックの負ID採番方式は同日の主キー再設計（2026-08-20-measurements-pk-redesign-design.md）で廃止された**（歴史的記録として残す）

## 目的

Withingsを「必須のデータ源」から「任意の入力源の1つ」に格下げし、Withings開発者アカウント・OAuth・webhookを一切セットアップしなくても bodylog の全機能（体重グラフ・BMR・日次ダイジェスト・実効代謝推定・AIコーチング）が使えるようにする。

体重の入力経路として、食事・運動と対称の2経路を追加する:

- MCPツール `log_weight`（Claude/ChatGPTアプリ等から会話で記録）
- `POST /api/weight`（Google OAuth 2.1保護のREST。iOSショートカット等の自動化用）

## 非目標

- ダッシュボードへの入力UI追加（読み取り専用のまま）
- `measurements` 主キーの再設計（grpid列は維持）
- Withings行の編集・削除API（Withingsデータは同期でのみ変化する）
- 手動記録のPATCH（削除→再記録で足りる）

## データモデル（migration 0006）

```sql
-- 手動体重記録の出所区別。既存行は 'withings' のまま
ALTER TABLE measurements ADD COLUMN source TEXT NOT NULL DEFAULT 'withings';
```

- 手動記録は同じ `measurements` テーブルに `source='manual'` で挿入する
- ID採番: `grpid` に負の整数を使う。`(SELECT COALESCE(MIN(grpid), 0) FROM measurements WHERE grpid < 0) - 1` → -1, -2, …。Withingsのgrpid（正の整数）と衝突しない
- `raw_json` には手動入力ペイロード（JSON）を保存し出所の証跡とする
- 読み取り系（stats / exercise BMR / slack digest / dashboard / MCP読み取り / metabolism / coaching）は**一切変更しない**。手動行も既存クエリがそのまま拾う

## 書き込み経路

新モジュール `src/weight.ts` に検証・挿入・削除ロジックを置く。

### 入力仕様（logWeight）

| フィールド | 必須 | 検証 |
|---|---|---|
| `weight_kg` | ✓ | 数値、20–300 |
| `fat_ratio` | – | 数値、%、3–75 |
| `measured_at` | – | ISO8601。省略時は現在時刻。now+5分超の未来と2000-01-01以前は拒否 |

- `fat_ratio` があれば `fat_free_mass = weight × (1 − fat_ratio/100)` を導出して保存（脂肪量は既存ロジックが `weight − fat_free_mass` で読む）
- 挿入と同時に `notification_batch_items` へ enqueue（負grpidでもPK claimは機能）。次の5分cronで既存の計測通知が飛ぶ — Withings webhook経由と同じ遅延特性

### エンドポイント

- `POST /api/weight`（`registerWriteRoutes` に既存 `w()`/unwrapToken パターンで追加）: 201で保存行を返す。バリデーション失敗は400＋日本語メッセージ
- `DELETE /api/weight/:id`: `source='manual'` の行のみ削除可。Withings行・存在しないIDは404。idは負整数を受ける
- MCP `log_weight`: write群に追加（書き込み6つ目、全体で13ツール目）。引数は上表と同じ。削除ツールは作らない（食事・運動MCPと同様）

## Withings任意化

- `runDailyBackfill` / `ensureSubscription`（`src/ingest.ts`）: 冒頭で `getTokenRow(env)` がnullなら infoログのみで静かに return。現状はWithings未認証だと毎日 `getValidAccessToken` が throw → admin alert が飛ぶ。「シークレット未設定」「設定済みだが未認証」の両方をトークン行の有無で一括カバー
- `processInbox` / `resumeInitialImport`: 既に未使用時no-op。変更なし
- `/auth/start` `/auth/callback`: `WITHINGS_CLIENT_ID/SECRET` 未設定なら500ではなく「Withings連携が未設定です」のエラーページ（既存 `errorPage` パターン）
- webhookルート: 変更なし（購読がなければ何も届かない）

### public_origin の初期化（隠れ依存の解消）

`settings.public_origin` は現状 `/auth/start`（src/index.ts:148）でのみ設定され、未設定だとダイジェスト・通知送信が全てスキップされる。解消策:

- 認証済み書き込みリクエスト（`/api/*` の各ハンドラ共通部およびMCP write）の到着時、`public_origin` が**未設定なら**リクエストURLのoriginで初期化する
- 設定済みなら上書きしない（workers.devと独自ドメイン併用時のフラッピング防止）
- 書けるのはオーナー認証済みリクエストのみなので汚染リスクなし
- `/auth/start` での設定は既存のまま維持

## ドキュメント

- README再構成: 「必要なもの」からWithings開発者アカウントを任意へ。セットアップ手順を「コア（Cloudflare＋Google OAuth＋Slack）」と「任意: Withings連携」に分離。チェックリスト更新。URL例は `weight.example.com` を維持
- `wrangler.toml.example`: `WITHINGS_CLIENT_ID/SECRET` のコメントに「任意: Withings連携を使う場合のみ」を明記
- `src/ai.ts`（llms.txt / openapi）: `POST /api/weight` `DELETE /api/weight/:id` と `source` フィールドを追記
- MCPサーバー instructions: 「Withings体重計」前提の文言を「体重計または手動記録」に更新。`log_weight` の案内を追加
- AGENTS.md: 変更なし

## テスト

- `test/weight.test.ts` 新設:
  - 認証: トークンなし401、スコープ不正
  - バリデーション: weight範囲外、fat_ratio範囲外、未来/過去すぎるmeasured_at
  - fat_free_mass導出値の正確性
  - 負ID採番が -1, -2 と連番になること（既存Withings行があっても影響しない）
  - DELETE: manual行は削除可、Withings行(正ID)は404、存在しないIDは404
  - 通知enqueue: 挿入後に `notification_batch_items` へ行があること
- `test/ingest.test.ts` 系: トークン行なし時に `runDailyBackfill` / `ensureSubscription` が admin alert を出さず no-op すること
- MCPテスト: tools/list が13ツール、`log_weight` 正常系・異常系
- 通し確認1本: 手動記録が daily series（体重・BMR）とダイジェストに載ること
- 日付依存のseedは `${ymd}T03:00:00Z` 固定時刻を使う（AGENTS.md規約）

## リスク・影響範囲

- 既存の本番データ・Withings運用への影響なし（migrationはDEFAULT付きADD COLUMNのみ、読み取りクエリ無変更）
- `grpid` 列名の意味が濁る（負=manual採番）→ スキーマコメントとweight.tsコメントで補足
- 将来入力源がさらに増えた場合は主キー再設計へ移行する（負IDのままでも移行可能）
