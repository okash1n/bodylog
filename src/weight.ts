/**
 * 手動体重記録。Withings由来の行と同じ measurements テーブルに source='manual' で同居する
 * （idは共通のAUTOINCREMENT。grpid列はWithings行専用でmanual行はNULL）。
 * 挿入と通知enqueueは1つの db.batch()（=1トランザクション）で原子的に行う。
 */
import type { Env } from './types';
import { immediateDestinations } from './slack';
import { newId } from './util';

export interface WeightInput {
  weight: number;
  fat_ratio: number | null;
  measured_at: string; // ISO8601
}

export interface ManualMeasurement {
  id: number;
  measured_at: string;
  weight: number;
  fat_ratio: number | null;
  fat_free_mass: number | null;
  source: string;
}

const WEIGHT_MIN = 20;
const WEIGHT_MAX = 300;
const FAT_RATIO_MIN = 3;
const FAT_RATIO_MAX = 75;
const MEASURED_AT_MIN_MS = Date.parse('2000-01-01T00:00:00Z');
const FUTURE_SLACK_MS = 5 * 60_000;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function parseWeightInput(
  b: Record<string, unknown> | null,
): { ok: true; value: WeightInput } | { ok: false; error: string } {
  const body = b ?? {};
  const weight = body.weight_kg;
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < WEIGHT_MIN || weight > WEIGHT_MAX) {
    return { ok: false, error: `weight_kg is required (${WEIGHT_MIN}-${WEIGHT_MAX})` };
  }
  let fatRatio: number | null = null;
  if (body.fat_ratio !== undefined && body.fat_ratio !== null) {
    const r = body.fat_ratio;
    if (typeof r !== 'number' || !Number.isFinite(r) || r < FAT_RATIO_MIN || r > FAT_RATIO_MAX) {
      return { ok: false, error: `fat_ratio must be ${FAT_RATIO_MIN}-${FAT_RATIO_MAX} (%)` };
    }
    fatRatio = r;
  }
  let measuredAt = new Date().toISOString();
  if (body.measured_at !== undefined) {
    if (typeof body.measured_at !== 'string') return { ok: false, error: 'measured_at must be an ISO8601 string' };
    const t = Date.parse(body.measured_at);
    if (!Number.isFinite(t)) return { ok: false, error: 'measured_at is not a valid ISO8601 datetime' };
    if (t < MEASURED_AT_MIN_MS) return { ok: false, error: 'measured_at is too old (before 2000-01-01)' };
    if (t > Date.now() + FUTURE_SLACK_MS) return { ok: false, error: 'measured_at is in the future' };
    measuredAt = new Date(t).toISOString();
  }
  return { ok: true, value: { weight, fat_ratio: fatRatio, measured_at: measuredAt } };
}

export async function logWeight(env: Env, input: WeightInput): Promise<ManualMeasurement> {
  const fatFreeMass = input.fat_ratio === null ? null : round2(input.weight * (1 - input.fat_ratio / 100));
  const rawJson = JSON.stringify({ source: 'manual', input });
  // idはAUTOINCREMENTで単調増加。同一トランザクション内に他の挿入は無いため、
  // 後続の文からは「自分が挿入した行 = MAX(id)」として参照できる
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      'INSERT INTO measurements (source, measured_at, weight, fat_ratio, fat_free_mass, raw_json) ' +
        "VALUES ('manual', ?1, ?2, ?3, ?4, ?5)",
    ).bind(input.measured_at, input.weight, input.fat_ratio, fatFreeMass, rawJson),
  ];
  // Withings webhook経由と同じ即時通知パイプラインに乗せる（mode=dailyのみの通知先はダイジェストで届く）
  const destinations = immediateDestinations(env);
  const batchId = newId();
  statements.push(
    env.DB.prepare(
      'INSERT OR IGNORE INTO notification_batch_items (measurement_id, batch_id) ' +
        'VALUES ((SELECT MAX(id) FROM measurements), ?1)',
    ).bind(batchId),
  );
  for (const dest of destinations) {
    statements.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO notification_batches (batch_id, destination_id, status, next_attempt_at) ' +
          "SELECT ?1, ?2, 'pending', datetime('now') " +
          'WHERE EXISTS (SELECT 1 FROM notification_batch_items WHERE batch_id = ?3)',
      ).bind(batchId, dest.id, batchId),
    );
  }
  statements.push(
    env.DB.prepare(
      'SELECT id, measured_at, weight, fat_ratio, fat_free_mass, source FROM measurements ' +
        'WHERE id = (SELECT MAX(id) FROM measurements)',
    ),
  );
  const results = await env.DB.batch<ManualMeasurement>(statements);
  const row = results[results.length - 1].results[0];
  if (!row) throw new Error('manual measurement insert did not return a row');
  return row;
}

export async function deleteManualMeasurement(env: Env, id: number): Promise<boolean> {
  // 計測本体と未送信（pending）の通知をひとつのbatch（=1トランザクション）で取り消す。
  // 取り消さないと、削除済み計測のbatchが送信時にdead化して管理者アラート（誤報）が飛ぶ。
  // sent は履歴として残し、claim済み（sending）は送信直前のJOINが本文送信を防ぐ
  const [del] = await env.DB.batch([
    env.DB.prepare("DELETE FROM measurements WHERE id = ?1 AND source = 'manual'").bind(id),
    // 削除が成立した場合のみ item を消す（manual以外のidを指定してもno-op）
    env.DB.prepare(
      'DELETE FROM notification_batch_items WHERE measurement_id = ?1 ' +
        'AND NOT EXISTS (SELECT 1 FROM measurements WHERE id = ?1)',
    ).bind(id),
    // itemが空になったbatchの未送信行を取り消す
    env.DB.prepare(
      `DELETE FROM notification_batches WHERE status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM notification_batch_items WHERE batch_id = notification_batches.batch_id)`,
    ),
  ]);
  return del.meta.changes > 0;
}
