/**
 * 運動データ層。種目マスタ（exercise_menus）・セッション記録（exercise_logs）・
 * 筋トレのセット明細（exercise_sets）のD1クエリを集約する。
 * 食事と同じスナップショット方式（記録時にメニュー由来の値を凍結）。
 */
import type {
  CircuitItem,
  DailyExercise,
  Env,
  ExerciseCategory,
  ExerciseLog,
  ExerciseMenu,
  ExerciseMenuInput,
  ExerciseSet,
} from './types';
import { addDaysYmd, escapeLikeValue, isPositiveFinite, isoNow, newId, tzModifier } from './util';
import { diffRecords, effectiveWeight, getExerciseRecords, roundVolume } from './exercise-records';

const MAX_METS = 30;
const MAX_DURATION_MIN = 1440; // 24h
const MAX_REPS = 1000;
const MAX_WEIGHT_KG = 1000;
const MAX_SETS = 50;
const MAX_ROUNDS = MAX_SETS; // 1ラウンド=1セット展開のため sets 上限と連動
const MAX_CIRCUIT_ITEMS = 10;
/** exercise_sets の複数行INSERTの1文あたり行数（4バインド/行 × 18 = 72 で D1 の100バインド上限内） */
const SET_INSERT_CHUNK = 18;

// ---- 種目マスタ ----

interface MenuRow {
  id: string; name: string; category: string;
  mets: number | null; muscle_group: string | null; is_bodyweight: number;
  bodyweight_factor: number; circuit_json: string | null;
  note: string | null; archived: number; created_at: string; updated_at: string;
}

/** circuit_json は書き込み時に検証済みだが、直接SQLで壊された場合に読み取り全体を落とさない */
function parseCircuitJson(raw: string | null): CircuitItem[] | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && v.length > 0 ? (v as CircuitItem[]) : null;
  } catch {
    return null;
  }
}

function toMenu(r: MenuRow): ExerciseMenu {
  return {
    id: r.id,
    name: r.name,
    category: r.category as ExerciseCategory,
    mets: r.mets,
    muscle_group: r.muscle_group,
    is_bodyweight: r.is_bodyweight !== 0,
    bodyweight_factor: r.bodyweight_factor,
    circuit: parseCircuitJson(r.circuit_json),
    note: r.note,
    archived: r.archived !== 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const MENU_COLS =
  'id, name, category, mets, muscle_group, is_bodyweight, bodyweight_factor, circuit_json, note, archived, created_at, updated_at';

/** サーキット構成の参照整合性（存在・strength・自重・非archived・入れ子禁止）。作成/更新時に検証する */
async function validateCircuitRefs(env: Env, circuit: CircuitItem[]): Promise<{ error: string } | null> {
  for (const item of circuit) {
    const m = await getExerciseMenu(env, item.menu_id);
    if (!m) return { error: `circuit item menu not found: ${item.menu_id}` };
    if (m.category !== 'strength') return { error: `circuit item "${m.name}" must be a strength menu` };
    if (m.circuit) return { error: `circuit item "${m.name}" is itself a circuit — nesting is not supported` };
    // 展開セットは weight_kg NULL で入るため、非自重種目は黙ってボリューム0になる。拒否して明示する（D8）
    if (!m.is_bodyweight) {
      return { error: `circuit item "${m.name}" is not a bodyweight menu — register it as is_bodyweight with a factor, or log it standalone with sets` };
    }
    if (m.archived) return { error: `circuit item "${m.name}" is archived — unarchive it or remove it from the circuit` };
  }
  return null;
}

/**
 * この種目を構成に含むサーキットを1件返す（無ければ null）。
 * 被参照種目を後から circuit 化すると参照元サーキットが記録不能になるため、更新時の逆方向チェックに使う。
 * id は newId() 生成の英数字なので LIKE に安全だが、部分一致の誤検知を防ぐため JSON を再確認する
 */
async function findReferencingCircuit(env: Env, menuId: string): Promise<{ name: string } | null> {
  const rows = await env.DB.prepare(
    `SELECT name, circuit_json FROM exercise_menus WHERE circuit_json IS NOT NULL AND id != ?1 AND circuit_json LIKE ?2`,
  )
    .bind(menuId, `%"${menuId}"%`)
    .all<{ name: string; circuit_json: string }>();
  for (const r of rows.results) {
    if (parseCircuitJson(r.circuit_json)?.some((it) => it.menu_id === menuId)) return { name: r.name };
  }
  return null;
}

export async function createExerciseMenu(
  env: Env,
  input: ExerciseMenuInput,
): Promise<ExerciseMenu | { error: string }> {
  if (input.circuit) {
    const invalid = await validateCircuitRefs(env, input.circuit);
    if (invalid) return invalid;
  }
  const now = isoNow();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO exercise_menus (${MENU_COLS})
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)`,
  )
    .bind(
      id, input.name, input.category,
      input.mets ?? null,
      input.category === 'strength' ? input.muscle_group ?? null : null,
      input.category === 'strength' && input.is_bodyweight ? 1 : 0,
      input.category === 'strength' && input.is_bodyweight ? input.bodyweight_factor ?? 1 : 1,
      input.circuit ? JSON.stringify(input.circuit) : null,
      input.note ?? null, now,
    )
    .run();
  return (await getExerciseMenu(env, id))!;
}

export async function getExerciseMenu(env: Env, id: string): Promise<ExerciseMenu | null> {
  const row = await env.DB.prepare(`SELECT ${MENU_COLS} FROM exercise_menus WHERE id = ?1`)
    .bind(id)
    .first<MenuRow>();
  return row ? toMenu(row) : null;
}

export async function setExerciseMenuArchived(env: Env, id: string, archived: boolean): Promise<boolean> {
  const res = await env.DB.prepare('UPDATE exercise_menus SET archived = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(id, archived ? 1 : 0, isoNow())
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** 更新可能な列。category は作成後変更しない（他カテゴリ列との不整合を避ける） */
export async function updateExerciseMenu(
  env: Env,
  id: string,
  patch: Partial<Omit<ExerciseMenuInput, 'category'>>,
): Promise<ExerciseMenu | null | { error: string }> {
  // カテゴリ整合が要る項目を含むときだけ現在行を引く（factor=1 は既定値なのでガード不要）
  const wantsFactor = typeof patch.bodyweight_factor === 'number' && patch.bodyweight_factor !== 1;
  const needsGuard =
    patch.circuit != null || typeof patch.muscle_group === 'string' || patch.is_bodyweight === true || wantsFactor;
  const current = needsGuard ? await getExerciseMenu(env, id) : null;
  if (needsGuard && !current) return null;
  if (current?.category === 'cardio') {
    // strength専用フィールドのcardioへの黙殺をやめて明示エラーにする（D8）
    if (typeof patch.muscle_group === 'string') return { error: 'muscle_group is not allowed for cardio menus' };
    if (patch.is_bodyweight === true) return { error: 'is_bodyweight is not allowed for cardio menus' };
    if (wantsFactor) return { error: 'bodyweight_factor is not allowed for cardio menus' };
  }
  if (current?.category === 'strength' && wantsFactor) {
    const effectiveBw = 'is_bodyweight' in patch ? patch.is_bodyweight === true : current.is_bodyweight;
    const effectiveCircuit = 'circuit' in patch ? patch.circuit != null : current.circuit != null;
    if (!effectiveBw || effectiveCircuit) return { error: 'bodyweight_factor requires is_bodyweight: true' };
  }
  if (patch.circuit) {
    if (current!.category !== 'strength') return { error: 'circuit is only valid for strength menus' };
    if (patch.circuit.some((it) => it.menu_id === id)) {
      return { error: 'a circuit cannot reference itself' };
    }
    // 被参照種目のcircuit化は参照元サーキットを記録不能にするため拒否する（入れ子禁止の逆方向）
    const ref = await findReferencingCircuit(env, id);
    if (ref) {
      return { error: `menu "${current!.name}" is a circuit item of "${ref.name}" — remove it from that circuit first` };
    }
    const invalid = await validateCircuitRefs(env, patch.circuit);
    if (invalid) return invalid;
  }
  const binds: unknown[] = [id];
  const sets: string[] = [];
  const push = (col: string, value: unknown): void => {
    binds.push(value);
    sets.push(`${col} = ?${binds.length}`);
  };
  if ('name' in patch) push('name', patch.name ?? null);
  if ('mets' in patch) push('mets', patch.mets ?? null);
  if ('muscle_group' in patch) push('muscle_group', patch.muscle_group ?? null);
  if ('is_bodyweight' in patch) push('is_bodyweight', patch.is_bodyweight ? 1 : 0);
  if ('bodyweight_factor' in patch) push('bodyweight_factor', patch.bodyweight_factor ?? 1);
  if ('circuit' in patch) push('circuit_json', patch.circuit ? JSON.stringify(patch.circuit) : null);
  if ('note' in patch) push('note', patch.note ?? null);
  if (sets.length === 0) return getExerciseMenu(env, id);
  binds.push(isoNow());
  sets.push(`updated_at = ?${binds.length}`);
  const res = await env.DB.prepare(`UPDATE exercise_menus SET ${sets.join(', ')} WHERE id = ?1`)
    .bind(...binds)
    .run();
  if ((res.meta.changes ?? 0) === 0) return null;
  return getExerciseMenu(env, id);
}

export async function listExerciseMenus(
  env: Env,
  opts: { q?: string; category?: ExerciseCategory; includeArchived?: boolean },
): Promise<ExerciseMenu[]> {
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (!opts.includeArchived) conds.push('archived = 0');
  if (opts.category) {
    binds.push(opts.category);
    conds.push(`category = ?${binds.length}`);
  }
  if (opts.q) {
    binds.push(`%${escapeLikeValue(opts.q)}%`);
    conds.push(`name LIKE ?${binds.length} ESCAPE '\\'`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  // 利用頻度順（食事メニューと同じ規則）: 直近90日の記録回数 → 最終使用 → 名前
  const res = await env.DB.prepare(
    `SELECT ${MENU_COLS} FROM exercise_menus ${where}
ORDER BY (SELECT COUNT(*) FROM exercise_logs l
          WHERE l.menu_id = exercise_menus.id AND l.performed_at >= datetime('now', '-90 days')) DESC,
         (SELECT MAX(performed_at) FROM exercise_logs l WHERE l.menu_id = exercise_menus.id) DESC,
         name
LIMIT 500`,
  )
    .bind(...binds)
    .all<MenuRow>();
  return res.results.map(toMenu);
}

// ---- 体重スナップショット ----

/**
 * 実施日のローカル日付「以前」で最も新しい実測体重。1件も無ければ null
 * （cardio/自重筋トレの記録に必須）。
 * 同日ローカル日付内の計測は時刻に関わらず含める（過去日をJST正午でbackfillしても、
 * その日の夕方の計測を拾える）。未来日の計測は混入させない。
 */
export async function getBodyWeightAt(env: Env, performedAt: string): Promise<number | null> {
  const tz = tzModifier(env);
  const row = await env.DB.prepare(
    `SELECT weight FROM measurements
WHERE date(measured_at, '${tz}') <= date(?1, '${tz}') AND weight IS NOT NULL
ORDER BY measured_at DESC LIMIT 1`,
  )
    .bind(performedAt)
    .first<{ weight: number }>();
  return row?.weight ?? null;
}

// ---- 記録 ----

interface LogRow {
  id: string; menu_id: string; performed_at: string; category: string;
  menu_name: string; note: string | null; is_bodyweight: number;
  bodyweight_factor: number;
  duration_min: number | null; mets: number | null; body_weight_kg: number | null;
  calories: number | null; created_at: string; group_id: string | null;
}

interface SetRow {
  log_id: string; set_index: number; reps: number; weight_kg: number | null;
}

const LOG_COLS =
  'id, menu_id, performed_at, category, menu_name, note, is_bodyweight, bodyweight_factor, duration_min, mets, body_weight_kg, calories, created_at, group_id';

function toSet(is_bodyweight: boolean, bodyWeight: number | null, factor: number, r: SetRow): ExerciseSet {
  const eff = effectiveWeight(is_bodyweight, bodyWeight, factor, r.weight_kg);
  return {
    set_index: r.set_index,
    reps: r.reps,
    weight_kg: r.weight_kg,
    effective_weight_kg: eff,
    volume: roundVolume(r.reps * eff),
  };
}

function toLog(r: LogRow, setRows: SetRow[]): ExerciseLog {
  const isBw = r.is_bodyweight !== 0;
  const sets = setRows.map((s) => toSet(isBw, r.body_weight_kg, r.bodyweight_factor, s));
  return {
    id: r.id,
    menu_id: r.menu_id,
    performed_at: r.performed_at,
    category: r.category as ExerciseCategory,
    menu_name: r.menu_name,
    note: r.note,
    is_bodyweight: isBw,
    bodyweight_factor: r.bodyweight_factor,
    duration_min: r.duration_min,
    mets: r.mets,
    body_weight_kg: r.body_weight_kg,
    calories: r.calories,
    created_at: r.created_at,
    group_id: r.group_id,
    sets,
    total_volume: r.category === 'strength' ? roundVolume(sets.reduce((a, s) => a + s.volume, 0)) : null,
  };
}

/** 消費kcal = METs × 体重kg × 時間h × 1.05（cardio / METs付きstrength共通） */
export function estimateCalories(mets: number, bodyWeightKg: number, durationMin: number): number {
  return mets * bodyWeightKg * (durationMin / 60) * 1.05;
}

export interface ExerciseLogFields {
  performed_at?: string;
  note?: string | null;
  duration_min?: number;
  sets?: { reps: number; weight_kg?: number | null }[];
  rounds?: number;
}

export async function getExerciseLog(env: Env, id: string): Promise<ExerciseLog | null> {
  const row = await env.DB.prepare(`SELECT ${LOG_COLS} FROM exercise_logs WHERE id = ?1`)
    .bind(id)
    .first<LogRow>();
  if (!row) return null;
  const sets = await env.DB.prepare(
    'SELECT log_id, set_index, reps, weight_kg FROM exercise_sets WHERE log_id = ?1 ORDER BY set_index',
  )
    .bind(id)
    .all<SetRow>();
  return toLog(row, sets.results);
}

export async function logExercise(
  env: Env,
  input: { menu_id: string } & ExerciseLogFields,
): Promise<ExerciseLog | { error: string }> {
  const menu = await getExerciseMenu(env, input.menu_id);
  if (!menu) return { error: 'menu not found' };
  if (menu.archived) return { error: 'menu is archived' };
  const performedAt = input.performed_at ?? isoNow();
  const id = newId();

  if (menu.category === 'cardio') {
    // カテゴリ不一致フィールドは黙殺せず明示エラーにする（D8）
    if (input.sets) return { error: `sets is not allowed for cardio menu "${menu.name}" — pass duration_min` };
    if (input.rounds != null) {
      return { error: `rounds is only valid for circuit menus — "${menu.name}" is cardio, pass duration_min` };
    }
    if (menu.mets == null) return { error: 'cardio menu has no METs' };
    if (input.duration_min == null) return { error: 'duration_min is required for cardio' };
    const bw = await getBodyWeightAt(env, performedAt);
    if (bw == null) return { error: 'no body weight measurement on or before performed_at' };
    const calories = estimateCalories(menu.mets, bw, input.duration_min);
    await env.DB.prepare(
      `INSERT INTO exercise_logs (${LOG_COLS})
VALUES (?1, ?2, ?3, 'cardio', ?4, ?5, 0, 1, ?6, ?7, ?8, ?9, ?10, NULL)`,
    )
      .bind(id, menu.id, performedAt, menu.name, input.note ?? null,
            input.duration_min, menu.mets, bw, calories, isoNow())
      .run();
    return { ...(await getExerciseLog(env, id))!, records_broken: [] };
  }

  if (menu.circuit) return logCircuitExercise(env, menu, menu.circuit, input, performedAt, id);

  // strength（単独種目）
  if (input.rounds != null) {
    return { error: `rounds is only valid for circuit menus — "${menu.name}" is strength, pass sets: [{reps, weight_kg?}]` };
  }
  const rawSets = input.sets ?? [];
  if (rawSets.length === 0) return { error: 'sets is required for strength' };
  // メニューに METs があり時間を記録したときは消費kcalを算出して凍結する（cardioと同一式）
  const wantsKcal = menu.mets != null && input.duration_min != null;
  let bw: number | null = null;
  if (menu.is_bodyweight || wantsKcal) {
    bw = await getBodyWeightAt(env, performedAt);
    if (bw == null) return { error: 'no body weight measurement on or before performed_at' };
  }
  const calories = wantsKcal ? estimateCalories(menu.mets!, bw!, input.duration_min!) : null;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO exercise_logs (${LOG_COLS})
VALUES (?1, ?2, ?3, 'strength', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL)`,
    ).bind(id, menu.id, performedAt, menu.name, input.note ?? null,
           menu.is_bodyweight ? 1 : 0, menu.is_bodyweight ? menu.bodyweight_factor : 1,
           input.duration_min ?? null, menu.mets ?? null, bw, calories, isoNow()),
    ...rawSets.map((s, i) =>
      env.DB.prepare(
        'INSERT INTO exercise_sets (id, log_id, set_index, reps, weight_kg) VALUES (?1, ?2, ?3, ?4, ?5)',
      ).bind(newId(), id, i + 1, s.reps, s.weight_kg ?? null),
    ),
  ];
  // 自己ベスト更新の判定: 挿入前後の集計を比べる（都度集計なので前の値を別途持たない）
  const before = await getExerciseRecords(env, menu);
  await env.DB.batch(statements);
  const after = await getExerciseRecords(env, menu);
  return { ...(await getExerciseLog(env, id))!, records_broken: diffRecords(before, after) };
}

/**
 * サーキット記録の展開: 親ログ（時間・kcal・noteを担う。sets無し）+ 構成種目ごとの通常strength子ログ
 * （1ラウンド=1セットで exercise_sets に展開）を1バッチで挿入する。展開結果そのものがスナップショットで、
 * circuit_json を後日編集しても過去ログは不変。子セットは自己ベスト対象外（D7）なので records_broken は常に空。
 */
async function logCircuitExercise(
  env: Env,
  menu: ExerciseMenu,
  items: CircuitItem[],
  input: ExerciseLogFields,
  performedAt: string,
  parentId: string,
): Promise<ExerciseLog | { error: string }> {
  if (input.sets) return { error: `sets is not allowed for circuit menu "${menu.name}" — pass rounds` };
  if (input.rounds == null) return { error: `rounds is required for circuit menu "${menu.name}"` };
  // 作成時にも検証済みだが、構成種目は後から archive / circuit化 / 非自重化されうるため記録時に再検証する
  const children: ExerciseMenu[] = [];
  for (const item of items) {
    const m = await getExerciseMenu(env, item.menu_id);
    if (!m) return { error: `circuit item menu not found: ${item.menu_id}` };
    if (m.archived) {
      return { error: `circuit item "${m.name}" is archived — unarchive it or remove it from the circuit` };
    }
    if (m.circuit) return { error: `circuit item "${m.name}" is itself a circuit — nesting is not supported` };
    if (!m.is_bodyweight) {
      return { error: `circuit item "${m.name}" is not a bodyweight menu — register it as is_bodyweight with a factor, or log it standalone with sets` };
    }
    children.push(m);
  }
  const wantsKcal = menu.mets != null && input.duration_min != null;
  const needBw = wantsKcal || children.some((m) => m.is_bodyweight);
  let bw: number | null = null;
  if (needBw) {
    bw = await getBodyWeightAt(env, performedAt);
    if (bw == null) return { error: 'no body weight measurement on or before performed_at' };
  }
  const calories = wantsKcal ? estimateCalories(menu.mets!, bw!, input.duration_min!) : null;
  const now = isoNow();
  const statements: D1PreparedStatement[] = [
    // 親ログ: group_id = 自id。ボリュームには寄与しない（is_bodyweight=0 / sets無し）
    env.DB.prepare(
      `INSERT INTO exercise_logs (${LOG_COLS})
VALUES (?1, ?2, ?3, 'strength', ?4, ?5, 0, 1, ?6, ?7, ?8, ?9, ?10, ?1)`,
    ).bind(parentId, menu.id, performedAt, menu.name, input.note ?? null,
           input.duration_min ?? null, menu.mets ?? null, bw, calories, now),
  ];
  for (const [i, child] of children.entries()) {
    const childId = newId();
    statements.push(
      env.DB.prepare(
        `INSERT INTO exercise_logs (${LOG_COLS})
VALUES (?1, ?2, ?3, 'strength', ?4, NULL, ?5, ?6, NULL, NULL, ?7, NULL, ?8, ?9)`,
      ).bind(childId, child.id, performedAt, child.name,
             child.is_bodyweight ? 1 : 0, child.is_bodyweight ? child.bodyweight_factor : 1,
             child.is_bodyweight ? bw : null, now, parentId),
    );
    // 1ラウンド=1セット。バインド上限（100/文）に収まるよう複数行INSERTを分割する
    const reps = items[i].reps;
    for (let start = 1; start <= input.rounds; start += SET_INSERT_CHUNK) {
      const end = Math.min(start + SET_INSERT_CHUNK - 1, input.rounds);
      const rows: string[] = [];
      const binds: unknown[] = [];
      for (let si = start; si <= end; si++) {
        rows.push(`(?${binds.length + 1}, ?${binds.length + 2}, ?${binds.length + 3}, ?${binds.length + 4}, NULL)`);
        binds.push(newId(), childId, si, reps);
      }
      statements.push(
        env.DB.prepare(
          `INSERT INTO exercise_sets (id, log_id, set_index, reps, weight_kg) VALUES ${rows.join(', ')}`,
        ).bind(...binds),
      );
    }
  }
  await env.DB.batch(statements);
  const per = children.map((child, i) => {
    const eff = effectiveWeight(child.is_bodyweight, bw, child.bodyweight_factor, null);
    const totalReps = items[i].reps * input.rounds!;
    return {
      menu_id: child.id,
      menu_name: child.name,
      reps_per_round: items[i].reps,
      total_reps: totalReps,
      effective_weight_kg: eff,
      volume: roundVolume(totalReps * eff),
    };
  });
  return {
    ...(await getExerciseLog(env, parentId))!,
    rounds: input.rounds,
    circuit: {
      rounds: input.rounds,
      per_movement: per,
      total_reps: per.reduce((a, p) => a + p.total_reps, 0),
      total_volume: roundVolume(per.reduce((a, p) => a + p.volume, 0)),
    },
    records_broken: [],
  };
}

export async function deleteExerciseLog(env: Env, id: string): Promise<boolean | { error: string }> {
  // サーキット子ログの単独削除は拒否する（グループの一部だけ消えるとラウンド数・ボリュームの
  // 整合が壊れる。親ログの削除でグループ全体を消す。D-06決定）
  const row = await env.DB.prepare('SELECT group_id FROM exercise_logs WHERE id = ?1')
    .bind(id)
    .first<{ group_id: string | null }>();
  if (row?.group_id != null && row.group_id !== id) {
    return {
      error: `this log is part of a circuit session — delete the parent log ${row.group_id} to remove the whole session`,
    };
  }
  // 外部キーのCASCADEに依存せず、セット→ログの順で明示削除（D1のFK有効可否に左右されない）。
  // サーキットの親id指定時は group_id 一致の全ログ（親+子）をまとめて削除する
  const [, logRes] = await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM exercise_sets WHERE log_id IN (SELECT id FROM exercise_logs WHERE id = ?1 OR group_id = ?1)',
    ).bind(id),
    env.DB.prepare('DELETE FROM exercise_logs WHERE id = ?1 OR group_id = ?1').bind(id),
  ]);
  return (logRes.meta.changes ?? 0) > 0;
}

/**
 * LIMIT がサーキットグループの途中で切れると「rounds不明の親」や「親のない子」が返るため、
 * 上限到達時は末尾の不完全なグループを丸ごと落とす（ORDER BY のタイブレーカでグループは必ず隣接する）
 */
export function dropIncompleteTrailingGroup<T extends { group_id: string | null }>(rows: T[], limit: number): T[] {
  if (rows.length < limit) return rows;
  const lastGroup = rows[rows.length - 1]?.group_id;
  if (lastGroup == null) return rows;
  let cut = rows.length;
  while (cut > 0 && rows[cut - 1].group_id === lastGroup) cut--;
  return rows.slice(0, cut);
}

const LOG_LIST_LIMIT = 2000;

export async function listExerciseLogs(env: Env, from: string, to: string): Promise<ExerciseLog[]> {
  const tz = tzModifier(env);
  // サーキット親子は同一performed_atのため、group単位で隣接するようタイブレーカを固定する
  const logs = await env.DB.prepare(
    `SELECT ${LOG_COLS} FROM exercise_logs
WHERE date(performed_at, '${tz}') BETWEEN ?1 AND ?2
ORDER BY performed_at DESC, COALESCE(group_id, id), id LIMIT ${LOG_LIST_LIMIT}`,
  )
    .bind(from, to)
    .all<LogRow>();
  logs.results = dropIncompleteTrailingGroup(logs.results, LOG_LIST_LIMIT);
  if (logs.results.length === 0) return [];
  const setRows = await env.DB.prepare(
    `SELECT s.log_id, s.set_index, s.reps, s.weight_kg
FROM exercise_sets s JOIN exercise_logs l ON l.id = s.log_id
WHERE date(l.performed_at, '${tz}') BETWEEN ?1 AND ?2
ORDER BY s.log_id, s.set_index`,
  )
    .bind(from, to)
    .all<SetRow>();
  const byLog = new Map<string, SetRow[]>();
  for (const s of setRows.results) {
    const arr = byLog.get(s.log_id);
    if (arr) arr.push(s);
    else byLog.set(s.log_id, [s]);
  }
  const out = logs.results.map((l) => toLog(l, byLog.get(l.id) ?? []));
  // サーキット親ログの rounds を子ログのセット数から復元する（1ラウンド=1セット展開のため全子で同数）
  const roundsByGroup = new Map<string, number>();
  for (const l of out) {
    if (l.group_id != null && l.group_id !== l.id && l.sets.length > 0) roundsByGroup.set(l.group_id, l.sets.length);
  }
  for (const l of out) {
    if (l.group_id != null && l.group_id === l.id) l.rounds = roundsByGroup.get(l.id) ?? null;
  }
  return out;
}

/** Katch-McArdle: 除脂肪体重(kg)からの基礎代謝推定 */
export function estimateBmr(fatFreeMassKg: number): number {
  return 370 + 21.6 * fatFreeMassKg;
}

export async function getDailyExercise(env: Env, from: string, to: string): Promise<DailyExercise[]> {
  const tz = tzModifier(env);
  const [counts, volume, ffmHist, ffmSeed] = await env.DB.batch<{ d: string } & Record<string, number>>([
    env.DB.prepare(
      // calories_burned は kcal を持つ全記録の合計（cardio + METs付きstrength）。
      // strength_count は 1サーキット=1件になるよう group_id で畳む
      `SELECT date(performed_at, '${tz}') AS d,
       SUM(CASE WHEN calories IS NOT NULL THEN calories ELSE 0 END) AS calories_burned,
       SUM(CASE WHEN calories IS NOT NULL THEN 1 ELSE 0 END) AS calories_count,
       SUM(CASE WHEN category = 'cardio' THEN COALESCE(calories, 0) ELSE 0 END) AS cardio_calories,
       SUM(CASE WHEN category = 'strength' THEN COALESCE(calories, 0) ELSE 0 END) AS strength_calories,
       SUM(CASE WHEN category = 'cardio' THEN 1 ELSE 0 END) AS cardio_count,
       COUNT(DISTINCT CASE WHEN category = 'strength' THEN COALESCE(group_id, id) END) AS strength_count
FROM exercise_logs
WHERE date(performed_at, '${tz}') BETWEEN ?1 AND ?2
GROUP BY 1`,
    ).bind(from, to),
    env.DB.prepare(
      // strength_volume の SUM は従来と同一式のまま残し（過去との数値連続性）、
      // 実荷重分 weighted_volume だけ追加で出す。自重換算分は読み取り側で差分導出する（D6）
      `SELECT date(l.performed_at, '${tz}') AS d,
       SUM(s.reps * (COALESCE(s.weight_kg, 0)
         + CASE WHEN l.is_bodyweight = 1 THEN COALESCE(l.body_weight_kg, 0) * l.bodyweight_factor ELSE 0 END)) AS strength_volume,
       SUM(s.reps * COALESCE(s.weight_kg, 0)) AS weighted_volume
FROM exercise_logs l JOIN exercise_sets s ON s.log_id = l.id
WHERE l.category = 'strength' AND date(l.performed_at, '${tz}') BETWEEN ?1 AND ?2
GROUP BY 1`,
    ).bind(from, to),
    // BMR用のFFM履歴（範囲内のみ、時系列順）。全履歴を返すと計測が増えるほど毎リクエスト重くなる
    env.DB.prepare(
      `SELECT date(measured_at, '${tz}') AS d, fat_free_mass AS ffm
FROM measurements
WHERE fat_free_mass IS NOT NULL AND date(measured_at, '${tz}') BETWEEN ?1 AND ?2
ORDER BY measured_at`,
    ).bind(from, to),
    // carry-forwardの種: 範囲開始より前で最新のFFM 1件
    env.DB.prepare(
      `SELECT fat_free_mass AS ffm
FROM measurements
WHERE fat_free_mass IS NOT NULL AND date(measured_at, '${tz}') < ?1
ORDER BY measured_at DESC LIMIT 1`,
    ).bind(from),
  ]);
  const volByDate = new Map<string, { total: number; weighted: number }>();
  for (const r of volume.results) {
    volByDate.set(r.d, { total: r.strength_volume, weighted: Number(r.weighted_volume ?? 0) });
  }
  const countsByDate = new Map<
    string,
    { calories: number; caloriesCount: number; cardioCalories: number; strengthCalories: number; cardio: number; strength: number }
  >();
  for (const r of counts.results) {
    countsByDate.set(r.d, {
      calories: Number(r.calories_burned ?? 0),
      caloriesCount: Number(r.calories_count ?? 0),
      cardioCalories: Number(r.cardio_calories ?? 0),
      strengthCalories: Number(r.strength_calories ?? 0),
      cardio: Number(r.cardio_count ?? 0),
      strength: Number(r.strength_count ?? 0),
    });
  }
  // 日ごとの最新FFM（同日複数計測は後勝ち=最新）。時系列順なのでMapが日付昇順の最新値になる
  const ffmByDay = new Map<string, number>();
  for (const r of ffmHist.results) ffmByDay.set(r.d, r.ffm);
  // 範囲開始前の最新FFMをcarryの初期値にする（seedクエリで1件だけ取得）
  let carry: number | null = ffmSeed.results[0]?.ffm ?? null;
  // 期間内の全日を返す（BMRは運動の有無によらず毎日成立するため）
  const out: DailyExercise[] = [];
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) {
    if (ffmByDay.has(d)) carry = ffmByDay.get(d)!;
    const c = countsByDate.get(d);
    const v = volByDate.get(d);
    out.push({
      d,
      bmr: carry != null ? estimateBmr(carry) : null,
      calories_burned: c && c.caloriesCount > 0 ? c.calories : null,
      cardio_calories: c && c.cardio > 0 ? c.cardioCalories : null,
      strength_calories: c && c.strengthCalories > 0 ? c.strengthCalories : null,
      strength_volume: v ? v.total : null,
      weighted_volume: v ? roundVolume(v.weighted) : null,
      bodyweight_volume: v ? roundVolume(Math.max(0, v.total - v.weighted)) : null,
      cardio_count: c?.cardio ?? 0,
      strength_count: c?.strength ?? 0,
    });
  }
  return out;
}

export async function getExerciseForDay(env: Env, ymd: string): Promise<DailyExercise | null> {
  const rows = await getDailyExercise(env, ymd, ymd);
  return rows[0] ?? null;
}

// ---- バリデータ（REST /rw と MCP の両方から使う） ----

function isNonNegativeFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** サーキット構成配列の型チェック（参照整合性の検証は createExerciseMenu / updateExerciseMenu 側で行う） */
function parseCircuitField(v: unknown): Parsed<CircuitItem[] | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (!Array.isArray(v) || v.length === 0) return { ok: false, error: 'circuit must be a non-empty array' };
  if (v.length > MAX_CIRCUIT_ITEMS) return { ok: false, error: `circuit must be <= ${MAX_CIRCUIT_ITEMS} items` };
  const out: CircuitItem[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'each circuit item must be an object' };
    const it = raw as Record<string, unknown>;
    if (typeof it.menu_id !== 'string' || it.menu_id === '') {
      return { ok: false, error: 'circuit item menu_id is required' };
    }
    if (!Number.isInteger(it.reps) || (it.reps as number) < 1 || (it.reps as number) > MAX_REPS) {
      return { ok: false, error: `circuit item reps must be an integer between 1 and ${MAX_REPS}` };
    }
    out.push({ menu_id: it.menu_id, reps: it.reps as number });
  }
  return { ok: true, value: out };
}

export function parseExerciseMenuInput(body: unknown): Parsed<ExerciseMenuInput> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.name !== 'string' || b.name.trim() === '') return { ok: false, error: 'name is required' };
  if (b.category !== 'cardio' && b.category !== 'strength') {
    return { ok: false, error: 'category must be cardio or strength' };
  }
  const category = b.category;
  if (category === 'cardio') {
    if (!isPositiveFinite(b.mets) || (b.mets as number) > MAX_METS) {
      return { ok: false, error: `mets must be a positive number <= ${MAX_METS}` };
    }
    // strength専用フィールドの黙殺をやめて明示エラーにする（D8。無意味な既定値と同義の指定は許容）
    if (typeof b.muscle_group === 'string' && b.muscle_group.trim() !== '') {
      return { ok: false, error: 'muscle_group is not allowed for cardio menus' };
    }
    if (b.is_bodyweight === true) return { ok: false, error: 'is_bodyweight is not allowed for cardio menus' };
    if (typeof b.bodyweight_factor === 'number' && b.bodyweight_factor !== 1) {
      return { ok: false, error: 'bodyweight_factor is not allowed for cardio menus' };
    }
  } else if (b.mets !== undefined && b.mets !== null) {
    // strength でも METs を任意設定できる（duration_min 記録時に消費kcalを算出する）
    if (!isPositiveFinite(b.mets) || (b.mets as number) > MAX_METS) {
      return { ok: false, error: `mets must be a positive number <= ${MAX_METS}` };
    }
  }
  if (b.muscle_group !== undefined && b.muscle_group !== null && typeof b.muscle_group !== 'string') {
    return { ok: false, error: 'muscle_group must be a string' };
  }
  if (!isValidBodyweightFactor(b.bodyweight_factor)) {
    return { ok: false, error: 'bodyweight_factor must be a number between 0 and 1' };
  }
  if (category === 'strength' && b.is_bodyweight !== true
      && typeof b.bodyweight_factor === 'number' && b.bodyweight_factor !== 1) {
    return { ok: false, error: 'bodyweight_factor requires is_bodyweight: true' };
  }
  const circuit = parseCircuitField(b.circuit);
  if (!circuit.ok) return circuit;
  if (circuit.value) {
    if (category !== 'strength') return { ok: false, error: 'circuit is only valid for strength menus' };
    if (b.is_bodyweight === true) {
      return { ok: false, error: 'is_bodyweight is not applicable to circuit menus (set it on the constituent menus)' };
    }
  }
  return {
    ok: true,
    value: {
      name: b.name.trim(),
      category,
      mets: typeof b.mets === 'number' ? b.mets : null,
      muscle_group:
        category === 'strength' && typeof b.muscle_group === 'string' && b.muscle_group.trim() !== ''
          ? b.muscle_group.trim()
          : null,
      is_bodyweight: category === 'strength' && b.is_bodyweight === true,
      bodyweight_factor:
        category === 'strength' && b.is_bodyweight === true && typeof b.bodyweight_factor === 'number'
          ? b.bodyweight_factor
          : 1,
      circuit: circuit.value,
      note: typeof b.note === 'string' ? b.note : null,
    },
  };
}

/** 0〜1の有限数か（undefinedは許可=既定1.0） */
function isValidBodyweightFactor(v: unknown): boolean {
  if (v === undefined) return true;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

export function parseExerciseMenuPatch(body: unknown): Parsed<Partial<Omit<ExerciseMenuInput, 'category'>>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'invalid request body' };
  }
  const b = body as Record<string, unknown>;
  const out: Partial<Omit<ExerciseMenuInput, 'category'>> = {};
  if ('name' in b) {
    if (typeof b.name !== 'string' || b.name.trim() === '') return { ok: false, error: 'name is required' };
    out.name = b.name.trim();
  }
  if ('mets' in b) {
    if (b.mets === null) out.mets = null;
    else if (isPositiveFinite(b.mets) && (b.mets as number) <= MAX_METS) out.mets = b.mets as number;
    else return { ok: false, error: `mets must be a positive number <= ${MAX_METS}` };
  }
  if ('muscle_group' in b) {
    if (b.muscle_group === null) out.muscle_group = null;
    else if (typeof b.muscle_group === 'string') out.muscle_group = b.muscle_group.trim() || null;
    else return { ok: false, error: 'muscle_group must be a string or null' };
  }
  if ('is_bodyweight' in b) {
    if (typeof b.is_bodyweight !== 'boolean') return { ok: false, error: 'is_bodyweight must be boolean' };
    out.is_bodyweight = b.is_bodyweight;
  }
  if ('bodyweight_factor' in b) {
    if (b.bodyweight_factor !== null && !isValidBodyweightFactor(b.bodyweight_factor)) {
      return { ok: false, error: 'bodyweight_factor must be a number between 0 and 1' };
    }
    out.bodyweight_factor = typeof b.bodyweight_factor === 'number' ? b.bodyweight_factor : 1;
  }
  if ('circuit' in b) {
    const circuit = parseCircuitField(b.circuit);
    if (!circuit.ok) return circuit;
    out.circuit = circuit.value; // null = サーキット構成をクリアして通常種目に戻す
  }
  if ('note' in b) {
    if (b.note === null) out.note = null;
    else if (typeof b.note === 'string') out.note = b.note;
    else return { ok: false, error: 'note must be a string or null' };
  }
  if (Object.keys(out).length === 0) return { ok: false, error: 'no fields to update' };
  return { ok: true, value: out };
}

/** 記録フィールドの型チェック。category依存の必須（cardio=duration_min / strength=sets）はlogExerciseで判定 */
export function parseExerciseLogFields(body: Record<string, unknown>): Parsed<ExerciseLogFields> {
  const out: ExerciseLogFields = {};
  if (body.performed_at !== undefined) {
    if (typeof body.performed_at !== 'string' || Number.isNaN(Date.parse(body.performed_at))) {
      return { ok: false, error: 'performed_at must be ISO8601' };
    }
    if (Date.parse(body.performed_at) > Date.parse(isoNow()) + 60_000) {
      return { ok: false, error: 'performed_at must not be in the future' };
    }
    out.performed_at = body.performed_at;
  }
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') return { ok: false, error: 'note must be a string' };
    out.note = body.note;
  }
  if (body.duration_min !== undefined && body.duration_min !== null) {
    if (!isPositiveFinite(body.duration_min) || (body.duration_min as number) > MAX_DURATION_MIN) {
      return { ok: false, error: `duration_min must be a positive number <= ${MAX_DURATION_MIN}` };
    }
    out.duration_min = body.duration_min as number;
  }
  if (body.rounds !== undefined && body.rounds !== null) {
    if (!Number.isInteger(body.rounds) || (body.rounds as number) < 1 || (body.rounds as number) > MAX_ROUNDS) {
      return { ok: false, error: `rounds must be an integer between 1 and ${MAX_ROUNDS}` };
    }
    out.rounds = body.rounds as number;
  }
  if (body.sets !== undefined && body.sets !== null) {
    if (!Array.isArray(body.sets) || body.sets.length === 0) {
      return { ok: false, error: 'sets must be a non-empty array' };
    }
    if (body.sets.length > MAX_SETS) return { ok: false, error: `sets must be <= ${MAX_SETS} entries` };
    const parsed: { reps: number; weight_kg?: number | null }[] = [];
    for (const raw of body.sets) {
      if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'each set must be an object' };
      const s = raw as Record<string, unknown>;
      if (!Number.isInteger(s.reps) || (s.reps as number) < 1 || (s.reps as number) > MAX_REPS) {
        return { ok: false, error: `reps must be an integer between 1 and ${MAX_REPS}` };
      }
      let weight: number | null = null;
      if (s.weight_kg !== undefined && s.weight_kg !== null) {
        if (!isNonNegativeFinite(s.weight_kg) || (s.weight_kg as number) > MAX_WEIGHT_KG) {
          return { ok: false, error: `weight_kg must be between 0 and ${MAX_WEIGHT_KG}` };
        }
        weight = s.weight_kg as number;
      }
      parsed.push({ reps: s.reps as number, weight_kg: weight });
    }
    out.sets = parsed;
  }
  return { ok: true, value: out };
}
