import { createExecutionContext } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { createRootDashboardRouter } from '../src/dashboard';
import { resetTables, testEnv } from './helpers';

const rootEnv: Env = { ...testEnv, DASHBOARD_SLUG: '' };
const app = new Hono<{ Bindings: Env }>().route('/', createRootDashboardRouter());

function request(path: string, env: Env): Promise<Response> {
  return app.request(path, {}, env, createExecutionContext());
}

describe('ドメイン直下モード（DASHBOARD_SLUG=空文字）', () => {
  beforeEach(async () => {
    await resetTables();
  });

  it('/ がダッシュボードHTMLを返し、{{BASE}}が / に展開される', async () => {
    const res = await request('/', rootEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    const html = await res.text();
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).not.toContain('{{BASE}}');
    expect(html).not.toContain('{{SLUG}}');
    // Phase 2: カロリーオーバーレイのトグルと日次表の摂取/消費/ネット列
    expect(html).toContain('id="calorie-toggle"');
    expect(html).toContain('摂取 <span class="unit">kcal</span>');
    expect(html).toContain('消費 <span class="unit">kcal</span>');
    expect(html).toContain('ネット <span class="unit">kcal</span>');
    // 食事履歴テーブル（直近50日）
    expect(html).toContain('id="meals-history"');
    expect(html).not.toContain('id="meals-list"');
    // 運動タブ
    expect(html).toContain('id="tab-exercise"');
    expect(html).toContain('id="panel-exercise"');
    expect(html).toContain('id="exercise-history"');
  });

  it('manifestの start_url / scope が / になる', async () => {
    const res = await request('/manifest.webmanifest', rootEnv);
    expect(res.status).toBe(200);
    const manifest = JSON.parse(await res.text()) as { start_url: string; scope: string };
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
  });

  it('/api/status が200を返す', async () => {
    const res = await request('/api/status', rootEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
  });

  it('DASHBOARD_SLUGが非空のときはドメイン直下では配信しない', async () => {
    expect((await request('/', testEnv)).status).toBe(404);
    expect((await request('/api/status', testEnv)).status).toBe(404);
  });

  it('/meals.js が配信され、HTMLに食事タブが含まれる', async () => {
    const js = await request('/meals.js', rootEnv);
    expect(js.status).toBe(200);
    expect(js.headers.get('Content-Type')).toContain('javascript');
    const html = await (await request('/', rootEnv)).text();
    expect(html).toContain('id="tab-meals"');
    expect(html).toContain('meals.js');
  });

  it('/exercise.js が配信され、HTMLに運動タブスクリプトが含まれる', async () => {
    const js = await request('/exercise.js', rootEnv);
    expect(js.status).toBe(200);
    expect(js.headers.get('Content-Type')).toContain('javascript');
    const html = await (await request('/', rootEnv)).text();
    expect(html).toContain('exercise.js');
  });

  it('/apple-touch-icon.png がPNGとして配信され、HTMLから参照される', async () => {
    const res = await request('/apple-touch-icon.png', rootEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const body = new Uint8Array(await res.arrayBuffer());
    // PNGマジックナンバー（\x89PNG）で中身がPNGであることを確認
    expect([...body.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const html = await (await request('/', rootEnv)).text();
    expect(html).toContain('rel="apple-touch-icon"');
  });
});
