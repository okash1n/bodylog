# bodylog

体重・体組成に加え、食事・運動の記録も扱うシングルユーザー向けの「からだ」トラッキングアプリ。Cloudflare Workers で受け取り、D1 に保存し、Slack 通知と公開ダッシュボードで可視化する。体重の入力は **Withings 体重計連携（任意）** と **手動記録（MCP / REST API）** の2経路がある。

Fork/clone して設定値を差し替えるだけで動く（コード変更不要）。Cloudflare 無料枠内で動作する。

- 対象データ: 体重・体脂肪率・除脂肪体重、食事記録（登録済みメニューからのカロリー・PFC記録）、運動記録（種目マスタは有酸素=METs / 筋トレ=セット明細 reps×weight、自重種目は記録時の体重 × 係数 `bodyweight_factor`（0〜1、既定1.0）を負荷に算入。コア系など体の一部しか動かさない種目は係数を下げて補正する）
- エネルギー収支: 消費 = 基礎代謝（BMR。Katch-McArdle: 370 + 21.6 × 実測除脂肪体重。その日以前で最新の実測FFMを carry-forward し、実測が一度も無い期間は算出しない。**基礎代謝を体重や年齢・性別ではなく実測の除脂肪体重から算定する**ため、同じ体重でも体組成の違いがそのまま反映され、一般式（Harris-Benedict 等）より個人に即したかなり正確な推定になる） + 運動消費（有酸素のみ、METs×体重×時間×1.05。筋トレはkcalではなく総ボリュームで追跡し、ダッシュボードで除脂肪体重の推移と重ねて見られる）。カロリー収支 = 摂取 − 総消費（日常活動・食事誘発性熱産生は含まない推定値）
- 通知: Slack Incoming Webhook（複数送信先対応）。最新計測値・7日間平均（前ターム比）・基準日からの変化に加え、**直近30日のグラフ画像を通知に直接埋め込む**
- ダッシュボード: PWA 対応・noindex。実測⇔7日平均のワンクリック切替、期間プリセット（1M/3M/1Y/カスタム）、日次集計⇔計測明細の表、ライト/ダークテーマ、OGP 画像を Worker 内で生成。食事・運動タブから記録の閲覧・入力もでき、体重グラフには摂取/消費（基礎代謝＋運動）/カロリー収支を重ねられる
- 食事記録: 登録済みメニュー（マスタ）からのみ記録する方式（自由入力ではない）。PFC比率はP×4/F×9/C×4kcal換算による3者内正規化で算出する（登録kcalでは割らない）。閲覧は公開API・認証不要、記録・メニュー登録はオーナーの Google アカウントによる OAuth 2.1 認可が必要
- インフラ: Cloudflare Workers + D1 + KV（KV は食事・運動記録の書き込みAPI、および MCP の書き込みツール用 OAuth の認可フロー・トークン保存にのみ使用。Queues / Durable Objects は不使用）。外部依存は Hono / Chart.js / `@cloudflare/workers-oauth-provider` / `@modelcontextprotocol/sdk` / `@hono/mcp` / zod
- 動作確認済みバージョン: Node.js 22+ / wrangler 4.122（大きく異なるバージョンでは手順が変わることがある）

## アーキテクチャ

```
体重の入力（2経路。どちらか一方でも併用でも動く）

[A] 手動記録（MCP log_weight / POST /api/weight、OAuth 2.1）──────────────────┐
                                                                              │
[B] Withings 体重計/アプリ（任意）                                            │
      │ 計測（Wi-Fi 同期 or アプリ手入力）                                    │
      ▼                                                                       ▼
    Withings Cloud ──(notify webhook: POST /webhook/withings-{secret})──▶ Cloudflare Worker (Hono)
      ▲                                                                    ├─ webhook_inbox に永続化 → 非同期処理
      └── getmeas / oauth2 ────────────────────────────────────────────────├─ 計測の取り込み/手動記録 → D1 へ保存
                                                                           ├─ 通知バッチ → Slack Webhook(複数)
                                                                           ├─ cron: 5分毎（inbox 回収・通知再送・初期インポート再開）
                                                                           ├─ cron: 日次（Withingsバックフィル・掃除・購読確認）
                                                                           └─ ダッシュボード（PWA + OGP 画像）
                                                                                   │
                                                                                   ▼
                                                                             Cloudflare D1
                                                             (measurements（source: withings|manual） /
                                                              tokens / settings / webhook_inbox /
                                                              notification_batches / 食事・運動・coaching系 ほか)
```

体重トラッキング以外の主要経路:

```
GitHub Actions (coaching.yml, 毎晩23:30 JST・任意機能)
  └─ Claude Agent SDK で講評生成 ──POST /api/coaching──▶ Worker ─▶ D1 (coaching_notes)
                                                          └─ 23:55 の日次ダイジェストに差し込み ─▶ Slack
AIクライアント / ダッシュボード ──OAuth 2.1 (Googleログイン)──▶ /mcp・/api/*(書き込み) ─▶ KV (OAUTH_KV: 認可フロー・トークン)
```

Webhook は受信内容を即座に D1 の inbox テーブルへ永続化して 200 を返し、実際の取り込みは `waitUntil` と cron で非同期に行う。取り込みは Withings の `grpid` をキーにした UPSERT のため、再送・値修正にも冪等。通知は計測ID単位の claim（一意制約）で二重送信を防ぐ。

## 必要なもの

- Cloudflare アカウント（無料プランで OK）
- 通知先 Slack ワークスペースで App 作成・Webhook 発行ができる権限
- Google アカウントと Google Cloud プロジェクト（食事・運動記録・体重の手動記録など書き込み機能で OAuth クライアントを作成する場合。**Withings を使わない場合は体重の記録にも必要**。閲覧だけなら不要）
- Node.js（npm）とターミナル
- **任意**: Withings アカウント（体重計連携を使う場合のみ。**体重計が無くても使える**: 無料の Withings アプリから体重を手入力すれば同じ経路で取り込まれる（手入力 attrib=2 も機器計測 attrib=0 と同様に採用）。Withings をまったく使わない場合も、MCP の `log_weight` か `POST /api/weight` で体重を手動記録すれば全機能が動く）

## セットアップ

### 1. リポジトリの準備

```sh
git clone https://github.com/okash1n/bodylog.git   # または Fork
cd bodylog
npm install
npx wrangler login
cp wrangler.toml.example wrangler.toml
```

`wrangler.toml` は実値を含むため `.gitignore` 済み（誤コミット防止）。以下の `[vars]` をランダム値で埋める。`database_id`（D1）と `id`（KV）は手順4で作成後に記入するため、この時点では空欄（テンプレートのプレースホルダーのまま）でよい。

```sh
openssl rand -hex 16   # → WEBHOOK_PATH_SECRET（Webhook 受信パスの秘匿部分）
openssl rand -hex 8    # → DASHBOARD_SLUG（ダッシュボード URL の slug）
```

| 変数 | 内容 |
|---|---|
| `WEBHOOK_PATH_SECRET` | Webhook パス `/webhook/withings-{WEBHOOK_PATH_SECRET}` のランダム部分。推測防止用 |
| `DASHBOARD_SLUG` | ダッシュボード URL `/d/{DASHBOARD_SLUG}/` の slug。URL を知っている人だけが見られる。**空文字（`""`）にするとドメイン直下（`/`）で配信**（カスタムドメイン運用向け。ホスト名は証明書の透明性ログ等で公開されるため、アクセス制限が必要なら Cloudflare Access などをドメインに後付けする） |
| `TZ_OFFSET_HOURS` | 集計・表示のタイムゾーンオフセット（時間）。既定 `9`（JST）。変更不要ならそのまま |

D1 のバインディング名（`DB`）と KV のバインディング名（`OAUTH_KV`）はコード・CI が参照するため変更しないこと。`database_name` は手順4で `wrangler d1 create` に渡す名前（本手順では `bodylog`）と一致させる。

### 2. Withings アプリ登録（任意: 体重計連携を使う場合のみ）

Withings を使わない場合はこの手順をスキップして手順3へ進む（体重は後述の手動記録で入れる。手順5の `WITHINGS_*` Secrets と手順7の認可も不要）。

1. [developer.withings.com](https://developer.withings.com/) で開発者アカウントを作成する
2. 初回に環境選択（Welcome 画面)が出たら **Europe Cloud** を選ぶ。US Cloud は契約パートナー専用（`Only under contract`）で選択不可。日本からの利用でも Europe Cloud で OK
3. アプリケーション作成に進み、SERVICES では **Public API integration** のみにチェックする（SDK / Cellular / Logistics は契約パートナー専用）
4. 利用規約に同意して **Next**
5. **Information** 画面を入力して **Done**:
   - **TARGET ENVIRONMENT**: `Development` のままでよい（個人利用の範囲なら十分）
   - **APPLICATION NAME / DESCRIPTION**: 任意
   - **REGISTERED URLS**: `https://<Worker URL>/auth/callback` と `https://<Worker URL>/webhook/withings-{WEBHOOK_PATH_SECRET}` を登録する。Worker URL はデプロイ後に確定するため、この時点では仮 URL でも通る（手順6で実 URL に更新する）
   - **YOUR PROJECT LOGO**: 任意（スキップ可）
6. 発行された **Client ID** と **Client Secret** を控える

補足: 登録フローにスコープ選択が表示される場合は `user.info` と `user.metrics` を選択する（不足すると後の認可でエラーになり気づきにくい）。スコープ選択が無い UI の場合は認可 URL 側でリクエストされるため設定不要。

### 3. Slack Webhook 発行（通知先チャンネルごとに繰り返し）

1. [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
2. App の表示名とアイコンを設定（この見た目で通知される）
3. Incoming Webhooks を ON にし、Add New Webhook to Workspace → 通知先チャンネルを選択
4. 発行された **Webhook URL** を控える
5. 別のワークスペースにも通知したい場合は、そのワークスペースごとに繰り返す

### 4. D1 と KV の作成

```sh
npx wrangler d1 create bodylog
# 表示された database_id を wrangler.toml の [[d1_databases]] に記入

npx wrangler d1 migrations apply bodylog --remote

npx wrangler kv namespace create OAUTH_KV
# 表示された id を wrangler.toml の [[kv_namespaces]]（binding = "OAUTH_KV"）に記入
```

`wrangler.toml.example` は KV バインディングを含んだ状態で配布されているため、食事・運動記録の書き込み機能を使う予定がなくても、ここで KV ネームスペースを作成して `id` を記入しておく必要がある（プレースホルダーの `id` のままデプロイすると Cloudflare 側で弾かれる）。Withings のトークンは D1 に保存される（KV は OAuth の認可フロー・トークン保存専用）。Google OAuth クライアントの作成や関連 Secrets の登録は手順9で行う。

### 5. Secrets の登録

初回はまだ Worker が存在しないため、`secret put` 時に「新しい Worker を作成して Secrets を追加するか」の確認が出る。yes と答えるとプレースホルダー Worker が作成され、手順6のデプロイで本体に置き換わる。

```sh
npx wrangler secret put SLACK_WEBHOOKS          # 通知先の JSON 配列（下記）
npx wrangler secret put ADMIN_SLACK_WEBHOOK     # 任意: 管理者アラート送信先。未設定時は SLACK_WEBHOOKS の先頭を使用

# 任意: Withings 連携を使う場合のみ（未設定でも他機能はすべて動く）
npx wrangler secret put WITHINGS_CLIENT_ID      # 手順2の Client ID
npx wrangler secret put WITHINGS_CLIENT_SECRET  # 手順2の Client Secret
npx wrangler secret put SETUP_SECRET            # Withings 認可の入口 /auth/start の保護キー。openssl rand -hex 32 などで生成
```

`SLACK_WEBHOOKS` の形式（`id` は再送管理に使う安定した識別子。後から変えない。並べ替え・URL 差し替えをしても送達記録が壊れないようにするためのもの）:

```json
[
  {"id": "main", "url": "https://hooks.slack.com/services/XXX/YYY/ZZZ", "mode": "both"},
  {"id": "family", "url": "https://hooks.slack.com/services/AAA/BBB/CCC", "mode": "daily", "digest_time": "21:00"},
  {"id": "morning", "url": "https://hooks.slack.com/services/DDD/EEE/FFF", "mode": "daily", "digest_time": "07:00", "digest_target": "previous"}
]
```

通知先ごとのオプション（`mode` 以外はダイジェスト用。すべて省略可）:

| キー | 値 | 動作 |
|---|---|---|
| `mode` | `immediate`（既定） / `daily` / `both` | 計測ごとの即時通知 / 日次ダイジェストのみ / 両方 |
| `digest_time` | `"HH:MM"`（ローカル） | この通知先のダイジェスト送信時刻。省略時は全体設定 `settings.digest_time`（既定 23:55）。5分刻み・最遅 23:55 |
| `digest_target` | `same`（既定） / `previous` | ダイジェストの対象日。`previous` にすると前日のまとめ（朝に送る用途） |

注意: JSON 配列はプロンプトが表示されてから 1 行でそのまま貼り付ける（シェルの引数として渡すと引用符が壊れやすい）。

### 6. デプロイと Registered URLs の更新

```sh
npm run deploy
```

表示された Worker URL（既定は `*.workers.dev`）を控える。Withings 連携を使う場合は、Withings アプリの **REGISTERED URLS** を実 URL に更新する。カスタムドメインを使う場合（後述）は、そのドメインで統一する。

### 7. Withings 認可（任意: 体重計連携を使う場合のみ・初回のみ）

Withings を使わない場合はスキップして手順8へ（`/auth/start` は `WITHINGS_*` Secrets 未設定時に「未設定」エラーページを返すだけで害はない）。

**手順6の URL 更新を確認してから**、ブラウザで以下を開く:

```
https://<Worker URL>/auth/start?key={SETUP_SECRET}
```

仮 URL のまま認可すると callback が失敗し、認可コードの 30 秒制限でやり直しになる。Withings にログインして許可すると、以下が自動で行われる。

1. トークン交換と D1 への保存
2. Withings notify の購読登録（計測のたびに Webhook が飛ぶようになる）
3. 全履歴の初期インポート開始（レート制限を守るため cron の 5 分毎実行で数回に分けて進む。進捗は完了画面とダッシュボードに表示される）

認可が完了したら `npx wrangler secret put SETUP_SECRET` で新しい値に差し替える（`key` はブラウザ履歴やアクセスログに残るため、使った値は使い捨てにするのが安全）。

### 8. 基準日の設定（任意）

通知の「基準日からの変化」の起点日を登録する。未設定の間はそのブロック自体が通知から省略される（エラーではない）:

```sh
npx wrangler d1 execute bodylog --remote \
  --command "INSERT OR REPLACE INTO settings (key, value) VALUES ('baseline_date', '2026-07-01')"
```

日付は `YYYY-MM-DD`。変更したいときも同じコマンドでよい（再デプロイ不要）。

### 9. 書き込み機能（食事・運動の記録と体重の手動記録）のセットアップ

メニュー・食事記録・運動記録の**閲覧**（`/api/menus` `/api/meals` `/api/meals/daily` `/api/exercise/menus` `/api/exercise/logs` `/api/exercise/daily`、ダッシュボードの食事・運動タブ表示）は追加設定なしで動く。**記録の書き込み**（ダッシュボードでの入力、`{base}/api/*` の POST/PATCH/DELETE（`{base}/api/weight` を含む）、MCP の書き込みツール）は Google アカウントによる OAuth 2.1 認可が必要で、以下を設定しないと `/authorize` が実行時エラーになる（KV ネームスペースは手順4で作成済み）。**Withings を使わない場合、体重の記録にはこの手順が必須**。

1. 新規の Google Cloud プロジェクトの場合は、先に **OAuth 同意画面**を構成する（User type: External、アプリ名等を入力）。公開ステータスが「テスト中（Testing）」の間は、`OWNER_EMAILS` に入れる予定の Google アカウントを**テストユーザーに追加**すること（追加しないとログインが 403 access_denied で拒否され、`OWNER_EMAILS` のチェック以前に失敗する）

2. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) で OAuth クライアントを作成する（アプリケーションの種類は「ウェブ アプリケーション」）:
   - **承認済みのリダイレクト URI** に `https://<デプロイ先のドメイン>/authorize/callback` を追加する（例: `https://weight.example.com/authorize/callback`。ドメインは手順6でデプロイした Worker のもの、カスタムドメインを使う場合はそちら）
   - 発行された **クライアント ID** と **クライアント シークレット** を控える

3. Secrets を登録する:

   ```sh
   npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID      # 上記 9-2 で発行したクライアントID
   npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET  # 上記 9-2 で発行したクライアントシークレット
   npx wrangler secret put OWNER_EMAILS                # 書き込みを許可するGoogleアカウントのメール（カンマ区切り。例: "me@example.com"）
   ```

`OWNER_EMAILS` に含まれないメールでログインした場合、Google 認証自体は成功しても 403 で拒否される（Google アカウントを持っているだけでは書き込めない）。CI（GitHub Actions）を使っている場合は、手順1・4で更新した `wrangler.toml` を `gh secret set WRANGLER_TOML < wrangler.toml` で反映すること（後述の「自動デプロイ」参照）。

### 10. 体重の手動記録（Withings を使わない場合の入力経路）

手順9の OAuth セットアップが済んでいれば、体重は次のどちらでも記録できる（Withings 連携と併用も可）:

- **MCP（推奨）**: Claude / ChatGPT などのクライアントで「今朝 83.4kg だった」と伝えると `log_weight` ツールで記録される（体脂肪率も言えば除脂肪体重を導出して保存し、BMR 計算にも使われる）
- **REST API**: OAuth の Bearer トークンで `POST {base}/api/weight` を叩く（iOS ショートカット等の自動化向け）:

  ```sh
  curl -X POST "https://weight.example.com/api/weight" \
    -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
    -d '{"weight_kg": 83.4, "fat_ratio": 28.3}'   # fat_ratio と measured_at は任意
  ```

  （`DASHBOARD_SLUG` 設定時のパスは `https://<ホスト>/d/{slug}/api/weight`）

手動記録は `measurements` に `source='manual'` で保存され、グラフ・通知・BMR・実効消費の推定など読み取り側はすべて Withings 由来の計測と同じ扱いになる。入力ミスは `DELETE {base}/api/weight/{id}` で消せる（Withings 由来の行は削除不可。`{id}` は記録時の応答か `{base}/api/raw` の明細で確認でき、ダッシュボードの「計測明細」表でもログイン中なら削除ボタンが出る）。

## カスタムドメイン運用（任意）

`*.workers.dev` の長い URL を避けたい場合、Cloudflare に登録済みのゾーンがあればカスタムドメインで配信できる。

1. `wrangler.toml` に以下を追加してデプロイ（DNS・証明書は自動設定される）:

   ```toml
   routes = [
     { pattern = "weight.example.com", custom_domain = true }
   ]
   workers_dev = false   # 任意: workers.dev URL を無効化してドメインを一本化
   ```

2. `DASHBOARD_SLUG = ""` にするとダッシュボードがドメイン直下（`https://weight.example.com/`）で配信される
3. （Withings 連携時のみ）Withings アプリの REGISTERED URLS を新ドメインに更新する
4. （Withings 連携時のみ）notify 購読の付け替えは日次 cron が自動で行う（`settings.public_origin` は認可時・通知時のリクエスト origin から更新される。即時に切り替えたい場合は再認可する）

## アクセス制御（READ_ACCESS）

閲覧範囲を `wrangler.toml` の `READ_ACCESS` で選べる（変更後は再デプロイ。CI利用時は `WRANGLER_TOML` Secret も更新）:

| モード | 閲覧（グラフ・API読み取り） | 記録（書き込み） |
|---|---|---|
| `"public"`（既定） | 誰でも可（URLを知っている人。従来どおり） | オーナーの Google ログイン必須 |
| `"private"` | **オーナーの Google ログイン必須** | 同左 |

`private` の動作と注意:

- ダッシュボードを開くとログイン画面になり、`OWNER_EMAILS` のアカウントでログインすると閲覧できる。アプリの外枠（HTML/JS）は配信されるが、データは一切出ない
- 保護されるのは `{base}/api/*` の読み取り・`llms.txt`・`openapi.json`・`og.png`。MCP・書き込み・Withings webhook・ログイン用エンドポイントは従来どおり
- **Slack通知のグラフ画像を維持するには** `npx wrangler secret put OG_ACCESS_TOKEN`（`openssl rand -hex 32` 等）を登録する。通知内の画像URLにこのキーが付いて例外的に通る（露出先は自分のSlackチャンネルのみ。漏れた疑いがあればローテーションすれば旧URLは無効になる）。未設定の場合、通知は画像なしで送られる（それ以外は正常動作）
- AIコーチングは対応済み（ジョブが `COACHING_API_SECRET` で読み取る）。追加設定不要
- **使えなくなるもの**: ChatGPT カスタムGPT（Actions）と `llms.txt` のURL渡しなど無認証のAI読み取り、リンクプレビューのグラフ画像（OGP）。AIからの照会は MCP（OAuth）を使う
- 「アプリが存在すること」自体は隠れない（ホスト名は証明書の透明性ログ等で公開される）。存在ごと隠したい場合は Cloudflare Access などドメイン前段の保護を検討する

## エンドポイント一覧

ダッシュボード配下のパスは、`DASHBOARD_SLUG` 設定時は `/d/{DASHBOARD_SLUG}/` 配下、空文字時はドメイン直下（`/`）になる。書き込み（POST/PATCH/DELETE）は読み取りと同じ `{base}/api/*` パスにメソッドで同居し、ハンドラごとに Bearer トークン（OAuth）を検証して個別に保護する。MCP（`/mcp`）と OAuth 認可フロー（`/authorize` `/token` `/register`）は `DASHBOARD_SLUG` の設定にかかわらず常にドメイン直下で動く。

| ルート | 役割 |
|---|---|
| `GET /auth/start?key={SETUP_SECRET}` | Withings 認可の開始。key 不一致・未設定は 404 |
| `GET /auth/callback` | 認可コールバック。トークン保存・購読登録・初期インポート投入 |
| `GET/HEAD/POST /webhook/withings-{WEBHOOK_PATH_SECRET}` | Withings notify 受信。GET/HEAD は疎通確認用に即 200 |
| `GET /authorize` / `POST /token` / `POST /register` | 食事・運動記録の書き込みAPI、および MCP 用 OAuth 2.1（`@cloudflare/workers-oauth-provider`）。`/authorize` は Google ログインでオーナーのメールを確認する |
| `POST /mcp` | MCP（Model Context Protocol）エンドポイント。OAuth 認証必須。読み取り7ツール + 書き込み6ツール（`log_meal` `create_menu` `log_exercise` `create_exercise_menu` `set_goal` `log_weight`） |
| `GET {base}/` | ダッシュボード本体（PWA） |
| `GET {base}/api/measurements?from=&to=` または `?days=N` | 日次系列 JSON（日平均 + 7日移動平均） |
| `GET {base}/api/raw?from=&to=` または `?days=N` | 計測明細 JSON（1計測=1行、新しい順） |
| `GET {base}/api/status` | 初期インポート状況・最終同期時刻 |
| `GET {base}/api/summary` | 要約 JSON（最新計測・直近7日平均・前週比・基準日比・今日の食事摂取量・目標（goal）・最終同期） |
| `GET {base}/api/menus?q=` | 食事メニュー（マスタ）一覧・検索（利用頻度順: 直近90日の記録回数→最終使用→名前）。認証不要 |
| `GET {base}/api/meals?from=&to=` または `?days=N` | 食事記録 JSON（メニュー名・倍率・実効kcal/PFC付き）。認証不要 |
| `GET {base}/api/meals/daily?from=&to=` または `?days=N` | 日次の摂取カロリー・PFC合計 JSON。認証不要 |
| `GET {base}/api/exercise/menus?q=&category=` | 運動種目（マスタ）一覧・検索（利用頻度順）。`category=cardio\|strength` で絞り込み。認証不要 |
| `GET {base}/api/exercise/logs?from=&to=` または `?days=N` | 運動記録 JSON（有酸素は消費kcal、筋トレはセット明細・総ボリューム付き）。認証不要 |
| `GET {base}/api/exercise/daily?from=&to=` または `?days=N` | 日次の基礎代謝（BMR推定）・運動消費kcal・総ボリューム JSON。期間内の全日を返す（運動が無い日も含む）。認証不要 |
| `GET {base}/api/coaching/latest` | AIコーチの最新講評（daily=日次 / weekly=週次。未生成は null）。認証不要 |
| `GET {base}/api/coaching?from=&to=` または `?days=N` | AIコーチ講評の履歴（新しい順、最大200件）。認証不要 |
| `GET {base}/api/metabolism` | 直近28日の実測データからの実効消費カロリー推定（摂取記録が8割未満などの期間は `insufficient_data`）。認証不要 |
| `POST {base}/api/coaching` | AIコーチ講評の保存（GitHub Actions のジョブ専用）。`Authorization: Bearer {COACHING_API_SECRET}` で保護。secret 未設定の環境では 404 |
| `POST {base}/api/menus` / `PATCH {base}/api/menus/:id` / `POST {base}/api/menus/:id/archive` / `POST {base}/api/menus/:id/unarchive` | 認証必須（OAuth）。メニュー（マスタ）の作成・更新・アーカイブ切替 |
| `POST {base}/api/meals` / `PATCH {base}/api/meals/:id` / `DELETE {base}/api/meals/:id` | 認証必須。食事記録の作成・更新・削除 |
| `POST {base}/api/exercise/menus` / `PATCH {base}/api/exercise/menus/:id` / `POST {base}/api/exercise/menus/:id/archive` / `POST {base}/api/exercise/menus/:id/unarchive` | 認証必須。運動種目（マスタ）の作成・更新・アーカイブ切替 |
| `POST {base}/api/exercise/logs` / `DELETE {base}/api/exercise/logs/:id` | 認証必須。運動記録の作成・削除 |
| `POST {base}/api/weight` / `DELETE {base}/api/weight/:id` | 認証必須。体重の手動記録の作成・削除（`weight_kg` 必須 20-300、`fat_ratio` 任意 3-75%、`measured_at` 任意 ISO8601。削除は `source='manual'` の行のみ） |
| `GET {base}/llms.txt` | AI向けのAPI案内（プレーンテキスト） |
| `GET {base}/openapi.json` | OpenAPI 3.1 定義（ChatGPT カスタムGPTの Actions 登録用） |
| `GET {base}/og.png` | OGP 画像（直近30日の体重グラフを PNG 生成。依存ライブラリなしの自前エンコーダ） |
| 上記以外 | 404（全レスポンスに `X-Robots-Tag: noindex` 付与） |

cron トリガー:

- `*/5 * * * *` — webhook inbox の処理、通知の再送、初期インポートの再開、日次ダイジェストの送信判定
- `15 20 * * *`（05:15 JST） — 日次バックフィル、古い行の掃除、notify 購読の確認・復旧


## ダッシュボード

- **実測⇔7日平均のワンクリック切替**: 3指標（体重・体脂肪率・除脂肪体重）を一括で切り替える。凡例タップで系列ごとの表示切替も可能。選択は localStorage に保存される
- **期間プリセット**: 1M / 3M / 1Y / カスタム。点の値は近くに常時表示（点が多い期間は各系列の最新点のみ）
- **カロリー統合ビュー**: 体重グラフに、食事タブの摂取カロリー（棒・右軸）、消費カロリー（基礎代謝＋運動消費、棒）、カロリー収支（摂取−消費、線）を重ねて表示する。「カロリーを重ねる」トグルで切替（既定オン）、ツールチップに PFC 内訳・消費の内訳（基礎代謝/運動）。日次ダイジェスト（Slack）にも当日の摂取カロリーが1行入る
- **表で見る**: 日次集計（1日1行=日平均、摂取/消費/カロリー収支のカロリー列つき）と計測明細（1計測=1行、時刻付き。カロリー列は日次集計とは粒度が違うため非表示）を切替できる
- **PWA**: スマホで「ホーム画面に追加」するとスタンドアロンで起動する
- **テーマ**: OS 設定に追従 + 手動トグル
- **食事タブ**: メニュー検索・当日の記録一覧・記録入力ができる。記録入力には「ログイン」ボタンから Google アカウントで OAuth 2.1（PKCE）認可する（オーナーのメールが `OWNER_EMAILS` にある場合のみ許可）
- **目標と実効消費**: MCP の `set_goal` で目標体重・目標脂肪量を設定すると、グラフに目標線（水平破線）、カードに「目標まで」が表示される。摂取記録が直近28日の8割以上あると「実効消費（推定）」カードも表示される（カロリー収支と実際の体重変化から逆算した参考値）
- **運動タブ**: 種目検索・当日の記録一覧・記録入力ができる（有酸素は時間、筋トレはセット明細 reps×weight。自重種目は記録時の体重を負荷に算入）。筋トレの総ボリュームは除脂肪体重の推移と重ねたグラフで確認できる。記録入力は食事タブと同じ Google アカウントでのログインが必要

グラフ・表・通知の集計はすべて「日単位（`TZ_OFFSET_HOURS` のローカル日付境界）」で行う。1日に複数回計測した場合、日次系列はその日の平均になる。

## AI から使う

ChatGPT・Claude などのAIクライアントから体重推移・食事記録・運動記録を照会できる。**読み取りはすべて認証不要**（公開範囲はダッシュボードと同じ）。食事・運動の**記録・メニュー/種目登録**（書き込み）はオーナーの Google アカウントによる OAuth 2.1 認可が必要。

- **URLを渡して読ませる**: `https://weight.example.com/llms.txt` にエンドポイント一覧と使い方が載っているので、「このURLを見て最近の体重推移を教えて」だけで動く。要約は `/api/summary`、時系列は `/api/measurements?days=90` のように相対期間で取れる。食事記録は `/api/menus` `/api/meals` `/api/meals/daily`、運動記録は `/api/exercise/menus` `/api/exercise/logs` `/api/exercise/daily` で照会できる
- **ChatGPT カスタムGPT（Actions）**: GPT編集画面の Actions で「URLからインポート」に `https://weight.example.com/openapi.json` を指定する。認証は「なし」（読み取り専用）
- **MCP クライアント**: `https://weight.example.com/mcp` を OAuth 対応のコネクタとして登録する（MCP はドメイン直下の単一エンドポイントで、`DASHBOARD_SLUG` の設定にかかわらずここに固定。OAuth 認可必須）。ChatGPT はコネクタ作成時に認証方式で「OAuth」を選ぶ。Claude Code は `claude mcp add --transport http bodylog https://weight.example.com/mcp`（接続時にブラウザで Google ログイン画面が開く）。ツールは読み取り7つ（体重: `get_weight_summary` / `get_daily_series` / `get_raw_measurements`、食事: `search_menus` / `get_meal_logs`、運動: `search_exercise_menus` / `get_exercise_logs`）＋書き込み6つ（`log_meal` 食事記録 / `create_menu` メニュー登録 / `log_exercise` 運動記録 / `create_exercise_menu` 種目登録 / `set_goal` 目標設定 / `log_weight` 体重の手動記録）。**記録は必ず登録済みのメニュー/種目から行うこと**（無ければ先に `create_menu` / `create_exercise_menu` で登録してから記録する。AI が判断でメニュー・種目を新規作成しないよう、登録前にユーザーへ確認するのが安全）

単位は kg（`fat_ratio` のみ %）、日付境界は `TZ_OFFSET_HOURS` のローカル日付。`fat_mass` は `weight - fat_free_mass` の導出値。食事記録の `calories` は kcal、`protein_g`/`fat_g`/`carbs_g` は g。日次の栄養素合計（`/api/meals/daily`）のうち `protein_g`/`fat_g`/`carbs_g` は栄養素が入力済みの記録のみの部分合計（未入力の記録は含まない）。`calories` は全記録の合計。PFC比率を出す場合は P×4 / F×9 / C×4 kcal に換算し3者の合計を100%として正規化すること（登録カロリーで割ると食物繊維等の差で100%を超えうるため不可）。運動記録の消費kcal（`/api/exercise/logs` の `calories`）は有酸素のみ算出（METs×体重×時間×1.05）。`/api/exercise/daily` の `bmr` は Katch-McArdle推定の基礎代謝（実測除脂肪体重が一度も無い期間は null）で、総消費は `bmr + calories_burned`。

## AIコーチング（定期講評）

この機能は**任意**で、Claude Pro/Max サブスクリプションが必要。使わない場合は下記 Secrets を登録しなければよい（Secrets 未登録のときワークフローは失敗ではなくスキップになる）。

毎晩 23:30 JST に GitHub Actions（`.github/workflows/coaching.yml`）が直近14日のデータを分析し、**当日の総括＋週間トレンド評価＋明日の行動方針**をまとめたAI講評を生成する（週次の別枠は無く、週間視点を毎日の総括に含める）。生成は Claude Agent SDK をサブスクリプションの OAuth トークンで動かすため、API の従量課金は発生しない。講評は `POST /api/coaching` で保存され、**23:55 の日次ダイジェスト（Slack）の本文に差し込まれる**（AI講評の単独Slackメッセージは無い）。ダッシュボードの「AIコーチ」カードにも表示される。方針は「体組成改善（脂肪量を減らし、除脂肪体重を維持・増加）」。`set_goal` で数値目標（体重・脂肪量）を設定している場合は目標との差を、実効消費の推定（`/api/metabolism`）が成立している場合はその値を、講評の評価軸に使う。

セットアップ（GitHub Secrets を3つ登録する）:

| Secret | 内容 |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` で発行するサブスク用トークン（要 Claude Pro/Max。約1年有効。失効したら再発行して更新） |
| `COACHING_API_SECRET` | `openssl rand -hex 32` 等で生成した値。Worker 側にも `npx wrangler secret put COACHING_API_SECRET` で**同じ値**を登録する |
| `BODYLOG_BASE_URL` | ダッシュボード基点までのURL。`DASHBOARD_SLUG` 設定時は `https://<ホスト>/d/{DASHBOARD_SLUG}`、空文字運用時は `https://weight.example.com`（実URLをリポジトリに書かないため Secret で渡す） |

補足:

- 手動実行: Actions の「AI Coaching」→ Run workflow（当日分を再生成・上書きする）
- GitHub の schedule は数分〜十数分遅れることがあり、23:55 のダイジェストに生成が間に合わなかった日は数値のみで配信される（講評はダッシュボードには出る）
- パブリックリポジトリの schedule は60日間コミットが無いと自動停止する（GitHub 仕様）。止まったら Actions 画面から有効化し直す
- Actions のログは公開されるため、ジョブは講評本文・健康データをログに出力しない設計になっている
- トークン失効などでジョブが失敗すると GitHub からワークフロー失敗の通知が届く

## Slack 通知

計測を取り込むと Block Kit で通知する。数値はインラインコード、見出しは太字、データ欠如は `—`。

通知は2種類あり、通知先ごとに `mode` で選べる。

**即時通知**（計測を取り込むたび）:

- 最新計測値（体重・脂肪量・除脂肪体重、参考として体脂肪率）
- 7日間平均と前ターム比（直近7暦日 vs その前の7暦日）
- 基準日からの変化（`baseline_date` 設定時のみ）
- ダッシュボードリンク + **直近30日のグラフ画像**

**日次ダイジェスト**（既定 23:55 ローカル、その日に計測があった日のみ）:

- その日の平均値（体重・脂肪量・除脂肪体重）と計測回数
- 当日の摂取・消費（基礎代謝＋運動）・カロリー収支
- AIコーチの当日総括と明日の行動方針（23:30 生成分。生成が間に合わない日は省略）
- 7日間平均と前ターム比・基準日からの変化・ダッシュボードリンク・グラフ画像

送信時刻は D1 の設定で変更できる（再デプロイ不要。5分刻み・最遅 23:55。5分毎 cron が判定するため）:

```sh
npx wrangler d1 execute bodylog --remote \
  --command "INSERT OR REPLACE INTO settings (key, value) VALUES ('digest_time', '21:00')"
```

補足: 送信時刻の時点で当日の計測が 0 件ならスキップする（その後同日中に計測が届けば、その時点で送られる）。翌日への持ち越しはしない。

グラフは画像ブロックとして通知に直接埋め込まれる（Incoming Webhook のメッセージ内リンクは Slack 仕様で自動展開されないため）。URL を人が手貼りした場合は OGP でも展開される。同一 URL の展開はキャッシュされるため、リンクには計測日のキャッシュバスター（`?v=`）が付く。

## 動作確認チェックリスト

- [ ] ダッシュボードを開くとグラフが表示される（Withings 利用時は初期インポート済みの過去データ、Withings 無しなら手順10 で記録した分）
- [ ] `{base}/api/measurements?from=<開始日>&to=<終了日>` が JSON を返す
- [ ] （Withings利用時）体重計に載る → 数分以内に全チャンネルへ Slack 通知（グラフ画像付き）が届き、D1 にも行が増えている:

  ```sh
  npx wrangler d1 execute bodylog --remote --command "SELECT COUNT(*) FROM measurements"
  ```

- [ ] （Withings無しの場合）MCP の `log_weight`（または `POST {base}/api/weight`）で体重を記録 → ダッシュボードに反映され、数分以内に Slack 通知が届く

- [ ] スマホでダッシュボードを「ホーム画面に追加」→ スタンドアロン起動でグラフが見える
- [ ] `key` なし（または誤った key）で `/auth/start` にアクセスすると 404 になる
- [ ] 翌日以降、日次バックフィル（cron）がエラーなく動いていることを `npx wrangler tail` で確認
- [ ] （書き込み機能利用時）食事タブの「ログイン」から Google 認可でき、テスト記録を1件作成・削除できる（`OWNER_EMAILS` 外のアカウントは 403 になる）
- [ ] （AIコーチング利用時）Actions の「AI Coaching」を Run workflow で手動実行 → 成功し、`{base}/api/coaching/latest` の daily が null でなくなり、ダッシュボードの「AIコーチ」カードに表示される
- [ ] （MCP利用時）`claude mcp add --transport http bodylog https://<ホスト>/mcp` で接続し、Google ログイン後に `get_weight_summary` が動く

## 自動デプロイ（GitHub Actions）

`main` への push で「typecheck + テスト → D1 マイグレーション → デプロイ」が自動実行される（`.github/workflows/deploy.yml`）。PR ではテストのみ実行。下記 Secrets が未設定の間、デプロイジョブはスキップされる（テストは example 設定で動く）。

> **Fork した場合の注意**: Fork 直後は Actions が無効のため、リポジトリの **Actions タブで有効化**する必要がある。また schedule トリガー（AIコーチングの `coaching.yml`）はパブリックリポジトリの Fork ではデフォルト無効のため、使う場合は Actions タブの「AI Coaching」で個別に有効化する（clone して自分のリポジトリとして push した場合は最初から有効）。パブリックリポジトリの schedule は60日間コミットが無いと自動停止する点にも注意。

利用するには GitHub リポジトリに以下の Secrets を登録する:

| Secret | 内容 |
|---|---|
| `WRANGLER_TOML` | 実値入り `wrangler.toml` の中身。`gh secret set WRANGLER_TOML < wrangler.toml` で登録 |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API トークン。テンプレート「Edit Cloudflare Workers」に **Account → D1 → Edit** 権限を追加して作成。カスタムドメイン運用時は対象ゾーンへのZone権限も必要 |

ローカルの `wrangler.toml` を変更したら（ドメイン変更・slug 変更など）、`gh secret set WRANGLER_TOML < wrangler.toml` で CI 側の Secret も更新すること。忘れると CI が古い設定でデプロイして手元の変更が巻き戻る。

## 運用

### 日次バックフィル（Withings 連携時のみ）

日次 cron が Withings の `lastupdate` API（前回同期時刻以降の差分取得）で取りこぼしを回収する。Webhook が落ちた期間があっても翌日には自動で埋まるため、通常は手動対応不要。Withings 未連携（トークン未保存）の環境ではこのステップと購読確認は静かにスキップされる。

### 再認可と refresh_token の 8 時間ルール

Withings のトークンは以下の性質を持つ。

- access_token の寿命は 3 時間。失効時は refresh_token で自動更新される
- refresh_token は**ローテーション制**: 使用すると失効し、新しい refresh_token が発行される。また**新しい refresh_token の発行から 8 時間経つと旧 refresh_token は無効になる**

Worker が保存している refresh_token が無効化される（例: D1 を古いバックアップから復元して旧トークンに巻き戻った、別の場所で同じアプリの refresh を実行した）と、自動更新のチェーンが切れて同期が止まる。この場合、管理者アラート（refresh 失敗）が届くので、以下で再認可する。

```
https://<Worker URL>/auth/start?key={SETUP_SECRET}
```

再認可してもデータは `grpid` キーの UPSERT なので重複しない。既存トークンと userid が異なる Withings アカウントで認可しようとした場合は 403 で拒否される（上書き防止）。

### ダッシュボード slug の再発行

URL が漏れた場合などは slug を変更する。

1. `openssl rand -hex 8` で新しい slug を生成
2. `wrangler.toml` の `DASHBOARD_SLUG` を書き換えてデプロイ（CI 利用時は `WRANGLER_TOML` Secret も更新）
3. 旧 URL は即 404 になる。ブックマーク・PWA・Slack 通知内リンクはすべて新 URL に切り替わる（通知は次回送信分から）

`WEBHOOK_PATH_SECRET` を変更した場合は、日次 cron の購読確認が旧 callback を revoke して新 URL で再購読する。即時反映したい場合は再認可（`/auth/start`）を行う。Withings アプリの REGISTERED URLS の更新も忘れないこと。

### D1 バックアップ

長期の健康データなので二段構えを推奨する。

1. **定期エクスポート**: 定期ジョブで以下を実行し、SQL ダンプを保管する（`backup*.sql` は git にコミットしない）

   ```sh
   npx wrangler d1 export bodylog --remote --output backup-$(date +%Y%m%d).sql
   ```

2. **Time Travel**: D1 は過去 **30 日**の任意時点へ復元できる（[公式ドキュメント](https://developers.cloudflare.com/d1/reference/time-travel/)）

   ```sh
   npx wrangler d1 time-travel restore bodylog --timestamp=<unix-timestamp>
   ```

注意: バックアップから復元すると `tokens` テーブルの refresh_token が古い値に巻き戻り、8 時間ルールにより無効になっている可能性が高い。復元後は `/auth/start` での再認可を前提とすること。

### TZ_OFFSET_HOURS の変更

`wrangler.toml` の `TZ_OFFSET_HOURS` を書き換えてデプロイする（例: `"8"` = 中国標準時、`"-5"` = 米東部標準時）。

- 計測データは UTC で保存されており、オフセットは集計・表示時にのみ適用される。変更すると過去データも新しいオフセットで再集計される
- **固定オフセットであり DST（夏時間）には対応しない**。DST のある地域では季節により日付境界が 1 時間ずれる
- 範囲は -14〜+14。不正値・未設定時は 9（JST）にフォールバックする

### SETUP_SECRET のローテーション

```sh
openssl rand -hex 32               # 新しい値を生成
npx wrangler secret put SETUP_SECRET   # 新しい値を入力
```

即時反映され、旧キーでのアクセスは 404 になる。既存のトークン・購読・データには影響しない（`SETUP_SECRET` は認可開始の入り口を守るだけで、認可済みの動作には使われない）。

### レート制限（推奨）

カスタムドメイン運用（自分のゾーンに Worker を載せている場合）が前提。`*.workers.dev` のみの運用ではゾーンの WAF/レート制限は設定できない。`/authorize` `/register` `/token`（OAuth 認可フロー）は総当たり・乱用の対象になりうるため、Cloudflare のゾーンのレート制限ルールを設定することを推奨する（無料プランでもゾーンごとに1ルールまで利用できる）。余裕があれば公開 GET API 全般にも広げるとよい。これはアプリのコードではなく Cloudflare ダッシュボード側（ゾーンの Security / WAF）で設定するもので、Fork したユーザーが自分のゾーンに対して個別に行う必要がある。しきい値は実際のトラフィックに合わせて調整すること。

## うまくいかないとき

- **通知が来ない**: `npx wrangler tail` でログを確認。Webhook 購読は `/auth/start?key={SETUP_SECRET}` をやり直すと再登録される（既存購読との重複はコード側で防止）
- **体重計で「x」（不明ユーザー）になる**: 前回計測から体重が約 5kg 以上変わっていると体重計がユーザーを認識できない。Withings アプリに出る「未割り当ての計測」を自分に割り当てると取り込まれ、以降は自動認識に戻る。なお未割り当てのまま同期された計測は帰属が曖昧（`attrib`）なため本システムは意図的に除外する
- **再認可を求めるエラー**: refresh_token が失効した状態。手順7を再実行する。失効時は管理者向け Slack アラートも届く
- **初期インポートが途中で止まった**: 放置してよい（5分毎の cron が未完了分を自動で再開する）。急ぐ場合は `npx wrangler tail` でエラーを確認
- **別の Withings アカウントで認可してしまった**: 保存済み userid と異なる認可は拒否される。正しいアカウントでログインし直して手順7を再実行
- **認可後にエラー画面になる**: Withings アプリの REGISTERED URLS が実際の Worker URL に更新されているか確認。仮 URL のままだと認可コードの交換に失敗する
- **ダッシュボードが 404**: URL の slug が `wrangler.toml` の `DASHBOARD_SLUG` と一致しているか確認（空文字ならドメイン直下）
- **Slack 通知は来るがグラフが空**: 初期インポートが未完了（ダッシュボードの取り込み状態を確認）、または表示期間にデータがないのが典型。期間プリセットを変えて確認する。データが 1 日分しかない間は点のみの表示になる
- **通知が一部のチャンネルだけ届かない**: Slack 側の 429/5xx は自動で再試行されるので少し待つ。再試行上限を超えると管理者向けアラートが届くので、Webhook URL の失効を確認して `SLACK_WEBHOOKS` を更新する
- **CI のデプロイで手元の変更が巻き戻った**: `WRANGLER_TOML` Secret が古い。`gh secret set WRANGLER_TOML < wrangler.toml` で更新して再実行する
- **体重を手動記録できない**: `OWNER_EMAILS` に含まれないアカウントでログインしていると 403（Google 認証自体は成功する点に注意）。Bearer トークンが切れていると 401（MCP クライアントは再接続、API は再認可でトークンを取り直す）。400 はバリデーション（`weight_kg` 20-300 / `fat_ratio` 3-75% / `measured_at` が未来）を確認

## 開発

```sh
npm run dev        # ローカル起動（wrangler dev）
npm test           # vitest（@cloudflare/vitest-pool-workers 上で実行）
npm run typecheck  # tsc --noEmit
```

`npm run deploy` で手元からもデプロイできるが、通常は main への push で CI に任せる。

## ライセンス

MIT License。詳細は [LICENSE](./LICENSE) を参照。
