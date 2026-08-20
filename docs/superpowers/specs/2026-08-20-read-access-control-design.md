# 読み取りアクセス制御モード（READ_ACCESS） 設計

日付: 2026-08-20
ステータス: 承認済み（実装へ）

## 目的

「記録だけ要ログイン（現状）」と「サイト全体（データ）要ログイン」を設定で選べるようにする。守る実体は計測・食事・運動などのデータ（API応答）であり、アプリの外枠（HTML/JS/CSS）は配信し続ける（データ保護モード）。

## 設定

`wrangler.toml` の `[vars]` に `READ_ACCESS`（`"public"` | `"private"`、既定 `"public"`）。セキュリティ姿勢の設定なのでD1 settings（実行時可変）ではなく設定ファイルに置く。加えて任意シークレット `OG_ACCESS_TOKEN`（private時のSlack画像用）。

## 挙動

### public（既定・現状どおり）

挙動変更ゼロ。読み取り無認証・書き込みOAuth。

### private

- **保護対象**: READ_ROUTES のうちデータ系すべて — `api/*`（全読み取り）・`llms.txt`・`openapi.json`・`og.png`。未認可は 401 JSON `{error:'unauthorized'}`＋`WWW-Authenticate: Bearer`＋`no-store`（書き込みの401と同形式）
- **公開のまま（アプリ外枠）**: `''`（index.html）・`styles.css`・`app.js`・`shared.js`・`meals.js`・`exercise.js`・`vendor/chart.umd.js`・`manifest.webmanifest`・`apple-touch-icon.png`・`sw.js`
- **公開のまま（インフラ）**: `/authorize` `/token` `/register`（ログインに必須）・`/auth/*`（Withings）・`/webhook/*`・`/mcp`（従来どおり自前OAuth）
- **認可手段（読み取り）**: 次のいずれか
  1. オーナーのOAuth Bearer（既存 `isOwner()` を再利用）
  2. `Authorization: Bearer {COACHING_API_SECRET}`（AIコーチングジョブ用。既存 `coachingTokenMatches` の定数時間比較）
  3. `og.png` のみ `?key={OG_ACCESS_TOKEN}` クエリでも許可（Slack画像プロキシ用。定数時間比較。トークン未設定・不一致は401）

### 例外連携の扱い（ユーザー決定済み）

- **Slack通知のグラフ画像**: private かつ `OG_ACCESS_TOKEN` 設定時、Slackメッセージに埋め込む `og.png` URLへ `&key=` を付与（即時通知・日次ダイジェスト両方）。未設定時は画像ブロック自体を省略して degrade（通知は文字と リンクのみ）
- **AIコーチングジョブ**: `coaching/generate.mjs` の全GETに `Authorization: Bearer {COACHING_API_SECRET}` を常時付与（publicモードでも無害）
- **無認証AI読み取り（ChatGPT Actions / llms.txt URL渡し）**: private時は非対応。AI照会はMCP（OAuth）に一本化
- **リンクプレビュー画像（OGP）**: private時は非対応。HTML内の `og:image` URLはトークン無しのまま（=プロキシが401を受けて画像なし表示）。**キー付きURLを公開HTMLに埋めない**ことが要件

## ダッシュボード（private時のUX）

- app.js は読み取りfetch全部に、localStorage の既存トークン（`meals.token`）があれば `Authorization` ヘッダーを付ける（app.jsは同期実行のため `window.__dash` に依存せずlocalStorageを直接参照）
- 初回ロードの `api/measurements` が401なら「ログインが必要です」状態ボックス＋ログインボタンを表示（`showState('auth')` を新設）。ボタンは `window.__dash.login()`（shared.jsの既存PKCEフロー）を呼ぶ
- `authchanged` イベント（トークン失効/取得）でデータ再読込。ログイン完了はPKCEのフルページリダイレクト→再ロードで自然に反映される
- tolerant系fetch（summary/metabolism/日次カロリー）は401時に既存のnull/空フォールバックのままでよい（メイン系列の401でauth状態に入るため実際は到達しない）

## エラー処理・セキュリティ詳細

- 比較はすべて定数時間（`coachingTokenMatches` 再利用）
- `og.png` の `key` はクエリ文字列のためアクセスログに残りうる。露出先は自分のSlackチャンネルとCloudflareログのみで、漏れた場合は `OG_ACCESS_TOKEN` のローテーションで無効化できる（README運用に記載）
- 401レスポンスにデータ由来の情報を含めない

## 変更ファイル

- `src/types.ts`: `READ_ACCESS?: string` / `OG_ACCESS_TOKEN?: string`
- `src/dashboard.ts`: `withReadAccess(path, handler)` を新設し、両ルータの READ_ROUTES 登録をラップ（シェルパス集合は同ファイルに定義）
- `src/slack.ts`: og画像URL組み立てを `ogImageUrl(env, base, v)` ヘルパーに集約（private＋トークン時 `&key=`、private＋未設定時 null）
- `src/dashboard/app.js`: 認証ヘッダー付与・auth状態・authchanged再読込
- `src/dashboard/index.html`: auth状態ボックス追加
- `coaching/generate.mjs`: GETに Authorization ヘッダー
- `wrangler.toml.example` / `README.md`: READ_ACCESS・OG_ACCESS_TOKEN・privateモードの制約（Actions不可・プレビュー画像なし）
- `test/access.test.ts` 新設

## テスト

- private: 全データ読み取りルートが401 / オーナーBearerで200 / コーチングBearerで200 / シェルパスは無認証200 / og.png key一致200・不一致/未設定401
- public（既定）: 既存テスト全部がそのまま通る（変更ゼロの回帰確認）
- Slack: private＋トークン時にメッセージのimage URLへkeyが付く / private＋未設定時はimageブロック省略
- generate.mjs は単体テスト対象外（既存方針どおり）。ヘッダー付与はコードレビューで担保

## リスク

- private運用でユーザーが `OG_ACCESS_TOKEN` を設定し忘れると通知の画像が消える（機能degradeであり障害ではない。READMEに明記）
- 本番はデフォルト `public` のため、このデプロイ自体による挙動変化はない。private化はユーザーが `wrangler.toml`（とCIの `WRANGLER_TOML` Secret）を更新したときに有効になる
