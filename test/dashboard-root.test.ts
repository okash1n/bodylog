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
    // カロリー表示は専用チェックボックスを廃止し凡例クリックに統一（トレンドのトグルは残る）
    expect(html).not.toContain('id="calorie-toggle"');
    expect(html).toContain('id="trend-toggle"');
    // テーマ切替は太陽/月アイコン
    expect(html).toContain('icon-sun');
    expect(html).toContain('icon-moon');
    expect(html).toContain('摂取 <span class="unit">kcal</span>');
    expect(html).toContain('消費 <span class="unit">kcal</span>');
    expect(html).toContain('カロリー収支 <span class="unit">kcal</span>');
    // AIコーチ講評カード（初期状態はhidden、/api/coaching/latest取得後にJSが表示する）
    expect(html).toContain('id="ai-coach"');
    expect(html).toContain('id="ai-coach-history"');
    // 実効消費カードと目標サブ行（目標未設定・データ不足時はhiddenのまま）
    expect(html).toContain('id="metabolism-card"');
    expect(html).toContain('id="card-weight-goal-row"');
    expect(html).toContain('id="card-fat-goal-row"');
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

  it('/shared.js が配信され、HTMLでmeals.jsより先に読み込まれる', async () => {
    const js = await request('/shared.js', rootEnv);
    expect(js.status).toBe(200);
    expect(js.headers.get('Content-Type')).toContain('javascript');
    const html = await (await request('/', rootEnv)).text();
    // deferスクリプトは記述順に実行される。shared.jsがwindow.__dashを公開してからmeals.jsが動く前提
    expect(html.indexOf('shared.js')).toBeGreaterThan(-1);
    expect(html.indexOf('shared.js')).toBeLessThan(html.indexOf('meals.js'));
  });

  it('sw.js のプリキャッシュにHTMLが読む全JSが含まれる（漏れるとオフラインでタブが壊れる）', async () => {
    const res = await request('/sw.js', rootEnv);
    expect(res.status).toBe(200);
    const sw = await res.text();
    for (const asset of ['app.js?v=', 'shared.js?v=', 'meals.js?v=', 'exercise.js?v=', 'styles.css?v=', 'vendor/chart.umd.js?v=']) {
      expect(sw).toContain(`'${asset}' + VERSION`);
    }
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

  it('体重タブに手動記録フォーム（POST /api/weight）とログイン導線がある', async () => {
    const html = await (await request('/', rootEnv)).text();
    for (const id of ['weight-entry', 'weight-login', 'weight-form', 'weight-kg', 'weight-fat', 'weight-at', 'weight-submit']) {
      expect(html, id).toContain(`id="${id}"`);
    }
    // フォームは #content（データ読込後にだけ出る領域）の外に置き、記録が1件も無くても使えるようにする
    expect(html.indexOf('id="weight-entry"')).toBeLessThan(html.indexOf('id="content"'));
  });
});
