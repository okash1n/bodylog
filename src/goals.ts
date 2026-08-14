/**
 * 目標（体重・脂肪量）の保存と読み取り。settingsテーブルに保存し、設定はMCPツール set_goal のみ
 * （ダッシュボードは表示専用）。どちらの指標も任意で、未設定は行なし=null。
 */
import type { Env, Goal } from './types';

export type { Goal };

const KEY_WEIGHT = 'goal_weight_kg';
const KEY_FAT = 'goal_fat_mass_kg';

/** 数値化できない保存値はnull扱い（手動でsettingsを壊した場合の防御） */
function parseStored(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function getGoal(env: Env): Promise<Goal> {
  const { results } = await env.DB.prepare(
    'SELECT key, value FROM settings WHERE key IN (?1, ?2)',
  )
    .bind(KEY_WEIGHT, KEY_FAT)
    .all<{ key: string; value: string | null }>();
  const map = new Map(results.map((r) => [r.key, r.value] as const));
  return {
    weight_kg: parseStored(map.get(KEY_WEIGHT)),
    fat_mass_kg: parseStored(map.get(KEY_FAT)),
  };
}

export interface SetGoalInput {
  /** undefined=変更しない / null=解除 / 数値=設定 */
  weight_kg?: number | null;
  fat_mass_kg?: number | null;
}

const WEIGHT_RANGE = [20, 300] as const;
const FAT_RANGE = [1, 150] as const;

function validateValue(
  v: unknown,
  name: string,
  [min, max]: readonly [number, number],
): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    return `${name} must be a number between ${min} and ${max} (or null to clear)`;
  }
  return null;
}

export function parseSetGoalInput(
  args: Record<string, unknown>,
): { ok: true; value: SetGoalInput } | { ok: false; error: string } {
  const hasWeight = 'weight_kg' in args && args.weight_kg !== undefined;
  const hasFat = 'fat_mass_kg' in args && args.fat_mass_kg !== undefined;
  if (!hasWeight && !hasFat) {
    return { ok: false, error: 'at least one of weight_kg / fat_mass_kg is required (null clears)' };
  }
  const err =
    validateValue(args.weight_kg, 'weight_kg', WEIGHT_RANGE) ??
    validateValue(args.fat_mass_kg, 'fat_mass_kg', FAT_RANGE);
  if (err) return { ok: false, error: err };
  const value: SetGoalInput = {};
  if (hasWeight) value.weight_kg = args.weight_kg as number | null;
  if (hasFat) value.fat_mass_kg = args.fat_mass_kg as number | null;
  return { ok: true, value };
}

export async function setGoal(env: Env, input: SetGoalInput): Promise<Goal> {
  const statements: D1PreparedStatement[] = [];
  const apply = (key: string, v: number | null | undefined): void => {
    if (v === undefined) return;
    if (v === null) {
      statements.push(env.DB.prepare('DELETE FROM settings WHERE key = ?1').bind(key));
    } else {
      statements.push(
        env.DB.prepare(
          'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ).bind(key, String(v)),
      );
    }
  };
  apply(KEY_WEIGHT, input.weight_kg);
  apply(KEY_FAT, input.fat_mass_kg);
  if (statements.length > 0) await env.DB.batch(statements);
  return getGoal(env);
}
