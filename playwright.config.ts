/**
 * browser E2E スモーク（PR-007b 初版）。wrangler dev（ローカルD1、実値なしの wrangler.e2e.toml）
 * に対して read-only の主要 journey を検証する。書き込み（OAuth）系は対象外。
 * 実行: npm run test:e2e（前段の e2e/setup-db.mjs が migration 適用と合成データの seed を行う。
 * playwright の globalSetup は webServer より後に走るため使わない）
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:8787',
    // 端末timezone非依存の検証: あえてJST以外に固定する（サーバーの日付境界は+9。
    // 端末ローカル日付に依存する実装だと「今日」の記録が消える回帰をここで検知する）
    timezoneId: 'UTC',
  },
  webServer: {
    command: 'npx wrangler dev --config wrangler.e2e.toml --port 8787 --persist-to .wrangler/e2e',
    url: 'http://127.0.0.1:8787/api/status',
    // seed 済みDBで起動する前提のため常に新規起動（残存devプロセスの古いDBハンドルを避ける）
    reuseExistingServer: false,
    timeout: 90_000,
  },
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
});
