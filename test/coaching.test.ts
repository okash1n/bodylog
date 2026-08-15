import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { coachingDigestBlocks, parseCoachingInput } from '../src/coaching';
import type { CoachingNote } from '../src/coaching';
import { resetTables, rootTestEnv } from './helpers';

const SECRET = 'test-coaching-secret';

/** シークレット設定済みのドメイン直下Env（Slack配信はダイジェスト側の責務なのでここでは不要） */
const coachingEnv: Env = { ...rootTestEnv, COACHING_API_SECRET: SECRET };

async function postCoaching(env: Env, body: unknown, token: string | null = SECRET): Promise<Response> {
  const ctx = createExecutionContext();
  return worker.fetch(
    new Request('http://localhost/api/coaching', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

function getLatest(env: Env): Promise<Response> {
  return worker.fetch(
    new Request('http://localhost/api/coaching/latest'),
    env,
    createExecutionContext(),
  );
}

const validBody = { kind: 'daily', date: '2026-08-13', content: '今日は脂質過多。明日は揚げ物を控えよう。', model: 'test-model' };

describe('POST /api/coaching の認証', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('COACHING_API_SECRET未設定なら404（機能無効）', async () => {
    const res = await postCoaching({ ...rootTestEnv, COACHING_API_SECRET: undefined }, validBody);
    expect(res.status).toBe(404);
  });

  it('Authorizationなし・トークン不一致は401', async () => {
    expect((await postCoaching(coachingEnv, validBody, null)).status).toBe(401);
    expect((await postCoaching(coachingEnv, validBody, 'wrong-token')).status).toBe(401);
    // 長さ一致でも不一致は401（タイミングセーフ比較の分岐）
    expect((await postCoaching(coachingEnv, validBody, 'x'.repeat(SECRET.length))).status).toBe(401);
  });
});

describe('POST /api/coaching の保存', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('バリデーション: kind/date/content不正は400', async () => {
    const cases: Record<string, unknown>[] = [
      { ...validBody, kind: 'monthly' },
      { ...validBody, date: '2026-02-30' },
      { ...validBody, date: '20260813' },
      { ...validBody, content: '' },
      { ...validBody, content: '  ' },
      { ...validBody, content: 'x'.repeat(4001) },
      { ...validBody, model: 42 },
    ];
    for (const body of cases) {
      const res = await postCoaching(coachingEnv, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });

  it('201で保存され、/api/coaching/latest に反映される', async () => {
    const res = await postCoaching(coachingEnv, validBody);
    expect(res.status).toBe(201);
    const saved = (await res.json()) as CoachingNote;
    expect(saved.kind).toBe('daily');
    expect(saved.date).toBe('2026-08-13');

    const latest = (await (await getLatest(coachingEnv)).json()) as { daily: CoachingNote | null };
    expect(latest.daily?.content).toBe(validBody.content);
  });

  it('同kind・同日の再保存はcontentを上書きする', async () => {
    expect((await postCoaching(coachingEnv, validBody)).status).toBe(201);
    expect((await postCoaching(coachingEnv, { ...validBody, content: '改訂版の講評' })).status).toBe(201);
    const latest = (await (await getLatest(coachingEnv)).json()) as { daily: CoachingNote | null };
    expect(latest.daily?.content).toBe('改訂版の講評');
  });
});

describe('GET /api/coaching（履歴一覧）', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('期間指定なしは400、days指定で新しい順に返す', async () => {
    await postCoaching(coachingEnv, { kind: 'daily', date: '2026-08-13', content: '一昨日' });
    await postCoaching(coachingEnv, { kind: 'daily', date: '2026-08-14', content: '昨日' });
    const bad = await worker.fetch(
      new Request('http://localhost/api/coaching'),
      rootTestEnv,
      createExecutionContext(),
    );
    expect(bad.status).toBe(400);

    const res = await worker.fetch(
      new Request('http://localhost/api/coaching?days=731'),
      rootTestEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const { notes } = (await res.json()) as { notes: CoachingNote[] };
    expect(notes.map((n) => n.date)).toEqual(['2026-08-14', '2026-08-13']);
  });
});

describe('GET /api/coaching/latest', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('未生成なら daily/weekly とも null', async () => {
    const res = await getLatest(rootTestEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(await res.json()).toEqual({ daily: null, weekly: null });
  });

  it('kindごとに日付が最新の1件を返す', async () => {
    await postCoaching(coachingEnv, { kind: 'daily', date: '2026-08-12', content: '古い日次' });
    await postCoaching(coachingEnv, { kind: 'daily', date: '2026-08-13', content: '新しい日次' });
    await postCoaching(coachingEnv, { kind: 'weekly', date: '2026-08-11', content: '週次総括' });
    const latest = (await (await getLatest(coachingEnv)).json()) as {
      daily: CoachingNote | null;
      weekly: CoachingNote | null;
    };
    expect(latest.daily?.date).toBe('2026-08-13');
    expect(latest.daily?.content).toBe('新しい日次');
    expect(latest.weekly?.date).toBe('2026-08-11');
  });
});

describe('coaching ユニット', () => {
  it('parseCoachingInput: contentをtrimし、model省略はnull', () => {
    const r = parseCoachingInput({ kind: 'weekly', date: '2026-08-10', content: '  本文  ' });
    expect(r).toEqual({
      ok: true,
      value: { kind: 'weekly', date: '2026-08-10', content: '本文', model: null },
    });
  });

  it('coachingDigestBlocks: 見出し＋本文で、長文はSlackのsection上限内に分割される', () => {
    const note: CoachingNote = {
      id: 'x',
      kind: 'daily',
      date: '2026-08-10',
      content: Array.from({ length: 80 }, (_, i) => `行${i} ${'あ'.repeat(50)}`).join('\n'),
      model: null,
      created_at: '2026-08-10T00:00:00Z',
    };
    const blocks = coachingDigestBlocks(note) as { text?: { text: string } }[];
    expect(blocks[0].text?.text).toContain('AIコーチ');
    expect(blocks.length).toBeGreaterThan(2); // 見出し + 本文2分割以上
    for (const b of blocks) {
      expect((b.text?.text ?? '').length).toBeLessThanOrEqual(2800);
    }
    // 分割しても本文が欠落しない
    const joined = blocks
      .slice(1)
      .map((b) => b.text?.text ?? '')
      .join('\n');
    expect(joined).toBe(note.content);
  });
});
