import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from './types';
import {
  LIMITS,
  dashboardBase,
  isValidYmd,
  isoNow,
  noindexHeaders,
  offsetHours,
  ymdWithOffset,
} from './util';
import { getDailySeries, getImportStatus, getRawMeasurements } from './queries';
import { renderOgPng } from './og';
import indexHtmlTpl from './dashboard/index.html';
import stylesCss from './dashboard/styles.css';
import appJs from './dashboard/app.js';
import swJsTpl from './dashboard/sw.js';
import manifestTpl from './dashboard/manifest.webmanifest';
import chartVendorJs from './dashboard/vendor/chart.umd.js';

/** 静的assetのキャッシュバスターとsw.jsのキャッシュ名に使うバージョン */
export const ASSET_VERSION = '2026-08-04-6';

const STATIC_CACHE_CONTROL = 'public, max-age=3600';
const JS_CONTENT_TYPE = 'text/javascript; charset=utf-8';

type DashboardContext = Context<{ Bindings: Env }>;
type Handler = (c: DashboardContext) => Response | Promise<Response>;

function notFound(c: DashboardContext): Response {
  return c.text('not found', 404, noindexHeaders());
}

function localToday(env: Env): string {
  return ymdWithOffset(isoNow(), offsetHours(env));
}

function addDaysYmd(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function inclusiveDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

// ---- 共有ハンドラ（/d/{slug}/ 配下とドメイン直下の両モードから使う） ----

const serveIndex: Handler = (c) => {
  const base = dashboardBase(c.env);
  const origin = new URL(c.req.url).origin;
  const html = indexHtmlTpl
    .replaceAll('{{BASE}}', base)
    .replaceAll('{{OG_IMAGE_URL}}', `${origin}${base}og.png`)
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

// sw.jsは即時更新できるようno-cacheで配信する
const serveSw: Handler = (c) =>
  c.body(
    swJsTpl.replaceAll('{{ASSET_VERSION}}', ASSET_VERSION),
    200,
    noindexHeaders({ 'Content-Type': JS_CONTENT_TYPE, 'Cache-Control': 'no-cache' }),
  );

function validatedRange(
  c: DashboardContext,
  headers: Record<string, string>,
): { from: string; to: string } | Response {
  const from = c.req.query('from') ?? '';
  const to = c.req.query('to') ?? '';
  if (!isValidYmd(from) || !isValidYmd(to)) {
    return c.json({ error: 'from/to must be valid YYYY-MM-DD' }, 400, headers);
  }
  if (from > to) {
    return c.json({ error: 'from must be on or before to' }, 400, headers);
  }
  if (to > localToday(c.env)) {
    return c.json({ error: 'to must not be a future date' }, 400, headers);
  }
  if (inclusiveDays(from, to) > LIMITS.API_MAX_RANGE_DAYS) {
    return c.json({ error: `range must be within ${LIMITS.API_MAX_RANGE_DAYS} days` }, 400, headers);
  }
  return { from, to };
}

const serveMeasurements: Handler = async (c) => {
  const headers = noindexHeaders({ 'Cache-Control': 'no-store' });
  const range = validatedRange(c, headers);
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
  const range = validatedRange(c, headers);
  if (range instanceof Response) return range;
  try {
    const measurements = await getRawMeasurements(c.env, range.from, range.to);
    return c.json({ measurements }, 200, headers);
  } catch (err) {
    console.error('[dashboard] getRawMeasurements failed', err);
    return c.json({ error: 'internal error' }, 500, headers);
  }
};

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
  app.get('/:slug/', guarded(serveIndex));
  app.get('/:slug/styles.css', guarded(serveStyles));
  app.get('/:slug/app.js', guarded(serveAppJs));
  app.get('/:slug/vendor/chart.umd.js', guarded(serveVendor));
  app.get('/:slug/manifest.webmanifest', guarded(serveManifest));
  app.get('/:slug/sw.js', guarded(serveSw));
  app.get('/:slug/api/measurements', guarded(serveMeasurements));
  app.get('/:slug/api/raw', guarded(serveRaw));
  app.get('/:slug/api/status', guarded(serveStatus));
  app.get('/:slug/og.png', guarded(serveOg));
  return app;
}

/**
 * DASHBOARD_SLUG が空文字のとき、ドメイン直下（/）でダッシュボードを配信する。
 * 専用ドメイン運用向け。アクセス制限が必要なら Cloudflare Access 等をドメインに後付けする。
 */
export function createRootDashboardRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const guarded = (h: Handler): Handler => (c) => (c.env.DASHBOARD_SLUG === '' ? h(c) : notFound(c));
  app.get('/', guarded(serveIndex));
  app.get('/styles.css', guarded(serveStyles));
  app.get('/app.js', guarded(serveAppJs));
  app.get('/vendor/chart.umd.js', guarded(serveVendor));
  app.get('/manifest.webmanifest', guarded(serveManifest));
  app.get('/sw.js', guarded(serveSw));
  app.get('/api/measurements', guarded(serveMeasurements));
  app.get('/api/raw', guarded(serveRaw));
  app.get('/api/status', guarded(serveStatus));
  app.get('/og.png', guarded(serveOg));
  return app;
}
