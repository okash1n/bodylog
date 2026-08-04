import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingestRange, parseWebhookPayload } from '../src/ingest';
import { insertTokenRow, resetTables, stubFetch, testEnv, withingsReply, type StubRoute } from './helpers';

interface RawMeasure {
  value: number;
  type: number;
  unit: number;
}

function grp(
  grpid: number,
  epochSec: number,
  opts: {
    weight?: number;
    fatRatio?: number;
    fatFreeMass?: number;
    attrib?: number;
    category?: number;
  },
): { grpid: number; date: number; category: number; attrib: number; measures: RawMeasure[] } {
  const measures: RawMeasure[] = [];
  if (opts.weight !== undefined) measures.push({ value: Math.round(opts.weight * 1000), type: 1, unit: -3 });
  if (opts.fatFreeMass !== undefined) measures.push({ value: Math.round(opts.fatFreeMass * 1000), type: 5, unit: -3 });
  if (opts.fatRatio !== undefined) measures.push({ value: Math.round(opts.fatRatio * 10), type: 6, unit: -1 });
  return { grpid, date: epochSec, category: opts.category ?? 1, attrib: opts.attrib ?? 0, measures };
}

function measRoute(groups: unknown[]): StubRoute {
  return {
    host: 'wbsapi.withings.net',
    path: '/measure',
    method: 'POST',
    times: 1,
    reply: () => withingsReply({ updatetime: 1736100000, measuregrps: groups, more: 0, offset: 0 }),
  };
}

async function count(table: string): Promise<number> {
  const row = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

const START = 1736000000;
const END = 1736100000;
const MEASURED = 1736089200;

describe('ingestRange', () => {
  beforeEach(async () => {
    await resetTables();
    await insertTokenRow({ expiresInSec: 3600 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('同一grpidの再送では通知claimが1回だけ発生する', async () => {
    const g = grp(1001, MEASURED, { weight: 65.2 });
    const stub = stubFetch().on(measRoute([g])).on(measRoute([g]));

    const r1 = await ingestRange(testEnv, START, END, 'webhook');
    expect(r1.claimedGrpids).toEqual([1001]);
    expect(await count('notification_batch_items')).toBe(1);
    expect(await count('notification_batches')).toBe(1);

    const r2 = await ingestRange(testEnv, START, END, 'webhook');
    expect(r2.claimedGrpids).toEqual([]);
    expect(await count('notification_batch_items')).toBe(1);
    expect(await count('notification_batches')).toBe(1);
    stub.assertAllConsumed();
  });

  it('UPSERTで同一grpidの値修正が反映される', async () => {
    stubFetch()
      .on(measRoute([grp(2001, MEASURED, { weight: 65.2 })]))
      .on(measRoute([grp(2001, MEASURED, { weight: 66.0, fatRatio: 18.5 })]));

    await ingestRange(testEnv, START, END, 'import');
    let row = await testEnv.DB.prepare('SELECT measured_at, weight, fat_ratio FROM measurements WHERE grpid = 2001').first<{
      measured_at: string;
      weight: number | null;
      fat_ratio: number | null;
    }>();
    expect(row?.weight).toBeCloseTo(65.2, 5);
    expect(row?.fat_ratio).toBeNull();
    expect(new Date(row?.measured_at ?? '').getTime()).toBe(MEASURED * 1000);

    await ingestRange(testEnv, START, END, 'import');
    row = await testEnv.DB.prepare('SELECT measured_at, weight, fat_ratio FROM measurements WHERE grpid = 2001').first<{
      measured_at: string;
      weight: number | null;
      fat_ratio: number | null;
    }>();
    expect(row?.weight).toBeCloseTo(66.0, 5);
    expect(row?.fat_ratio).toBeCloseTo(18.5, 5);
    // import コンテキストは通知に登録しない
    expect(await count('notification_batches')).toBe(0);
    expect(await count('notification_batch_items')).toBe(0);
  });

  it('attrib 0/2 のみ採用し、attrib 1/4 と category!=1 を除外する', async () => {
    stubFetch().on(
      measRoute([
        grp(3001, MEASURED, { weight: 65.0, attrib: 0 }),
        grp(3002, MEASURED, { weight: 65.1, attrib: 1 }),
        grp(3003, MEASURED, { weight: 65.2, attrib: 2 }),
        grp(3004, MEASURED, { weight: 65.3, attrib: 4 }),
        grp(3005, MEASURED, { weight: 65.4, attrib: 0, category: 2 }),
      ]),
    );

    const r = await ingestRange(testEnv, START, END, 'import');
    expect(r.upserted).toBe(2);
    expect(r.claimedGrpids).toEqual([]);
    const rows = await testEnv.DB.prepare('SELECT grpid FROM measurements ORDER BY grpid').all<{ grpid: number }>();
    expect(rows.results.map((x) => x.grpid)).toEqual([3001, 3003]);
  });

  it('大量行はmulti-row UPSERTのバインド上限分割で全件保存される', async () => {
    // 200行 × 6バインド = 1200バインド。分割しないと1文のバインド上限を超える
    const groups = Array.from({ length: 200 }, (_, i) =>
      grp(10000 + i, MEASURED - i * 60, { weight: 60 + (i % 10) * 0.1 }),
    );
    stubFetch().on(measRoute(groups));

    const r = await ingestRange(testEnv, START, END, 'import');
    expect(r.upserted).toBe(200);
    expect(await count('measurements')).toBe(200);
    const row = await testEnv.DB.prepare('SELECT weight FROM measurements WHERE grpid = 10007').first<{
      weight: number | null;
    }>();
    expect(row?.weight).toBeCloseTo(60.7, 5);
  });
});

describe('parseWebhookPayload', () => {
  const valid = {
    userid: '42',
    appli: '1',
    startdate: '1736000000',
    enddate: '1736100000',
  };
  const params = (o: Record<string, string>): URLSearchParams => new URLSearchParams(o);

  it('正しいペイロードをパースする', () => {
    expect(parseWebhookPayload(params(valid))).toEqual({
      userid: '42',
      appli: 1,
      startdate: 1736000000,
      enddate: 1736100000,
    });
  });

  it('useridが欠落・空なら null', () => {
    const { userid: _drop, ...rest } = valid;
    expect(parseWebhookPayload(params(rest))).toBeNull();
    expect(parseWebhookPayload(params({ ...valid, userid: '' }))).toBeNull();
  });

  it('appliが1以外・非数値なら null', () => {
    expect(parseWebhookPayload(params({ ...valid, appli: '16' }))).toBeNull();
    expect(parseWebhookPayload(params({ ...valid, appli: 'x' }))).toBeNull();
  });

  it('startdate/enddateの型不正・範囲不正なら null', () => {
    expect(parseWebhookPayload(params({ ...valid, startdate: 'abc' }))).toBeNull();
    expect(parseWebhookPayload(params({ ...valid, startdate: '0' }))).toBeNull();
    expect(parseWebhookPayload(params({ ...valid, startdate: '-5' }))).toBeNull();
    expect(parseWebhookPayload(params({ ...valid, startdate: '1.5' }))).toBeNull();
    expect(parseWebhookPayload(params({ ...valid, enddate: '1735999999' }))).toBeNull(); // enddate < startdate
    const { enddate: _drop, ...rest } = valid;
    expect(parseWebhookPayload(params(rest))).toBeNull();
  });
});
