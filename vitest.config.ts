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
      const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
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
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
    // 全テストが同一 D1 を共有しても干渉しないようファイル並列を無効化
    fileParallelism: false,
    // lease 待ち（最大 LIMITS.LEASE_WAIT_MS）を含むテストの余裕を確保
    testTimeout: 15_000,
  },
});
