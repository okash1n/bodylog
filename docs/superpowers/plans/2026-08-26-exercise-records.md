# 筋トレ種目の自己ベスト（exercise records）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 筋トレ種目ごとの自己ベスト（最大重量 / REP数ごとの最大 / 推定1RM / 最大REP / 最大セット・セッションボリューム / 前回セッション）を都度集計で返す `get_exercise_records`（MCP）と `GET /api/exercise/records`（REST）を追加し、`log_exercise` の応答に自己ベスト更新フラグを付ける。

**Architecture:** 新モジュール `src/exercise-records.ts` に「1種目の全セットを1クエリで取る」`fetchRecordRows` と、純関数 `computeRecords` / `diffRecords` を置く。`exercise.ts` の `logExercise` は挿入前後で `computeRecords` を呼び差分を `records_broken` として返す。REST は `READ_ROUTES` テーブル、MCP は既存の `resolveIdByName` による名前解決を流用する。DB スキーマ変更なし。

**Tech Stack:** Cloudflare Workers / Hono 4 / D1 / @hono/mcp + @modelcontextprotocol/sdk + zod / vitest + @cloudflare/vitest-pool-workers

**Spec:** `docs/superpowers/specs/2026-08-26-exercise-records-design.md`

## Global Constraints

- 実環境の値（本番ドメイン・ID・シークレット・実測値）をコード・テスト・ドキュメントに書かない（URL例は `weight.example.com`）
- 検証コマンドは `npm run typecheck` と `npm test`（`npx vitest run <file>` で個別実行可）
- テストで日付依存の計測を seed するときは固定時刻 `${ymd}T03:00:00Z`（JST正午）を使う
- コミットは Conventional Commits。`Co-Authored-By` は入れない
- 集計の定義（重量の基準・タイブレーク・Epley の rep 上限 12・自重種目の 1RM は null）は spec の「集計の定義」節に従う

---

## ファイル構成

| ファイル | 役割 |
|---|---|
| `src/types.ts`（変更） | `ExerciseRecords` / `RecordBroken` 型、`ExerciseLog.records_broken?` |
| `src/exercise-records.ts`（新規） | `effectiveWeight`、`computeRecords`（純関数）、`diffRecords`（純関数）、`fetchRecordRows` / `getExerciseRecords`（D1） |
| `src/exercise.ts`（変更） | `toSet` が `effectiveWeight` を使う。`logExercise` が前後の記録差分 `records_broken` を返す |
| `src/exercise-api.ts`（変更） | `serveExerciseRecords`（`GET /api/exercise/records?menu_id=`） |
| `src/dashboard.ts`（変更） | `READ_ROUTES` に `api/exercise/records` |
| `src/ai.ts`（変更） | llms.txt 1行、openapi の path と `ExerciseRecords` スキーマ |
| `src/mcp.ts`（変更） | ツール `get_exercise_records`、instructions と `log_exercise` 説明の追記 |
| `README.md`（変更） | API 表・MCP ツール一覧（13→14）・運動記録節の説明 |
| `test/exercise-records.test.ts`（新規） | 純関数と D1 経由の集計 |
| `test/exercise.test.ts`（変更） | `records_broken` |
| `test/exercise-api.test.ts` / `test/access.test.ts` / `test/ai-api.test.ts`（変更） | REST・private・openapi ドリフト |
| `test/mcp.test.ts`（変更） | ツール数 14、`get_exercise_records` |

`exercise-records.ts` は `exercise.ts` を import しない（`exercise.ts` → `exercise-records.ts` の一方向。循環 import を避けるため、種目の取得はハンドラ側で `getExerciseMenu` を呼んで `ExerciseMenu` を渡す）。

---

### Task 1: 型と純関数（effectiveWeight / computeRecords / diffRecords）

**Files:**
- Modify: `src/types.ts`（`ExerciseLog` の直後に型を追加、`ExerciseLog` に任意フィールド）
- Create: `src/exercise-records.ts`
- Modify: `src/exercise.ts`（`toSet` の実効重量計算を共通関数に置換）
- Test: `test/exercise-records.test.ts`

**Interfaces:**
- Produces: `effectiveWeight(isBodyweight: boolean, bodyWeightKg: number | null, factor: number, weightKg: number | null): number`
- Produces: `interface RecordSetRow { log_id: string; performed_at: string; set_index: number; reps: number; weight_kg: number | null; is_bodyweight: number; bodyweight_factor: number; body_weight_kg: number | null }`
- Produces: `computeRecords(menu: ExerciseMenu, rows: RecordSetRow[]): ExerciseRecords`（rows は `performed_at, log_id, set_index` 昇順が前提）
- Produces: `diffRecords(before: ExerciseRecords, after: ExerciseRecords): RecordBroken[]`
- Produces（types.ts）: `ExerciseRecords`, `RecordKind`, `RecordBroken`, `ExerciseLog.records_broken?: RecordBroken[]`

- [ ] **Step 1: 型を追加する（`src/types.ts`）**

`export interface ExerciseLog { ... total_volume: number | null; }` の `total_volume` 行の直後に 1 行追加し、インターフェースの後ろに型を足す:

```ts
  total_volume: number | null; // strengthのみ（Σ volume）
  records_broken?: RecordBroken[]; // logExercise の戻り値にだけ付く（自己ベスト更新。cardio は []）
}

/** 記録を達成したセット/セッションへの参照 */
export interface RecordRef {
  performed_at: string; // 達成日時（同値なら最初に達成した日）
  log_id: string;
}

/**
 * 筋トレ種目の自己ベスト（都度集計。DBには保持しない）。
 * max_weight / rep_maxes / estimated_1rm は追加重量（weight_kg）基準で null/0 のセットは対象外、
 * max_set_volume / max_session_volume は実効重量（自重種目は体重×係数込み）基準。
 * estimated_1rm は Epley（weight×(1+reps/30)）で reps<=12 のセットのみ、自重種目は常に null。
 */
export interface ExerciseRecords {
  menu: Pick<ExerciseMenu, 'id' | 'name' | 'category' | 'muscle_group' | 'is_bodyweight' | 'bodyweight_factor'>;
  sessions: number; // 記録した log 数
  first_performed_at: string | null;
  last_performed_at: string | null;
  max_weight: (RecordRef & { weight_kg: number; reps: number }) | null;
  rep_maxes: (RecordRef & { reps: number; weight_kg: number })[]; // reps 昇順
  estimated_1rm: (RecordRef & { value_kg: number; weight_kg: number; reps: number }) | null;
  max_reps: (RecordRef & { reps: number; weight_kg: number | null }) | null;
  max_set_volume: (RecordRef & { volume: number; reps: number; effective_weight_kg: number }) | null;
  max_session_volume: (RecordRef & { volume: number; sets: number }) | null;
  last_session: (RecordRef & { total_volume: number; sets: ExerciseSet[] }) | null;
}

export type RecordKind =
  | 'max_weight' | 'rep_max' | 'estimated_1rm' | 'max_reps' | 'max_set_volume' | 'max_session_volume';

/** 記録時に更新した自己ベスト1件。rep_max のときだけ reps が付く。previous は更新前の値（初回は null） */
export interface RecordBroken {
  kind: RecordKind;
  reps?: number;
  previous: number | null;
  current: number;
}
```

- [ ] **Step 2: 失敗するテストを書く（`test/exercise-records.test.ts`）**

```ts
import { describe, expect, it } from 'vitest';
import type { ExerciseMenu, ExerciseRecords } from '../src/types';
import { computeRecords, diffRecords, effectiveWeight, type RecordSetRow } from '../src/exercise-records';

const bench: ExerciseMenu = {
  id: 'm-bench', name: 'ベンチプレス', category: 'strength', mets: null, muscle_group: '胸',
  is_bodyweight: false, bodyweight_factor: 1, note: null, archived: false,
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
};
const pullup: ExerciseMenu = { ...bench, id: 'm-pullup', name: '懸垂', muscle_group: '背中', is_bodyweight: true };

/** セット行を作る。log の順序は performed_at 昇順で渡すこと（DB の ORDER BY と同じ前提） */
function row(
  log: string, performed: string, setIndex: number, reps: number, weight: number | null,
  bw: { factor?: number; body?: number | null } | null = null,
): RecordSetRow {
  return {
    log_id: log, performed_at: performed, set_index: setIndex, reps, weight_kg: weight,
    is_bodyweight: bw ? 1 : 0, bodyweight_factor: bw?.factor ?? 1, body_weight_kg: bw ? bw.body ?? null : null,
  };
}

describe('effectiveWeight', () => {
  it('自重種目は追加重量+体重×係数、それ以外は追加重量（nullは0）', () => {
    expect(effectiveWeight(false, 80, 1, 60)).toBe(60);
    expect(effectiveWeight(false, 80, 1, null)).toBe(0);
    expect(effectiveWeight(true, 80, 1, null)).toBe(80);
    expect(effectiveWeight(true, 80, 0.5, 10)).toBe(50);
    expect(effectiveWeight(true, null, 1, 5)).toBe(5);
  });
});

describe('computeRecords', () => {
  it('記録が無ければ全項目 null / 空', () => {
    const r = computeRecords(bench, []);
    expect(r.sessions).toBe(0);
    expect(r.first_performed_at).toBeNull();
    expect(r.max_weight).toBeNull();
    expect(r.rep_maxes).toEqual([]);
    expect(r.estimated_1rm).toBeNull();
    expect(r.max_reps).toBeNull();
    expect(r.max_set_volume).toBeNull();
    expect(r.max_session_volume).toBeNull();
    expect(r.last_session).toBeNull();
    expect(r.menu).toEqual({
      id: 'm-bench', name: 'ベンチプレス', category: 'strength', muscle_group: '胸', is_bodyweight: false, bodyweight_factor: 1,
    });
  });

  it('最大重量・レップマックス表・推定1RM・最大REP・セット/セッションボリューム・前回セッションを集計する', () => {
    const rows = [
      row('L1', '2026-08-01T03:00:00Z', 1, 8, 80), // vol 640
      row('L1', '2026-08-01T03:00:00Z', 2, 8, 80),
      row('L1', '2026-08-01T03:00:00Z', 3, 6, 80), // L1 total 1760
      row('L2', '2026-08-05T03:00:00Z', 1, 5, 90), // vol 450, 1RM 105
      row('L2', '2026-08-05T03:00:00Z', 2, 3, 100), // vol 300, 1RM 110 → 最大
      row('L2', '2026-08-05T03:00:00Z', 3, 12, 60), // vol 720 → 最大セット
    ];
    const r = computeRecords(bench, rows);
    expect(r.sessions).toBe(2);
    expect(r.first_performed_at).toBe('2026-08-01T03:00:00Z');
    expect(r.last_performed_at).toBe('2026-08-05T03:00:00Z');
    expect(r.max_weight).toEqual({ weight_kg: 100, reps: 3, performed_at: '2026-08-05T03:00:00Z', log_id: 'L2' });
    expect(r.rep_maxes).toEqual([
      { reps: 3, weight_kg: 100, performed_at: '2026-08-05T03:00:00Z', log_id: 'L2' },
      { reps: 5, weight_kg: 90, performed_at: '2026-08-05T03:00:00Z', log_id: 'L2' },
      { reps: 6, weight_kg: 80, performed_at: '2026-08-01T03:00:00Z', log_id: 'L1' },
      { reps: 8, weight_kg: 80, performed_at: '2026-08-01T03:00:00Z', log_id: 'L1' },
      { reps: 12, weight_kg: 60, performed_at: '2026-08-05T03:00:00Z', log_id: 'L2' },
    ]);
    expect(r.estimated_1rm).toEqual({ value_kg: 110, weight_kg: 100, reps: 3, performed_at: '2026-08-05T03:00:00Z', log_id: 'L2' });
    expect(r.max_reps).toEqual({ reps: 12, weight_kg: 60, performed_at: '2026-08-05T03:00:00Z', log_id: 'L2' });
    expect(r.max_set_volume).toEqual({ volume: 720, reps: 12, effective_weight_kg: 60, performed_at: '2026-08-05T03:00:00Z', log_id: 'L2' });
    expect(r.max_session_volume).toEqual({ volume: 1760, sets: 3, performed_at: '2026-08-01T03:00:00Z', log_id: 'L1' });
    expect(r.last_session).toEqual({
      performed_at: '2026-08-05T03:00:00Z', log_id: 'L2', total_volume: 1470,
      sets: [
        { set_index: 1, reps: 5, weight_kg: 90, effective_weight_kg: 90, volume: 450 },
        { set_index: 2, reps: 3, weight_kg: 100, effective_weight_kg: 100, volume: 300 },
        { set_index: 3, reps: 12, weight_kg: 60, effective_weight_kg: 60, volume: 720 },
      ],
    });
  });

  it('同値は最初に達成した日が残る（先勝ち）', () => {
    const rows = [
      row('L1', '2026-08-01T03:00:00Z', 1, 5, 100),
      row('L2', '2026-08-08T03:00:00Z', 1, 5, 100),
    ];
    const r = computeRecords(bench, rows);
    expect(r.max_weight?.log_id).toBe('L1');
    expect(r.rep_maxes[0].log_id).toBe('L1');
    expect(r.estimated_1rm?.log_id).toBe('L1');
    expect(r.max_set_volume?.log_id).toBe('L1');
    expect(r.max_session_volume?.log_id).toBe('L1');
    expect(r.last_session?.log_id).toBe('L2');
  });

  it('推定1RMは reps<=12 のセットだけから計算し、小数1桁に丸める', () => {
    const rows = [
      row('L1', '2026-08-01T03:00:00Z', 1, 20, 60), // 60×(1+20/30)=100 だが対象外
      row('L1', '2026-08-01T03:00:00Z', 2, 10, 70), // 70×(1+10/30)=93.33 → 93.3
    ];
    expect(computeRecords(bench, rows).estimated_1rm).toMatchObject({ value_kg: 93.3, weight_kg: 70, reps: 10 });
  });

  it('自重種目: 純自重セットは最大重量/レップマックス/1RMの対象外、ボリュームは実効重量で計算し、1RMは常にnull', () => {
    const rows = [
      row('L1', '2026-08-01T03:00:00Z', 1, 10, null, { body: 80 }), // 実効80, vol 800
      row('L1', '2026-08-01T03:00:00Z', 2, 5, 10, { body: 80 }), // 実効90, vol 450
    ];
    const r = computeRecords(pullup, rows);
    expect(r.max_weight).toMatchObject({ weight_kg: 10, reps: 5 });
    expect(r.rep_maxes).toEqual([{ reps: 5, weight_kg: 10, performed_at: '2026-08-01T03:00:00Z', log_id: 'L1' }]);
    expect(r.estimated_1rm).toBeNull();
    expect(r.max_reps).toMatchObject({ reps: 10, weight_kg: null });
    expect(r.max_set_volume).toMatchObject({ volume: 800, reps: 10, effective_weight_kg: 80 });
    expect(r.max_session_volume).toMatchObject({ volume: 1250, sets: 2 });
  });

  it('純自重のみの種目は max_weight が null', () => {
    const r = computeRecords(pullup, [row('L1', '2026-08-01T03:00:00Z', 1, 12, null, { body: 80 })]);
    expect(r.max_weight).toBeNull();
    expect(r.rep_maxes).toEqual([]);
    expect(r.max_reps).toMatchObject({ reps: 12 });
  });
});

describe('diffRecords', () => {
  const empty = computeRecords(bench, []);
  const first = computeRecords(bench, [row('L1', '2026-08-01T03:00:00Z', 1, 5, 80)]);

  it('初回記録は previous=null で全項目が更新扱い', () => {
    expect(diffRecords(empty, first)).toEqual([
      { kind: 'max_weight', previous: null, current: 80 },
      { kind: 'rep_max', reps: 5, previous: null, current: 80 },
      { kind: 'estimated_1rm', previous: null, current: 93.3 },
      { kind: 'max_reps', previous: null, current: 5 },
      { kind: 'max_set_volume', previous: null, current: 400 },
      { kind: 'max_session_volume', previous: null, current: 400 },
    ]);
  });

  it('上回った項目だけを返し、同値は更新扱いにしない', () => {
    const after = computeRecords(bench, [
      row('L1', '2026-08-01T03:00:00Z', 1, 5, 80),
      row('L2', '2026-08-03T03:00:00Z', 1, 5, 80), // 同値
      row('L2', '2026-08-03T03:00:00Z', 2, 8, 70), // 新しい reps の記録。セッション 400+560=960
    ]);
    expect(diffRecords(first, after)).toEqual([
      { kind: 'rep_max', reps: 8, previous: null, current: 70 },
      { kind: 'max_reps', previous: 5, current: 8 },
      { kind: 'max_set_volume', previous: 400, current: 560 },
      { kind: 'max_session_volume', previous: 400, current: 960 },
    ]);
  });

  it('何も上回らなければ空', () => {
    const after: ExerciseRecords = computeRecords(bench, [
      row('L1', '2026-08-01T03:00:00Z', 1, 5, 80),
      row('L2', '2026-08-03T03:00:00Z', 1, 3, 60),
    ]);
    expect(diffRecords(first, after)).toEqual([{ kind: 'rep_max', reps: 3, previous: null, current: 60 }]);
    expect(diffRecords(after, after)).toEqual([]);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `npx vitest run test/exercise-records.test.ts`
Expected: FAIL（`../src/exercise-records` が無い）

- [ ] **Step 4: `src/exercise-records.ts` を作る（純関数部分）**

```ts
/**
 * 筋トレ種目の自己ベスト（都度集計）。DB には保持せず、1種目の全セットを1クエリで取り
 * 純関数 computeRecords で集計する。定義は docs/superpowers/specs/2026-08-26-exercise-records-design.md。
 * exercise.ts から参照されるため、このファイルは exercise.ts を import しない（循環回避）。
 */
import type { Env, ExerciseMenu, ExerciseRecords, ExerciseSet, RecordBroken, RecordKind } from './types';

/** Epley 式で推定 1RM を出す reps の上限（高 rep では式が信頼できない） */
const EPLEY_MAX_REPS = 12;

/** 実効重量 = 追加重量 + （自重種目なら 体重 × 係数）。null は 0 として扱う */
export function effectiveWeight(
  isBodyweight: boolean,
  bodyWeightKg: number | null,
  factor: number,
  weightKg: number | null,
): number {
  return (weightKg ?? 0) + (isBodyweight ? (bodyWeightKg ?? 0) * factor : 0);
}

/** exercise_logs ⋈ exercise_sets の1行（log 側はスナップショット列） */
export interface RecordSetRow {
  log_id: string;
  performed_at: string;
  set_index: number;
  reps: number;
  weight_kg: number | null;
  is_bodyweight: number;
  bodyweight_factor: number;
  body_weight_kg: number | null;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * 1種目の全セットから自己ベストを集計する。rows は performed_at, log_id, set_index 昇順を前提とし、
 * 比較は厳密な > なので同値は最初に達成した行が残る（先勝ち）。
 */
export function computeRecords(menu: ExerciseMenu, rows: RecordSetRow[]): ExerciseRecords {
  let maxWeight: ExerciseRecords['max_weight'] = null;
  const repMaxes = new Map<number, ExerciseRecords['rep_maxes'][number]>();
  let estimated1rm: ExerciseRecords['estimated_1rm'] = null;
  let maxReps: ExerciseRecords['max_reps'] = null;
  let maxSetVolume: ExerciseRecords['max_set_volume'] = null;
  // 挿入順 = performed_at 昇順（Map は挿入順を保つ）
  const sessions = new Map<string, { performed_at: string; volume: number; sets: ExerciseSet[] }>();

  for (const r of rows) {
    const eff = effectiveWeight(r.is_bodyweight !== 0, r.body_weight_kg, r.bodyweight_factor, r.weight_kg);
    const volume = r.reps * eff;
    const ref = { performed_at: r.performed_at, log_id: r.log_id };

    if (r.weight_kg != null && r.weight_kg > 0) {
      if (!maxWeight || r.weight_kg > maxWeight.weight_kg) maxWeight = { ...ref, weight_kg: r.weight_kg, reps: r.reps };
      const rm = repMaxes.get(r.reps);
      if (!rm || r.weight_kg > rm.weight_kg) repMaxes.set(r.reps, { ...ref, reps: r.reps, weight_kg: r.weight_kg });
      if (!menu.is_bodyweight && r.reps <= EPLEY_MAX_REPS) {
        const value = round1(r.weight_kg * (1 + r.reps / 30));
        if (!estimated1rm || value > estimated1rm.value_kg) {
          estimated1rm = { ...ref, value_kg: value, weight_kg: r.weight_kg, reps: r.reps };
        }
      }
    }
    if (!maxReps || r.reps > maxReps.reps) maxReps = { ...ref, reps: r.reps, weight_kg: r.weight_kg };
    if (!maxSetVolume || volume > maxSetVolume.volume) {
      maxSetVolume = { ...ref, volume, reps: r.reps, effective_weight_kg: eff };
    }

    let session = sessions.get(r.log_id);
    if (!session) {
      session = { performed_at: r.performed_at, volume: 0, sets: [] };
      sessions.set(r.log_id, session);
    }
    session.volume += volume;
    session.sets.push({ set_index: r.set_index, reps: r.reps, weight_kg: r.weight_kg, effective_weight_kg: eff, volume });
  }

  let maxSession: ExerciseRecords['max_session_volume'] = null;
  for (const [logId, s] of sessions) {
    if (!maxSession || s.volume > maxSession.volume) {
      maxSession = { performed_at: s.performed_at, log_id: logId, volume: s.volume, sets: s.sets.length };
    }
  }
  const entries = [...sessions.entries()];
  const first = entries[0];
  const last = entries[entries.length - 1];

  return {
    menu: {
      id: menu.id,
      name: menu.name,
      category: menu.category,
      muscle_group: menu.muscle_group,
      is_bodyweight: menu.is_bodyweight,
      bodyweight_factor: menu.bodyweight_factor,
    },
    sessions: entries.length,
    first_performed_at: first?.[1].performed_at ?? null,
    last_performed_at: last?.[1].performed_at ?? null,
    max_weight: maxWeight,
    rep_maxes: [...repMaxes.values()].sort((a, b) => a.reps - b.reps),
    estimated_1rm: estimated1rm,
    max_reps: maxReps,
    max_set_volume: maxSetVolume,
    max_session_volume: maxSession,
    last_session: last
      ? { performed_at: last[1].performed_at, log_id: last[0], total_volume: last[1].volume, sets: last[1].sets }
      : null,
  };
}

/** 挿入前後の記録を比べ、上回った項目を返す（同値は更新扱いにしない。初回は previous=null） */
export function diffRecords(before: ExerciseRecords, after: ExerciseRecords): RecordBroken[] {
  const out: RecordBroken[] = [];
  const push = (kind: RecordKind, prev: number | null | undefined, cur: number | null | undefined, reps?: number): void => {
    if (cur == null) return;
    if (prev != null && cur <= prev) return;
    out.push({ kind, ...(reps === undefined ? {} : { reps }), previous: prev ?? null, current: cur });
  };
  push('max_weight', before.max_weight?.weight_kg, after.max_weight?.weight_kg);
  for (const rm of after.rep_maxes) {
    push('rep_max', before.rep_maxes.find((b) => b.reps === rm.reps)?.weight_kg, rm.weight_kg, rm.reps);
  }
  push('estimated_1rm', before.estimated_1rm?.value_kg, after.estimated_1rm?.value_kg);
  push('max_reps', before.max_reps?.reps, after.max_reps?.reps);
  push('max_set_volume', before.max_set_volume?.volume, after.max_set_volume?.volume);
  push('max_session_volume', before.max_session_volume?.volume, after.max_session_volume?.volume);
  return out;
}
```

（`Env` の import は Task 2 で使う。Task 1 の時点では `noUnusedLocals` に引っかからないよう、Task 2 まで `Env` を import しないこと）

- [ ] **Step 5: `src/exercise.ts` の `toSet` を共通関数に置き換える**

`import { addDaysYmd, ... } from './util';` の下に追加:

```ts
import { effectiveWeight } from './exercise-records';
```

`toSet` を置き換え:

```ts
function toSet(is_bodyweight: boolean, bodyWeight: number | null, factor: number, r: SetRow): ExerciseSet {
  const eff = effectiveWeight(is_bodyweight, bodyWeight, factor, r.weight_kg);
  return {
    set_index: r.set_index,
    reps: r.reps,
    weight_kg: r.weight_kg,
    effective_weight_kg: eff,
    volume: r.reps * eff,
  };
}
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `npx vitest run test/exercise-records.test.ts test/exercise.test.ts && npm run typecheck`
Expected: PASS（既存の exercise テストも変化なし）

- [ ] **Step 7: コミット**

```bash
git add src/types.ts src/exercise-records.ts src/exercise.ts test/exercise-records.test.ts
git commit -m "feat: pure record aggregation for strength menus (computeRecords / diffRecords)"
```

---

### Task 2: D1 からの集計と `logExercise` の自己ベスト更新フラグ

**Files:**
- Modify: `src/exercise-records.ts`（`fetchRecordRows` / `getExerciseRecords` を追加）
- Modify: `src/exercise.ts`（`logExercise` の strength 経路と cardio 経路）
- Test: `test/exercise-records.test.ts`（D1 経由の describe を追加）、`test/exercise.test.ts`

**Interfaces:**
- Consumes: Task 1 の `computeRecords` / `diffRecords`
- Produces: `getExerciseRecords(env: Env, menu: ExerciseMenu): Promise<ExerciseRecords>`（呼び出し側が strength の `ExerciseMenu` を渡す）
- Produces: `logExercise` の戻り値 `ExerciseLog` に `records_broken` が常に付く（cardio は `[]`）

- [ ] **Step 1: 失敗するテストを書く**

`test/exercise-records.test.ts` の末尾に追加（import を拡張する）:

```ts
import { beforeEach } from 'vitest';
import { createExerciseMenu, logExercise } from '../src/exercise';
import { getExerciseRecords } from '../src/exercise-records';
import { insertMeasurement, resetTables, testEnv } from './helpers';

describe('getExerciseRecords（D1）', () => {
  beforeEach(async () => {
    await resetTables();
    // 自重種目の体重スナップショット用（過去日に固定）
    await insertMeasurement({ grpid: 9601, measured_at: '2026-07-01T03:00:00Z', weight: 80, fat_free_mass: 64 });
  });

  it('記録順に関係なく performed_at 順で集計し、他種目の記録は混ぜない', async () => {
    const squat = await createExerciseMenu(testEnv, { name: 'スクワット', category: 'strength' });
    const other = await createExerciseMenu(testEnv, { name: 'デッドリフト', category: 'strength' });
    // 新しい日を先に記録してから古い日を追記する（過去日付の追記でも先勝ちが崩れないこと）
    const l2 = await logExercise(testEnv, { menu_id: squat.id, performed_at: '2026-08-10T03:00:00Z', sets: [{ reps: 5, weight_kg: 100 }] });
    const l1 = await logExercise(testEnv, { menu_id: squat.id, performed_at: '2026-08-03T03:00:00Z', sets: [{ reps: 5, weight_kg: 100 }, { reps: 8, weight_kg: 80 }] });
    await logExercise(testEnv, { menu_id: other.id, performed_at: '2026-08-11T03:00:00Z', sets: [{ reps: 3, weight_kg: 140 }] });
    if ('error' in l1 || 'error' in l2) throw new Error('seed failed');

    const r = await getExerciseRecords(testEnv, squat);
    expect(r.sessions).toBe(2);
    expect(r.max_weight).toMatchObject({ weight_kg: 100, log_id: l1.id }); // 同値 → 古い日（先勝ち）
    expect(r.max_session_volume).toMatchObject({ volume: 1140, log_id: l1.id });
    expect(r.last_session).toMatchObject({ log_id: l2.id, total_volume: 500 });
    expect(r.rep_maxes.map((x) => x.reps)).toEqual([5, 8]);
  });

  it('記録が無い種目は sessions=0 で各項目 null', async () => {
    const menu = await createExerciseMenu(testEnv, { name: 'ローイング', category: 'strength' });
    const r = await getExerciseRecords(testEnv, menu);
    expect(r.sessions).toBe(0);
    expect(r.max_weight).toBeNull();
    expect(r.last_session).toBeNull();
  });
});
```

`test/exercise.test.ts` の `describe('運動記録（筋トレ）'`（既存の筋トレ describe）に追加:

```ts
  it('logExercise は自己ベスト更新を records_broken で返す（初回=全項目、更新なし=空、有酸素=空）', async () => {
    const bench = await createExerciseMenu(testEnv, { name: 'ベンチプレス', category: 'strength' });
    const first = await logExercise(testEnv, { menu_id: bench.id, performed_at: '2026-08-01T03:00:00Z', sets: [{ reps: 5, weight_kg: 80 }] });
    if ('error' in first) throw new Error(first.error);
    expect(first.records_broken?.map((b) => b.kind)).toEqual([
      'max_weight', 'rep_max', 'estimated_1rm', 'max_reps', 'max_set_volume', 'max_session_volume',
    ]);
    expect(first.records_broken?.[0]).toEqual({ kind: 'max_weight', previous: null, current: 80 });

    const second = await logExercise(testEnv, { menu_id: bench.id, performed_at: '2026-08-03T03:00:00Z', sets: [{ reps: 5, weight_kg: 82.5 }] });
    if ('error' in second) throw new Error(second.error);
    expect(second.records_broken).toEqual([
      { kind: 'max_weight', previous: 80, current: 82.5 },
      { kind: 'rep_max', reps: 5, previous: 80, current: 82.5 },
      { kind: 'estimated_1rm', previous: 93.3, current: 96.3 },
      { kind: 'max_set_volume', previous: 400, current: 412.5 },
      { kind: 'max_session_volume', previous: 400, current: 412.5 },
    ]);

    const third = await logExercise(testEnv, { menu_id: bench.id, performed_at: '2026-08-05T03:00:00Z', sets: [{ reps: 3, weight_kg: 60 }] });
    if ('error' in third) throw new Error(third.error);
    expect(third.records_broken).toEqual([{ kind: 'rep_max', reps: 3, previous: null, current: 60 }]);

    await seedWeight(localYmdDaysAgo(1), 80);
    const run = await createExerciseMenu(testEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    const cardio = await logExercise(testEnv, { menu_id: run.id, duration_min: 30 });
    if ('error' in cardio) throw new Error(cardio.error);
    expect(cardio.records_broken).toEqual([]);
  });
```

（`seedWeight` と `localYmdDaysAgo` は同ファイル既存のヘルパー / import。cardio は `getBodyWeightAt(now)` が体重を拾える必要があるため前日に seed する）

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run test/exercise-records.test.ts test/exercise.test.ts`
Expected: FAIL（`getExerciseRecords` 未定義、`records_broken` が undefined）

- [ ] **Step 3: `src/exercise-records.ts` に D1 取得を追加する**

ファイル末尾に追加（`Env` は既に import 済み）:

```ts
/**
 * 1種目の全セットを performed_at, log_id, set_index 昇順で取る（idx_exercise_logs_menu_performed を使う）。
 * 個人1人分（年数百行）なので上限は設けない。
 */
export async function fetchRecordRows(env: Env, menuId: string): Promise<RecordSetRow[]> {
  const res = await env.DB.prepare(
    `SELECT s.log_id, l.performed_at, s.set_index, s.reps, s.weight_kg,
        l.is_bodyweight, l.bodyweight_factor, l.body_weight_kg
FROM exercise_sets s JOIN exercise_logs l ON l.id = s.log_id
WHERE l.menu_id = ?1 AND l.category = 'strength'
ORDER BY l.performed_at, l.id, s.set_index`,
  )
    .bind(menuId)
    .all<RecordSetRow>();
  return res.results;
}

/** 筋トレ種目の自己ベストを都度集計する。menu は呼び出し側が取得した strength の種目 */
export async function getExerciseRecords(env: Env, menu: ExerciseMenu): Promise<ExerciseRecords> {
  return computeRecords(menu, await fetchRecordRows(env, menu.id));
}
```

- [ ] **Step 4: `src/exercise.ts` の `logExercise` を変更する**

import を拡張:

```ts
import { diffRecords, effectiveWeight, getExerciseRecords } from './exercise-records';
```

cardio 経路の `return (await getExerciseLog(env, id))!;` を:

```ts
    return { ...(await getExerciseLog(env, id))!, records_broken: [] };
```

strength 経路の `await env.DB.batch(statements); return (await getExerciseLog(env, id))!;` を:

```ts
  // 自己ベスト更新の判定: 挿入前後の集計を比べる（都度集計なので前の値を別途持たない）
  const before = await getExerciseRecords(env, menu);
  await env.DB.batch(statements);
  const after = await getExerciseRecords(env, menu);
  return { ...(await getExerciseLog(env, id))!, records_broken: diffRecords(before, after) };
```

（`before` の取得は `statements` を組み立てた後・batch の前。batch が失敗すれば例外で抜けるので不整合は起きない）

- [ ] **Step 5: テストが通ることを確認する**

Run: `npx vitest run test/exercise-records.test.ts test/exercise.test.ts test/exercise-api.test.ts test/mcp.test.ts && npm run typecheck`
Expected: PASS（REST/MCP の `log_exercise` 応答に `records_broken` が増えるだけで既存アサーションは壊れない）

- [ ] **Step 6: コミット**

```bash
git add src/exercise-records.ts src/exercise.ts test/exercise-records.test.ts test/exercise.test.ts
git commit -m "feat: aggregate strength records from D1 and flag broken records on log_exercise"
```

---

### Task 3: REST `GET /api/exercise/records` と openapi / llms.txt

**Files:**
- Modify: `src/exercise-api.ts`（`serveExerciseRecords` を追加）
- Modify: `src/dashboard.ts`（`READ_ROUTES` に 1 行）
- Modify: `src/ai.ts`（llms.txt 1 行、openapi path、`ExerciseRecords` スキーマ）
- Test: `test/exercise-api.test.ts`、`test/access.test.ts`、`test/ai-api.test.ts`

**Interfaces:**
- Consumes: Task 2 の `getExerciseRecords(env, menu)`、既存 `getExerciseMenu(env, id)`
- Produces: `GET {base}/api/exercise/records?menu_id=` — 200 `ExerciseRecords` / 400 `{error:'menu_id is required'}` / 404 `{error:'menu not found'}` / 400 `{error:'records are only available for strength menus'}`

- [ ] **Step 1: 失敗するテストを書く**

`test/exercise-api.test.ts` の `describe('公開REST（運動）'` に追加:

```ts
  it('GET /api/exercise/records は menu_id 必須・未知は404・有酸素は400・筋トレは自己ベストを返す', async () => {
    expect((await request('/api/exercise/records')).status).toBe(400);
    expect((await request('/api/exercise/records?menu_id=nope')).status).toBe(404);
    const run = await createExerciseMenu(testEnv, { name: 'ラン', category: 'cardio', mets: 8 });
    expect((await request(`/api/exercise/records?menu_id=${run.id}`)).status).toBe(400);

    const bench = await createExerciseMenu(testEnv, { name: 'ベンチプレス', category: 'strength' });
    await logExercise(testEnv, { menu_id: bench.id, performed_at: '2026-08-01T03:00:00Z', sets: [{ reps: 5, weight_kg: 80 }] });
    const res = await request(`/api/exercise/records?menu_id=${bench.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as { menu: { id: string }; max_weight: { weight_kg: number }; rep_maxes: unknown[] };
    expect(body.menu.id).toBe(bench.id);
    expect(body.max_weight.weight_kg).toBe(80);
    expect(body.rep_maxes).toHaveLength(1);
  });
```

`test/access.test.ts` の 401 テストのパス配列に `'/api/exercise/records?menu_id=x'` を追加:

```ts
    for (const path of ['/api/summary', '/api/measurements?days=7', '/api/raw?days=7', '/api/exercise/records?menu_id=x', '/llms.txt', '/openapi.json']) {
```

`test/ai-api.test.ts` のドリフトテストを、必須クエリを持つ path はパラメータ無しで 400 を返せばよいように変える:

```ts
    it('openapi.jsonの全pathが実ルータで配信される（削除/改名ドリフトの検知）', async () => {
      const spec = (await (await request('/openapi.json')).json()) as {
        paths: Record<string, { get?: { parameters?: { name: string; required?: boolean }[] } }>;
      };
      for (const [path, ops] of Object.entries(spec.paths)) {
        const params = ops.get?.parameters ?? [];
        const needsRange = params.some((p) => p.name === 'days');
        // days 以外の必須クエリを持つ path は、パラメータ無しで検証エラー（400）を返せば配信されている
        const requiresQuery = params.some((p) => p.required && p.name !== 'days');
        const res = await request(needsRange ? `${path}?days=1` : path);
        expect(res.status, `documented path ${path} should be served`).toBe(requiresQuery ? 400 : 200);
      }
    });
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run test/exercise-api.test.ts test/access.test.ts test/ai-api.test.ts`
Expected: FAIL（`/api/exercise/records` が 404）

- [ ] **Step 3: ハンドラを追加する（`src/exercise-api.ts`）**

import を拡張:

```ts
import { getDailyExercise, getExerciseMenu, listExerciseLogs, listExerciseMenus } from './exercise';
import { getExerciseRecords } from './exercise-records';
```

ファイル末尾に追加:

```ts
/** 筋トレ種目の自己ベスト（都度集計）。menu_id 必須・筋トレ種目のみ */
export const serveExerciseRecords: Handler = async (c) => {
  const headers = noindexHeaders(NO_STORE);
  const menuId = c.req.query('menu_id')?.trim();
  if (!menuId) return c.json({ error: 'menu_id is required' }, 400, headers);
  try {
    const menu = await getExerciseMenu(c.env, menuId);
    if (!menu) return c.json({ error: 'menu not found' }, 404, headers);
    if (menu.category !== 'strength') {
      return c.json({ error: 'records are only available for strength menus' }, 400, headers);
    }
    return c.json(await getExerciseRecords(c.env, menu), 200, headers);
  } catch (err) {
    console.error('[exercise-api] getExerciseRecords failed', err);
    return c.json({ error: 'internal error' }, 500, headers);
  }
};
```

- [ ] **Step 4: ルートを登録する（`src/dashboard.ts`）**

`serveExerciseRecords` を exercise-api の import に加え、`READ_ROUTES` の `['api/exercise/logs', serveExerciseLogs],` の直後に:

```ts
  ['api/exercise/records', serveExerciseRecords],
```

- [ ] **Step 5: llms.txt と openapi を更新する（`src/ai.ts`）**

llms.txt の `- GET ${root}/api/exercise/daily?days=30 — ...` の直後に:

```
- GET ${root}/api/exercise/records?menu_id= — 筋トレ種目の自己ベスト（最大重量・REP数ごとの最大・推定1RM(Epley, reps<=12)・最大REP・最大セット/セッションボリューム・前回セッション）。都度集計。全記録を取らずにこれを使う
```

openapi の `'/api/exercise/daily': {` の直前に path を追加:

```ts
      '/api/exercise/records': {
        get: {
          operationId: 'getExerciseRecords',
          summary:
            '筋トレ種目の自己ベスト（最大重量・REP数ごとの最大重量・推定1RM・最大REP・最大セット/セッションボリューム・前回セッション）。都度集計',
          parameters: [
            {
              name: 'menu_id',
              in: 'query',
              required: true,
              description: '種目ID（/api/exercise/menus で取得。筋トレ種目のみ）',
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: '自己ベスト',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ExerciseRecords' } } },
            },
            '400': errorResponse,
            '404': errorResponse,
          },
        },
      },
```

`components.schemas` の `ExerciseLog: {` の直前に:

```ts
        ExerciseRecords: {
          type: 'object',
          description:
            '筋トレ種目の自己ベスト（都度集計）。max_weight / rep_maxes / estimated_1rm は追加重量（weight_kg）基準で純自重セットは対象外、' +
            'max_set_volume / max_session_volume は実効重量（自重種目は体重×係数込み）基準。estimated_1rm は Epley（weight×(1+reps/30)）で ' +
            'reps<=12 のセットのみ、自重種目は常に null。各項目の performed_at / log_id は達成したセット（同値なら最初に達成した日）',
          properties: {
            menu: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                category: { type: 'string', enum: ['cardio', 'strength'] },
                muscle_group: { type: ['string', 'null'] },
                is_bodyweight: { type: 'boolean' },
                bodyweight_factor: { type: 'number' },
              },
            },
            sessions: { type: 'integer' },
            first_performed_at: { type: ['string', 'null'], format: 'date-time' },
            last_performed_at: { type: ['string', 'null'], format: 'date-time' },
            max_weight: { type: ['object', 'null'], properties: { weight_kg: { type: 'number' }, reps: { type: 'integer' }, performed_at: { type: 'string' }, log_id: { type: 'string' } } },
            rep_maxes: {
              type: 'array',
              items: { type: 'object', properties: { reps: { type: 'integer' }, weight_kg: { type: 'number' }, performed_at: { type: 'string' }, log_id: { type: 'string' } } },
            },
            estimated_1rm: { type: ['object', 'null'], properties: { value_kg: { type: 'number' }, weight_kg: { type: 'number' }, reps: { type: 'integer' }, performed_at: { type: 'string' }, log_id: { type: 'string' } } },
            max_reps: { type: ['object', 'null'], properties: { reps: { type: 'integer' }, weight_kg: { type: ['number', 'null'] }, performed_at: { type: 'string' }, log_id: { type: 'string' } } },
            max_set_volume: { type: ['object', 'null'], properties: { volume: { type: 'number' }, reps: { type: 'integer' }, effective_weight_kg: { type: 'number' }, performed_at: { type: 'string' }, log_id: { type: 'string' } } },
            max_session_volume: { type: ['object', 'null'], properties: { volume: { type: 'number' }, sets: { type: 'integer' }, performed_at: { type: 'string' }, log_id: { type: 'string' } } },
            last_session: {
              type: ['object', 'null'],
              properties: {
                performed_at: { type: 'string' },
                log_id: { type: 'string' },
                total_volume: { type: 'number' },
                sets: { type: 'array', items: { $ref: '#/components/schemas/ExerciseSet' } },
              },
            },
          },
        },
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `npx vitest run test/exercise-api.test.ts test/access.test.ts test/ai-api.test.ts && npm run typecheck`
Expected: PASS（「READ_ROUTES の /api GET ルートがすべて openapi に文書化されている」テストも通る）

- [ ] **Step 7: コミット**

```bash
git add src/exercise-api.ts src/dashboard.ts src/ai.ts test/exercise-api.test.ts test/access.test.ts test/ai-api.test.ts
git commit -m "feat: GET /api/exercise/records for per-menu strength records"
```

---

### Task 4: MCP ツール `get_exercise_records` と README

**Files:**
- Modify: `src/mcp.ts`（ツール追加、instructions と `log_exercise` 説明の追記、ヘッダコメントのツール数）
- Modify: `README.md`（API 表、MCP ツール一覧 13→14、運動記録の説明）
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: Task 2 の `getExerciseRecords`、既存 `getExerciseMenu` / `listExerciseMenus` / `resolveIdByName`
- Produces: MCP ツール `get_exercise_records { menu_id?: string; menu_name?: string }` → `ExerciseRecords` の JSON。エラー文: `menu_id or menu_name is required` / `menu not found` / `records are only available for strength menus` / `resolveIdByName` のメッセージ

- [ ] **Step 1: 失敗するテストを書く（`test/mcp.test.ts`）**

`toHaveLength(13)` の 2 か所（tools/list のテストと MCP-Protocol-Version ヘッダのテスト）を `toHaveLength(14)` にし、ツール名の期待配列（`'create_menu', 'get_daily_series', ...`）に `'get_exercise_records'` をアルファベット順（`'get_exercise_logs'` の直後）で追加する。

`log_weight` のテストの後ろに追加:

```ts
  it('get_exercise_records は menu_name で解決し自己ベストを返す。曖昧・未知・有酸素はエラー', async () => {
    const bench = await createExerciseMenu(rootEnv, { name: 'ベンチプレス', category: 'strength' });
    await createExerciseMenu(rootEnv, { name: 'インクラインベンチプレス', category: 'strength' });
    await createExerciseMenu(rootEnv, { name: 'ランニング', category: 'cardio', mets: 8 });
    await logExercise(rootEnv, { menu_id: bench.id, performed_at: '2026-08-01T03:00:00Z', sets: [{ reps: 5, weight_kg: 80 }, { reps: 8, weight_kg: 70 }] });

    const ok = (await (await rwRpc(token, 'tools/call', {
      name: 'get_exercise_records', arguments: { menu_name: 'ベンチプレス' },
    })).json()) as RpcResponse;
    const records = parseToolJson<{ menu: { id: string }; max_weight: { weight_kg: number }; rep_maxes: { reps: number }[]; last_session: { total_volume: number } }>(ok.result!);
    expect(records.menu.id).toBe(bench.id); // 完全一致が部分一致より優先
    expect(records.max_weight.weight_kg).toBe(80);
    expect(records.rep_maxes.map((r) => r.reps)).toEqual([5, 8]);
    expect(records.last_session.total_volume).toBe(960);

    const ambiguous = (await (await rwRpc(token, 'tools/call', {
      name: 'get_exercise_records', arguments: { menu_name: 'ベンチ' },
    })).json()) as RpcResponse;
    expect((ambiguous.result as { isError?: boolean }).isError).toBe(true);

    const cardio = (await (await rwRpc(token, 'tools/call', {
      name: 'get_exercise_records', arguments: { menu_name: 'ランニング' },
    })).json()) as RpcResponse;
    expect((cardio.result as { isError?: boolean }).isError).toBe(true);

    const missing = (await (await rwRpc(token, 'tools/call', { name: 'get_exercise_records', arguments: {} })).json()) as RpcResponse;
    expect((missing.result as { isError?: boolean }).isError).toBe(true);
  });
```

（`createExerciseMenu` / `logExercise` を `../src/exercise` から import に追加。既存テストの `rwRpc` / `token` / `RpcResponse` / `parseToolJson` をそのまま使う。エラー応答の形は既存テストの `isError` 判定に合わせる）

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest run test/mcp.test.ts`
Expected: FAIL（ツール数 13、`get_exercise_records` が unknown tool）

- [ ] **Step 3: ツールを追加する（`src/mcp.ts`）**

import を拡張:

```ts
import {
  createExerciseMenu, getExerciseMenu, listExerciseLogs, listExerciseMenus, logExercise,
  parseExerciseLogFields, parseExerciseMenuInput,
} from './exercise';
import { getExerciseRecords } from './exercise-records';
```

ヘッダコメント（1〜5行目）の読み取りツール列挙と「13ツール」相当の記述に `get_exercise_records` を足す。`instructions` の運動の行を置き換え:

```ts
    '運動記録はsearch_exercise_menus / get_exercise_logsで照会できる（有酸素は消費kcal、筋トレはセット明細と総ボリューム。記録・種目作成は/mcpのみ）。',
    '筋トレ種目の自己ベスト（最大重量・REP数ごとの最大・推定1RM・最大REP・最大セット/セッションボリューム）と前回セッションの内容は get_exercise_records で引く（get_exercise_logs で全記録を取って推論しない）。log_exercise の応答の records_broken に自己ベスト更新が入るので、更新があれば伝える。',
```

`get_exercise_logs` の `registerTool` の直後（`if (opts.write)` より前）に:

```ts
  server.registerTool(
    'get_exercise_records',
    {
      description:
        '筋トレ種目の自己ベストを返す: max_weight（REP数問わずの最大重量）、rep_maxes（REP数ごとの最大重量）、estimated_1rm（Epley推定、reps<=12のセットから。自重種目はnull）、max_reps、max_set_volume（1セットのreps×実効重量）、max_session_volume（1回のトレーニングの総ボリューム）、last_session（前回のセット明細）。menu_id か menu_name で種目を指定する。有酸素種目は対象外',
      inputSchema: {
        menu_id: z.string().optional().describe('種目ID（search_exercise_menusで取得）'),
        menu_name: z.string().optional().describe('種目名（完全一致→一意な部分一致の順で解決）'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => guarded('get_exercise_records', async () => {
      let menuId = args.menu_id;
      if (!menuId && args.menu_name) {
        const resolved = resolveIdByName(await listExerciseMenus(env, { q: args.menu_name }), args.menu_name);
        if (!resolved.ok) return errorResult(resolved.error);
        menuId = resolved.id;
      }
      if (!menuId) return errorResult('menu_id or menu_name is required');
      const menu = await getExerciseMenu(env, menuId);
      if (!menu) return errorResult('menu not found');
      if (menu.category !== 'strength') return errorResult('records are only available for strength menus');
      return jsonResult(await getExerciseRecords(env, menu));
    }),
  );
```

`log_exercise` の description 末尾に追記: `。応答の records_broken に自己ベスト更新（kind / reps / previous / current）が入る`

- [ ] **Step 4: README を更新する**

- API 表の `GET {base}/api/exercise/daily` 行の直後に行を追加:
  `| \`GET {base}/api/exercise/records?menu_id=\` | 筋トレ種目の自己ベスト（最大重量・REP数ごとの最大・推定1RM・最大REP・最大セット/セッションボリューム・前回セッション）。都度集計。認証不要（既定） |`
- `POST /mcp` 行の「読み取り7ツール + 書き込み6ツール」を「読み取り8ツール + 書き込み6ツール」に
- 「MCP クライアント」の段落: ツール列挙の運動読み取りに `get_exercise_records` を足し、「読み取り7つ」を「読み取り8つ」に。末尾に 1 文: 「筋トレの自己ベスト（最大重量・N回での最大・推定1RM・最大ボリューム）と前回のセット内容は `get_exercise_records` で 1 回で引ける。`log_exercise` の応答には更新した自己ベスト（`records_broken`）が入る」
- 運動記録の機能説明（「運動記録」節）に 1 段落: 「**自己ベスト**: 種目ごとの最大重量（追加重量基準）・REP数ごとの最大重量・推定1RM（Epley、reps≤12、自重種目は対象外）・最大REP・最大セットボリューム／セッションボリューム（実効重量基準）を都度集計で返す（DBには保持しない）。同値は最初に達成した日を採る」

- [ ] **Step 5: テストが通ることを確認する**

Run: `npm run typecheck && npm test`
Expected: 全ファイル PASS（`test/mcp.test.ts` のツール数 14、`test/mcp-meals.test.ts` にツール数のアサーションがあれば同様に更新）

- [ ] **Step 6: 実値スキャンとコミット**

```bash
# 本番ドメインの文字列はこの文書に書かない（ローカル wrangler.toml の値を PROD_DOMAIN に入れて実行する）
git --no-pager diff | grep -nE "${PROD_DOMAIN}|[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" || echo clean
git add src/mcp.ts README.md test/mcp.test.ts
git commit -m "feat: get_exercise_records MCP tool for per-menu strength records"
```

---

## 完了条件

- `npm run typecheck` と `npm test` が通る
- 本番で `search_exercise_menus` → `get_exercise_records` の順に呼び、自己ベストが返る（ChatGPT / Claude Code どちらでも）
- `log_exercise` の応答に `records_broken` が入る
