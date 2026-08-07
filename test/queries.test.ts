import { beforeEach, describe, expect, it } from 'vitest';
import type { LatestMeasurement } from '../src/types';
import { offsetHours } from '../src/util';
import {
  getDailySeries,
  getImportStatus,
  getLatestForBatch,
  getNotificationStats,
} from '../src/queries';
import { insertMeasurement, localYmdDaysAgo, resetTables, setSetting, testEnv } from './helpers';

let grpid = 1;
function nextGrpid(): number {
  return grpid++;
}

async function seedDay(ymd: string, weight: number, fatRatio: number | null = null): Promise<void> {
  // T03:00:00Z は JST 正午。ローカル日付 = ymd のまま
  await insertMeasurement({
    grpid: nextGrpid(),
    measured_at: `${ymd}T03:00:00Z`,
    weight,
    fat_ratio: fatRatio,
  });
}

describe('getDailySeries', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('7日移動平均が表示期間の先頭でも from-6日 のデータを含めて計算される', async () => {
    const days = ['2025-12-26', '2025-12-27', '2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31'];
    for (let i = 0; i < days.length; i++) await seedDay(days[i], 60 + i); // 60..65
    // 2026-01-01 は 2 計測（66 と 64）→ 日平均 65
    await seedDay('2026-01-01', 66);
    await seedDay('2026-01-01', 64);

    const series = await getDailySeries(testEnv, '2026-01-01', '2026-01-01');
    expect(series).toHaveLength(1);
    expect(series[0].d).toBe('2026-01-01');
    expect(series[0].weight).toBeCloseTo(65, 5);
    // (60+61+62+63+64+65+65)/7
    expect(series[0].weight_7d_avg).toBeCloseTo(440 / 7, 5);
    expect(series[0].fat_mass).toBeNull();
    expect(series[0].fat_mass_7d_avg).toBeNull();
  });

  it('JST境界: UTC 15:00 の計測は翌ローカル日に割り当てられる', async () => {
    expect(offsetHours(testEnv)).toBe(9); // このテストは wrangler.toml の TZ_OFFSET_HOURS=9 前提
    await insertMeasurement({ grpid: nextGrpid(), measured_at: '2026-01-05T15:00:00Z', weight: 66 });
    await insertMeasurement({ grpid: nextGrpid(), measured_at: '2026-01-05T14:59:00Z', weight: 64 });

    const day6 = await getDailySeries(testEnv, '2026-01-06', '2026-01-06');
    expect(day6).toHaveLength(1);
    expect(day6[0].d).toBe('2026-01-06');
    expect(day6[0].weight).toBeCloseTo(66, 5);

    const day5 = await getDailySeries(testEnv, '2026-01-05', '2026-01-05');
    expect(day5).toHaveLength(1);
    expect(day5[0].d).toBe('2026-01-05');
    expect(day5[0].weight).toBeCloseTo(64, 5);
  });
});

describe('getNotificationStats', () => {
  beforeEach(async () => {
    await resetTables();
  });

  const latest: LatestMeasurement = {
    measured_at: new Date().toISOString(),
    weight: 64,
    fat_mass: null,
    fat_free_mass: null,
  };

  it('recent7 / diff7 / 基準日比を計算する', async () => {
    // 直近 7 暦日 = 65、その前ターム（境界の数え方差異を吸収して 7〜14 日前全て）= 70
    for (let i = 0; i <= 6; i++) await seedDay(localYmdDaysAgo(i), 65);
    for (let i = 7; i <= 14; i++) await seedDay(localYmdDaysAgo(i), 70);
    const baselineDate = localYmdDaysAgo(10);
    await setSetting('baseline_date', baselineDate);

    const stats = await getNotificationStats(testEnv, latest);
    expect(stats.recent7.weight).toBeCloseTo(65, 5);
    expect(stats.diff7.weight).toBeCloseTo(-5, 5);
    expect(stats.recent7.fat_mass).toBeNull();
    expect(stats.diff7.fat_mass).toBeNull();
    expect(stats.baselineDate).toBe(baselineDate);
    // 基準日（10日前）の日平均 70 に対し latest.weight 64
    expect(stats.baselineDiff.weight).toBeCloseTo(-6, 5);
    expect(stats.baselineDiff.fat_mass).toBeNull();
  });

  it('基準日に計測がない場合は基準日以降最初の計測値を使う', async () => {
    await seedDay(localYmdDaysAgo(3), 66);
    await setSetting('baseline_date', localYmdDaysAgo(8));

    const stats = await getNotificationStats(testEnv, latest);
    expect(stats.baselineDiff.weight).toBeCloseTo(64 - 66, 5);
    // 前タームのデータなし → diff7 は null
    expect(stats.diff7.weight).toBeNull();
    expect(stats.recent7.weight).toBeCloseTo(66, 5);
  });

  it('データ欠如時は null になる', async () => {
    const stats = await getNotificationStats(testEnv, latest);
    expect(stats.recent7.weight).toBeNull();
    expect(stats.diff7.weight).toBeNull();
    expect(stats.baselineDate).toBeNull();
    expect(stats.baselineDiff.weight).toBeNull();
  });
});

describe('getLatestForBatch / getImportStatus', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('batch 内の最新計測と件数を返す', async () => {
    const g1 = nextGrpid();
    const g2 = nextGrpid();
    await insertMeasurement({ grpid: g1, measured_at: '2026-01-01T00:00:00Z', weight: 60 });
    await insertMeasurement({ grpid: g2, measured_at: '2026-01-02T00:00:00Z', weight: 61 });
    await testEnv.DB.prepare('INSERT INTO notification_batch_items (grpid, batch_id) VALUES (?, ?), (?, ?)')
      .bind(g1, 'bx', g2, 'bx')
      .run();

    const result = await getLatestForBatch(testEnv, 'bx');
    expect(result).not.toBeNull();
    expect(result?.count).toBe(2);
    expect(result?.latest.weight).toBeCloseTo(61, 5);

    expect(await getLatestForBatch(testEnv, 'no-such-batch')).toBeNull();
  });

  it('import 状態と最新計測時刻を返す', async () => {
    await setSetting('import_status', 'running');
    await setSetting('last_sync_at', '2026-01-01T00:00:00Z');
    await insertMeasurement({ grpid: nextGrpid(), measured_at: '2026-01-02T03:04:05Z', weight: 60 });

    const status = await getImportStatus(testEnv);
    expect(status.import_status).toBe('running');
    expect(status.import_error).toBeNull();
    expect(status.last_sync_at).toBe('2026-01-01T00:00:00Z');
    expect(status.latest_measured_at).toBe('2026-01-02T03:04:05Z');
  });
});
