/**
 * coaching/replay-score.mjs（再現評価の集計部分: scoreNote / summarizeRows）のテスト。
 * キーワード一致の粗い指標なので、代表的な言い回しが拾えることと、拾ってはいけない文脈を拾わないことを固定する。
 * replay.mjs 本体は Node の child_process / fs を使うため Workers プールのテストでは読み込まない。
 */
import { describe, expect, it } from 'vitest';
import { scoreNote, summarizeRows } from '../coaching/replay-score.mjs';

describe('scoreNote', () => {
  it('行動方針の休養・有酸素上限・炭水化物増・グラム指定を拾う', () => {
    const s = scoreNote(
      '今日の評価: 除脂肪も0.3kg減っており要注意。\n\n明日の行動方針:\n・炭水化物は250g程度まで許容し回復を優先する\n・有酸素は20〜30分に留める',
    );
    expect(s).toMatchObject({ rest: 1, cardio_cap: 1, carb_up: 1, ffm_reason: 1, gram_change: 1, no_change: 0 });
    expect(s.chars).toBeGreaterThan(0);
  });

  it('評価欄だけの休養語は行動方針として数えず、「方針変更なし」を拾う', () => {
    const s = scoreNote('今日の評価: 昨日の回復を優先した判断は妥当。\n\n明日の行動方針:\n・方針変更なし（継続）');
    expect(s).toMatchObject({ rest: 0, cardio_cap: 0, carb_up: 0, ffm_reason: 0, gram_change: 0, no_change: 1 });
  });

  it('総量の引き上げは具体的な kcal 値に依存せず拾う', () => {
    expect(scoreNote('明日の行動方針:\n・総量を2100kcalに引き上げる').carb_up).toBe(1);
    expect(scoreNote('明日の行動方針:\n・総量は1900 kcal前後に置く').carb_up).toBe(1);
    expect(scoreNote('明日の行動方針:\n・総量は据え置き').carb_up).toBe(0);
  });

  it('本文が無ければ全て 0', () => {
    expect(scoreNote(null)).toEqual({ rest: 0, cardio_cap: 0, carb_up: 0, ffm_reason: 0, gram_change: 0, no_change: 0, chars: 0 });
  });
});

describe('summarizeRows', () => {
  it('配信済みと再生成の指標を日数分だけ合計する', () => {
    const zero = { rest: 0, cardio_cap: 0, carb_up: 0, ffm_reason: 0, gram_change: 0, no_change: 0, chars: 10 };
    const rows = [
      { date: '2026-09-05', original: { ...zero, rest: 1, carb_up: 1 }, regenerated: { ...zero, no_change: 1 } },
      { date: '2026-09-06', original: null, regenerated: { ...zero, rest: 1 } },
    ];
    const s = summarizeRows(rows, { from: '2026-09-05', to: '2026-09-06', promptOnly: false });
    expect(s.days).toBe(2);
    expect(s.with_original).toBe(1);
    expect(s.original).toEqual({ rest: 1, cardio_cap: 0, carb_up: 1, ffm_reason: 0, gram_change: 0, no_change: 0 });
    expect(s.regenerated).toEqual({ rest: 1, cardio_cap: 0, carb_up: 0, ffm_reason: 0, gram_change: 0, no_change: 1 });
  });

  it('prompt-only では再生成側の集計を null にする', () => {
    const s = summarizeRows([], { from: '2026-09-05', to: '2026-09-05', promptOnly: true });
    expect(s.regenerated).toBeNull();
    expect(s.days).toBe(0);
  });
});
