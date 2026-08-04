# withings-weight-tracker

Withings 体重計の計測データを Cloudflare Workers で受け取り、D1 に保存して Slack に通知し、公開ダッシュボードで可視化するシングルユーザー向けアプリケーション。

- 対象データ: 体重・体脂肪率・除脂肪体重
- 通知: Slack Incoming Webhook（複数送信先対応）。最新計測値・7日間平均（前ターム比）・基準日からの変化を Block Kit で送信
- ダッシュボード: ランダム slug 付き URL（`/d/{slug}/`）で公開。noindex、PWA 対応、OGP 画像を Worker 内で生成
- インフラ: Cloudflare Workers + D1 のみ（KV / Queues / Durable Objects 不使用）。外部依存は Hono と Chart.js のみ

## アーキテクチャ

```
Withings 体重計
      │ 計測
      ▼
Withings Cloud ──(notify webhook: POST /webhook/withings-{secret})──┐
      ▲                                                             ▼
      │ getmeas / oauth2                              Cloudflare Worker (Hono)
      └──────────────────────────────────────────────  ├─ webhook_inbox に永続化 → 非同期処理
                                                        ├─ 計測取得 → D1 に UPSERT
                                                        ├─ 通知バッチ → Slack Webhook(複数)
                                                        ├─ cron: 5分毎（inbox 回収・通知再送・初期インポート再開）
                                                        ├─ cron: 日次（バックフィル・掃除・購読確認）
                                                        └─ /d/{slug}/ ダッシュボード（PWA + OGP 画像）
                                                                │
                                                                ▼
                                                          Cloudflare D1
                                          (measurements / tokens / settings /
                                           webhook_inbox / notification_batches)
```

Webhook は受信内容を即座に D1 の inbox テーブルへ永続化して 200 を返し、実際の取り込みは `waitUntil` と cron で非同期に行う。取り込みは Withings の `grpid` をキーにした UPSERT のため、再送・値修正にも冪等。通知は grpid 単位の claim（一意制約）で二重送信を防ぐ。

## 必要なもの

- Cloudflare アカウント（Workers / D1 が使えるプラン。無料枠で動作する想定）
- Withings アカウントと体重計（Body シリーズ等）
- Slack Incoming Webhook URL（通知先の数だけ）
- Node.js / npm / wrangler CLI

## セットアップ

### 1. Withings 開発者登録

1. [Withings Developer Portal](https://developer.withings.com/) でアプリケーションを作成する
2. Callback URL に Worker の URL + `/auth/callback` を登録する（例: `https://withings-weight-tracker.<your-subdomain>.workers.dev/auth/callback`）
3. 発行された **Client ID** と **Client Secret** を控える（後で Secrets に登録）

### 2. 設定ファイルの作成

```sh
git clone <this-repo>
cd withings
npm install
cp wrangler.toml.example wrangler.toml
```

`wrangler.toml` は実値を含むため `.gitignore` 済み。以下の `[vars]` をランダム値で埋める。

```sh
openssl rand -hex 16   # → WEBHOOK_PATH_SECRET（Webhook 受信パスの秘匿部分）
openssl rand -hex 8    # → DASHBOARD_SLUG（ダッシュボード URL の slug）
```

| 変数 | 内容 |
|---|---|
| `WEBHOOK_PATH_SECRET` | Webhook パス `/webhook/withings-{WEBHOOK_PATH_SECRET}` のランダム部分。推測防止用 |
| `DASHBOARD_SLUG` | ダッシュボード URL `/d/{DASHBOARD_SLUG}/` の slug。URL を知っている人だけが見られる。**空文字（`""`）にするとドメイン直下（`/`）で配信**（専用ドメイン運用向け。ホスト名は証明書の透明性ログ等で公開されるため、アクセス制限が必要なら Cloudflare Access などをドメインに後付けする） |
| `TZ_OFFSET_HOURS` | 集計・表示のタイムゾーンオフセット（時間）。既定 `9`（JST）。変更不要ならそのまま |

### 3. D1 データベースの作成とマイグレーション

```sh
wrangler d1 create withings-weight
# 表示された database_id を wrangler.toml の [[d1_databases]] に記入

wrangler d1 migrations apply withings-weight --remote
```

### 4. Secrets の登録

```sh
wrangler secret put WITHINGS_CLIENT_ID      # 手順1の Client ID
wrangler secret put WITHINGS_CLIENT_SECRET  # 手順1の Client Secret
wrangler secret put SLACK_WEBHOOKS          # 通知先のJSON配列（下記）
wrangler secret put SETUP_SECRET            # /auth/start の保護キー。openssl rand -hex 32 などで生成
wrangler secret put ADMIN_SLACK_WEBHOOK     # 任意: 管理者アラート送信先。未設定時は SLACK_WEBHOOKS の先頭を使用
```

`SLACK_WEBHOOKS` の形式（`id` は再送管理に使う安定した識別子。後から変えない）:

```json
[
  {"id": "main", "url": "https://hooks.slack.com/services/XXX/YYY/ZZZ"},
  {"id": "family", "url": "https://hooks.slack.com/services/AAA/BBB/CCC"}
]
```

### 5. デプロイ

```sh
npm run deploy
```

### 6. Withings 認可（初回のみ）

ブラウザで以下を開く（`{SETUP_SECRET}` は手順4で登録した値）:

```
https://<your-worker-domain>/auth/start?key={SETUP_SECRET}
```

Withings の認可画面で許可すると `/auth/callback` に戻り、以下が自動で行われる。

1. トークン交換と D1 への保存
2. Withings notify の購読登録（計測のたびに Webhook が飛ぶようになる）
3. 全履歴の初期インポート開始（レート制限を守るため cron の 5 分毎実行で数回に分けて進む）

完了ページからダッシュボード `/d/{DASHBOARD_SLUG}/` へ移動できる。初期インポートの進捗はダッシュボードおよび `/d/{slug}/api/status` で確認できる。

## エンドポイント一覧

| ルート | 役割 |
|---|---|
| `GET /auth/start?key={SETUP_SECRET}` | Withings 認可の開始。key 不一致・未設定は 404 |
| `GET /auth/callback` | 認可コールバック。トークン保存・購読登録・初期インポート投入 |
| `GET/HEAD/POST /webhook/withings-{WEBHOOK_PATH_SECRET}` | Withings notify 受信。GET/HEAD は疎通確認用に即 200 |
| `GET /d/{DASHBOARD_SLUG}/` | ダッシュボード本体（PWA） |
| `GET /d/{slug}/api/measurements?from=&to=` | 日次系列 JSON（日平均 + 7日移動平均） |
| `GET /d/{slug}/api/status` | 初期インポート状況・最終同期時刻 |
| `GET /d/{slug}/og.png` | OGP 画像（直近30日の体重グラフを PNG 生成） |
| 上記以外 | 404（全レスポンスに `X-Robots-Tag: noindex` 付与） |

cron トリガー:

- `*/5 * * * *` — webhook inbox の処理、通知の再送、初期インポートの再開
- `15 20 * * *`（05:15 JST） — 日次バックフィル、古い行の掃除、notify 購読の確認・復旧

## 運用

### 日次バックフィル

日次 cron が Withings の `lastupdate` API（前回同期時刻以降の差分取得）で取りこぼしを回収する。Webhook が落ちた期間があっても翌日には自動で埋まるため、通常は手動対応不要。

### 再認可と refresh_token の 8 時間ルール

Withings のトークンは以下の性質を持つ。

- access_token の寿命は 3 時間。失効時は refresh_token で自動更新される
- refresh_token は**ローテーション制**: 使用すると失効し、新しい refresh_token が発行される。また**新しい refresh_token の発行から 8 時間経つと旧 refresh_token は無効になる**

つまり Worker が保存している refresh_token が何らかの理由で無効化される（例: D1 を古いバックアップから復元して旧トークンに巻き戻った、別の場所で同じアプリの refresh を実行した）と、自動更新のチェーンが切れて同期が止まる。この場合、管理者アラート（refresh 失敗）が届くので、以下で再認可する。

```
https://<your-worker-domain>/auth/start?key={SETUP_SECRET}
```

再認可してもデータは `grpid` キーの UPSERT なので重複しない。userid が既存トークンと異なる Withings アカウントで認可しようとした場合は 403 で拒否される（上書き防止）。

### ダッシュボード slug の再発行

URL が漏れた場合などは slug を変更する。

1. `openssl rand -hex 8` で新しい slug を生成
2. `wrangler.toml` の `DASHBOARD_SLUG` を書き換えて `npm run deploy`
3. 旧 URL は即 404 になる。ブックマーク・PWA のインストール・Slack 通知内リンクはすべて新 URL に切り替わる（通知は次回送信分から新 slug を使用）

`WEBHOOK_PATH_SECRET` を変更した場合は、日次 cron の購読確認（`ensureSubscription`)が旧 callback を revoke して新 URL で再購読するが、即時反映したい場合は再認可（`/auth/start`）を行うとその場で購読し直される。

### D1 バックアップ

二段構えを推奨する。

1. **定期エクスポート**: cron やローカルの定期ジョブで以下を実行し、SQL ダンプを保管する

   ```sh
   wrangler d1 export withings-weight --remote --output backup-$(date +%Y%m%d).sql
   ```

2. **Time Travel**: D1 は過去 **30 日**の任意時点へ復元できる（有料プランは30日、無料プランは短い場合があるため [公式ドキュメント](https://developers.cloudflare.com/d1/reference/time-travel/) を確認）

   ```sh
   wrangler d1 time-travel restore withings-weight --timestamp=<unix-timestamp>
   ```

注意: バックアップから復元すると `tokens` テーブルの refresh_token が古い値に巻き戻り、上記の 8 時間ルールにより無効になっている可能性が高い。復元後は `/auth/start` での再認可を前提とすること。

### TZ_OFFSET_HOURS の変更

`wrangler.toml` の `TZ_OFFSET_HOURS` を書き換えて `npm run deploy` する（例: `"8"` = 中国標準時、`"-5"` = 米東部標準時）。

- 計測データは UTC で保存されており、オフセットは集計・表示時にのみ適用される。変更しても過去データはそのまま新しいオフセットで再集計される
- **固定オフセットであり DST（夏時間）には対応しない**。DST のある地域では季節により日付境界が 1 時間ずれる
- 範囲は -14〜+14。不正値・未設定時は 9（JST）にフォールバックする

### SETUP_SECRET のローテーション

`/auth/start` の保護キーが漏れた疑いがある場合:

```sh
openssl rand -hex 32          # 新しい値を生成
wrangler secret put SETUP_SECRET   # 新しい値を入力
```

即時反映され、旧キーでのアクセスは 404 になる。既存のトークン・購読・データには影響しない（`SETUP_SECRET` は認可開始の入り口を守るだけで、認可済みの動作には使われない）。

## 開発

```sh
npm run dev        # ローカル起動（wrangler dev）
npm test           # vitest（@cloudflare/vitest-pool-workers 上で実行）
npm run typecheck  # tsc --noEmit
```

## ライセンス

MIT License。詳細は [LICENSE](./LICENSE) を参照。
