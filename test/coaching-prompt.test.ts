/**
 * coaching/prompt.mjs（講評プロンプトの文面）のテスト。評価軸・除脂肪ノイズ規則・運動データの凡例・
 * 回復提案の条件・profile の扱いを固定する。文面そのものの妥当性は再現評価（replay.mjs）で見る。
 * フィクスチャの文字列は合成（本人の方針・メニューではない）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_HARD_BURN_KCAL, DEFAULT_TREND_WINDOW_DAYS } from '../coaching/derive.mjs';
import {
  DEEP_DEFICIT_KCAL,
  DEFAULT_MAX_HARD_STREAK,
  POLICY,
  SYSTEM_PROMPT,
  buildPrompt,
  commonRules,
  parseProfile,
} from '../coaching/prompt.mjs';

const baseData = {
  policy: POLICY,
  profile: null,
  goal: { weight_kg: 70, fat_mass_kg: null },
  metabolism: null,
  summary: { as_of: '2026-09-14' },
  trend: { window_days: 21 },
  body: [],
  intake: [],
  exercise: [],
  sessions: [],
  previous_notes: [],
};

describe('parseProfile', () => {
  it('空・未設定は null', () => {
    expect(parseProfile(undefined)).toBeNull();
    expect(parseProfile('')).toBeNull();
    expect(parseProfile('   ')).toBeNull();
  });

  it('自由記述はそのまま text になり、閾値と下限は既定', () => {
    expect(parseProfile('固定メニューあり。ほぼ毎日トレーニング')).toEqual({
      text: '固定メニューあり。ほぼ毎日トレーニング',
      max_hard_streak: DEFAULT_MAX_HARD_STREAK,
      min_kcal: null,
      min_protein_g: null,
    });
  });

  it('JSON なら text・max_hard_streak・min_kcal・min_protein_g を取り出す（不正な数値は既定・null）', () => {
    expect(parseProfile('{"text":"方針A","max_hard_streak":5,"min_kcal":1500,"min_protein_g":150}')).toEqual({
      text: '方針A',
      max_hard_streak: 5,
      min_kcal: 1500,
      min_protein_g: 150,
    });
    expect(parseProfile('{"text":"方針B","max_hard_streak":0,"min_kcal":"abc","min_protein_g":5.5}')).toEqual({
      text: '方針B',
      max_hard_streak: DEFAULT_MAX_HARD_STREAK,
      min_kcal: null,
      min_protein_g: null,
    });
    expect(parseProfile('{"max_hard_streak":"7"}')?.max_hard_streak).toBe(7);
    expect(parseProfile('{"max_hard_streak":5.5}')?.max_hard_streak).toBe(DEFAULT_MAX_HARD_STREAK);
  });

  it('閾値だけの JSON は text が null（{} を方針として渡さない）', () => {
    expect(parseProfile('{"max_hard_streak":5}')).toEqual({
      text: null,
      max_hard_streak: 5,
      min_kcal: null,
      min_protein_g: null,
    });
    expect(parseProfile('{"text":123}')?.text).toBeNull();
  });

  it('未知のキーは捨てずに text の末尾へ JSON で連結する', () => {
    expect(parseProfile('{"text":"A","routine":"daily"}')?.text).toBe('A\n{"routine":"daily"}');
    expect(parseProfile('{"routine":"daily"}')?.text).toBe('{"routine":"daily"}');
  });

  it('配列 JSON や壊れた JSON は自由記述として扱う', () => {
    expect(parseProfile('["a"]')?.text).toBe('["a"]');
    expect(parseProfile('{not json')).toEqual({
      text: '{not json',
      max_hard_streak: DEFAULT_MAX_HARD_STREAK,
      min_kcal: null,
      min_protein_g: null,
    });
  });
});

describe('buildPrompt', () => {
  it('方針の正本（POLICY）を本文に埋め込み、評価軸は脂肪量の減少で、除脂肪維持を理由にした摂取増・休養増を禁じる', () => {
    const p = buildPrompt(baseData, '2026-09-14', { fetchDays: 22 });
    expect(p).toContain(POLICY);
    expect(p).toContain('goal（weight_kg / fat_mass_kg）は到達点の目安');
    expect(p).toContain('摂取を増やす・休養を増やす方向は取らない');
    expect(p).not.toContain('目標との位置関係');
    expect(p).not.toContain('除脂肪体重を維持・増加');
    expect(POLICY).not.toContain('増加');
    expect(SYSTEM_PROMPT).toContain('反射的に勧めない');
  });

  it('除脂肪ノイズ規則・運動データの凡例・trend のラベル・metabolism null の扱いを含む', () => {
    const p = buildPrompt(baseData, '2026-09-14', { fetchDays: 22 });
    expect(p).toContain('−0.5 以上（減少幅が0.5kg以下）なら「変化なし」');
    expect(p).toContain('trend.ffm.label が declining');
    expect(p).toContain('declining / rising / flat / uncertain');
    expect(p).toContain('weighted_volume');
    expect(p).toContain('bodyweight_volume');
    expect(p).toContain('hard_streak_days_before_today');
    expect(p).toContain(`burn≥${DEFAULT_HARD_BURN_KCAL}kcal`);
    expect(p).toContain(`直近${DEFAULT_TREND_WINDOW_DAYS}日の日次回帰`);
    expect(p).toContain('回復目的');
    expect(p).toContain(`estimated_tdee_kcal − ${DEEP_DEFICIT_KCAL}`);
    expect(p).toContain('metabolism が null のときは (2) は不成立');
    expect(p).toContain('exercise[].strength > 0');
    expect(p).toContain('引き上げ後の摂取目標は');
  });

  it('回復提案の閾値と下限は data.profile から取り、未設定なら既定・汎用文', () => {
    const none = buildPrompt(baseData, '2026-09-14', { fetchDays: 22 });
    expect(none).toContain(`hard_streak_days_before_today が ${DEFAULT_MAX_HARD_STREAK} 以上`);
    expect(none).toContain('profile にタンパク質目標・摂取下限があればそれを下回る提案はしない');
    expect(none).not.toMatch(/摂取\d+kcal未満/);
    const data = {
      ...baseData,
      profile: { text: '固定メニューAとBを交互', max_hard_streak: 4, min_kcal: 1400, min_protein_g: 120 },
    };
    const withProfile = buildPrompt(data, '2026-09-14', { fetchDays: 22 });
    expect(withProfile).toContain('hard_streak_days_before_today が 4 以上');
    expect(withProfile).toContain('摂取1400kcal未満・タンパク質120g未満になる提案はしない');
    expect(commonRules({ maxHardStreak: 9 })).toContain('hard_streak_days_before_today が 9 以上');
  });

  it('profile があれば本文に差し込み、text が無ければ「未設定」を出しつつ閾値は反映する', () => {
    const none = buildPrompt(baseData, '2026-09-14', { fetchDays: 22 });
    expect(none).toContain('profile: 未設定');
    const withText = buildPrompt(
      { ...baseData, profile: { text: '固定メニューAとBを交互', max_hard_streak: 6, min_kcal: null, min_protein_g: null } },
      '2026-09-14',
      { fetchDays: 22 },
    );
    expect(withText).toContain('固定メニューAとBを交互');
    expect(withText).not.toContain('profile: 未設定');
    const thresholdOnly = buildPrompt(
      { ...baseData, profile: { text: null, max_hard_streak: 5, min_kcal: null, min_protein_g: null } },
      '2026-09-14',
      { fetchDays: 22 },
    );
    expect(thresholdOnly).toContain('profile: 未設定');
    expect(thresholdOnly).toContain('hard_streak_days_before_today が 5 以上');
    expect(thresholdOnly).not.toContain('最優先で従う）: {}');
  });

  it('対象日・取得日数・データ JSON を埋め込み、定型句の許可を書く', () => {
    const data = { ...baseData, intake_7d_avg_kcal: 1870 };
    const p = buildPrompt(data, '2026-09-14', { fetchDays: 22 });
    expect(p).toContain('今日（2026-09-14）');
    expect(p).toContain('直近22日');
    expect(p).toContain('"intake_7d_avg_kcal":1870');
    expect(p).toContain('「方針変更なし（継続）」の定型句は毎日そのまま書いてよい');
  });
});
