import { beforeEach, describe, expect, it } from 'vitest';
import { deleteManualMeasurement, logWeight, parseWeightInput } from '../src/weight';
import { insertMeasurement, localYmdDaysAgo, resetTables, testEnv } from './helpers';

describe('parseWeightInput', () => {
  it('weight_kg必須・範囲20–300', () => {
    expect(parseWeightInput({}).ok).toBe(false);
    expect(parseWeightInput({ weight_kg: 19 }).ok).toBe(false);
    expect(parseWeightInput({ weight_kg: 301 }).ok).toBe(false);
    const ok = parseWeightInput({ weight_kg: 83.4 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.fat_ratio).toBeNull();
  });
  it('fat_ratioは3–75', () => {
    expect(parseWeightInput({ weight_kg: 80, fat_ratio: 2 }).ok).toBe(false);
    expect(parseWeightInput({ weight_kg: 80, fat_ratio: 76 }).ok).toBe(false);
    expect(parseWeightInput({ weight_kg: 80, fat_ratio: 28.3 }).ok).toBe(true);
  });
  it('measured_atは2000年以降〜now+5分。省略時は現在時刻', () => {
    expect(parseWeightInput({ weight_kg: 80, measured_at: 'not-a-date' }).ok).toBe(false);
    expect(parseWeightInput({ weight_kg: 80, measured_at: '1999-12-31T00:00:00Z' }).ok).toBe(false);
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(parseWeightInput({ weight_kg: 80, measured_at: future }).ok).toBe(false);
    const ok = parseWeightInput({ weight_kg: 80 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(Date.parse(ok.value.measured_at)).toBeGreaterThan(Date.now() - 5000);
  });
});

describe('logWeight / deleteManualMeasurement', () => {
  beforeEach(resetTables);
  const at = `${localYmdDaysAgo(0)}T03:00:00Z`;

  it('正のidを単調増加で採番し、fat_free_massを導出して保存する', async () => {
    await insertMeasurement({ grpid: 1234567890, measured_at: at, weight: 84 });
    const m1 = await logWeight(testEnv, { weight: 83.4, fat_ratio: 28.3, measured_at: at });
    expect(m1.id).toBeGreaterThan(0);
    expect(m1.source).toBe('manual');
    expect(m1.fat_free_mass).toBeCloseTo(83.4 * (1 - 0.283), 2);
    const m2 = await logWeight(testEnv, { weight: 83.0, fat_ratio: null, measured_at: at });
    expect(m2.id).toBeGreaterThan(m1.id);
    expect(m2.fat_free_mass).toBeNull();
  });

  it('挿入時にimmediate通知先へbatchをenqueueする', async () => {
    const m = await logWeight(testEnv, { weight: 83.4, fat_ratio: null, measured_at: at });
    const item = await testEnv.DB.prepare(
      'SELECT measurement_id, batch_id FROM notification_batch_items',
    ).first<{
      measurement_id: number;
      batch_id: string;
    }>();
    expect(item?.measurement_id).toBe(m.id);
    const batch = await testEnv.DB.prepare('SELECT status FROM notification_batches WHERE batch_id = ?1')
      .bind(item?.batch_id)
      .first<{ status: string }>();
    expect(batch?.status).toBe('pending');
  });

  it('deleteはmanual行のみ削除できる', async () => {
    await insertMeasurement({ grpid: 42, measured_at: at, weight: 84 });
    const m = await logWeight(testEnv, { weight: 83.4, fat_ratio: null, measured_at: at });
    expect(await deleteManualMeasurement(testEnv, 42)).toBe(false);
    expect(await deleteManualMeasurement(testEnv, 999)).toBe(false);
    expect(await deleteManualMeasurement(testEnv, m.id)).toBe(true);
    const left = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM measurements').first<{ n: number }>();
    expect(left?.n).toBe(1);
  });
});
