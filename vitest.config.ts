import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// wrangler.toml の [[rules]] type="Text"（src/dashboard 配下のアセット）は
// vitest-pool-workers が wrangler 設定から解釈するため、Vite側の追加設定は不要。
export default defineConfig({
  plugins: [
    // インストール済み @cloudflare/vitest-pool-workers 0.20.x（vitest 4 対応）には
    // 旧 defineWorkersConfig / poolOptions.workers API が無いため、plugin 形式で指定する。
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
      return {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          kvNamespaces: ['OAUTH_KV'],
          bindings: {
            TEST_MIGRATIONS: migrations,
            // wrangler.toml の実値に依存しないようテスト用slugを固定する
            DASHBOARD_SLUG: 'testslug',
            SETUP_SECRET: 'test-setup',
            SLACK_WEBHOOKS: '[{"id":"main","url":"https://hooks.slack.com/services/T0/B0/X"}]',
            WITHINGS_CLIENT_ID: 'cid',
            WITHINGS_CLIENT_SECRET: 'csec',
            GOOGLE_OAUTH_CLIENT_ID: 'gcid',
            GOOGLE_OAUTH_CLIENT_SECRET: 'gsec',
            OWNER_EMAILS: 'owner@example.com',
            // ローカルwrangler.tomlのGITHUB_DISPATCH_REPO実値がテストへ流れ込まないよう空で固定する
            // （トークン（Secret）が無い限りdispatchはno-opだが、convention どおり実値非依存にする）
            GITHUB_DISPATCH_REPO: '',
          },
        },
      };
    }),
  ],
  test: {
    // e2e/ は Playwright 専用（npm run test:e2e）。vitest が *.spec.ts を拾うと
    // Playwright ランナー前提の import で失敗・ハングするため除外する
    exclude: ['**/node_modules/**', 'e2e/**'],
    setupFiles: ['./test/apply-migrations.ts', './test/setup-cleanup.ts'],
    // vitest-pool-workers はファイルごとに独立した worker/ストレージで実行するため並列可
    // （resetTables は各ファイル内の直列実行にのみ必要）
    fileParallelism: true,
    // lease 待ち（最大 LIMITS.LEASE_WAIT_MS）を含むテストの余裕を確保
    testTimeout: 15_000,
  },
});
