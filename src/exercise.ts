/**
 * 運動データ層。種目マスタ（exercise_menus）・セッション記録（exercise_logs）・
 * 筋トレのセット明細（exercise_sets）のD1クエリを集約する。
 * 食事と同じスナップショット方式（記録時にメニュー由来の値を凍結）。
 */
import type {
  DailyExercise,
  Env,
  ExerciseCategory,
  ExerciseLog,
  ExerciseMenu,
  ExerciseMenuInput,
  ExerciseSet,
} from './types';
import { addDaysYmd, escapeLikeValue, isPositiveFinite, isoNow, newId, tzModifier } from './util';

const MAX_METS = 30;
const MAX_DURATION_MIN = 1440; // 24h
const MAX_REPS = 1000;
const MAX_WEIGHT_KG = 1000;
const MAX_SETS = 50;

// ---- 種目マスタ ----

interface MenuRow {
  id: string; name: string; category: string;
  mets: number | null; muscle_group: string | null; is_bodyweight: number;
  note: string | null; archived: number; created_at: string; updated_at: string;
}

function toMenu(r: MenuRow): ExerciseMenu {
  return {
    id: r.id,
    name: r.name,
    category: r.category as ExerciseCategory,
    mets: r.mets,
    muscle_group: r.muscle_group,
    is_bodyweight: r.is_bodyweight !== 0,
    note: r.note,
    archived: r.archived !== 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const MENU_COLS =
  'id, name, category, mets, muscle_group, is_bodyweight, note, archived, created_at, updated_at';

export async function createExerciseMenu(env: Env, input: ExerciseMenuInput): Promise<ExerciseMenu> {
  const now = isoNow();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO exercise_menus (${MENU_COLS})
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)`,
  )
    .bind(
      id, input.name, input.category,
      input.category === 'cardio' ? input.mets ?? null : null,
      input.category === 'strength' ? input.muscle_group ?? null : null,
      input.category === 'strength' && input.is_bodyweight ? 1 : 0,
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
): Promise<ExerciseMenu | null> {
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
  const res = await env.DB.prepare(
    `SELECT ${MENU_COLS} FROM exercise_menus ${where} ORDER BY name LIMIT 500`,
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
  duration_min: number | null; mets: number | null; body_weight_kg: number | null;
  calories: number | null; created_at: string;
}

interface SetRow {
  log_id: string; set_index: number; reps: number; weight_kg: number | null;
}

const LOG_COLS =
  'id, menu_id, performed_at, category, menu_name, note, is_bodyweight, duration_min, mets, body_weight_kg, calories, created_at';

function toSet(is_bodyweight: boolean, bodyWeight: number | null, r: SetRow): ExerciseSet {
  const eff = (r.weight_kg ?? 0) + (is_bodyweight ? bodyWeight ?? 0 : 0);
  return {
    set_index: r.set_index,
    reps: r.reps,
    weight_kg: r.weight_kg,
    effective_weight_kg: eff,
    volume: r.reps * eff,
  };
}

function toLog(r: LogRow, setRows: SetRow[]): ExerciseLog {
  const isBw = r.is_bodyweight !== 0;
  const sets = setRows.map((s) => toSet(isBw, r.body_weight_kg, s));
  return {
    id: r.id,
    menu_id: r.menu_id,
    performed_at: r.performed_at,
    category: r.category as ExerciseCategory,
    menu_name: r.menu_name,
    note: r.note,
    is_bodyweight: isBw,
    duration_min: r.duration_min,
    mets: r.mets,
    body_weight_kg: r.body_weight_kg,
    calories: r.calories,
    created_at: r.created_at,
    sets,
    total_volume: r.category === 'strength' ? sets.reduce((a, s) => a + s.volume, 0) : null,
  };
}

/** 有酸素の消費kcal = METs × 体重kg × 時間h × 1.05 */
export function estimateCalories(mets: number, bodyWeightKg: number, durationMin: number): number {
  return mets * bodyWeightKg * (durationMin / 60) * 1.05;
}

export interface ExerciseLogFields {
  performed_at?: string;
  note?: string | null;
  duration_min?: number;
  sets?: { reps: number; weight_kg?: number | null }[];
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
    if (menu.mets == null) return { error: 'cardio menu has no METs' };
    if (input.duration_min == null) return { error: 'duration_min is required for cardio' };
    const bw = await getBodyWeightAt(env, performedAt);
    if (bw == null) return { error: 'no body weight measurement on or before performed_at' };
    const calories = estimateCalories(menu.mets, bw, input.duration_min);
    await env.DB.prepare(
      `INSERT INTO exercise_logs (${LOG_COLS})
VALUES (?1, ?2, ?3, 'cardio', ?4, ?5, 0, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(id, menu.id, performedAt, menu.name, input.note ?? null,
            input.duration_min, menu.mets, bw, calories, isoNow())
      .run();
    return (await getExerciseLog(env, id))!;
  }

  // strength
  const rawSets = input.sets ?? [];
  if (rawSets.length === 0) return { error: 'sets is required for strength' };
  let bw: number | null = null;
  if (menu.is_bodyweight) {
    bw = await getBodyWeightAt(env, performedAt);
    if (bw == null) return { error: 'no body weight measurement on or before performed_at' };
  }
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO exercise_logs (${LOG_COLS})
VALUES (?1, ?2, ?3, 'strength', ?4, ?5, ?6, NULL, NULL, ?7, NULL, ?8)`,
    ).bind(id, menu.id, performedAt, menu.name, input.note ?? null,
           menu.is_bodyweight ? 1 : 0, bw, isoNow()),
    ...rawSets.map((s, i) =>
      env.DB.prepare(
        'INSERT INTO exercise_sets (id, log_id, set_index, reps, weight_kg) VALUES (?1, ?2, ?3, ?4, ?5)',
      ).bind(newId(), id, i + 1, s.reps, s.weight_kg ?? null),
    ),
  ];
  await env.DB.batch(statements);
  return (await getExerciseLog(env, id))!;
}

export async function deleteExerciseLog(env: Env, id: string): Promise<boolean> {
  // 外部キーのCASCADEに依存せず、セット→ログの順で明示削除（D1のFK有効可否に左右されない）
  const [, logRes] = await env.DB.batch([
    env.DB.prepare('DELETE FROM exercise_sets WHERE log_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM exercise_logs WHERE id = ?1').bind(id),
  ]);
  return (logRes.meta.changes ?? 0) > 0;
}

export async function listExerciseLogs(env: Env, from: string, to: string): Promise<ExerciseLog[]> {
  const tz = tzModifier(env);
  const logs = await env.DB.prepare(
    `SELECT ${LOG_COLS} FROM exercise_logs
WHERE date(performed_at, '${tz}') BETWEEN ?1 AND ?2
ORDER BY performed_at DESC LIMIT 2000`,
  )
    .bind(from, to)
    .all<LogRow>();
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
  return logs.results.map((l) => toLog(l, byLog.get(l.id) ?? []));
}

/** Katch-McArdle: 除脂肪体重(kg)からの基礎代謝推定 */
export function estimateBmr(fatFreeMassKg: number): number {
  return 370 + 21.6 * fatFreeMassKg;
}

export async function getDailyExercise(env: Env, from: string, to: string): Promise<DailyExercise[]> {
  const tz = tzModifier(env);
  const [counts, volume, ffmHist, ffmSeed] = await env.DB.batch<{ d: string } & Record<string, number>>([
    env.DB.prepare(
      `SELECT date(performed_at, '${tz}') AS d,
       SUM(CASE WHEN category = 'cardio' THEN calories ELSE 0 END) AS calories_burned,
       SUM(CASE WHEN category = 'cardio' THEN 1 ELSE 0 END) AS cardio_count,
       SUM(CASE WHEN category = 'strength' THEN 1 ELSE 0 END) AS strength_count
FROM exercise_logs
WHERE date(performed_at, '${tz}') BETWEEN ?1 AND ?2
GROUP BY 1`,
    ).bind(from, to),
    env.DB.prepare(
      `SELECT date(l.performed_at, '${tz}') AS d,
       SUM(s.reps * (COALESCE(s.weight_kg, 0)
         + CASE WHEN l.is_bodyweight = 1 THEN COALESCE(l.body_weight_kg, 0) ELSE 0 END)) AS strength_volume
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
  const volByDate = new Map<string, number>();
  for (const r of volume.results) volByDate.set(r.d, r.strength_volume);
  const countsByDate = new Map<string, { calories: number; cardio: number; strength: number }>();
  for (const r of counts.results) {
    countsByDate.set(r.d, {
      calories: Number(r.calories_burned ?? 0),
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
    out.push({
      d,
      bmr: carry != null ? estimateBmr(carry) : null,
      calories_burned: c && c.cardio > 0 ? c.calories : null,
      strength_volume: volByDate.has(d) ? volByDate.get(d)! : null,
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
  }
  if (b.muscle_group !== undefined && b.muscle_group !== null && typeof b.muscle_group !== 'string') {
    return { ok: false, error: 'muscle_group must be a string' };
  }
  return {
    ok: true,
    value: {
      name: b.name.trim(),
      category,
      mets: category === 'cardio' ? (b.mets as number) : null,
      muscle_group:
        category === 'strength' && typeof b.muscle_group === 'string' && b.muscle_group.trim() !== ''
          ? b.muscle_group.trim()
          : null,
      is_bodyweight: category === 'strength' && b.is_bodyweight === true,
      note: typeof b.note === 'string' ? b.note : null,
    },
  };
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
