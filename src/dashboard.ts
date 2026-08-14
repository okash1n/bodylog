import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from './types';
import {
  addDaysYmd,
  dashboardBase,
  localToday,
  noindexHeaders,
  offsetHours,
  resolveRangeFromQuery,
  ymdWithOffset,
} from './util';
import { getDailySeries, getImportStatus, getRawMeasurements, getSummary } from './queries';
import { llmsTxt, openapiSpec } from './ai';
import { serveMealsDaily, serveMealsList, serveMenus } from './meals-api';
import { serveExerciseDaily, serveExerciseLogs, serveExerciseMenus } from './exercise-api';
import { serveCoachingLatest } from './coaching';
import { registerWriteRoutes } from './writes';
import { OG_RENDERER_VERSION, renderOgPng } from './og';
import indexHtmlTpl from './dashboard/index.html';
import stylesCss from './dashboard/styles.css';
import appJs from './dashboard/app.js';
import sharedJs from './dashboard/shared.js';
import mealsJs from './dashboard/meals.js';
import exerciseJs from './dashboard/exercise.js';
import swJsTpl from './dashboard/sw.js';
import manifestTpl from './dashboard/manifest.webmanifest';
import chartVendorJs from './dashboard/vendor/chart.umd.js';
import { appleTouchIconPng } from './dashboard/icon';

/** 静的assetのキャッシュバスターとsw.jsのキャッシュ名に使うバージョン */
export const ASSET_VERSION = '2026-08-14-27';

const STATIC_CACHE_CONTROL = 'public, max-age=3600';
const JS_CONTENT_TYPE = 'text/javascript; charset=utf-8';

type DashboardContext = Context<{ Bindings: Env }>;
type Handler = (c: DashboardContext) => Response | Promise<Response>;

function notFound(c: DashboardContext): Response {
  return c.text('not found', 404, noindexHeaders());
}

// ---- 共有ハンドラ（/d/{slug}/ 配下とドメイン直下の両モードから使う） ----

const serveIndex: Handler = async (c) => {
  const base = dashboardBase(c.env);
  const origin = new URL(c.req.url).origin;
  // og:imageは最新計測日のキャッシュバスター付きにする。固定URLだとSlack等の
  // 画像プロキシが一度キャッシュした古いグラフを返し続けるため
  let ogVersion = localToday(c.env);
  try {
    const status = await getImportStatus(c.env);
    if (status.latest_measured_at) {
      ogVersion = ymdWithOffset(status.latest_measured_at, offsetHours(c.env));
    }
  } catch (err) {
    console.error('[dashboard] failed to resolve og version (falling back to today)', err);
  }
  const html = indexHtmlTpl
    .replaceAll('{{BASE}}', base)
    .replaceAll('{{OG_IMAGE_URL}}', `${origin}${base}og.png?v=${ogVersion}-r${OG_RENDERER_VERSION}`)
    .replaceAll('{{ASSET_VERSION}}', ASSET_VERSION);
  return c.html(html, 200, noindexHeaders({ 'Cache-Control': 'no-cache' }));
};

const serveStyles: Handler = (c) =>
  c.body(
    stylesCss,
    200,
    noindexHeaders({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': STATIC_CACHE_CONTROL }),
  );

const serveAppJs: Handler = (c) =>
  c.body(appJs, 200, noindexHeaders({ 'Content-Type': JS_CONTENT_TYPE, 'Cache-Control': STATIC_CACHE_CONTROL }));

const serveSharedJs: Handler = (c) =>
  c.body(sharedJs, 200, noindexHeaders({ 'Content-Type': JS_CONTENT_TYPE, 'Cache-Control': STATIC_CACHE_CONTROL }));

const serveMealsJs: Handler = (c) =>
  c.body(mealsJs, 200, noindexHeaders({ 'Content-Type': JS_CONTENT_TYPE, 'Cache-Control': STATIC_CACHE_CONTROL }));

const serveExerciseJs: Handler = (c) =>
  c.body(exerciseJs, 200, noindexHeaders({ 'Content-Type': JS_CONTENT_TYPE, 'Cache-Control': STATIC_CACHE_CONTROL }));

const serveVendor: Handler = (c) =>
  c.body(
    chartVendorJs,
    200,
    noindexHeaders({ 'Content-Type': JS_CONTENT_TYPE, 'Cache-Control': STATIC_CACHE_CONTROL }),
  );

const serveManifest: Handler = (c) =>
  c.body(
    manifestTpl.replaceAll('{{BASE}}', dashboardBase(c.env)),
    200,
    noindexHeaders({
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': STATIC_CACHE_CONTROL,
    }),
  );

// Safariのホーム画面追加用（manifestのdata URI SVGはSafariが使わないため実URLのPNGを配信）
const serveAppleTouchIcon: Handler = (c) =>
  c.body(
    appleTouchIconPng(),
    200,
    noindexHeaders({ 'Content-Type': 'image/png', 'Cache-Control': STATIC_CACHE_CONTROL }),
  );

// sw.jsは即時更新できるようno-cacheで配信する
const serveSw: Handler = (c) =>
  c.body(
    swJsTpl.replaceAll('{{ASSET_VERSION}}', ASSET_VERSION),
    200,
    noindexHeaders({ 'Content-Type': JS_CONTENT_TYPE, 'Cache-Control': 'no-cache' }),
  );

const serveMeasurements: Handler = async (c) => {
  const headers = noindexHeaders({ 'Cache-Control': 'no-store' });
  const range = resolveRangeFromQuery(c, headers);
  if (range instanceof Response) return range;
  try {
    const days = await getDailySeries(c.env, range.from, range.to);
    return c.json({ days }, 200, headers);
  } catch (err) {
    console.error('[dashboard] getDailySeries failed', err);
    return c.json({ error: 'internal error' }, 500, headers);
  }
};

const serveRaw: Handler = async (c) => {
  const headers = noindexHeaders({ 'Cache-Control': 'no-store' });
  const range = resolveRangeFromQuery(c, headers);
  if (range instanceof Response) return range;
  try {
    const measurements = await getRawMeasurements(c.env, range.from, range.to);
    return c.json({ measurements }, 200, headers);
  } catch (err) {
    console.error('[dashboard] getRawMeasurements failed', err);
    return c.json({ error: 'internal error' }, 500, headers);
  }
};

const serveSummary: Handler = async (c) => {
  const headers = noindexHeaders({ 'Cache-Control': 'no-store' });
  try {
    const summary = await getSummary(c.env);
    return c.json(summary, 200, headers);
  } catch (err) {
    console.error('[dashboard] getSummary failed', err);
    return c.json({ error: 'internal error' }, 500, headers);
  }
};

const serveLlmsTxt: Handler = (c) =>
  c.body(
    llmsTxt(new URL(c.req.url).origin, dashboardBase(c.env), offsetHours(c.env)),
    200,
    noindexHeaders({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': STATIC_CACHE_CONTROL,
    }),
  );

const serveOpenapi: Handler = (c) =>
  c.json(
    openapiSpec(new URL(c.req.url).origin, dashboardBase(c.env), offsetHours(c.env)),
    200,
    noindexHeaders({ 'Cache-Control': STATIC_CACHE_CONTROL }),
  );

const serveStatus: Handler = async (c) => {
  const headers = noindexHeaders({ 'Cache-Control': 'no-store' });
  try {
    const status = await getImportStatus(c.env);
    return c.json(status, 200, headers);
  } catch (err) {
    console.error('[dashboard] getImportStatus failed', err);
    return c.json({ error: 'internal error' }, 500, headers);
  }
};

const serveOg: Handler = async (c) => {
  try {
    const to = localToday(c.env);
    const from = addDaysYmd(to, -29);
    const days = await getDailySeries(c.env, from, to);
    const png = await renderOgPng(days, { width: 1200, height: 630 });
    return new Response(png, {
      status: 200,
      headers: noindexHeaders({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=600' }),
    });
  } catch (err) {
    console.error('[dashboard] og.png render failed', err);
    return c.text('og render failed', 500, noindexHeaders());
  }
};

/**
 * 公開GETルートの一覧。スラッグ配下とドメイン直下の両ルータへ同じ表から登録する
 * （個別列挙の二重管理だと、追加漏れがテストを素通りして本番に出るため）。
 * openapi.json との整合テストからも参照する。
 */
export const READ_ROUTES: ReadonlyArray<readonly [string, Handler]> = [
  ['', serveIndex],
  ['styles.css', serveStyles],
  ['app.js', serveAppJs],
  ['shared.js', serveSharedJs],
  ['meals.js', serveMealsJs],
  ['exercise.js', serveExerciseJs],
  ['vendor/chart.umd.js', serveVendor],
  ['manifest.webmanifest', serveManifest],
  ['apple-touch-icon.png', serveAppleTouchIcon],
  ['sw.js', serveSw],
  ['api/measurements', serveMeasurements],
  ['api/raw', serveRaw],
  ['api/status', serveStatus],
  ['api/summary', serveSummary],
  ['api/menus', serveMenus],
  ['api/meals/daily', serveMealsDaily],
  ['api/meals', serveMealsList],
  ['api/exercise/menus', serveExerciseMenus],
  ['api/exercise/daily', serveExerciseDaily],
  ['api/exercise/logs', serveExerciseLogs],
  ['api/coaching/latest', serveCoachingLatest],
  ['llms.txt', serveLlmsTxt],
  ['openapi.json', serveOpenapi],
  ['og.png', serveOg],
];

/** /d/{slug}/ 配下でダッシュボードを配信する（DASHBOARD_SLUG が非空のとき有効） */
export function createDashboardRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const slugMatches = (c: DashboardContext): boolean =>
    c.env.DASHBOARD_SLUG !== '' && c.req.param('slug') === c.env.DASHBOARD_SLUG;
  const guarded = (h: Handler): Handler => (c) => (slugMatches(c) ? h(c) : notFound(c));

  // 末尾スラッシュなしは正規URLへリダイレクト
  app.get('/:slug', (c) => {
    if (!slugMatches(c)) return notFound(c);
    return new Response(null, {
      status: 301,
      headers: noindexHeaders({ Location: `/d/${c.env.DASHBOARD_SLUG}/` }),
    });
  });
  for (const [path, handler] of READ_ROUTES) {
    app.get(`/:slug/${path}`, guarded(handler));
  }
  // 書き込み（POST/PATCH/DELETE）は同じ /api 名前空間にメソッドで同居し、withAuthで保護する
  registerWriteRoutes(app, guarded, '/:slug');
  return app;
}

/**
 * DASHBOARD_SLUG が空文字のとき、ドメイン直下（/）でダッシュボードを配信する。
 * 専用ドメイン運用向け。アクセス制限が必要なら Cloudflare Access 等をドメインに後付けする。
 */
export function createRootDashboardRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const guarded = (h: Handler): Handler => (c) => (c.env.DASHBOARD_SLUG === '' ? h(c) : notFound(c));
  for (const [path, handler] of READ_ROUTES) {
    app.get(`/${path}`, guarded(handler));
  }
  registerWriteRoutes(app, guarded, '');
  return app;
}
