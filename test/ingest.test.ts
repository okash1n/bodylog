import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { ensureSubscription, ingestRange, parseWebhookPayload, processInbox, runDailyBackfill } from '../src/ingest';
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

describe('withings未連携時のcronゲート', () => {
  beforeEach(resetTables);
  afterEach(() => vi.unstubAllGlobals());

  it('トークン行が無ければrunDailyBackfillは外部通信せずに終わる', async () => {
    const stub = stubFetch(); // ルート未登録: fetchが飛べばthrowする
    await runDailyBackfill(testEnv);
    expect(stub.requests().length).toBe(0);
  });

  it('トークン行が無ければensureSubscriptionは外部通信せずに終わる', async () => {
    const stub = stubFetch();
    await ensureSubscription(testEnv, 'https://weight.example.com/webhook/withings-x');
    expect(stub.requests().length).toBe(0);
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

describe('ページング停滞と再試行（inbox）', () => {
  beforeEach(async () => {
    await resetTables();
    await insertTokenRow({ expiresInSec: 3600 });
  });
  afterEach(() => vi.unstubAllGlobals());

  const seedInbox = (start: number, end: number): Promise<unknown> =>
    testEnv.DB.prepare('INSERT INTO webhook_inbox (payload) VALUES (?1)')
      .bind(JSON.stringify({ userid: '42', appli: 1, startdate: start, enddate: end }))
      .run();

  it('offsetが前進しない応答は失敗として未処理に残り、正常応答の再試行で回収される', async () => {
    await seedInbox(START, END);
    // 停滞応答: more=1 なのに offset が進まない
    stubFetch().on({
      host: 'wbsapi.withings.net', path: '/measure', method: 'POST', times: 1,
      reply: () => withingsReply({ updatetime: 1736100000, measuregrps: [grp(3001, MEASURED, { weight: 64 })], more: 1, offset: 0 }),
    });
    const id = (await testEnv.DB.prepare('SELECT MAX(id) AS id FROM webhook_inbox').first<{ id: number }>())!.id;
    const r1 = await processInbox(testEnv);
    expect(r1).toEqual({ processed: 0, failed: 1 });
    const row1 = await testEnv.DB.prepare('SELECT processed_at, attempts, last_error FROM webhook_inbox WHERE id = ?1')
      .bind(id)
      .first<{ processed_at: string | null; attempts: number; last_error: string | null }>();
    expect(row1?.processed_at).toBeNull();
    expect(row1?.attempts).toBe(1);
    expect(row1?.last_error).toContain('offset did not advance');

    vi.unstubAllGlobals();
    stubFetch().on(measRoute([grp(3001, MEASURED, { weight: 64 })]));
    const r2 = await processInbox(testEnv);
    expect(r2).toEqual({ processed: 1, failed: 0 });
    const row2 = await testEnv.DB.prepare('SELECT processed_at, last_error FROM webhook_inbox WHERE id = ?1')
      .bind(id)
      .first<{ processed_at: string | null; last_error: string | null }>();
    expect(row2?.processed_at).not.toBeNull();
    expect(row2?.last_error).toBeNull();
    // 全範囲の即時反映・通知が回復している
    expect(await count('measurements')).toBe(1);
    expect(await count('notification_batch_items')).toBe(1);
  });

  it('claimは未処理かつattemptsが読み取り時のままの行にだけ成功する（楽観排他の契約）', async () => {
    await seedInbox(START, END);
    const id = (await testEnv.DB.prepare('SELECT MAX(id) AS id FROM webhook_inbox').first<{ id: number }>())!.id;
    // consumer A が先に claim（attempts 0→1）
    const a = await testEnv.DB.prepare(
      'UPDATE webhook_inbox SET attempts = 1 WHERE id = ?1 AND processed_at IS NULL AND attempts = 0',
    ).bind(id).run();
    expect(a.meta.changes).toBe(1);
    // 同じスナップショット（attempts=0）を読んだ consumer B の claim は敗北する
    const b = await testEnv.DB.prepare(
      'UPDATE webhook_inbox SET attempts = 1 WHERE id = ?1 AND processed_at IS NULL AND attempts = 0',
    ).bind(id).run();
    expect(b.meta.changes).toBe(0);
    // 処理済み行への last_error 上書きも no-op
    await testEnv.DB.prepare("UPDATE webhook_inbox SET processed_at = datetime('now') WHERE id = ?1").bind(id).run();
    const c = await testEnv.DB.prepare(
      "UPDATE webhook_inbox SET last_error = 'stale' WHERE id = ?1 AND processed_at IS NULL",
    ).bind(id).run();
    expect(c.meta.changes).toBe(0);
  });
});

describe('processInboxのchunk上限とre-enqueue', () => {
  beforeEach(async () => {
    await resetTables();
    await insertTokenRow({ expiresInSec: 3600 });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('広い範囲の行は上限chunkで打ち切り、残りを新しい行へre-enqueueして完了できる', async () => {
    const spanSeconds = 31 * 86_400;
    const start = 1700000000;
    const end = start + 6 * (spanSeconds + 1); // 7chunk相当（上限4を超える）
    await testEnv.DB.prepare('INSERT INTO webhook_inbox (payload) VALUES (?1)')
      .bind(JSON.stringify({ userid: '42', appli: 1, startdate: start, enddate: end }))
      .run();
    const stub = stubFetch().on({
      host: 'wbsapi.withings.net', path: '/measure', method: 'POST',
      reply: () => withingsReply({ updatetime: 1736100000, measuregrps: [], more: 0, offset: 0 }),
    });

    const r1 = await processInbox(testEnv);
    expect(r1.processed).toBe(1); // 元の行は上限分を取り込んでprocessedになる
    expect(stub.requests({ path: '/measure' })).toHaveLength(4); // INBOX_CHUNKS_PER_ROW
    const tail = await testEnv.DB.prepare(
      'SELECT payload FROM webhook_inbox WHERE processed_at IS NULL',
    ).all<{ payload: string }>();
    expect(tail.results).toHaveLength(1); // 残り範囲が1行re-enqueueされている
    const parsed = JSON.parse(tail.results[0].payload) as { startdate: number; enddate: number };
    expect(parsed.startdate).toBe(start + 4 * (spanSeconds + 1)); // 進捗のチェックポイント
    expect(parsed.enddate).toBe(end);

    // 2回目で尻尾（残り3chunk）も完了する
    const r2 = await processInbox(testEnv);
    expect(r2.processed).toBe(1);
    const remaining = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS n FROM webhook_inbox WHERE processed_at IS NULL',
    ).first<{ n: number }>();
    expect(remaining?.n).toBe(0);
    expect(stub.requests({ path: '/measure' })).toHaveLength(7); // 4 + 3
  });
});

describe('webhookのchunk上限と残範囲', () => {
  beforeEach(async () => {
    await resetTables();
    await insertTokenRow({ expiresInSec: 3600 });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('上限超過の残り範囲を破棄せず同型payloadでinboxへ入れる', async () => {
    // waitUntil の processInbox が走るため、空ページ応答で無害化しておく
    stubFetch().on({
      host: 'wbsapi.withings.net', path: '/measure', method: 'POST',
      reply: () => withingsReply({ updatetime: 1736100000, measuregrps: [], more: 0, offset: 0 }),
    });
    const env = { ...testEnv, WEBHOOK_PATH_SECRET: 'testhook' };
    const startdate = 1700000000;
    const enddate = startdate + 500 * 86_400; // 500日 > 12チャンク×31日
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('http://localhost/webhook/withings-testhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ userid: '42', appli: '1', startdate: String(startdate), enddate: String(enddate) }).toString(),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    await waitOnExecutionContext(ctx);

    const rows = await testEnv.DB.prepare('SELECT payload FROM webhook_inbox ORDER BY id').all<{ payload: string }>();
    expect(rows.results.length).toBe(13); // 12チャンク + 残範囲1行
    const parsed = rows.results.map((r) => JSON.parse(r.payload) as { startdate: number; enddate: number });
    expect(parsed[0].startdate).toBe(startdate);
    expect(parsed[12].enddate).toBe(enddate); // 残範囲の終端は元payloadの終端
    // 範囲全体が隙間なく連続している（各行の次のstartは前のend+1）
    for (let i = 1; i < parsed.length; i++) expect(parsed[i].startdate).toBe(parsed[i - 1].enddate + 1);
  });
});
