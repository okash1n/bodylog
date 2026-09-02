/**
 * AIコーチング講評の保存・取得。
 * 生成はGitHub Actions上のAgent SDK（Claudeサブスク課金）が行い、POST /api/coaching で保存される。
 * WorkerはD1保存・Slack配信（slack.ts）・表示のみを担い、AI推論は行わない。
 * 公開READハンドラが1本だけなので専用の*-api.tsは作らずここに同居させる。
 */
import type { Context } from 'hono';
import type { Env } from './types';
import { isValidYmd, localToday, newId, noindexHeaders, withRange } from './util';

export type CoachingKind = 'daily' | 'weekly';

export interface CoachingNote {
  id: string;
  kind: CoachingKind;
  date: string;
  content: string;
  model: string | null;
  created_at: string;
}

export interface CoachingInput {
  kind: CoachingKind;
  date: string;
  content: string;
  model: string | null;
}

const MAX_CONTENT_LENGTH = 4000;

export function parseCoachingInput(
  body: Record<string, unknown> | null,
  today: string,
): { ok: true; value: CoachingInput } | { ok: false; error: string } {
  if (!body) return { ok: false, error: 'invalid JSON body' };
  const { kind, date, content, model } = body;
  if (kind !== 'daily' && kind !== 'weekly') {
    return { ok: false, error: "kind must be 'daily' or 'weekly'" };
  }
  if (typeof date !== 'string' || !isValidYmd(date)) {
    return { ok: false, error: 'date must be a valid YYYY-MM-DD' };
  }
  // 将来日の講評を保存させない（latest が現在より先の日付を返し、鮮度判定・表示を狂わせるため）
  if (date > today) {
    return { ok: false, error: 'date must not be a future date' };
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, error: 'content is required' };
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return { ok: false, error: `content must be at most ${MAX_CONTENT_LENGTH} characters` };
  }
  if (model !== undefined && model !== null && typeof model !== 'string') {
    return { ok: false, error: 'model must be a string' };
  }
  return {
    ok: true,
    value: { kind, date, content: content.trim(), model: (model as string | undefined) ?? null },
  };
}

export async function getCoachingNote(
  env: Env,
  kind: CoachingKind,
  date: string,
): Promise<CoachingNote | null> {
  const row = await env.DB.prepare(
    'SELECT id, kind, date, content, model, created_at FROM coaching_notes WHERE kind = ?1 AND date = ?2',
  )
    .bind(kind, date)
    .first<CoachingNote>();
  return row ?? null;
}

export async function upsertCoachingNote(env: Env, input: CoachingInput): Promise<CoachingNote> {
  await env.DB.prepare(
    `INSERT INTO coaching_notes (id, kind, date, content, model, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
     ON CONFLICT (kind, date) DO UPDATE SET
       content = excluded.content, model = excluded.model, created_at = excluded.created_at`,
  )
    .bind(newId(), input.kind, input.date, input.content, input.model)
    .run();
  const note = await getCoachingNote(env, input.kind, input.date);
  if (!note) throw new Error('coaching note upsert failed');
  return note;
}

export interface LatestCoaching {
  daily: CoachingNote | null;
  weekly: CoachingNote | null;
}

async function latestOfKind(env: Env, kind: CoachingKind): Promise<CoachingNote | null> {
  // 保存境界でも将来日を拒否するが、別経路で入った既存不正行があっても latest は現在日以前に限定する
  const row = await env.DB.prepare(
    `SELECT id, kind, date, content, model, created_at FROM coaching_notes
     WHERE kind = ?1 AND date <= ?2 ORDER BY date DESC LIMIT 1`,
  )
    .bind(kind, localToday(env))
    .first<CoachingNote>();
  return row ?? null;
}

export async function getLatestCoaching(env: Env): Promise<LatestCoaching> {
  const [daily, weekly] = await Promise.all([
    latestOfKind(env, 'daily'),
    latestOfKind(env, 'weekly'),
  ]);
  return { daily, weekly };
}

/** 期間内の講評一覧（新しい順、最大200件）。履歴表示用 */
export async function listCoachingNotes(env: Env, from: string, to: string): Promise<CoachingNote[]> {
  const res = await env.DB.prepare(
    `SELECT id, kind, date, content, model, created_at FROM coaching_notes
     WHERE date BETWEEN ?1 AND ?2 ORDER BY date DESC, kind LIMIT 200`,
  )
    .bind(from, to)
    .all<CoachingNote>();
  return res.results;
}

/** 生成スロット（毎晩23:30ローカル）のUTCアンカー分。coaching.yml の cron / coaching/dates.mjs と対で保つ */
const SLOT_UTC_MINUTES = 14 * 60 + 30;
const DAY_MS = 86_400_000;

/** 対象ローカル日付の生成スロット時刻（エポックms）。coaching/dates.mjs の slotTimeForDate と同じ定義 */
export function coachingSlotMs(date: string, tzOffsetHours: number): number {
  const localMidnightUtcMs = Date.parse(`${date}T00:00:00Z`) - tzOffsetHours * 3_600_000;
  const sinceMidnightUtc = ((localMidnightUtcMs % DAY_MS) + DAY_MS) % DAY_MS;
  let slotMs = localMidnightUtcMs - sinceMidnightUtc + SLOT_UTC_MINUTES * 60_000;
  if (slotMs < localMidnightUtcMs) slotMs += DAY_MS;
  return slotMs;
}

/** created_at（D1の datetime('now') = 'YYYY-MM-DD HH:MM:SS' UTC、またはISO 8601）→エポックms。不正はNaN */
function createdAtMs(s: string): number {
  const t = s.includes('T') ? s : s.replace(' ', 'T');
  return Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}Z`);
}

/**
 * ダイジェストに差し込んでよい講評か: その夜のスロット（23:30ローカル）以降に生成されたものだけを許す。
 * 未明の遅延実行が残した空データ講評や、日中の部分データ再生成をそのまま配信しないため
 * （2026-08-28 に、未明に生成された空データ講評が上書きされないままダイジェストに載った事象への対策）。
 * 判定不能（created_at 不正）は差し込まない側に倒す（数値のみのダイジェストになるだけで実害が小さい）
 */
export function isFreshCoachingNote(note: CoachingNote | null, tzOffsetHours: number): boolean {
  if (!note) return false;
  const created = createdAtMs(note.created_at);
  return Number.isFinite(created) && created >= coachingSlotMs(note.date, tzOffsetHours);
}

/** Slackのsection.textは3000文字上限のため、余裕を持って行単位で分割する */
const SLACK_SECTION_LIMIT = 2800;

function splitForSlack(text: string): string[] {
  if (text.length <= SLACK_SECTION_LIMIT) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= SLACK_SECTION_LIMIT) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (line.length <= SLACK_SECTION_LIMIT) {
      current = line;
    } else {
      for (let i = 0; i < line.length; i += SLACK_SECTION_LIMIT) {
        chunks.push(line.slice(i, i + SLACK_SECTION_LIMIT));
      }
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * 日次ダイジェストに差し込むAI講評ブロック（見出し＋本文）。
 * AI講評は単独のSlackメッセージにせず、日次サマリーの一部として配信する
 */
export function coachingDigestBlocks(note: CoachingNote): unknown[] {
  const section = (text: string): unknown => ({ type: 'section', text: { type: 'mrkdwn', text } });
  return [section(':robot_face: *AIコーチ*'), ...splitForSlack(note.content).map(section)];
}

/**
 * COACHING_API_SECRET とのBearerトークン照合（タイミングセーフ比較）。
 * 長さ不一致はtimingSafeEqualがthrowするため先に弾く（長さの漏洩は許容）。
 */
export function coachingTokenMatches(token: string, secret: string): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(token);
  const b = enc.encode(secret);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

/** GET /api/coaching — 期間内の講評一覧（履歴）。公開読み取り */
export const serveCoachingList = (c: Context<{ Bindings: Env }>): Promise<Response> | Response =>
  withRange(c, async (from, to) => {
    try {
      return c.json(
        { notes: await listCoachingNotes(c.env, from, to) },
        200,
        noindexHeaders({ 'Cache-Control': 'no-store' }),
      );
    } catch (err) {
      console.error('[coaching] listCoachingNotes failed', err);
      return c.json({ error: 'internal error' }, 500, noindexHeaders({ 'Cache-Control': 'no-store' }));
    }
  });

/** GET /api/coaching/latest — 各kindの最新講評（なければnull）。公開読み取り */
export const serveCoachingLatest = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  const headers = noindexHeaders({ 'Cache-Control': 'no-store' });
  try {
    return c.json(await getLatestCoaching(c.env), 200, headers);
  } catch (err) {
    console.error('[coaching] getLatestCoaching failed', err);
    return c.json({ error: 'internal error' }, 500, headers);
  }
};
