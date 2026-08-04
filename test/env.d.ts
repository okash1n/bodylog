import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Env as AppEnv } from '../src/types';

// インストール済み 0.20.x では cloudflare:test の env が Cloudflare.Env 型のため、
// グローバル側の宣言マージでアプリの Env 契約を反映する。
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

// 旧 API（ProvidedEnv）互換の宣言も残す（存在しない版では無害な追加宣言になる）。
declare module 'cloudflare:test' {
  interface ProvidedEnv extends AppEnv {
    TEST_MIGRATIONS: D1Migration[];
  }
}
