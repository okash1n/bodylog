# AGENTS.md

AIコーディングエージェント向けのリポジトリ固有ルール（Claude Code は CLAUDE.md 経由でこのファイルをインポートして読む）。

## 最重要: これはパブリックリポジトリ

実環境の値を、リポジトリ内のあらゆる場所（コード・docs・README・テスト・コミットメッセージ・Issue/PR）に**一切書かない**こと。対象:

- 本番のカスタムドメイン / ホスト名（ダッシュボードは noindex + 非リンクで発見可能性を下げる運用のため、リポジトリに書くと台無しになる）
- Cloudflare のアカウント名・アカウントID・D1 データベースID などのリソース識別子
- シークレット値（`WEBHOOK_PATH_SECRET` / `SETUP_SECRET` / Slack Webhook 実URL / Withings クライアント情報 など。名前の参照はOK、値はNG）
- 個人情報・実測データのダンプ

ルール:

- ドキュメント・テストのURL例は `weight.example.com`（`wrangler.toml.example` と同じ）を使う
- 実値は gitignore 済みのローカル `wrangler.toml` と GitHub Secrets（`WRANGLER_TOML` / `CLOUDFLARE_API_TOKEN`）にのみ置く
- コミット前に実値の混入を検索で確認する（本番ドメイン・シークレット値・32桁hex/UUID形式のID）。実値そのものはこのファイルにも書かないこと
- 誤ってコミットした場合: push 前なら amend で除去し、`git reflog expire --expire-unreachable=now --all && git gc --prune=now` で到達不能オブジェクトも消す。push 済みなら値のローテーションを含めてユーザーに相談する

## 開発の基本

- 検証: `npm run typecheck` と `npm test`（vitest + workers pool。テストはローカル `wrangler.toml` を参照する）
- デプロイ: main への push で GitHub Actions がテスト → D1マイグレーション → `wrangler deploy` を実行する（push = 本番デプロイ）
- テストで日付に依存する計測を seed するときは、日付境界のフレークを避けるため固定時刻 `${ymd}T03:00:00Z`（= JST 正午）を使う
- コミットは Conventional Commits 形式。`Co-Authored-By` は入れない
