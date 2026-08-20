import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  apiFetch, insertMeasurement, localYmdDaysAgo, obtainAccessToken, resetTables, rootTestEnv, setSetting, testEnv,
} from './helpers';

let token: string;
beforeAll(async () => {
  await resetTables();
  token = await obtainAccessToken(rootTestEnv);
});
afterEach(() => vi.unstubAllGlobals());

// APIはmeasured_atの未来日時を拒否するため、確実に過去になる前日正午（JST）を使う
const at = `${localYmdDaysAgo(1)}T03:00:00Z`;

/** OAuthプロバイダの状態（KV）は残し、D1側だけ空にする */
async function clearData(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM measurements'),
    testEnv.DB.prepare('DELETE FROM notification_batch_items'),
    testEnv.DB.prepare('DELETE FROM notification_batches'),
    testEnv.DB.prepare('DELETE FROM settings'),
  ]);
}

describe('POST /api/weight', () => {
  beforeEach(clearData);

  it('未認証は401', async () => {
    const res = await apiFetch(rootTestEnv, '/api/weight', null, 'POST', { weight_kg: 83.4 });
    expect(res.status).toBe(401);
  });

  it('バリデーション失敗は400', async () => {
    const res = await apiFetch(rootTestEnv, '/api/weight', token, 'POST', { weight_kg: 10 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('weight_kg');
  });

  it('201で保存行を返し、summaryの読み取りに載る', async () => {
    const res = await apiFetch(rootTestEnv, '/api/weight', token, 'POST', {
      weight_kg: 83.4, fat_ratio: 28.3, measured_at: at,
    });
    expect(res.status).toBe(201);
    const saved = (await res.json()) as { id: number; source: string; fat_free_mass: number };
    expect(saved.id).toBe(-1);
    expect(saved.source).toBe('manual');
    const summary = await worker.fetch(
      new Request('http://localhost/api/summary'), rootTestEnv, createExecutionContext(),
    );
    const body = (await summary.json()) as { latest: { weight: number } };
    expect(body.latest.weight).toBeCloseTo(83.4, 3);
  });

  it('public_origin未設定なら書き込み到着時に初期化し、設定済みなら上書きしない', async () => {
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request('http://localhost/api/weight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ weight_kg: 83.4, measured_at: at }),
      }),
      rootTestEnv, ctx,
    );
    await waitOnExecutionContext(ctx);
    const row = await testEnv.DB.prepare("SELECT value FROM settings WHERE key = 'public_origin'")
      .first<{ value: string }>();
    expect(row?.value).toBe('http://localhost');

    await setSetting('public_origin', 'https://weight.example.com');
    const ctx2 = createExecutionContext();
    await worker.fetch(
      new Request('http://localhost/api/weight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ weight_kg: 83.2, measured_at: at }),
      }),
      rootTestEnv, ctx2,
    );
    await waitOnExecutionContext(ctx2);
    const row2 = await testEnv.DB.prepare("SELECT value FROM settings WHERE key = 'public_origin'")
      .first<{ value: string }>();
    expect(row2?.value).toBe('https://weight.example.com');
  });
});

describe('DELETE /api/weight/:id', () => {
  beforeEach(clearData);

  it('manual行は削除でき、Withings行と不在IDは404', async () => {
    await insertMeasurement({ grpid: 42, measured_at: at, weight: 84 });
    const created = await apiFetch(rootTestEnv, '/api/weight', token, 'POST', { weight_kg: 83.4, measured_at: at });
    const { id } = (await created.json()) as { id: number };
    expect((await apiFetch(rootTestEnv, '/api/weight/42', token, 'DELETE')).status).toBe(404);
    expect((await apiFetch(rootTestEnv, '/api/weight/abc', token, 'DELETE')).status).toBe(404);
    expect((await apiFetch(rootTestEnv, `/api/weight/${id}`, token, 'DELETE')).status).toBe(200);
    expect((await apiFetch(rootTestEnv, `/api/weight/${id}`, token, 'DELETE')).status).toBe(404);
  });
});
