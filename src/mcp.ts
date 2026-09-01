/**
 * MCP（Model Context Protocol）サーバー。読み取り専用ツール8つ（体重3 / 食事2 / 運動3）を
 * 公開し、認証済みエンドポイント（/mcp）では書き込みツール14本（記録・登録: log_meal / create_menu /
 * log_exercise / create_exercise_menu / set_goal / log_weight、編集・削除: update_menu / archive_menu /
 * update_meal_log / delete_meal_log / update_exercise_menu / archive_exercise_menu / delete_exercise_log /
 * delete_weight）を追加で公開する。
 * リクエストごとにサーバー/トランスポートを生成するステートレス構成
 * （セッションを持たないため、Durable Objects等の追加インフラが不要）。
 */
import { StreamableHTTPTransport } from '@hono/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { getDailySeries, getRawMeasurements, getSummary } from './queries';
import { parseSetGoalInput, setGoal } from './goals';
import {
  createMenu, deleteMealLog, listMealLogs, listMenus, logMeal, parseMealFields, parseMenuInput, parseMenuPatch,
  setMenuArchived, updateMealLog, updateMenu,
} from './meals';
import {
  createExerciseMenu, deleteExerciseLog, getExerciseMenu, listExerciseLogs, listExerciseMenus, logExercise,
  parseExerciseLogFields, parseExerciseMenuInput, parseExerciseMenuPatch, setExerciseMenuArchived,
  updateExerciseMenu,
} from './exercise';
import { getExerciseRecords } from './exercise-records';
import type { Env } from './types';
import { ensurePublicOrigin, LIMITS, localToday, noindexHeaders, offsetHours, resolveRange } from './util';
import { deleteManualMeasurement, logWeight, parseWeightInput } from './weight';

const MCP_SERVER_VERSION = '1.0.0';

function instructions(tzOffsetHours: number): string {
  return [
    '個人の体重・体組成・食事・運動を照会・記録するサーバー（bodylog、1ユーザー分）。体重はWithings連携または手動記録（log_weight）で入る。',
    '単位: 質量（weight / fat_mass / fat_free_mass）はkg、fat_ratioのみ%。',
    'fat_mass（脂肪量）は weight - fat_free_mass から導出した値。',
    `日付の境界はUTC${tzOffsetHours >= 0 ? '+' : ''}${tzOffsetHours}のローカル日付。`,
    'まず get_weight_summary で全体像を取り、詳細な推移が必要なときだけ get_daily_series / get_raw_measurements を使う。',
    '食事記録はsearch_menus / get_meal_logsで照会できる（記録・メニュー作成は認可済みエンドポイント/mcpのみ）。',
    'PFC（protein_g/fat_g/carbs_g）はグラム数。比率を出すときはP×4/F×9/C×4kcalに換算し3者の合計を100%として正規化すること。登録カロリーで割ってはいけない（食物繊維等の差で換算合計と登録kcalは一致せず、100%を超えうる）。',
    '運動記録はsearch_exercise_menus / get_exercise_logsで照会できる（有酸素は消費kcal、筋トレはセット明細と総ボリューム。筋トレも時間を記録でき、種目にMETsがあれば消費kcalが自動算出される。記録・種目作成は/mcpのみ）。',
    'サーキット/AMRAP（複数種目を1ラウンドとして繰り返す運動）は circuit 構成付きの種目として登録し、記録は rounds（ラウンド数）だけ渡す。換算ボリューム・種目別レップ・消費kcalはサーバが算出するので、クライアント側で換算値を計算・入力しない。',
    '筋トレ種目の自己ベスト（最大重量・REP数ごとの最大・推定1RM・最大REP・最大セット/セッションボリューム）と前回セッションの内容は get_exercise_records で引く（get_exercise_logs で全記録を取って推論しない）。自己ベストは単独トレーニングのみ対象で、サーキット内の実績は含まない。log_exercise の応答の records_broken に自己ベスト更新が入るので、更新があれば伝える。',
    '目標（体重・脂肪量）はget_weight_summaryのgoalで確認でき、set_goalで設定・解除できる（ユーザーが明示的に依頼したときだけ変更すること）。',
    '体重はlog_weightで手動記録できる（体重計が無い/Withings未連携の場合の記録手段。ユーザーが体重を報告したときに使う）。',
    '誤登録の修正は update_menu / update_exercise_menu（メニュー・種目の編集）、update_meal_log（食事記録の倍率・日時・区分）、archive_menu / archive_exercise_menu（一覧から非表示。archived=falseで復元）、delete_meal_log / delete_exercise_log / delete_weight（記録の削除）で行える。いずれもユーザーが明示的に依頼したときだけ使い、削除・アーカイブの前に対象（名前・日時・値）を確認すること。運動記録の編集はできないので削除して記録し直す。',
  ].join('\n');
}

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** DBエラー等の内部情報をクライアントに漏らさない（RESTの 'internal error' と同じ方針） */
async function guarded(tool: string, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[mcp] ${tool} failed`, err);
    return errorResult('internal error');
  }
}

/**
 * サーキット構成の各項目を menu_id に解決する（menu_name は完全一致→一意な部分一致）。
 * 解決後の配列は parseExerciseMenuInput / parseExerciseMenuPatch の circuit として渡す
 */
async function resolveCircuitArg(
  env: Env,
  circuit: { menu_id?: string; menu_name?: string; reps: number }[] | undefined,
): Promise<{ ok: true; value?: { menu_id: string; reps: number }[] } | { ok: false; error: string }> {
  if (!circuit) return { ok: true };
  const out: { menu_id: string; reps: number }[] = [];
  for (const it of circuit) {
    let menuId = it.menu_id;
    if (!menuId && it.menu_name) {
      const resolved = resolveIdByName(
        await listExerciseMenus(env, { q: it.menu_name, category: 'strength' }),
        it.menu_name,
      );
      if (!resolved.ok) return resolved;
      menuId = resolved.id;
    }
    if (!menuId) return { ok: false, error: 'circuit item requires menu_id or menu_name' };
    out.push({ menu_id: menuId, reps: it.reps });
  }
  return { ok: true, value: out };
}

/**
 * menu_id未指定時にmenu_nameから一意解決する（完全一致→一意な部分一致の順）。
 * 見つからない/曖昧なときはエラーメッセージを返す（log_meal / log_exercise共用）。
 */
function resolveIdByName(
  items: { id: string; name: string }[],
  name: string,
): { ok: true; id: string } | { ok: false; error: string } {
  const exact = items.filter((m) => m.name === name);
  const candidates = exact.length > 0 ? exact : items;
  if (candidates.length === 0) return { ok: false, error: `menu not found: ${name}` };
  if (candidates.length > 1) {
    return {
      ok: false,
      error: `menu name is ambiguous: ${candidates.slice(0, 5).map((m) => m.name).join(' / ')}`,
    };
  }
  return { ok: true, id: candidates[0].id };
}

const rangeShape = {
  days: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.API_MAX_RANGE_DAYS)
    .optional()
    .describe('今日を末尾とする直近N日（当日含む）。from/toとは併用不可'),
  from: z.string().optional().describe('開始日 YYYY-MM-DD（ローカル日付）'),
  to: z.string().optional().describe('終了日 YYYY-MM-DD（ローカル日付、今日以前）'),
};

function buildServer(env: Env, opts: { write: boolean }): McpServer {
  const server = new McpServer(
    { name: 'bodylog', version: MCP_SERVER_VERSION },
    { instructions: instructions(offsetHours(env)) },
  );
  server.registerTool(
    'get_weight_summary',
    {
      description: '体重データの要約（最新計測・直近7日平均・前週比・基準日比・最終同期）を返す',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guarded('get_weight_summary', async () => jsonResult(await getSummary(env))),
  );
  server.registerTool(
    'get_daily_series',
    {
      description: '日次平均と7日移動平均の時系列を返す（計測がある日のみ）',
      inputSchema: rangeShape,
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guarded('get_daily_series', async () => {
        const range = resolveRange(args, localToday(env));
        if (!range.ok) return errorResult(range.error);
        return jsonResult({ days: await getDailySeries(env, range.from, range.to) });
      }),
  );
  server.registerTool(
    'get_raw_measurements',
    {
      description: '計測1回ごとの明細を返す（新しい順、最大2000件）',
      inputSchema: rangeShape,
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guarded('get_raw_measurements', async () => {
        const range = resolveRange(args, localToday(env));
        if (!range.ok) return errorResult(range.error);
        return jsonResult({ measurements: await getRawMeasurements(env, range.from, range.to) });
      }),
  );
  server.registerTool(
    'search_menus',
    {
      description: '登録済みの食事メニュー（マスタ）を名前の部分一致で検索する。結果は利用頻度順（直近90日の記録回数→最終使用→名前）',
      inputSchema: { q: z.string().optional().describe('検索語（省略時は全件、最大500件）') },
      annotations: { readOnlyHint: true },
    },
    (args) => guarded('search_menus', async () =>
      jsonResult({ menus: await listMenus(env, { q: args.q }) })),
  );
  server.registerTool(
    'get_meal_logs',
    {
      description: '食事記録を返す（メニュー名・倍率・実効kcal/PFC付き）。daysまたはfrom/toで期間指定',
      inputSchema: rangeShape,
      annotations: { readOnlyHint: true },
    },
    (args) => guarded('get_meal_logs', async () => {
      const range = resolveRange(args, localToday(env));
      if (!range.ok) return errorResult(range.error);
      return jsonResult({ meals: await listMealLogs(env, range.from, range.to) });
    }),
  );
  server.registerTool(
    'search_exercise_menus',
    {
      description: '登録済みの運動種目（マスタ）を名前の部分一致で検索する。categoryで有酸素/筋トレを絞れる。結果は利用頻度順（直近90日の記録回数→最終使用→名前）',
      inputSchema: {
        q: z.string().optional().describe('検索語（省略時は全件、最大500件）'),
        category: z.enum(['cardio', 'strength']).optional().describe('cardio=有酸素 / strength=筋トレ'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => guarded('search_exercise_menus', async () =>
      jsonResult({ menus: await listExerciseMenus(env, { q: args.q, category: args.category }) })),
  );
  server.registerTool(
    'get_exercise_logs',
    {
      description:
        '運動記録を返す。有酸素は消費kcal（METs×体重×時間×1.05）、筋トレはセット明細と総ボリューム付き（時間を記録した筋トレは消費kcalも付く）。サーキットは親ログ（rounds・時間・kcal）と構成種目の子ログが group_id で束なって返る。daysまたはfrom/toで期間指定',
      inputSchema: rangeShape,
      annotations: { readOnlyHint: true },
    },
    (args) => guarded('get_exercise_logs', async () => {
      const range = resolveRange(args, localToday(env));
      if (!range.ok) return errorResult(range.error);
      return jsonResult({ logs: await listExerciseLogs(env, range.from, range.to) });
    }),
  );
  server.registerTool(
    'get_exercise_records',
    {
      description:
        '筋トレ種目の自己ベストを返す: max_weight（REP数問わずの最大重量）、rep_maxes（REP数ごとの最大重量）、estimated_1rm（Epley推定、reps<=12のセットから。自重種目はnull）、max_reps、max_set_volume（1セットのreps×実効重量）、max_session_volume（1回のトレーニングの総ボリューム）、last_session（前回のセット明細）。自己ベストは単独トレーニングのみ対象（サーキット内の実績は含まない）。menu_id か menu_name で種目を指定する。有酸素種目は対象外',
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
  if (opts.write) {
    server.registerTool(
      'log_meal',
      {
        description:
          '食事を記録する。menu_id か menu_name で登録済みメニューを指定する（メニューにない食事は記録できない。無ければユーザーに確認の上create_menuで登録してから記録する）',
        inputSchema: {
          menu_id: z.string().optional().describe('メニューID（search_menusで取得）'),
          menu_name: z.string().optional().describe('メニュー名（完全一致→一意な部分一致の順で解決）'),
          multiplier: z.number().positive().max(20).optional().describe('倍率（省略時1.0）'),
          eaten_at: z.string().optional().describe('食べた日時 ISO8601（省略時は現在時刻）'),
          meal_type: z.enum(['breakfast', 'lunch', 'dinner', 'snack']).optional(),
        },
      },
      (args) => guarded('log_meal', async () => {
        let menuId = args.menu_id;
        if (!menuId && args.menu_name) {
          const resolved = resolveIdByName(await listMenus(env, { q: args.menu_name }), args.menu_name);
          if (!resolved.ok) return errorResult(resolved.error);
          menuId = resolved.id;
        }
        if (!menuId) return errorResult('menu_id or menu_name is required');
        const fields = parseMealFields(args as Record<string, unknown>);
        if (!fields.ok) return errorResult(fields.error);
        const log = await logMeal(env, { menu_id: menuId, ...fields.value });
        if ('error' in log) return errorResult(log.error);
        return jsonResult(log);
      }),
    );
    server.registerTool(
      'create_menu',
      {
        description:
          '食事メニュー（マスタ）を新規登録する。ユーザーが明示的にメニュー登録を依頼したときだけ使うこと',
        inputSchema: {
          name: z.string().describe('メニュー名'),
          calories: z.number().positive().describe('1食分のkcal'),
          protein_g: z.number().positive().optional(),
          fat_g: z.number().positive().optional(),
          carbs_g: z.number().positive().optional(),
          note: z.string().optional(),
        },
      },
      (args) => guarded('create_menu', async () => {
        const parsed = parseMenuInput(args);
        if (!parsed.ok) return errorResult(parsed.error);
        return jsonResult(await createMenu(env, parsed.value));
      }),
    );
    server.registerTool(
      'log_exercise',
      {
        description:
          '運動を記録する。menu_id か menu_name で登録済み種目を指定する。有酸素は duration_min（分）、筋トレは sets（[{reps, weight_kg?}]）、サーキット種目は rounds（ラウンド数）を渡す。種目にない運動は記録できない（無ければ確認の上create_exercise_menuで登録してから）。ボリューム・消費kcal等の換算値はサーバが算出するので、クライアント側で計算・入力しない。応答の records_broken に自己ベスト更新（kind / reps / previous / current）が入る（サーキットは常に空）',
        inputSchema: {
          menu_id: z.string().optional().describe('種目ID（search_exercise_menusで取得）'),
          menu_name: z.string().optional().describe('種目名（完全一致→一意な部分一致の順で解決）'),
          performed_at: z.string().optional().describe('実施日時 ISO8601（省略時は現在時刻）'),
          note: z.string().optional(),
          duration_min: z.number().positive().max(1440).optional().describe(
            '実施時間（分）。有酸素は必須。筋トレ・サーキットは任意（種目にMETsが設定されていれば消費kcalを自動算出して記録する）',
          ),
          sets: z
            .array(z.object({
              reps: z.number().int().positive().max(1000),
              weight_kg: z.number().nonnegative().max(1000).optional(),
            }))
            .max(50)
            .optional()
            .describe(
              '筋トレ: セット明細。weight_kgは追加/バーの重量（自重種目は体重×bodyweight_factorが自動算入される。実効重量 = weight_kg + 体重×係数）。サーキット種目には渡さない（roundsを使う）',
            ),
          rounds: z.number().int().min(1).max(50).optional().describe(
            'サーキット: ラウンド数。サーバが1ラウンド=構成種目の1セットに展開し、種目別レップ・換算ボリュームを算出する。サーキット以外の種目には渡せない',
          ),
        },
      },
      (args) => guarded('log_exercise', async () => {
        let menuId = args.menu_id;
        if (!menuId && args.menu_name) {
          const resolved = resolveIdByName(
            await listExerciseMenus(env, { q: args.menu_name }),
            args.menu_name,
          );
          if (!resolved.ok) return errorResult(resolved.error);
          menuId = resolved.id;
        }
        if (!menuId) return errorResult('menu_id or menu_name is required');
        const fields = parseExerciseLogFields(args as Record<string, unknown>);
        if (!fields.ok) return errorResult(fields.error);
        const log = await logExercise(env, { menu_id: menuId, ...fields.value });
        if ('error' in log) return errorResult(log.error);
        return jsonResult(log);
      }),
    );
    server.registerTool(
      'create_exercise_menu',
      {
        description:
          '運動種目（マスタ）を新規登録する。ユーザーが明示的に種目登録を依頼したときだけ使うこと。有酸素はmets必須、筋トレは自重種目ならis_bodyweight=true（bodyweight_factorも必ず目安から指定する）。サーキット/AMRAP（例: Cindy）は既存の筋トレ種目を circuit で組み合わせて登録し、記録時は rounds を渡すだけでよい',
        inputSchema: {
          name: z.string().describe('種目名'),
          category: z.enum(['cardio', 'strength']).describe('cardio=有酸素 / strength=筋トレ（サーキットもstrength）'),
          mets: z.number().positive().max(30).optional().describe(
            '運動強度METs（安静時比）。cardioで必須。strengthでも任意で設定でき、duration_min記録時に消費kcalを自動算出する（目安: 高強度サーキット8前後、通常ウェイト3.5〜6）',
          ),
          muscle_group: z.string().optional().describe('筋トレの対象部位（任意）'),
          is_bodyweight: z.boolean().optional().describe('筋トレの自重種目（懸垂・腕立て等）。サーキット自体には付けない（構成種目側に付ける）'),
          bodyweight_factor: z.number().min(0).max(1).optional().describe(
            '自重種目の体重算入係数0〜1（実効重量 = weight_kg + 体重×係数）。自重種目は必ず目安から指定する（既定1.0=全体重は過大評価になりやすい）。目安: 懸垂0.8 / ディップス0.85 / スクワット0.4 / ランジ0.5 / 腕立て0.6 / 膝つき腕立て0.45 / コア系0.2〜0.35。アシスト付き自重は (係数×体重 − アシストkg) / 体重 で設定する（換算はこちらで行い、ユーザーにはさせない）',
          ),
          circuit: z
            .array(z.object({
              menu_id: z.string().optional().describe('構成種目のID'),
              menu_name: z.string().optional().describe('構成種目名（完全一致→一意な部分一致で解決）'),
              reps: z.number().int().min(1).max(1000).describe('1ラウンドあたりの回数'),
            }))
            .min(1)
            .max(10)
            .optional()
            .describe(
              'サーキットの1ラウンド分の構成（登録済みの自重（is_bodyweight）筋トレ種目のみ参照可、最大10種目）。構成種目が未登録なら先にcreate_exercise_menuで登録する。この定義を後から変えても過去の記録は変わらない',
            ),
          note: z.string().optional(),
        },
      },
      (args) => guarded('create_exercise_menu', async () => {
        const circuit = await resolveCircuitArg(env, args.circuit);
        if (!circuit.ok) return errorResult(circuit.error);
        const parsed = parseExerciseMenuInput({ ...args, circuit: circuit.value });
        if (!parsed.ok) return errorResult(parsed.error);
        const menu = await createExerciseMenu(env, parsed.value);
        if ('error' in menu) return errorResult(menu.error);
        return jsonResult(menu);
      }),
    );
    server.registerTool(
      'set_goal',
      {
        description:
          '目標（体重・脂肪量kg）を設定・解除する。少なくとも一方を指定し、nullでその指標の目標を解除する。ユーザーが明示的に依頼したときだけ使うこと',
        inputSchema: {
          weight_kg: z.number().nullable().optional().describe('目標体重kg（nullで解除）'),
          fat_mass_kg: z.number().nullable().optional().describe('目標脂肪量kg（nullで解除）'),
        },
      },
      (args) => guarded('set_goal', async () => {
        const parsed = parseSetGoalInput(args as Record<string, unknown>);
        if (!parsed.ok) return errorResult(parsed.error);
        return jsonResult(await setGoal(env, parsed.value));
      }),
    );
    server.registerTool(
      'log_weight',
      {
        description:
          '体重を手動記録する（体重計が無い/Withings未連携でも記録できる）。fat_ratioを渡すと除脂肪体重を導出して保存し、BMR計算にも使われる',
        inputSchema: {
          weight_kg: z.number().min(20).max(300).describe('体重kg'),
          fat_ratio: z.number().min(3).max(75).optional().describe('体脂肪率%（任意）'),
          measured_at: z.string().optional().describe('計測日時 ISO8601（省略時は現在時刻）'),
        },
      },
      (args) => guarded('log_weight', async () => {
        const parsed = parseWeightInput(args as Record<string, unknown>);
        if (!parsed.ok) return errorResult(parsed.error);
        return jsonResult(await logWeight(env, parsed.value));
      }),
    );

    // ---- 編集・削除・アーカイブ ----
    // AIが写真の読み違い等で誤登録したメニュー・記録を、ウェブアプリを開かずに直せるようにする（GitHub Issue #1）。
    // 検証・更新関数は REST（src/writes.ts）と同じものを使う
    server.registerTool(
      'update_menu',
      {
        description:
          '食事メニュー（マスタ）を編集する。指定した項目だけ更新し、protein_g / fat_g / carbs_g / note は null で消せる。過去の食事記録は記録時点のスナップショットなので変わらない。ユーザーが明示的に修正を依頼したときだけ使うこと',
        inputSchema: {
          menu_id: z.string().describe('メニューID（search_menusで取得）'),
          name: z.string().optional().describe('メニュー名'),
          calories: z.number().positive().optional().describe('1食分のkcal'),
          protein_g: z.number().positive().nullable().optional(),
          fat_g: z.number().positive().nullable().optional(),
          carbs_g: z.number().positive().nullable().optional(),
          note: z.string().nullable().optional(),
        },
      },
      (args) => guarded('update_menu', async () => {
        const { menu_id, ...patch } = args;
        const parsed = parseMenuPatch(patch);
        if (!parsed.ok) return errorResult(parsed.error);
        const menu = await updateMenu(env, menu_id, parsed.value);
        return menu ? jsonResult(menu) : errorResult('menu not found');
      }),
    );
    server.registerTool(
      'archive_menu',
      {
        description:
          '食事メニューをアーカイブする（一覧・検索から非表示。過去の記録は残る）。archived=false で元に戻す。ユーザーが明示的に依頼したときだけ使い、実行前に対象のメニュー名を確認すること',
        inputSchema: {
          menu_id: z.string().describe('メニューID（search_menusで取得）'),
          archived: z.boolean().optional().describe('省略時 true（アーカイブ）。false で復元'),
        },
        annotations: { destructiveHint: true },
      },
      (args) => guarded('archive_menu', async () => {
        const archived = args.archived ?? true;
        if (!(await setMenuArchived(env, args.menu_id, archived))) return errorResult('menu not found');
        return jsonResult({ ok: true, menu_id: args.menu_id, archived });
      }),
    );
    server.registerTool(
      'update_meal_log',
      {
        description:
          '食事記録を編集する（倍率・食べた日時・食事区分）。メニュー自体を変えたい場合は delete_meal_log で消して log_meal し直す。ユーザーが明示的に修正を依頼したときだけ使うこと',
        inputSchema: {
          meal_id: z.string().describe('食事記録ID（get_meal_logsで取得）'),
          multiplier: z.number().positive().max(20).optional().describe('倍率'),
          eaten_at: z.string().optional().describe('食べた日時 ISO8601'),
          meal_type: z.enum(['breakfast', 'lunch', 'dinner', 'snack']).optional(),
        },
      },
      (args) => guarded('update_meal_log', async () => {
        const { meal_id, ...rest } = args;
        const fields = parseMealFields(rest as Record<string, unknown>);
        if (!fields.ok) return errorResult(fields.error);
        if (Object.keys(fields.value).length === 0) return errorResult('no fields to update');
        const log = await updateMealLog(env, meal_id, fields.value);
        return log ? jsonResult(log) : errorResult('meal log not found');
      }),
    );
    server.registerTool(
      'delete_meal_log',
      {
        description:
          '食事記録を1件削除する。ユーザーが明示的に依頼したときだけ使い、実行前に対象（メニュー名・日時）を確認すること',
        inputSchema: { meal_id: z.string().describe('食事記録ID（get_meal_logsで取得）') },
        annotations: { destructiveHint: true },
      },
      (args) => guarded('delete_meal_log', async () =>
        (await deleteMealLog(env, args.meal_id))
          ? jsonResult({ ok: true, meal_id: args.meal_id })
          : errorResult('meal log not found')),
    );
    server.registerTool(
      'update_exercise_menu',
      {
        description:
          '運動種目（マスタ）を編集する。指定した項目だけ更新し、mets / muscle_group / circuit / note は null で消せる。category は変更できない（作り直す）。過去の運動記録は記録時点のスナップショットなので変わらない。ユーザーが明示的に修正を依頼したときだけ使うこと',
        inputSchema: {
          menu_id: z.string().describe('種目ID（search_exercise_menusで取得）'),
          name: z.string().optional().describe('種目名'),
          mets: z.number().positive().max(30).nullable().optional().describe(
            '運動強度METs。strengthでも設定でき、duration_min記録時に消費kcalを自動算出する',
          ),
          muscle_group: z.string().nullable().optional().describe('筋トレの対象部位'),
          is_bodyweight: z.boolean().optional().describe('筋トレの自重種目か'),
          bodyweight_factor: z.number().min(0).max(1).nullable().optional().describe(
            '自重種目の体重算入係数0〜1（null で既定1.0）。目安: 懸垂0.8 / ディップス0.85 / スクワット0.4 / ランジ0.5 / 腕立て0.6 / コア系0.2〜0.35',
          ),
          circuit: z
            .array(z.object({
              menu_id: z.string().optional().describe('構成種目のID'),
              menu_name: z.string().optional().describe('構成種目名（完全一致→一意な部分一致で解決）'),
              reps: z.number().int().min(1).max(1000).describe('1ラウンドあたりの回数'),
            }))
            .min(1)
            .max(10)
            .nullable()
            .optional()
            .describe('サーキット構成の差し替え（nullでサーキット構成を外して通常種目に戻す）。過去の記録は変わらない'),
          note: z.string().nullable().optional(),
        },
      },
      (args) => guarded('update_exercise_menu', async () => {
        const { menu_id, circuit: circuitArg, ...patch } = args;
        const circuit = await resolveCircuitArg(env, circuitArg ?? undefined);
        if (!circuit.ok) return errorResult(circuit.error);
        const parsed = parseExerciseMenuPatch(
          circuitArg === undefined ? patch : { ...patch, circuit: circuitArg === null ? null : circuit.value },
        );
        if (!parsed.ok) return errorResult(parsed.error);
        const menu = await updateExerciseMenu(env, menu_id, parsed.value);
        if (menu && 'error' in menu) return errorResult(menu.error);
        return menu ? jsonResult(menu) : errorResult('menu not found');
      }),
    );
    server.registerTool(
      'archive_exercise_menu',
      {
        description:
          '運動種目をアーカイブする（一覧・検索から非表示。過去の記録は残る）。archived=false で元に戻す。ユーザーが明示的に依頼したときだけ使い、実行前に対象の種目名を確認すること',
        inputSchema: {
          menu_id: z.string().describe('種目ID（search_exercise_menusで取得）'),
          archived: z.boolean().optional().describe('省略時 true（アーカイブ）。false で復元'),
        },
        annotations: { destructiveHint: true },
      },
      (args) => guarded('archive_exercise_menu', async () => {
        const archived = args.archived ?? true;
        if (!(await setExerciseMenuArchived(env, args.menu_id, archived))) return errorResult('menu not found');
        return jsonResult({ ok: true, menu_id: args.menu_id, archived });
      }),
    );
    server.registerTool(
      'delete_exercise_log',
      {
        description:
          '運動記録を1件削除する（セット明細ごと）。サーキットの親ログID（group_idが自身のidと一致する行）を指定するとグループ全体（構成種目の子ログ含む）が削除される。運動記録は編集できないので、直したいときは削除して log_exercise し直す。ユーザーが明示的に依頼したときだけ使い、実行前に対象（種目名・日時）を確認すること',
        inputSchema: { log_id: z.string().describe('運動記録ID（get_exercise_logsで取得）') },
        annotations: { destructiveHint: true },
      },
      (args) => guarded('delete_exercise_log', async () =>
        (await deleteExerciseLog(env, args.log_id))
          ? jsonResult({ ok: true, log_id: args.log_id })
          : errorResult('exercise log not found')),
    );
    server.registerTool(
      'delete_weight',
      {
        description:
          'log_weight で手動記録した体重を1件削除する（Withings由来の計測は削除できない）。ユーザーが明示的に依頼したときだけ使い、実行前に対象（日時・値）を確認すること',
        inputSchema: { id: z.number().int().describe('計測ID（get_raw_measurements の id。source が manual の行のみ）') },
        annotations: { destructiveHint: true },
      },
      (args) => guarded('delete_weight', async () =>
        (await deleteManualMeasurement(env, args.id))
          ? jsonResult({ ok: true, id: args.id })
          : errorResult('manual measurement not found')),
    );
  }
  return server;
}

function rpcError(c: Context<{ Bindings: Env }>, code: number, message: string): Response {
  return c.json({ jsonrpc: '2.0', error: { code, message }, id: null }, 400, noindexHeaders());
}

function withNoindex(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(noindexHeaders())) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

async function dispatchToTransport(
  c: Context<{ Bindings: Env }>,
  body: unknown,
  write: boolean,
): Promise<Response> {
  const server = buildServer(c.env, { write });
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const res = await transport.handleRequest(c, body);
  // ステートレスPOST処理では必ずResponseが返る想定。念のためのフォールバック
  if (!res) return c.text('not found', 404, noindexHeaders());
  return withNoindex(res);
}

/**
 * Streamable HTTPのMCPリクエストを処理する。POSTのレスポンスはJSON
 * （enableJsonResponse）にして、SSE非対応のクライアントとテストを単純にする。
 * ステートレス構成でサーバー発信メッセージは無いため、POST以外は405で受けない
 * （MCP仕様: GETのSSEを提供しないサーバーは405を返してよい）。
 */
export async function handleMcpRequest(
  c: Context<{ Bindings: Env }>,
  opts?: { write?: boolean },
): Promise<Response> {
  const write = opts?.write ?? false;
  if (c.req.method !== 'POST') {
    return c.text('method not allowed', 405, noindexHeaders({ Allow: 'POST' }));
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return rpcError(c, -32700, 'Parse error');
  }
  // JSON-RPCバッチは受けない（MCP 2025-06-18で廃止済み。D1クエリ増幅の防止）
  if (Array.isArray(body)) {
    return rpcError(c, -32600, 'JSON-RPC batch requests are not supported');
  }
  // クライアント互換性問題の切り分け用（bodyはtailに出ないため、メソッドとツール名だけ残す）
  if (typeof body === 'object' && body !== null) {
    const b = body as { method?: unknown; params?: { name?: unknown } };
    console.log('[mcp] request', String(b.method ?? '?'), String(b.params?.name ?? ''));
  }
  // 認証済み書き込みの到着時にpublic_originを初期化する（/api/*側と同じ。Withings無し運用の通知起点）
  if (write) {
    c.executionCtx.waitUntil(
      ensurePublicOrigin(c.env, new URL(c.req.url).origin).catch((err) =>
        console.error('[mcp] ensurePublicOrigin failed', err),
      ),
    );
  }
  try {
    // ChatGPT（openai-mcp）等はSDK未対応の新しいMCP-Protocol-Versionヘッダを
    // 交渉前から送り、@hono/mcpはそれをヘッダ検証404でthrowする。未対応版は
    // ヘッダを外し、initialize本文でのバージョン交渉（サーバー対応版への
    // ダウングレード）に任せる
    const protocolVersion = c.req.header('mcp-protocol-version');
    if (protocolVersion !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
      const headers = new Headers(c.req.raw.headers);
      headers.delete('mcp-protocol-version');
      const inner = new Hono<{ Bindings: Env }>()
        .post('*', (ic) => dispatchToTransport(ic, body, write))
        .onError((err, ic) => {
          if (err instanceof HTTPException) return withNoindex(err.getResponse());
          console.error('[mcp] transport error', err);
          return ic.text('internal error', 500, noindexHeaders());
        });
      return await inner.fetch(
        new Request(c.req.url, { method: 'POST', headers, body: JSON.stringify(body) }),
        c.env,
        c.executionCtx,
      );
    }
    return await dispatchToTransport(c, body, write);
  } catch (err) {
    // @hono/mcpは検証エラー（Accept/Content-Type/セッション等）をHTTPExceptionで
    // throwする。グローバルonErrorに渡すと500になるため、本来の4xxで返す
    if (err instanceof HTTPException) return withNoindex(err.getResponse());
    throw err;
  }
}
