/**
 * グローバルスタブの復元保証。stubFetch（vi.stubGlobal('fetch', ...)）の後始末は
 * 各テストファイルの afterEach に依存していたため、書き忘れ・テスト失敗時に
 * global fetch が汚染されたまま次のテストへ波及していた。ここで一律に復元する
 * （各ファイル個別の vi.unstubAllGlobals() は冪等なので残っていても無害）
 */
import { afterEach, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});
