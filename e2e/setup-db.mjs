/**
 * E2E の前準備: ローカルD1（.wrangler/e2e）へ migration を適用し、合成データを seed する。
 * playwright の webServer 起動より前に完了させる必要があるため、npm script の前段で実行する
 * （playwright の globalSetup は webServer より後に走るため使わない）。
 * 実環境の値・個人データは使わない。日付は JST（TZ_OFFSET_HOURS=9）基準の相対日で組み立てる。
 */
import { execFileSync } from 'node:child_process';

const COMMON = ['DB', '--local', '--config', 'wrangler.e2e.toml', '--persist-to', '.wrangler/e2e'];

function wranglerD1(...args) {
  execFileSync('npx', ['wrangler', 'd1', ...args], { stdio: 'inherit' });
}

function jstYmd(daysAgo) {
  return new Date(Date.now() + 9 * 3_600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

wranglerD1('migrations', 'apply', ...COMMON);

const d0 = jstYmd(0);
const d1 = jstYmd(1);
const d2 = jstYmd(2);
// 固定時刻（JST正午 = T03:00:00Z）で seed する（AGENTS.md の日付境界規約と同じ）
const sql = [
  // 冪等にするため毎回リセットする
  'DELETE FROM exercise_sets', 'DELETE FROM exercise_logs', 'DELETE FROM exercise_menus',
  'DELETE FROM meal_logs', 'DELETE FROM menus', 'DELETE FROM measurements', 'DELETE FROM coaching_notes',
  // 体重（3日分。カード・チャート・日次表用）
  `INSERT INTO measurements (id, grpid, measured_at, weight, fat_ratio, fat_free_mass, raw_json) VALUES` +
    ` (9001, 9001, '${d2}T03:00:00Z', 83.0, 21.5, 65.1, '{}'),` +
    ` (9002, 9002, '${d1}T03:00:00Z', 82.8, 21.2, 65.2, '{}'),` +
    ` (9003, 9003, '${d0}T03:00:00Z', 82.5, 21.0, 65.3, '{}')`,
  // 食事（メニュー + 今日の記録）
  `INSERT INTO menus (id, name, calories, protein_g, fat_g, carbs_g, note, archived, created_at, updated_at)` +
    ` VALUES ('e2e-menu-1', 'E2E定食', 650, 32, 18, 80, NULL, 0, '${d2}T03:00:00Z', '${d2}T03:00:00Z')`,
  `INSERT INTO meal_logs (id, menu_id, eaten_at, meal_type, multiplier, menu_name, calories, protein_g, fat_g, carbs_g, created_at)` +
    ` VALUES ('e2e-meal-1', 'e2e-menu-1', '${d0}T03:10:00Z', 'lunch', 1.0, 'E2E定食', 650, 32, 18, 80, '${d0}T03:10:00Z')`,
  // 運動（strength 種目 + 今日の記録 1件2セット）
  `INSERT INTO exercise_menus (id, name, category, mets, muscle_group, is_bodyweight, bodyweight_factor, circuit_json, note, archived, created_at, updated_at)` +
    ` VALUES ('e2e-ex-menu-1', 'E2Eベンチプレス', 'strength', NULL, '胸', 0, 1, NULL, NULL, 0, '${d2}T03:00:00Z', '${d2}T03:00:00Z')`,
  `INSERT INTO exercise_logs (id, menu_id, performed_at, category, menu_name, note, is_bodyweight, bodyweight_factor, duration_min, mets, body_weight_kg, calories, created_at, group_id)` +
    ` VALUES ('e2e-ex-log-1', 'e2e-ex-menu-1', '${d0}T03:30:00Z', 'strength', 'E2Eベンチプレス', NULL, 0, 1, NULL, NULL, NULL, NULL, '${d0}T03:30:00Z', NULL)`,
  `INSERT INTO exercise_sets (id, log_id, set_index, reps, weight_kg) VALUES` +
    ` ('e2e-set-1', 'e2e-ex-log-1', 1, 5, 60), ('e2e-set-2', 'e2e-ex-log-1', 2, 5, 60)`,
].join('; ');
wranglerD1('execute', ...COMMON, '--command', sql);
console.log('[e2e] D1 migrations + seed done');
