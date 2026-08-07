import type { DayPoint, Env, LatestMeasurement, NotificationStats, NotifyMode, SlackDestination } from './types';
import { LIMITS, assertSecret, dashboardBase, isoNow, offsetHours, ymdWithOffset } from './util';
import { getDailySeries, getDayMeasurementCount, getLatestForBatch, getNotificationStats } from './queries';
import { OG_RENDERER_VERSION } from './og';

/** 日次ダイジェストのバッチID（notification_batchesのUNIQUE制約で同日二重送信を防ぐ） */
const DAILY_BATCH_PREFIX = 'daily-';

export function parseDestinations(env: Env): SlackDestination[] {
  const raw = assertSecret(env.SLACK_WEBHOOKS, 'SLACK_WEBHOOKS');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('SLACK_WEBHOOKS is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('SLACK_WEBHOOKS must be a non-empty JSON array of {id, url}');
  }
  const out: SlackDestination[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      throw new Error('SLACK_WEBHOOKS entries must be objects of {id, url, mode?}');
    }
    const { id, url, mode } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('SLACK_WEBHOOKS entries must have a non-empty string "id"');
    }
    if (typeof url !== 'string' || !url.startsWith('https://hooks.slack.com/')) {
      throw new Error(`SLACK_WEBHOOKS entry "${id}" must have a https://hooks.slack.com/ url`);
    }
    if (mode !== undefined && mode !== 'immediate' && mode !== 'daily' && mode !== 'both') {
      throw new Error(`SLACK_WEBHOOKS entry "${id}" has invalid mode (immediate | daily | both)`);
    }
    // destination_id はD1に保存される安定IDのため重複を拒否
    if (seen.has(id)) {
      throw new Error(`SLACK_WEBHOOKS has duplicate id "${id}"`);
    }
    seen.add(id);
    out.push({ id, url, mode: (mode as NotifyMode | undefined) ?? 'immediate' });
  }
  return out;
}

/** 計測ごとの即時通知を受け取る通知先 */
export function immediateDestinations(env: Env): SlackDestination[] {
  return parseDestinations(env).filter((d) => d.mode !== 'daily');
}

const DASH = '`—`';

function fmtValue(v: number | null, unit: string): string {
  return v === null ? DASH : `\`${v.toFixed(1)}${unit}\``;
}

function fmtDiff(v: number | null, unit: string): string {
  if (v === null) return DASH;
  const fixed = v.toFixed(1);
  return `\`${fixed.startsWith('-') ? fixed : `+${fixed}`}${unit}\``;
}

function formatLocalDateTime(iso: string, offsetH: number): string {
  const t = new Date(iso).getTime() + offsetH * 3_600_000;
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}

function section(text: string): unknown {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

export function buildMessageBlocks(input: {
  latest: LatestMeasurement;
  extraCount: number;
  stats: NotificationStats;
  dashboardUrl: string;
  tzOffset: number;
  ogImageUrl?: string;
}): unknown[] {
  const { latest, extraCount, stats, dashboardUrl, tzOffset, ogImageUrl } = input;

  // 体脂肪率は計測時点の参考値としてこの行にだけ載せる（平均・差分は3値kgベース）
  const latestLine = [
    `*体重* : ${fmtValue(latest.weight, ' kg')}`,
    `*脂肪量* : ${fmtValue(latest.fat_mass, ' kg')}`,
    `*除脂肪体重* : ${fmtValue(latest.fat_free_mass, ' kg')}`,
    `*体脂肪率* : ${fmtValue(latest.fat_ratio, '%')}`,
  ].join(' | ');

  // 注意: Slack mrkdwnは全角括弧「（」直後のバッククォートをコード開始と認識できず
  // スパンがずれるため、コードスパンの前後は半角括弧+半角スペースにする
  const avgLine = [
    `*体重* : ${fmtValue(stats.recent7.weight, ' kg')} (${fmtDiff(stats.diff7.weight, ' kg')})`,
    `*脂肪量* : ${fmtValue(stats.recent7.fat_mass, ' kg')} (${fmtDiff(stats.diff7.fat_mass, ' kg')})`,
    `*除脂肪体重* : ${fmtValue(stats.recent7.fat_free_mass, ' kg')} (${fmtDiff(stats.diff7.fat_free_mass, ' kg')})`,
  ].join(' | ');

  const blocks: unknown[] = [
    section(`計測結果（${formatLocalDateTime(latest.measured_at, tzOffset)}）\n${latestLine}`),
    section(`*7日間平均（前ターム比）*\n${avgLine}`),
  ];

  // 基準日未設定ならブロック自体を省略
  if (stats.baselineDate !== null) {
    const baselineLine = [
      `*体重* : ${fmtDiff(stats.baselineDiff.weight, ' kg')}`,
      `*脂肪量* : ${fmtDiff(stats.baselineDiff.fat_mass, ' kg')}`,
      `*除脂肪体重* : ${fmtDiff(stats.baselineDiff.fat_free_mass, ' kg')}`,
    ].join(' | ');
    blocks.push(section(`*基準日（${stats.baselineDate}）からの変化*\n${baselineLine}`));
  }

  blocks.push(section(`ダッシュボード: ${dashboardUrl}`));

  if (extraCount > 0) {
    blocks.push(section(`ほか ${extraCount} 件取り込み`));
  }
  // Incoming Webhookのリンクは自動展開（unfurl）されないため、グラフは画像ブロックで直接埋め込む
  if (ogImageUrl) {
    blocks.push({ type: 'image', image_url: ogImageUrl, alt_text: '直近30日の体重グラフ' });
  }
  return blocks;
}

/** 日次ダイジェスト（その日の平均3値 + 7日平均比 + 基準日比） */
export function buildDigestBlocks(input: {
  date: string;
  count: number;
  day: DayPoint;
  stats: NotificationStats;
  dashboardUrl: string;
  ogImageUrl?: string;
}): unknown[] {
  const { date, count, day, stats, dashboardUrl, ogImageUrl } = input;

  const avgLine = [
    `*体重* : ${fmtValue(day.weight, ' kg')}`,
    `*脂肪量* : ${fmtValue(day.fat_mass, ' kg')}`,
    `*除脂肪体重* : ${fmtValue(day.fat_free_mass, ' kg')}`,
  ].join(' | ');

  const termLine = [
    `*体重* : ${fmtValue(stats.recent7.weight, ' kg')} (${fmtDiff(stats.diff7.weight, ' kg')})`,
    `*脂肪量* : ${fmtValue(stats.recent7.fat_mass, ' kg')} (${fmtDiff(stats.diff7.fat_mass, ' kg')})`,
    `*除脂肪体重* : ${fmtValue(stats.recent7.fat_free_mass, ' kg')} (${fmtDiff(stats.diff7.fat_free_mass, ' kg')})`,
  ].join(' | ');

  const blocks: unknown[] = [
    section(`日次サマリー（${date}・計測 ${count} 回）\n${avgLine}`),
    section(`*7日間平均（前ターム比）*\n${termLine}`),
  ];

  if (stats.baselineDate !== null) {
    const baselineLine = [
      `*体重* : ${fmtDiff(stats.baselineDiff.weight, ' kg')}`,
      `*脂肪量* : ${fmtDiff(stats.baselineDiff.fat_mass, ' kg')}`,
      `*除脂肪体重* : ${fmtDiff(stats.baselineDiff.fat_free_mass, ' kg')}`,
    ].join(' | ');
    blocks.push(section(`*基準日（${stats.baselineDate}）からの変化*\n${baselineLine}`));
  }

  blocks.push(section(`ダッシュボード: ${dashboardUrl}`));
  if (ogImageUrl) {
    blocks.push({ type: 'image', image_url: ogImageUrl, alt_text: '直近30日のグラフ' });
  }
  return blocks;
}

/** 既定の送信時刻 23:55（5分毎cronで確実に踏める最も遅い時刻） */
const DEFAULT_DIGEST_MINUTES = 23 * 60 + 55;
const MAX_DIGEST_MINUTES = DEFAULT_DIGEST_MINUTES;

/**
 * settings.digest_time（ローカル "HH:MM"）を分に変換する。
 * 不正値は既定23:55にフォールバック。23:55超は「その日のうちにtickが来ない」ため23:55へclamp。
 */
export function parseDigestTime(raw: string | null): number {
  if (raw === null) return DEFAULT_DIGEST_MINUTES;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw.trim());
  if (!m) {
    console.warn('[slack] invalid settings.digest_time, using default 23:55:', raw);
    return DEFAULT_DIGEST_MINUTES;
  }
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (minutes > MAX_DIGEST_MINUTES) {
    console.warn('[slack] digest_time later than 23:55 cannot fire same-day; clamping to 23:55');
    return MAX_DIGEST_MINUTES;
  }
  return minutes;
}

/**
 * 5分毎cronから呼ぶ。ローカル時刻が digest_time を過ぎていれば当日分のダイジェストを送る。
 * 送信済みかはUNIQUE制約が担保するため、同日の後続tickでは何も起きない。
 */
export async function runDailyDigestIfDue(env: Env, origin: string): Promise<{ queued: number }> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'digest_time'")
    .first<{ value: string | null }>();
  const dueMinutes = parseDigestTime(row?.value ?? null);
  const localMs = Date.now() + offsetHours(env) * 3_600_000;
  const local = new Date(localMs);
  const nowMinutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (nowMinutes < dueMinutes) return { queued: 0 };
  return runDailyDigest(env, origin);
}

/**
 * 日次ダイジェストの送信バッチを投入する。
 * その日に計測がなければ何もしない。UNIQUE(batch_id, destination_id)により再実行しても二重送信しない。
 */
export async function runDailyDigest(env: Env, origin: string): Promise<{ queued: number }> {
  const destinations = parseDestinations(env).filter((d) => d.mode === 'daily' || d.mode === 'both');
  if (destinations.length === 0) return { queued: 0 };

  const today = ymdWithOffset(isoNow(), offsetHours(env));
  const count = await getDayMeasurementCount(env, today);
  if (count === 0) return { queued: 0 };

  const batchId = `${DAILY_BATCH_PREFIX}${today}`;
  const statements = destinations.map((d) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO notification_batches (batch_id, destination_id, status, next_attempt_at) VALUES (?1, ?2, 'pending', datetime('now'))",
    ).bind(batchId, d.id),
  );
  const results = await env.DB.batch(statements);
  const queued = results.reduce((n, r) => n + r.meta.changes, 0);
  if (queued > 0) {
    await processNotificationBatches(env, origin);
  }
  return { queued };
}

async function buildDailyDigestMessage(env: Env, origin: string, batchId: string): Promise<BuiltMessage> {
  try {
    const date = batchId.slice(DAILY_BATCH_PREFIX.length);
    const [series, count] = await Promise.all([
      getDailySeries(env, date, date),
      getDayMeasurementCount(env, date),
    ]);
    const day = series[series.length - 1];
    if (!day) {
      return { kind: 'permanent', error: `daily digest ${date} has no measurements` };
    }
    // 基準日比は「その日の平均」との差分にする
    const latestLike: LatestMeasurement = {
      measured_at: `${date}T00:00:00Z`,
      weight: day.weight,
      fat_mass: day.fat_mass,
      fat_free_mass: day.fat_free_mass,
      fat_ratio: null,
    };
    const stats = await getNotificationStats(env, latestLike);
    const base = `${origin}${dashboardBase(env)}`;
    const v = `${date}-r${OG_RENDERER_VERSION}`;
    return {
      kind: 'ok',
      blocks: buildDigestBlocks({
        date,
        count,
        day,
        stats,
        dashboardUrl: `${base}?v=${date}`,
        ogImageUrl: `${base}og.png?v=${v}`,
      }),
    };
  } catch (e) {
    console.error('[slack] failed to build daily digest for', batchId, e);
    return { kind: 'transient', error: e instanceof Error ? e.message : String(e) };
  }
}

export async function sendAdminAlert(env: Env, text: string): Promise<void> {
  // アラート送信の失敗はログのみ（アラート失敗→アラートの無限ループを防ぐ）
  try {
    let url = env.ADMIN_SLACK_WEBHOOK;
    if (!url) {
      url = parseDestinations(env)[0].url;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `[withings-weight-tracker] ${text}` }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error('[slack] admin alert failed', res.status, await res.text().catch(() => ''));
    }
  } catch (e) {
    console.error('[slack] admin alert failed', e);
  }
}

interface BatchRow {
  batch_id: string;
  destination_id: string;
  attempts: number;
}

interface Counts {
  sent: number;
  deferred: number;
  dead: number;
}

type BuiltMessage =
  | { kind: 'ok'; blocks: unknown[] }
  | { kind: 'permanent'; error: string }
  | { kind: 'transient'; error: string };

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    const sec = Math.ceil((dateMs - Date.now()) / 1000);
    return sec > 0 ? sec : 1;
  }
  return null;
}

async function errorDetail(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  return `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
}

async function markDead(
  env: Env,
  row: BatchRow,
  error: string,
  counts: Counts,
  attempts?: number,
): Promise<void> {
  console.error('[slack] notification dead', {
    batch_id: row.batch_id,
    destination_id: row.destination_id,
    error,
  });
  await env.DB.prepare(
    `UPDATE notification_batches SET status = 'dead', attempts = ?3, last_error = ?4
     WHERE batch_id = ?1 AND destination_id = ?2`,
  )
    .bind(row.batch_id, row.destination_id, attempts ?? row.attempts, error)
    .run();
  counts.dead++;
  await sendAdminAlert(
    env,
    `Slack通知をdeadにしました: batch=${row.batch_id} destination=${row.destination_id} error=${error}`,
  );
}

async function deferOrDead(
  env: Env,
  row: BatchRow,
  error: string,
  retryAfterSec: number | null,
  counts: Counts,
): Promise<void> {
  const attempts = row.attempts + 1;
  if (attempts >= LIMITS.MAX_NOTIFY_ATTEMPTS) {
    await markDead(env, row, `${error} (attempts limit reached)`, counts, attempts);
    return;
  }
  // 429のRetry-After優先。それ以外は指数バックオフ（上限3600秒）
  const delaySec = Math.max(1, Math.ceil(retryAfterSec ?? Math.min(30 * 2 ** attempts, 3600)));
  console.warn('[slack] notification deferred', {
    batch_id: row.batch_id,
    destination_id: row.destination_id,
    attempts,
    delaySec,
    error,
  });
  await env.DB.prepare(
    `UPDATE notification_batches SET status = 'pending', attempts = ?3, next_attempt_at = datetime('now', ?4), last_error = ?5
     WHERE batch_id = ?1 AND destination_id = ?2`,
  )
    .bind(row.batch_id, row.destination_id, attempts, `+${delaySec} seconds`, error)
    .run();
  counts.deferred++;
}

async function buildBatchMessage(env: Env, origin: string, batchId: string): Promise<BuiltMessage> {
  if (batchId.startsWith(DAILY_BATCH_PREFIX)) {
    return buildDailyDigestMessage(env, origin, batchId);
  }
  try {
    const found = await getLatestForBatch(env, batchId);
    if (!found) {
      return { kind: 'permanent', error: `batch ${batchId} has no measurements` };
    }
    const stats = await getNotificationStats(env, found.latest);
    const tzOffset = offsetHours(env);
    // ローカル日付をキャッシュバスターに使う（SlackのURL単位キャッシュ対策）
    const v = ymdWithOffset(found.latest.measured_at, tzOffset);
    const base = `${origin}${dashboardBase(env)}`;
    return {
      kind: 'ok',
      blocks: buildMessageBlocks({
        latest: found.latest,
        extraCount: found.count - 1,
        stats,
        dashboardUrl: `${base}?v=${v}`,
        tzOffset,
        ogImageUrl: `${base}og.png?v=${v}-r${OG_RENDERER_VERSION}`,
      }),
    };
  } catch (e) {
    console.error('[slack] failed to build message for batch', batchId, e);
    return { kind: 'transient', error: e instanceof Error ? e.message : String(e) };
  }
}

export async function processNotificationBatches(
  env: Env,
  origin: string,
): Promise<{ sent: number; deferred: number; dead: number }> {
  const destinations = new Map(parseDestinations(env).map((d) => [d.id, d] as const));
  const { results: rows } = await env.DB.prepare(
    `SELECT batch_id, destination_id, attempts FROM notification_batches
     WHERE status = 'pending' AND next_attempt_at <= datetime('now')
     ORDER BY next_attempt_at
     LIMIT ?1`,
  )
    .bind(LIMITS.NOTIFY_PER_RUN)
    .all<BatchRow>();

  const counts: Counts = { sent: 0, deferred: 0, dead: 0 };
  // 同一batchのメッセージ構築は1回だけ
  const messages = new Map<string, BuiltMessage>();

  for (const row of rows) {
    // status='pending'条件付き更新で行を占有（並行実行での二重送信防止）
    const claimed = await env.DB.prepare(
      `UPDATE notification_batches SET status = 'sending'
       WHERE batch_id = ?1 AND destination_id = ?2 AND status = 'pending'`,
    )
      .bind(row.batch_id, row.destination_id)
      .run();
    if (claimed.meta.changes !== 1) continue;

    const dest = destinations.get(row.destination_id);
    if (!dest) {
      await markDead(env, row, `destination "${row.destination_id}" not in SLACK_WEBHOOKS`, counts);
      continue;
    }

    let message = messages.get(row.batch_id);
    if (message === undefined) {
      message = await buildBatchMessage(env, origin, row.batch_id);
      messages.set(row.batch_id, message);
    }
    if (message.kind === 'permanent') {
      await markDead(env, row, message.error, counts);
      continue;
    }
    if (message.kind === 'transient') {
      await deferOrDead(env, row, message.error, null, counts);
      continue;
    }

    try {
      const res = await fetch(dest.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blocks: message.blocks }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        await env.DB.prepare(
          `UPDATE notification_batches SET status = 'sent', sent_at = datetime('now'), last_error = NULL
           WHERE batch_id = ?1 AND destination_id = ?2`,
        )
          .bind(row.batch_id, row.destination_id)
          .run();
        counts.sent++;
      } else if (res.status === 429 || res.status >= 500) {
        const retryAfterSec = res.status === 429 ? parseRetryAfter(res.headers.get('Retry-After')) : null;
        await deferOrDead(env, row, await errorDetail(res), retryAfterSec, counts);
      } else {
        // その他4xx: URL無効などリトライで回復しないため即dead
        await markDead(env, row, await errorDetail(res), counts, row.attempts + 1);
      }
    } catch (e) {
      // ネットワークエラー・5秒timeoutは一時故障としてバックオフ
      await deferOrDead(env, row, e instanceof Error ? e.message : String(e), null, counts);
    }
  }
  return counts;
}
