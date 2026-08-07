import type { Env, IngestContext, MeasureGroup, MeasurementUpsert } from './types';
import { LIMITS, newId } from './util';
import {
  fetchMeasPage,
  getValidAccessToken,
  groupToUpsert,
  listNotifySubscriptions,
  revokeNotify,
  subscribeNotify,
} from './withings';
import { immediateDestinations, sendAdminAlert } from './slack';

// 1文あたりバインド変数90個以下の制約: 1行6バインドなので15行ずつ分割する
const UPSERT_BINDS_PER_ROW = 6;
const UPSERT_ROWS_PER_STATEMENT = Math.floor(90 / UPSERT_BINDS_PER_ROW);
// Withingsレート制限（120req/分）対策のページ間待機
const PAGE_INTERVAL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1')
    .bind(key)
    .first<{ value: string | null }>();
  return row?.value ?? null;
}

function setSettingStmt(env: Env, key: string, value: string | null): D1PreparedStatement {
  return env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).bind(key, value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function collectUpserts(groups: MeasureGroup[], into: Map<number, MeasurementUpsert>): void {
  for (const g of groups) {
    const u = groupToUpsert(g);
    if (u) into.set(u.grpid, u);
  }
}

function buildUpsertStatements(env: Env, upserts: MeasurementUpsert[]): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < upserts.length; i += UPSERT_ROWS_PER_STATEMENT) {
    const chunk = upserts.slice(i, i + UPSERT_ROWS_PER_STATEMENT);
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const sql =
      'INSERT INTO measurements (grpid, measured_at, weight, fat_ratio, fat_free_mass, raw_json) ' +
      `VALUES ${placeholders} ` +
      'ON CONFLICT(grpid) DO UPDATE SET measured_at = excluded.measured_at, weight = excluded.weight, ' +
      'fat_ratio = excluded.fat_ratio, fat_free_mass = excluded.fat_free_mass, raw_json = excluded.raw_json, ' +
      "updated_at = datetime('now')";
    const binds = chunk.flatMap((u) => [
      u.grpid,
      u.measured_at,
      u.weight,
      u.fat_ratio,
      u.fat_free_mass,
      u.raw_json,
    ]);
    statements.push(env.DB.prepare(sql).bind(...binds));
  }
  return statements;
}

export function parseWebhookPayload(
  params: URLSearchParams,
): { userid: string; appli: number; startdate: number; enddate: number } | null {
  const userid = params.get('userid');
  const appliRaw = params.get('appli');
  const startRaw = params.get('startdate');
  const endRaw = params.get('enddate');
  if (!userid || appliRaw === null || startRaw === null || endRaw === null) return null;
  if (!/^\d+$/.test(appliRaw) || !/^\d+$/.test(startRaw) || !/^\d+$/.test(endRaw)) return null;
  const appli = Number(appliRaw);
  const startdate = Number(startRaw);
  const enddate = Number(endRaw);
  if (
    !Number.isSafeInteger(appli) ||
    !Number.isSafeInteger(startdate) ||
    !Number.isSafeInteger(enddate)
  ) {
    return null;
  }
  if (startdate <= 0 || enddate <= 0 || enddate < startdate) return null;
  // このWebhookは体重・体組成カテゴリ（appli=1）専用
  if (appli !== 1) return null;
  return { userid, appli, startdate, enddate };
}

export async function insertInbox(env: Env, payloadJson: string): Promise<void> {
  await env.DB.prepare('INSERT INTO webhook_inbox (payload) VALUES (?1)').bind(payloadJson).run();
}

function parseInboxPayload(json: string): {
  userid: string;
  appli: number;
  startdate: number;
  enddate: number;
} {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('inbox payload is not valid JSON');
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('inbox payload is not an object');
  }
  const p = value as Record<string, unknown>;
  if (
    typeof p.userid !== 'string' ||
    typeof p.appli !== 'number' ||
    typeof p.startdate !== 'number' ||
    typeof p.enddate !== 'number'
  ) {
    throw new Error('inbox payload has invalid fields');
  }
  if (
    !Number.isSafeInteger(p.startdate) ||
    !Number.isSafeInteger(p.enddate) ||
    p.startdate <= 0 ||
    p.enddate < p.startdate
  ) {
    throw new Error('inbox payload has invalid range');
  }
  return { userid: p.userid, appli: p.appli, startdate: p.startdate, enddate: p.enddate };
}

export async function processInbox(env: Env): Promise<{ processed: number; failed: number }> {
  const { results } = await env.DB.prepare(
    'SELECT id, payload, attempts FROM webhook_inbox WHERE processed_at IS NULL AND attempts < ?1 ORDER BY id LIMIT ?2',
  )
    .bind(LIMITS.MAX_INBOX_ATTEMPTS, LIMITS.INBOX_PER_RUN)
    .all<{ id: number; payload: string; attempts: number }>();

  let processed = 0;
  let failed = 0;
  for (const row of results) {
    // 失敗時もattempts上限で止まるよう、処理前にインクリメントする
    const attempts = row.attempts + 1;
    await env.DB.prepare('UPDATE webhook_inbox SET attempts = ?1 WHERE id = ?2')
      .bind(attempts, row.id)
      .run();
    try {
      const payload = parseInboxPayload(row.payload);
      // WEBHOOK_MAX_RANGE_DAYS 超の期間は拒否せず分割して取り込む
      const maxSpanSeconds = LIMITS.WEBHOOK_MAX_RANGE_DAYS * 86_400;
      let chunkStart = payload.startdate;
      while (chunkStart <= payload.enddate) {
        const chunkEnd = Math.min(chunkStart + maxSpanSeconds, payload.enddate);
        await ingestRange(env, chunkStart, chunkEnd, 'webhook');
        chunkStart = chunkEnd + 1;
      }
      await env.DB.prepare(
        "UPDATE webhook_inbox SET processed_at = datetime('now'), last_error = NULL WHERE id = ?1",
      )
        .bind(row.id)
        .run();
      processed += 1;
    } catch (err) {
      failed += 1;
      const message = errorMessage(err);
      console.error('[ingest] inbox row failed', { id: row.id, attempts, message });
      await env.DB.prepare('UPDATE webhook_inbox SET last_error = ?1 WHERE id = ?2')
        .bind(message, row.id)
        .run();
      if (attempts >= LIMITS.MAX_INBOX_ATTEMPTS) {
        await sendAdminAlert(
          env,
          `webhook inbox row ${row.id} reached ${attempts} attempts: ${message}`,
        );
      }
    }
  }
  return { processed, failed };
}

export async function ingestRange(
  env: Env,
  startdate: number,
  enddate: number,
  context: IngestContext,
): Promise<{ upserted: number; claimedGrpids: number[] }> {
  const accessToken = await getValidAccessToken(env);

  const byGrpid = new Map<number, MeasurementUpsert>();
  let offset = 0;
  for (;;) {
    const page = await fetchMeasPage(
      env,
      accessToken,
      offset > 0 ? { startdate, enddate, offset } : { startdate, enddate },
    );
    collectUpserts(page.groups, byGrpid);
    if (!page.more) break;
    // offsetが前進しない応答は無限ループになるため中断する
    if (page.offset <= offset) {
      console.error('[ingest] pagination offset did not advance, aborting', {
        context,
        offset,
        next: page.offset,
      });
      break;
    }
    offset = page.offset;
    await sleep(PAGE_INTERVAL_MS);
  }

  const upserts = [...byGrpid.values()];
  if (upserts.length === 0) return { upserted: 0, claimedGrpids: [] };

  // claim → 条件付きバッチ登録 → UPSERT を1つのdb.batch()（=1トランザクション）で原子的に行う
  const statements: D1PreparedStatement[] = [];
  const claimGrpids: number[] = [];
  if (context === 'webhook') {
    // 即時通知の対象はmodeがimmediate/bothの通知先のみ（dailyはダイジェストで送る）
    const destinations = immediateDestinations(env);
    const batchId = newId();
    for (const u of upserts) {
      claimGrpids.push(u.grpid);
      statements.push(
        env.DB.prepare(
          'INSERT OR IGNORE INTO notification_batch_items (grpid, batch_id) VALUES (?1, ?2)',
        ).bind(u.grpid, batchId),
      );
    }
    // 同一トランザクション内でclaim結果を参照し、新規claim 0件なら登録しない
    for (const dest of destinations) {
      statements.push(
        env.DB.prepare(
          'INSERT OR IGNORE INTO notification_batches (batch_id, destination_id, status, next_attempt_at) ' +
            "SELECT ?1, ?2, 'pending', datetime('now') " +
            'WHERE EXISTS (SELECT 1 FROM notification_batch_items WHERE batch_id = ?3)',
        ).bind(batchId, dest.id, batchId),
      );
    }
  }
  statements.push(...buildUpsertStatements(env, upserts));

  const results = await env.DB.batch(statements);
  const claimedGrpids: number[] = [];
  for (let i = 0; i < claimGrpids.length; i++) {
    if (results[i].meta.changes > 0) claimedGrpids.push(claimGrpids[i]);
  }
  return { upserted: upserts.length, claimedGrpids };
}

export async function startInitialImport(env: Env): Promise<void> {
  await env.DB.batch([
    setSettingStmt(env, 'import_status', 'pending'),
    setSettingStmt(env, 'import_cursor', '0'),
    setSettingStmt(env, 'import_error', null),
  ]);
}

export async function resumeInitialImport(env: Env): Promise<{ done: boolean }> {
  const status = await getSetting(env, 'import_status');
  if (status !== 'pending' && status !== 'running') return { done: true };
  await setSettingStmt(env, 'import_status', 'running').run();

  try {
    const cursorRaw = await getSetting(env, 'import_cursor');
    let cursor = Number(cursorRaw ?? '0');
    if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
    const enddate = Math.floor(Date.now() / 1000);
    const accessToken = await getValidAccessToken(env);

    for (let i = 0; i < LIMITS.IMPORT_PAGES_PER_RUN; i++) {
      const page = await fetchMeasPage(
        env,
        accessToken,
        cursor > 0 ? { startdate: 1, enddate, offset: cursor } : { startdate: 1, enddate },
      );
      const byGrpid = new Map<number, MeasurementUpsert>();
      collectUpserts(page.groups, byGrpid);
      const statements = buildUpsertStatements(env, [...byGrpid.values()]);
      if (!page.more) {
        statements.push(setSettingStmt(env, 'import_status', 'done'));
        statements.push(setSettingStmt(env, 'import_error', null));
        // GetMeasPageはupdatetimeを持たないため、取得範囲の上限（この実行のenddate）で初期化する
        statements.push(setSettingStmt(env, 'last_sync_at', String(enddate)));
        await env.DB.batch(statements);
        return { done: true };
      }
      if (page.offset <= cursor) {
        throw new Error(`import pagination offset did not advance (${cursor} -> ${page.offset})`);
      }
      cursor = page.offset;
      // ページのUPSERTとカーソル前進を同一batchにして、片方だけ反映される状態を防ぐ
      statements.push(setSettingStmt(env, 'import_cursor', String(cursor)));
      await env.DB.batch(statements);
      await sleep(PAGE_INTERVAL_MS);
    }
    return { done: false };
  } catch (err) {
    const message = errorMessage(err);
    console.error('[ingest] initial import failed', message);
    await env.DB.batch([
      setSettingStmt(env, 'import_status', 'error'),
      setSettingStmt(env, 'import_error', message),
    ]);
    await sendAdminAlert(env, `initial import failed: ${message}`);
    return { done: false };
  }
}

export async function runDailyBackfill(env: Env): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000);
  try {
    const lastSyncRaw = await getSetting(env, 'last_sync_at');
    let lastupdate = Number(lastSyncRaw ?? '0');
    if (!Number.isSafeInteger(lastupdate) || lastupdate < 0) lastupdate = 0;
    const accessToken = await getValidAccessToken(env);

    const byGrpid = new Map<number, MeasurementUpsert>();
    let offset = 0;
    for (;;) {
      const page = await fetchMeasPage(
        env,
        accessToken,
        offset > 0 ? { lastupdate, offset } : { lastupdate },
      );
      collectUpserts(page.groups, byGrpid);
      if (!page.more) break;
      if (page.offset <= offset) {
        throw new Error(
          `backfill pagination offset did not advance (${offset} -> ${page.offset})`,
        );
      }
      offset = page.offset;
      await sleep(PAGE_INTERVAL_MS);
    }

    // 成功時のみ last_sync_at を実行開始時刻へ前進（UPSERTと同一batchで原子的に）
    const statements = buildUpsertStatements(env, [...byGrpid.values()]);
    statements.push(setSettingStmt(env, 'last_sync_at', String(startedAt)));
    await env.DB.batch(statements);
  } catch (err) {
    const message = errorMessage(err);
    console.error('[ingest] daily backfill failed', message);
    await sendAdminAlert(env, `daily backfill failed: ${message}`);
  }
}

function isOauthStateEntry(v: unknown): v is { state: string; expires_at: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).state === 'string' &&
    typeof (v as Record<string, unknown>).expires_at === 'string'
  );
}

export async function cleanupOldRows(env: Env): Promise<void> {
  const retention = `-${LIMITS.CLEANUP_AFTER_DAYS} days`;
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM webhook_inbox WHERE processed_at IS NOT NULL AND processed_at < datetime('now', ?1)",
    ).bind(retention),
    // sent は sent_at、dead は next_attempt_at を基準に判定する
    env.DB.prepare(
      "DELETE FROM notification_batches WHERE status IN ('sent', 'dead') AND COALESCE(sent_at, next_attempt_at) < datetime('now', ?1)",
    ).bind(retention),
    env.DB.prepare(
      'DELETE FROM notification_batch_items WHERE batch_id NOT IN (SELECT batch_id FROM notification_batches)',
    ),
  ]);

  const raw = await getSetting(env, 'oauth_state');
  if (raw === null) return;
  let entries: { state: string; expires_at: string }[] = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) entries = parsed.filter(isOauthStateEntry);
  } catch {
    console.warn('[ingest] oauth_state is not valid JSON, clearing');
  }
  const nowMs = Date.now();
  const alive = entries.filter((s) => {
    const t = Date.parse(s.expires_at);
    return Number.isFinite(t) && t > nowMs;
  });
  if (alive.length === 0) {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'oauth_state'").run();
  } else if (alive.length !== entries.length) {
    await setSettingStmt(env, 'oauth_state', JSON.stringify(alive)).run();
  }
}

export async function ensureSubscription(env: Env, currentCallbackUrl: string): Promise<void> {
  try {
    const accessToken = await getValidAccessToken(env);
    const subscriptions = await listNotifySubscriptions(env, accessToken);
    if (subscriptions.some((s) => s.appli === 1 && s.callbackurl === currentCallbackUrl)) return;

    // 新URLの購読成功を確認してから旧URLをrevokeする（先にrevokeすると
    // subscribe失敗時に購読ゼロになり、次の日次cronまでwebhookが途絶える）
    await subscribeNotify(env, accessToken, currentCallbackUrl);
    const previous = await getSetting(env, 'subscribed_callback_url');
    if (previous && previous !== currentCallbackUrl) {
      try {
        await revokeNotify(env, accessToken, previous);
      } catch (err) {
        // 旧購読の残存は二重通知ではなく二重取り込み（UPSERTで無害）にしかならない
        console.error('[ingest] failed to revoke previous subscription', errorMessage(err));
      }
    }
    await setSettingStmt(env, 'subscribed_callback_url', currentCallbackUrl).run();
  } catch (err) {
    const message = errorMessage(err);
    console.error('[ingest] ensureSubscription failed', message);
    await sendAdminAlert(env, `notify subscription check failed: ${message}`);
  }
}
