/**
 * coaching/derive.mjs（過去日の講評再生成で /api/summary の代わりに使う対象日時点の集計）のテスト。
 * Worker 側 getTermStats と同じ定義（recent7 = D-6〜D、prev7 = D-13〜D-7 の日平均の平均）を固定する。
 */
import { describe, expect, it } from 'vitest';
import { deriveTerms } from '../coaching/derive.mjs';

function day(d: string, weight: number | null, fat_mass: number | null = null, fat_free_mass: number | null = null) {
  return { d, weight, fat_mass, fat_free_mass };
}

describe('deriveTerms', () => {
  it('D-6〜D を recent7、D-13〜D-7 を prev7 として日平均の平均と差を返す', () => {
    const days = [
      day('2026-08-11', 90), // D-13（prev の先頭）
      day('2026-08-17', 88), // D-7（prev の末尾）
      day('2026-08-18', 85), // D-6（recent の先頭）
      day('2026-08-24', 83), // D
    ];
    const t = deriveTerms(days, '2026-08-24');
    expect(t.recent7_avg.weight).toBe(84);
    expect(t.diff_vs_prev7.weight).toBe(84 - 89);
  });

  it('対象日より後の日と D-14 以前の日は集計に含めない', () => {
    const days = [
      day('2026-08-10', 100), // D-14: 範囲外
      day('2026-08-20', 84),
      day('2026-08-25', 70), // D+1: 範囲外
    ];
    const t = deriveTerms(days, '2026-08-24');
    expect(t.recent7_avg.weight).toBe(84);
    expect(t.diff_vs_prev7.weight).toBeNull(); // prev7 に該当日が無い
  });

  it('対象日自体に計測が無くても窓内の他の日から算出する', () => {
    const t = deriveTerms([day('2026-08-22', 82), day('2026-08-23', 84)], '2026-08-24');
    expect(t.recent7_avg.weight).toBe(83);
  });

  it('指標ごとに null を無視し、値が1つも無い指標は null になる', () => {
    const days = [day('2026-08-23', 84, 20, null), day('2026-08-24', 82, null, 62)];
    const t = deriveTerms(days, '2026-08-24');
    expect(t.recent7_avg).toEqual({ weight: 83, fat_mass: 20, fat_free_mass: 62 });
    expect(t.diff_vs_prev7).toEqual({ weight: null, fat_mass: null, fat_free_mass: null });
  });

  it('入力が空なら全て null', () => {
    expect(deriveTerms([], '2026-08-24')).toEqual({
      recent7_avg: { weight: null, fat_mass: null, fat_free_mass: null },
      diff_vs_prev7: { weight: null, fat_mass: null, fat_free_mass: null },
    });
  });
});
