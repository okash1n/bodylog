import { Hono } from 'hono';
import type { Env } from './types';
import { LIMITS, dashboardBase, newId, noindexHeaders } from './util';
import {
  authorizeUrl,
  exchangeAuthorizationCode,
  getTokenRow,
  persistTokens,
  subscribeNotify,
} from './withings';
import {
  cleanupOldRows,
  ensureSubscription,
  insertInbox,
  parseWebhookPayload,
  processInbox,
  resumeInitialImport,
  runDailyBackfill,
  startInitialImport,
} from './ingest';
import { processNotificationBatches } from './slack';
import { createDashboardRouter, createRootDashboardRouter } from './dashboard';

interface OauthStateEntry {
  state: string;
  expires_at: string;
}

const OAUTH_STATE_TTL_MS = 10 * 60_000;
// inbox INSERT数をD1クエリ予算内に抑える上限（31日×12 ≒ 1年分/回。超過分は打ち切り）
const WEBHOOK_MAX_CHUNKS = 12;
const CRON_FREQUENT = '*/5 * * * *';
const CRON_DAILY = '15 20 * * *';

function authHeaders(): Record<string, string> {
  return noindexHeaders({ 'Referrer-Policy': 'no-referrer' });
}

async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1')
    .bind(key)
    .first<{ value: string | null }>();
  return row?.value ?? null;
}

function settingUpsert(env: Env, key: string, value: string): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).bind(key, value);
}

function parseStateList(raw: string | null): OauthStateEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is OauthStateEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { state?: unknown }).state === 'string' &&
        typeof (e as { expires_at?: unknown }).expires_at === 'string',
    );
  } catch (err) {
    console.error('[index] failed to parse settings.oauth_state', err);
    return [];
  }
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.7}.warn{color:#b45309}</style>
</head>
<body>${body}</body>
</html>`;
}

function errorPage(title: string, message: string): string {
  return htmlPage(title, `<h1>${title}</h1><p>${message}</p>`);
}

function completionHtml(base: string, subscribed: boolean): string {
  const dashboardPath = base;
  const statusPath = `${base}api/status`;
  const warn = subscribed
    ? ''
    : '<p class="warn">Withings通知の購読に失敗しました。日次ジョブで自動的に再試行されます。</p>';
  return htmlPage(
    '連携完了',
    `<h1>Withings連携が完了しました</h1>
${warn}<p>計測データの初期インポートを開始しました。</p>
<p>進捗: <span id="status">確認中...</span></p>
<p><a href="${dashboardPath}">ダッシュボードを開く</a></p>
<script>
(() => {
  const el = document.getElementById('status');
  const url = ${JSON.stringify(statusPath)};
  const poll = async () => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const s = await res.json();
      if (s.import_status === 'done') { el.textContent = '初期インポート完了'; return; }
      if (s.import_status === 'error') { el.textContent = '初期インポート失敗: ' + (s.import_error || '不明なエラー'); return; }
      el.textContent = '初期インポート中 (' + (s.import_status || '準備中') + ')';
    } catch {
      el.textContent = '状態を取得できませんでした。再試行します...';
    }
    setTimeout(poll, 3000);
  };
  poll();
})();
</script>`,
  );
}

function isWebhookToken(env: Env, token: string): boolean {
  return env.WEBHOOK_PATH_SECRET.length > 0 && token === `withings-${env.WEBHOOK_PATH_SECRET}`;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/auth/start', async (c) => {
  const env = c.env;
  for (const [k, v] of Object.entries(authHeaders())) c.header(k, v);
  if (!env.SETUP_SECRET || c.req.query('key') !== env.SETUP_SECRET) {
    return c.text('not found', 404);
  }
  const origin = new URL(c.req.url).origin;
  const state = newId();
  const now = Date.now();
  // 未期限切れstateは残す（二重タブ対応）、期限切れは掃除
  const states = parseStateList(await getSetting(env, 'oauth_state')).filter(
    (e) => Date.parse(e.expires_at) > now,
  );
  states.push({ state, expires_at: new Date(now + OAUTH_STATE_TTL_MS).toISOString() });
  await env.DB.batch([
    settingUpsert(env, 'oauth_state', JSON.stringify(states)),
    settingUpsert(env, 'public_origin', origin),
  ]);
  return c.redirect(authorizeUrl(env, `${origin}/auth/callback`, state), 302);
});

app.get('/auth/callback', async (c) => {
  const env = c.env;
  for (const [k, v] of Object.entries(authHeaders())) c.header(k, v);
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) {
    return c.html(errorPage('認証エラー', 'code / state パラメータがありません。'), 403);
  }
  const now = Date.now();
  const states = parseStateList(await getSetting(env, 'oauth_state'));
  const matched = states.find((e) => e.state === state && Date.parse(e.expires_at) > now);
  if (!matched) {
    return c.html(
      errorPage('認証エラー', 'state が不一致か期限切れです。/auth/start からやり直してください。'),
      403,
    );
  }
  // 使用済みstateは配列から削除（期限切れも掃除）
  const remaining = states.filter((e) => e.state !== state && Date.parse(e.expires_at) > now);
  await settingUpsert(env, 'oauth_state', JSON.stringify(remaining)).run();

  const origin = new URL(c.req.url).origin;
  const tokens = await exchangeAuthorizationCode(env, code, `${origin}/auth/callback`).catch(
    (err: unknown) => {
      console.error('[index] authorization code exchange failed', err);
      return null;
    },
  );
  if (!tokens) {
    return c.html(
      errorPage(
        '認証エラー',
        'トークン交換に失敗しました。認可コードは30秒で失効するため、/auth/start からやり直してください。',
      ),
      500,
    );
  }
  const existing = await getTokenRow(env);
  if (existing?.userid && existing.userid !== tokens.userid) {
    console.error('[index] userid mismatch on callback');
    return c.html(
      errorPage('認証エラー', '登録済みユーザーと異なるWithingsアカウントです。'),
      403,
    );
  }
  await persistTokens(env, tokens);

  const callbackUrl = `${origin}/webhook/withings-${env.WEBHOOK_PATH_SECRET}`;
  let subscribed = true;
  try {
    await subscribeNotify(env, tokens.access_token, callbackUrl);
    await settingUpsert(env, 'subscribed_callback_url', callbackUrl).run();
  } catch (err) {
    subscribed = false;
    console.error('[index] notify subscribe failed (daily ensureSubscription will retry)', err);
  }
  await startInitialImport(env);
  c.executionCtx.waitUntil(
    resumeInitialImport(env).then(
      () => undefined,
      (err: unknown) => console.error('[index] initial import run failed', err),
    ),
  );
  return c.html(completionHtml(dashboardBase(env), subscribed));
});

app.on(['GET', 'HEAD'], '/webhook/:token', (c) => {
  if (!isWebhookToken(c.env, c.req.param('token'))) return c.notFound();
  return c.text('ok', 200);
});

app.post('/webhook/:token', async (c) => {
  const env = c.env;
  if (!isWebhookToken(env, c.req.param('token'))) return c.notFound();
  const params = new URLSearchParams(await c.req.text());
  const payload = parseWebhookPayload(params);
  if (!payload || payload.appli !== 1) {
    // 不正payloadはWithingsの再送ループを防ぐため200で握る
    console.warn('[index] ignored invalid webhook payload', params.toString());
    return c.text('ignored', 200);
  }
  const tokenRow = await getTokenRow(env);
  if (!tokenRow?.userid || tokenRow.userid !== payload.userid) {
    console.warn('[index] ignored webhook for unknown userid');
    return c.text('ignored', 200);
  }
  // WEBHOOK_MAX_RANGE_DAYS 超の期間は拒否せず分割してinboxへ
  const spanSeconds = LIMITS.WEBHOOK_MAX_RANGE_DAYS * 86_400;
  let chunks = 0;
  for (let s = payload.startdate; s <= payload.enddate; s += spanSeconds + 1) {
    if (chunks >= WEBHOOK_MAX_CHUNKS) {
      console.warn('[index] webhook range truncated at chunk cap', {
        startdate: payload.startdate,
        enddate: payload.enddate,
      });
      break;
    }
    const e = Math.min(s + spanSeconds, payload.enddate);
    await insertInbox(
      env,
      JSON.stringify({ userid: payload.userid, appli: payload.appli, startdate: s, enddate: e }),
    );
    chunks++;
  }
  c.executionCtx.waitUntil(
    (async () => {
      await processInbox(env);
      const origin = await getSetting(env, 'public_origin');
      if (!origin) {
        console.warn('[index] settings.public_origin is not set; skipping notification send');
        return;
      }
      await processNotificationBatches(env, origin);
    })().catch((err: unknown) => console.error('[index] webhook async processing failed', err)),
  );
  return c.text('ok', 200);
});

app.route('/d', createDashboardRouter());
// DASHBOARD_SLUG が空文字（専用ドメイン運用）のときだけ有効になる
app.route('/', createRootDashboardRouter());

app.notFound((c) => c.text('not found', 404, noindexHeaders()));

app.onError((err, c) => {
  console.error('[index] unhandled error', err);
  return c.text('internal error', 500, noindexHeaders());
});

async function runStep(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // 1ステップの失敗で後続を止めない（各モジュール内でalert済み）
    console.error(`[index] scheduled step ${name} failed`, err);
  }
}

async function scheduled(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  if (controller.cron === CRON_FREQUENT) {
    await runStep('processInbox', () => processInbox(env));
    const origin = await getSetting(env, 'public_origin');
    if (origin) {
      await runStep('processNotificationBatches', () => processNotificationBatches(env, origin));
    } else {
      console.warn('[index] settings.public_origin is not set; skipping notification send');
    }
    // import未完了かの判定はresumeInitialImport自身が行う（done/errorなら即return）
    await runStep('resumeInitialImport', () => resumeInitialImport(env));
    return;
  }
  if (controller.cron === CRON_DAILY) {
    await runStep('runDailyBackfill', () => runDailyBackfill(env));
    await runStep('cleanupOldRows', () => cleanupOldRows(env));
    const origin = await getSetting(env, 'public_origin');
    if (origin) {
      await runStep('ensureSubscription', () =>
        ensureSubscription(env, `${origin}/webhook/withings-${env.WEBHOOK_PATH_SECRET}`),
      );
    } else {
      console.warn('[index] settings.public_origin is not set; skipping subscription check');
    }
    return;
  }
  console.warn('[index] unknown cron expression', controller.cron);
}

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
