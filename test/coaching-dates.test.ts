/**
 * coaching/dates.mjs（AI講評ジョブの日付ヘルパー）のテスト。
 * ジョブ本体（generate.mjs）は環境変数とネットワークに依存するため、日付の解決だけをここで固定する。
 */
import { describe, expect, it } from 'vitest';
import { addDaysYmd, fetchRange, isValidYmd, localYmd, resolveTargetDate } from '../coaching/dates.mjs';

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
