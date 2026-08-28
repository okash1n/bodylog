/**
 * coaching/dates.mjs（AI講評ジョブの日付ヘルパー）のテスト。
 * ジョブ本体（generate.mjs）は環境変数とネットワークに依存するため、日付の解決だけをここで固定する。
 */
import { describe, expect, it } from 'vitest';
import {
  addDaysYmd,
  fetchRange,
  isValidYmd,
  localYmd,
  resolveTargetDate,
  scheduleTargetDate,
} from '../coaching/dates.mjs';

describe('localYmd', () => {
  it('UTC+9 では 14:59Z が当日、15:00Z が翌日になる', () => {
    expect(localYmd(Date.UTC(2026, 7, 24, 14, 59), 9)).toBe('2026-08-24');
    expect(localYmd(Date.UTC(2026, 7, 24, 15, 0), 9)).toBe('2026-08-25');
  });
  it('offset 0 は UTC 日付そのまま', () => {
    expect(localYmd(Date.UTC(2026, 7, 24, 23, 30), 0)).toBe('2026-08-24');
  });
});

describe('isValidYmd / addDaysYmd', () => {
  it('形式と実在日を検証する', () => {
    expect(isValidYmd('2026-08-24')).toBe(true);
    expect(isValidYmd('2026-8-24')).toBe(false);
    expect(isValidYmd('2026-02-30')).toBe(false);
    expect(isValidYmd('2026-08-24T00:00:00Z')).toBe(false);
    expect(isValidYmd(undefined)).toBe(false);
  });
  it('月またぎ・年またぎで加減算できる', () => {
    expect(addDaysYmd('2026-08-24', -14)).toBe('2026-08-10');
    expect(addDaysYmd('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDaysYmd('2026-08-24', 0)).toBe('2026-08-24');
  });
});

describe('resolveTargetDate', () => {
  const today = '2026-08-25';
  it('未設定・空・空白は当日にフォールバックする（schedule実行の通常動作）', () => {
    expect(resolveTargetDate(undefined, today)).toEqual({ ok: true, date: today });
    expect(resolveTargetDate('', today)).toEqual({ ok: true, date: today });
    expect(resolveTargetDate('   ', today)).toEqual({ ok: true, date: today });
  });
  it('過去日と当日は受理する（前後の空白は除く）', () => {
    expect(resolveTargetDate('2026-08-24', today)).toEqual({ ok: true, date: '2026-08-24' });
    expect(resolveTargetDate(' 2026-08-24 ', today)).toEqual({ ok: true, date: '2026-08-24' });
    expect(resolveTargetDate(today, today)).toEqual({ ok: true, date: today });
  });
  it('形式不正・非実在日・未来日は理由付きで拒否する', () => {
    const bad = resolveTargetDate('2026/08/24', today);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('YYYY-MM-DD');
    expect(resolveTargetDate('2026-02-30', today).ok).toBe(false);
    const future = resolveTargetDate('2026-08-26', today);
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.error).toContain('future');
  });
});

describe('fetchRange', () => {
  it('対象日を末尾とする直近N日（両端含む）を返す', () => {
    expect(fetchRange('2026-08-24', 15)).toEqual({ from: '2026-08-10', to: '2026-08-24' });
    expect(fetchRange('2026-08-24', 1)).toEqual({ from: '2026-08-24', to: '2026-08-24' });
  });
});

describe('scheduleTargetDate', () => {
  it('JST: 予定どおり〜同日内の遅延は当日を対象にする', () => {
    expect(scheduleTargetDate(Date.UTC(2026, 7, 26, 14, 30), 9)).toBe('2026-08-26'); // 23:30 JST ちょうど
    expect(scheduleTargetDate(Date.UTC(2026, 7, 26, 14, 47), 9)).toBe('2026-08-26'); // 23:47 JST（通常の遅延）
    expect(scheduleTargetDate(Date.UTC(2026, 7, 26, 14, 54), 9)).toBe('2026-08-26'); // 23:54 JST（間に合う限界近く）
  });
  it('JST: 日付をまたいだ遅延は前日を対象にする（2026-08-27 の実事例）', () => {
    expect(scheduleTargetDate(Date.UTC(2026, 7, 27, 18, 14), 9)).toBe('2026-08-27'); // 翌 03:14 JST 開始
    expect(scheduleTargetDate(Date.UTC(2026, 7, 27, 15, 0), 9)).toBe('2026-08-27'); // 翌 00:00 JST 開始
    expect(scheduleTargetDate(Date.UTC(2026, 7, 28, 5, 29), 9)).toBe('2026-08-27'); // 翌 14:29 JST（次スロット直前）
  });
  it('offset 0: スロットは 14:30 ローカル。前後で当日/前日が切り替わる', () => {
    expect(scheduleTargetDate(Date.UTC(2026, 7, 26, 14, 40), 0)).toBe('2026-08-26');
    expect(scheduleTargetDate(Date.UTC(2026, 7, 27, 2, 0), 0)).toBe('2026-08-26');
  });
  it('負のオフセットでも直近スロットのローカル日付になる', () => {
    // UTC-5 ではスロットは 09:30 ローカル。09:00 ローカル起動は前日スロット扱い、10:00 ローカルは当日
    expect(scheduleTargetDate(Date.UTC(2026, 7, 27, 14, 0), -5)).toBe('2026-08-26');
    expect(scheduleTargetDate(Date.UTC(2026, 7, 27, 15, 0), -5)).toBe('2026-08-27');
  });
  it('スロットがローカルで日付をまたぐオフセットでは、ローカル側の日付になる（tz変換の検証）', () => {
    // UTC+10 では 14:30 UTC スロット = 翌 00:30 ローカル。UTC 日付のまま返す誤実装はここで落ちる
    expect(scheduleTargetDate(Date.UTC(2026, 7, 26, 14, 40), 10)).toBe('2026-08-27');
    expect(scheduleTargetDate(Date.UTC(2026, 7, 27, 10, 0), 10)).toBe('2026-08-27'); // 翌日 20:00 ローカルでも直近スロットは同じ
  });
});
