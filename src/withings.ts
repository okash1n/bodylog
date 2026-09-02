import type { Env, GetMeasPage, MeasureGroup, MeasurementUpsert, TokenRow } from './types';
import { LIMITS, WithingsApiError, assertSecret, newId } from './util';

const AUTHORIZE_URL = 'https://account.withings.com/oauth2_user/authorize2';
const TOKEN_URL = 'https://wbsapi.withings.net/v2/oauth2';
const MEASURE_URL = 'https://wbsapi.withings.net/measure';
const NOTIFY_URL = 'https://wbsapi.withings.net/notify';

/** access_token失効判定の余裕（この秒数以内に切れるトークンは失効扱い） */
const EXPIRY_MARGIN_MS = 60_000;
const LEASE_POLL_MS = 500;
/** 外部fetchのtimeout。LEASE_SECONDS(30秒)より短くし、lease保持中のrefreshを必ず決着させる */
const FETCH_TIMEOUT_MS = 15_000;

interface StoredTokens {
  userid: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Withings API共通呼び出し。全APIが form-urlencoded POST で、
 * HTTP 200でも {status, body} 形式のため status !== 0 は WithingsApiError にする。
 */
async function withingsPost(
  url: string,
  params: Record<string, string>,
  accessToken?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {};
  if (accessToken !== undefined) headers['Authorization'] = `Bearer ${accessToken}`;
  let res: Response;
  try {
    // 全Withings API呼び出しはこの1箇所を通る。ハングするとrefresh leaseの保持中に
    // LEASE_SECONDS(30秒)を超えて他ownerとの競合を増幅するため、それより短いtimeoutで必ず決着させる
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    console.error('[withings] network error', { url, action: params['action'], error: e });
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    console.error('[withings] non-JSON response', { url, action: params['action'], httpStatus: res.status });
    throw new Error(`Withings returned non-JSON response (HTTP ${res.status})`);
  }
  const envelope = parsed as { status?: unknown; body?: unknown; error?: unknown };
  if (typeof envelope.status !== 'number') {
    console.error('[withings] malformed response envelope', { url, action: params['action'] });
    throw new Error('Withings response is missing numeric status');
  }
  if (envelope.status !== 0) {
    const detail = typeof envelope.error === 'string' ? envelope.error : `action=${params['action']}`;
    console.error('[withings] API error', {
      url,
      action: params['action'],
      status: envelope.status,
      error: envelope.error,
    });
    throw new WithingsApiError(envelope.status, detail);
  }
  return (envelope.body ?? {}) as Record<string, unknown>;
}

/** requesttoken 共通（authorization_code / refresh_token）。expires_at = now + expires_in - 60秒 */
async function requestToken(env: Env, grantParams: Record<string, string>): Promise<StoredTokens> {
  const body = await withingsPost(TOKEN_URL, {
    action: 'requesttoken',
    client_id: assertSecret(env.WITHINGS_CLIENT_ID, 'WITHINGS_CLIENT_ID'),
    client_secret: assertSecret(env.WITHINGS_CLIENT_SECRET, 'WITHINGS_CLIENT_SECRET'),
    ...grantParams,
  });
  const userid = body['userid'];
  const accessToken = body['access_token'];
  const refreshToken = body['refresh_token'];
  const expiresIn = Number(body['expires_in']);
  if (
    (typeof userid !== 'string' && typeof userid !== 'number') ||
    typeof accessToken !== 'string' ||
    accessToken === '' ||
    typeof refreshToken !== 'string' ||
    refreshToken === '' ||
    !Number.isFinite(expiresIn)
  ) {
    console.error('[withings] malformed token response body', { keys: Object.keys(body) });
    throw new Error('Withings token response is missing required fields');
  }
  return {
    userid: String(userid),
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: new Date(Date.now() + (expiresIn - 60) * 1000).toISOString(),
  };
}

export function authorizeUrl(env: Env, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: assertSecret(env.WITHINGS_CLIENT_ID, 'WITHINGS_CLIENT_ID'),
    // Withingsのスコープ区切りはカンマ（スペースではない）
    scope: 'user.info,user.metrics',
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeAuthorizationCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<{ userid: string; access_token: string; refresh_token: string; expires_at: string }> {
  return requestToken(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
}

/** lease列は触らない（進行中のリフレッシュ単一フライトを壊さないため） */
function persistStatement(env: Env, t: StoredTokens): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO tokens (id, userid, access_token, refresh_token, expires_at)
     VALUES (1, ?1, ?2, ?3, ?4)
     ON CONFLICT(id) DO UPDATE SET
       userid = excluded.userid,
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at`,
  ).bind(t.userid, t.access_token, t.refresh_token, t.expires_at);
}

export async function persistTokens(
  env: Env,
  t: { userid: string; access_token: string; refresh_token: string; expires_at: string },
): Promise<void> {
  await persistStatement(env, t).run();
}

export async function getTokenRow(env: Env): Promise<TokenRow | null> {
  return env.DB.prepare(
    'SELECT userid, access_token, refresh_token, expires_at, refresh_lease_owner, refresh_lease_until FROM tokens WHERE id = 1',
  ).first<TokenRow>();
}

function freshAccessToken(row: TokenRow): string | null {
  if (!row.access_token || !row.expires_at) return null;
  const expiresAt = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + EXPIRY_MARGIN_MS) return null;
  return row.access_token;
}

/** 条件付きUPDATE。meta.changes === 1 の場合のみlease所有者（期限切れleaseはここで自然に奪取される） */
async function tryAcquireLease(env: Env, owner: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE tokens
     SET refresh_lease_owner = ?1, refresh_lease_until = datetime('now', '+${LIMITS.LEASE_SECONDS} seconds')
     WHERE id = 1 AND (refresh_lease_owner IS NULL OR refresh_lease_until < datetime('now'))`,
  )
    .bind(owner)
    .run();
  return result.meta.changes === 1;
}

/** 自分が所有するleaseのみ解放する（他所有者のleaseを消さない） */
function releaseLeaseStatement(env: Env, owner: string): D1PreparedStatement {
  return env.DB.prepare(
    'UPDATE tokens SET refresh_lease_owner = NULL, refresh_lease_until = NULL WHERE id = 1 AND refresh_lease_owner = ?1',
  ).bind(owner);
}

async function refreshAsLeaseOwner(env: Env, owner: string): Promise<string> {
  try {
    // refresh_tokenはローテーション制のため、lease取得後に必ず再読取して最新値を使う。
    // 直前に他所有者が保存済みならリフレッシュ不要（外部refreshを1回に抑える）。
    const row = await getTokenRow(env);
    if (!row || !row.refresh_token) {
      throw new Error('No Withings tokens stored. Complete OAuth via /auth/start first.');
    }
    const fresh = freshAccessToken(row);
    if (fresh !== null) {
      await releaseLeaseStatement(env, owner).run();
      return fresh;
    }
    const tokens = await requestToken(env, { grant_type: 'refresh_token', refresh_token: row.refresh_token });
    // fenced persist: 「自分が消費した refresh_token が読み取り時のまま」を条件（CAS）にした
    // 単一UPDATEで保存する。Withingsのrefresh_tokenはローテーション制のため、旧値から新チェーンを
    // 作れるのは1人だけ — 値が変わっていれば別経路（他ownerの保存や再認可）が正当な後継であり、
    // 遅延したこの応答で巻き戻してはいけない。逆に値が変わっていなければ（lease期限切れ後に
    // 別ownerが奪取したがrefreshに失敗したケースを含め）自分のチェーンが唯一の有効な後継なので
    // 保存する。lease owner を条件にすると後者で唯一の有効チェーンを破棄してしまう
    const persisted = await env.DB.prepare(
      `UPDATE tokens
       SET userid = ?1, access_token = ?2, refresh_token = ?3, expires_at = ?4,
           refresh_lease_owner = NULL, refresh_lease_until = NULL
       WHERE id = 1 AND refresh_token = ?5`,
    )
      .bind(tokens.userid, tokens.access_token, tokens.refresh_token, tokens.expires_at, row.refresh_token)
      .run();
    if ((persisted.meta.changes ?? 0) === 0) {
      // 別経路が新チェーンを保存済み: 取得したトークンは破棄し、現在値を使う
      console.warn('[withings] refresh_token changed before persist; discarding refreshed tokens');
      const current = await getTokenRow(env);
      const currentFresh = current ? freshAccessToken(current) : null;
      if (currentFresh !== null) return currentFresh;
      throw new Error('Withings token refresh was superseded and no fresh token is available (retryable)');
    }
    return tokens.access_token;
  } catch (e) {
    console.error('[withings] token refresh failed', e);
    try {
      await releaseLeaseStatement(env, owner).run();
    } catch (releaseError) {
      console.error('[withings] failed to release refresh lease', releaseError);
    }
    throw e;
  }
}

export async function getValidAccessToken(env: Env): Promise<string> {
  const owner = newId();
  const deadline = Date.now() + LIMITS.LEASE_WAIT_MS;
  for (;;) {
    const row = await getTokenRow(env);
    if (!row || !row.refresh_token) {
      throw new Error('No Withings tokens stored. Complete OAuth via /auth/start first.');
    }
    const fresh = freshAccessToken(row);
    if (fresh !== null) return fresh;
    if (await tryAcquireLease(env, owner)) return refreshAsLeaseOwner(env, owner);
    if (Date.now() >= deadline) {
      console.error('[withings] timed out waiting for token refresh lease', {
        lease_owner: row.refresh_lease_owner,
        lease_until: row.refresh_lease_until,
      });
      throw new Error(`Timed out waiting for token refresh after ${LIMITS.LEASE_WAIT_MS}ms`);
    }
    await sleep(LEASE_POLL_MS);
  }
}

export async function fetchMeasPage(
  env: Env,
  accessToken: string,
  q: { startdate?: number; enddate?: number; lastupdate?: number; offset?: number },
): Promise<GetMeasPage> {
  void env;
  const params: Record<string, string> = { action: 'getmeas', meastypes: '1,5,6', category: '1' };
  if (q.startdate !== undefined) params['startdate'] = String(q.startdate);
  if (q.enddate !== undefined) params['enddate'] = String(q.enddate);
  if (q.lastupdate !== undefined) params['lastupdate'] = String(q.lastupdate);
  if (q.offset !== undefined) params['offset'] = String(q.offset);
  const body = await withingsPost(MEASURE_URL, params, accessToken);
  const groups = Array.isArray(body['measuregrps']) ? (body['measuregrps'] as MeasureGroup[]) : [];
  const rawOffset = Number(body['offset']);
  return {
    groups,
    more: Boolean(body['more']),
    offset: Number.isFinite(rawOffset) ? rawOffset : 0,
  };
}

export function groupToUpsert(g: MeasureGroup): MeasurementUpsert | null {
  // category=1（実測）のみ。attribは 0（機器・本人確定）と 2（手入力）のみ採用
  if (g.category !== 1) return null;
  if (g.attrib !== 0 && g.attrib !== 2) return null;
  let weight: number | null = null;
  let fatRatio: number | null = null;
  let fatFreeMass: number | null = null;
  for (const m of g.measures) {
    // 実値 = value * 10^unit（unitは負の指数）
    const value = m.value * Math.pow(10, m.unit);
    if (m.type === 1) weight = value;
    else if (m.type === 6) fatRatio = value;
    else if (m.type === 5) fatFreeMass = value;
  }
  // 対象3指標がいずれも無いグループは保存しない
  if (weight === null && fatRatio === null && fatFreeMass === null) return null;
  return {
    grpid: g.grpid,
    measured_at: new Date(g.date * 1000).toISOString(),
    weight,
    fat_ratio: fatRatio,
    fat_free_mass: fatFreeMass,
    raw_json: JSON.stringify(g),
  };
}

export async function subscribeNotify(env: Env, accessToken: string, callbackurl: string): Promise<void> {
  void env;
  await withingsPost(NOTIFY_URL, { action: 'subscribe', callbackurl, appli: '1' }, accessToken);
}

export async function listNotifySubscriptions(
  env: Env,
  accessToken: string,
): Promise<{ callbackurl: string; appli: number }[]> {
  void env;
  const body = await withingsPost(NOTIFY_URL, { action: 'list', appli: '1' }, accessToken);
  const profiles = Array.isArray(body['profiles']) ? body['profiles'] : [];
  const subscriptions: { callbackurl: string; appli: number }[] = [];
  for (const profile of profiles) {
    if (profile === null || typeof profile !== 'object') continue;
    const rec = profile as Record<string, unknown>;
    if (typeof rec['callbackurl'] !== 'string') continue;
    const appli = Number(rec['appli']);
    subscriptions.push({ callbackurl: rec['callbackurl'], appli: Number.isFinite(appli) ? appli : 1 });
  }
  return subscriptions;
}

export async function revokeNotify(env: Env, accessToken: string, callbackurl: string): Promise<void> {
  void env;
  await withingsPost(NOTIFY_URL, { action: 'revoke', callbackurl, appli: '1' }, accessToken);
}
