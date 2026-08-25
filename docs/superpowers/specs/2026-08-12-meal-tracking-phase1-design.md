# 食事記録 Phase 1（メニュー方式・OAuth 2.1書き込み）設計

日付: 2026-08-12
ステータス: 承認済み（実装計画へ）

このドキュメント内のURL例は `weight.example.com` を使う（実環境の設定値はこのリポジトリに書かない。CLAUDE.md参照）。

## 目的

体重トラッカーに食事（摂取カロリー・PFC）の記録機能を追加する。MyFitnessPal等の外部サービスにはAPI経路がないため自前で持つ。
入力の原則は「**必ずメニューから**」: 事前登録したメニュー（マスタ）を選んで記録する。自由文の直接記録は提供しない。

## フェーズ分割

- **Phase 1（本スペック）**: メニュー管理・記録・倍率・PFC・日次合計・ダッシュボード入力UI・MCP書き込み・OAuth 2.1認証
- Phase 2: 目標設定、体重×摂取カロリーの重ね合わせ、Slackダイジェストへの組み込み
- Phase 3: 食事アドバイス・スコアリング等（あすけん的評価）

## 決定事項

- 記録は必ずメニュー参照（menu_id）。倍率 `multiplier`（既定1.0）で量のブレを吸収
- PFC（タンパク質・脂質・炭水化物、g）はPhase 1から任意入力
- 読み取りは既存方針どおり**全公開**（食事明細・メニュー含む）。書き込みのみ認証
- 認証は **OAuth 2.1**（`@cloudflare/workers-oauth-provider`）。ChatGPTコネクタ（OAuthのみ対応）からの書き込みを可能にするため
- 本人確認は **Googleログイン**。userinfoのメールを secret `OWNER_EMAILS`（カンマ区切り）と照合
- MCPからできる操作: メニュー検索・記録の読み書き・**明示依頼時のみ**メニュー作成。編集・アーカイブ・削除はダッシュボードUI専用
  - **2026-08-26 更新（GitHub Issue #1）**: AI の誤登録をウェブアプリ無しで直せるよう、MCP にも `update_menu` / `archive_menu`（`archived:false` で復元） / `update_meal_log` / `delete_meal_log` を追加した。REST と同じ検証・更新関数を使い、明示依頼時のみ・実行前に対象確認を instructions で指示する

## 認証アーキテクチャ

- `@cloudflare/workers-oauth-provider` を導入し、Workerのfetchをラップする
  - 提供エンドポイント: `/authorize` `/token` `/register`（動的クライアント登録、PKCE必須）
  - ストレージ: KVネームスペース `OAUTH_KV`（新規バインディング）
  - `scheduled` ハンドラは従来どおり素通し（ラップはfetchのみ）
- **認証必須パスは `/rw/` プレフィックスに集約**し、`apiRoute: ['/rw/']` でトークン検証をかける
  - `/rw/menus` `/rw/meals`（REST書き込み）と `/rw/mcp`（読み書き両対応MCP）
  - 既存の公開 `/mcp`・読み取りAPIは無認証のまま変更しない
- `/authorize` の中身（defaultHandler側で実装）:
  1. 認可リクエストをparseして保留
  2. Googleへリダイレクト（scope: openid email。client id/secretは secrets）
  3. コールバックでcode交換 → **userinfoエンドポイント**からメール取得（JWT署名検証を自前でしない）
  4. `email_verified` が真であることを確認した上で `OWNER_EMAILS` と照合。一致すれば同意画面なしで即トークン発行、不一致は403
- ダッシュボードもOAuthクライアント: 動的登録（client_idはlocalStorageにキャッシュ）→ PKCE認可コードフロー → アクセストークン+リフレッシュトークンをlocalStorageに保持。期限切れはリフレッシュ、失敗時のみ再ログイン
- ChatGPT/Claudeには `https://weight.example.com/rw/mcp` をOAuthコネクタとして登録する（公開 `/mcp` コネクタは読み取り専用として併存可）

## データモデル（D1マイグレーション 0002）

```sql
CREATE TABLE menus (
  id         TEXT PRIMARY KEY,          -- uuid
  name       TEXT NOT NULL,
  calories   REAL NOT NULL,             -- 1食分 kcal
  protein_g  REAL, fat_g REAL, carbs_g REAL,  -- 任意
  note       TEXT,
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE meal_logs (
  id         TEXT PRIMARY KEY,          -- uuid
  menu_id    TEXT NOT NULL REFERENCES menus(id),
  eaten_at   TEXT NOT NULL,             -- ISO8601 UTC（集計はTZ_OFFSET_HOURSのローカル日付境界）
  meal_type  TEXT,                      -- breakfast / lunch / dinner / snack（任意）
  multiplier REAL NOT NULL DEFAULT 1.0,
  -- 記録時点のメニュー値スナップショット（1食分あたり）
  menu_name  TEXT NOT NULL,
  calories   REAL NOT NULL,
  protein_g  REAL, fat_g REAL, carbs_g REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_meal_logs_eaten_at ON meal_logs (eaten_at);
```

- **スナップショット方式**: 記録時にメニュー値をコピー。メニュー編集は過去記録に影響しない
- **メニューは物理削除しない**（アーカイブのみ）。記録の削除は物理削除
- 実効値（倍率適用後）は保存せず読み取り時に計算する

## REST API

公開（読み取り。期間指定・検証・エラー形式は既存 `resolveRange` / 400+`{error}` と同一規約）:

- `GET /api/menus?q=` — メニュー一覧・部分一致検索（archived除外。`?archived=1` で含める）
- `GET /api/meals?days|from&to` — 記録一覧（新しい順。スナップショット値と実効値 `effective_calories` 等を返す）
- `GET /api/meals/daily?days|from&to` — ローカル日付ごとの合計（kcal・PFC・件数）
- `GET /api/summary` — 既存レスポンスに `intake_today`（当日合計 kcal・PFC）を追加

認証必須（`/rw/`、Bearerトークン）:

- `POST /rw/menus` — 作成 {name, calories, protein_g?, fat_g?, carbs_g?, note?}
- `PATCH /rw/menus/:id` — 更新（同項目）
- `POST /rw/menus/:id/archive` / `POST /rw/menus/:id/unarchive`
- `POST /rw/meals` — 記録 {menu_id, multiplier?, eaten_at?, meal_type?}（eaten_at省略時は現在時刻）
- `PATCH /rw/meals/:id` — multiplier / eaten_at / meal_type の修正
- `DELETE /rw/meals/:id` — 記録の削除

バリデーション: name非空、calories/PFC/multiplierは正の有限数（multiplier上限20）、meal_typeは4値のみ、eaten_atはISO8601かつ未来不可（POST/PATCH共通）。**アーカイブ済みメニューへの新規記録は400で拒否**（MCPの `log_meal` も同様）。

## MCPツール

公開 `/mcp`（既存3ツールに追加、読み取り専用）:

- `search_menus` {q?} — メニュー検索
- `get_meal_logs` {days?|from?/to?} — 記録一覧（実効値付き）

認証付き `/rw/mcp`（公開側の全ツール + 書き込み2つ）:

- `log_meal` {menu_id または menu_name, multiplier?, eaten_at?, meal_type?} — menu_nameは完全一致→一意な部分一致の順で解決。曖昧なら候補を返してエラー
- `create_menu` {name, calories, protein_g?, fat_g?, carbs_g?, note?} — ツール説明に「ユーザーが明示的にメニュー登録を依頼したときだけ使う」と明記

llms.txt / openapi.json / README を更新（openapi.jsonには公開読み取りのみ記載。書き込みはMCP経由が主用途のため）。

## ダッシュボードUI

- 「体重/食事」タブ切替を追加。食事タブ: 当日の記録一覧（時刻・メニュー名・倍率・実効kcal/PFC・編集・削除）、日次合計、記録追加（メニュー検索ピッカー→倍率・時刻・食事区分）、メニュー管理（作成・編集・アーカイブ）
- 未ログイン時は閲覧のみ（書き込みUI非表示 + ログインボタン）
- 実装は `src/dashboard/meals.js` を新設（app.jsに足さない）。`ASSET_VERSION` 更新、配信ルート追加

## エラー処理

- REST: 既存規約（400+`{error}`、401はライブラリ、500はマスクしてconsole.error）
- MCP: 既存規約（範囲・解決エラーはisError、内部エラーは 'internal error' にマスク）
- OAuth: Google連携失敗・メール不一致は認可画面上でエラー表示（トークンは発行しない）

## テスト

- OAuthフロー統合テスト1式: クライアント登録→認可（GoogleはstubFetchでモック）→トークン取得。以後の書き込みテストはこの実トークンを使う
- 書き込みAPIの認証ゲート（トークン無し401/不正401/有り200）
- スナップショット保全（メニュー編集後も過去記録不変）、倍率計算、アーカイブ済みメニューへの記録拒否、JST境界の日次集計
- MCP: `/rw/mcp` の書き込みツール（認証込み）、公開 `/mcp` に書き込みツールが**現れない**こと
- 既存のOpenAPIドリフト検知・llms.txtテストの拡張
- 日付依存のseedは固定時刻 `${ymd}T03:00:00Z`（CLAUDE.mdの規約）

## 導入手順（実装完了後）

1. `wrangler kv namespace create OAUTH_KV` → バインディングを wrangler.toml 3箇所へ（ローカル実物 / example=プレースホルダ / GitHub Secret `WRANGLER_TOML` を `gh secret set` で更新。実行前にユーザー確認）
2. Google CloudでOAuthクライアント作成（ユーザー作業・手順は案内。リダイレクトURI `https://weight.example.com/authorize/callback` 相当の実値はGoogle画面にのみ入力）
3. secrets登録: `GOOGLE_OAUTH_CLIENT_ID` `GOOGLE_OAUTH_CLIENT_SECRET` `OWNER_EMAILS`
4. push → CIがD1マイグレーション+デプロイ
5. 動作検証後、ChatGPT/Claudeに `/rw/mcp` をOAuthコネクタとして登録

## スコープ外（Phase 1）

Slackダイジェストへの摂取カロリー、体重×カロリーのグラフ重ね合わせ、目標設定、アドバイス/スコア、食品DB・バーコード、iOSショートカット経路、ChatGPT Actions（REST OpenAPI）経由の書き込み。

## リスク・前提

- `workers-oauth-provider` とChatGPTコネクタのOAuth互換性は実装時に実機検証が必要（動的クライアント登録・PKCE・リフレッシュ）。MCPクライアント互換問題の前例（protocol versionヘッダ）があるため、失敗時はwrangler tailで切り分ける
- 読み取り全公開の決定により、URLを知る人には食事明細も見える（ドメイン非公開運用が前提。必要になればPhase 2以降で絞る）
- KVバインディング追加により wrangler.toml の3箇所同期が新たな運用ポイントになる
- ダッシュボードのトークンはlocalStorage保持（自分の端末のみで使う前提）
