/**
 * AI向けの機械可読ドキュメント（llms.txt / OpenAPI）。
 * URLはリクエストのオリジンから実行時に組み立て、実環境の値をコードに持たない。
 */
import { LIMITS } from './util';

/** origin + base からAPIのベースURL（末尾スラッシュなし）を作る */
function apiRoot(origin: string, base: string): string {
  return `${origin}${base.replace(/\/$/, '')}`;
}

export function llmsTxt(origin: string, base: string, tzOffsetHours: number): string {
  const root = apiRoot(origin, base);
  return `# bodylog

個人の体重・体組成（Withings体重計、1ユーザー分）・食事・運動を記録しているサービスのAPI。
REST（GET）はすべて読み取り専用・認証不要。書き込みは /mcp（OAuth 2.1）のみ。

## データの読み方

- 単位: 質量（weight / fat_mass / fat_free_mass）はkg、fat_ratioのみ%
- fat_mass（脂肪量）は weight - fat_free_mass から導出した値
- 日付の境界はUTC${tzOffsetHours >= 0 ? '+' : ''}${tzOffsetHours} のローカル日付
- 期間指定は days=N（今日を末尾とする直近N日、当日含む）か from/to=YYYY-MM-DD。併用不可、最大${LIMITS.API_MAX_RANGE_DAYS}日
- 日次PFC合計（protein_g/fat_g/carbs_g）は栄養素が入力済みの記録のみの合計（未入力の記録は含まれない）。caloriesは全記録の合計
- PFCはグラム数。比率を出すときは P×4 / F×9 / C×4 kcal に換算し、3者の合計を100%として正規化する。登録カロリーで割らないこと（食物繊維等の差で換算合計と登録kcalは一致せず、100%を超えうる）

## エンドポイント

- GET ${root}/api/summary — 最新計測・直近7日平均・前週比・基準日比・今日の食事摂取量・目標（goal）の要約。まずこれを見る
- GET ${root}/api/measurements?days=90 — 日次平均と7日移動平均の時系列
- GET ${root}/api/raw?days=30 — 計測1回ごとの明細（新しい順、最大2000件）
- GET ${root}/api/status — データ同期状態（最終同期・最新計測日時）
- GET ${root}/api/menus?q= — 食事メニュー（マスタ）一覧・検索（利用頻度順）
- GET ${root}/api/meals?days=7 — 食事記録（メニュー名・倍率・実効kcal/PFC付き）
- GET ${root}/api/meals/daily?days=30 — 日次の摂取カロリー・PFC合計
- GET ${root}/api/exercise/menus?q=&category= — 運動種目（マスタ）一覧・検索（利用頻度順）。category=cardio|strengthで絞れる
- GET ${root}/api/exercise/logs?days=30 — 運動記録（有酸素は消費kcal、筋トレはセット明細・総ボリューム付き）
- GET ${root}/api/exercise/daily?days=30 — 日次の基礎代謝（Katch-McArdle推定）・運動消費kcal・総ボリューム。期間内の全日を返す
- GET ${root}/api/coaching/latest — AIコーチの最新講評（daily=日次 / weekly=週次。未生成はnull）
- GET ${root}/api/coaching?days=30 — AIコーチ講評の履歴（新しい順、最大200件）
- GET ${root}/api/metabolism — 直近28日の実測データからの実効消費カロリー推定（摂取記録が8割未満の期間はinsufficient_data）
- GET ${root}/openapi.json — このAPIのOpenAPI 3.1定義（ChatGPTカスタムGPTのActionsにはこれを登録する）
- POST ${root}/mcp — MCP（Model Context Protocol）エンドポイント。OAuth 2.1（Streamable HTTP）。読み取り＋書き込みツール

## 例

- 最近の推移の要約: ${root}/api/summary
- 直近90日の時系列: ${root}/api/measurements?days=90
- 特定期間の時系列: ${root}/api/measurements?from=2026-01-01&to=2026-03-31
`;
}

const metricTripleSchema = {
  type: 'object',
  description: '体重・脂肪量・除脂肪量の組（kg）。算出不能な値はnull',
  properties: {
    weight: { type: ['number', 'null'] },
    fat_mass: { type: ['number', 'null'] },
    fat_free_mass: { type: ['number', 'null'] },
  },
} as const;

export function openapiSpec(
  origin: string,
  base: string,
  tzOffsetHours: number,
): Record<string, unknown> {
  const rangeParams = [
    {
      name: 'days',
      in: 'query',
      required: false,
      description: `今日を末尾とする直近N日（当日含む、1〜${LIMITS.API_MAX_RANGE_DAYS}）。from/toとは併用不可`,
      schema: { type: 'integer', minimum: 1, maximum: LIMITS.API_MAX_RANGE_DAYS },
    },
    {
      name: 'from',
      in: 'query',
      required: false,
      description: '開始日 YYYY-MM-DD（ローカル日付）。daysを使わない場合はfrom/toの両方が必須',
      schema: { type: 'string', format: 'date' },
    },
    {
      name: 'to',
      in: 'query',
      required: false,
      description: '終了日 YYYY-MM-DD（ローカル日付、今日以前）',
      schema: { type: 'string', format: 'date' },
    },
  ];
  const errorResponse = {
    description: 'バリデーションエラー',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: { error: { type: 'string' } },
          required: ['error'],
        },
      },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'bodylog API',
      version: '1.0.0',
      description:
        `個人の体重・体組成（Withings体重計、1ユーザー分）・食事・運動の読み取り専用API。認証不要。` +
        `質量の単位はkg（fat_ratioのみ%）。fat_massは weight - fat_free_mass の導出値。` +
        `日付の境界はUTC${tzOffsetHours >= 0 ? '+' : ''}${tzOffsetHours}のローカル日付。`,
    },
    servers: [{ url: apiRoot(origin, base) }],
    paths: {
      '/api/summary': {
        get: {
          operationId: 'getWeightSummary',
          summary: '体重データの要約（最新計測・直近7日平均・前週比・基準日比・今日の食事摂取量）',
          responses: {
            '200': {
              description: '要約',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      as_of: { type: 'string', format: 'date-time' },
                      units: { type: 'object' },
                      timezone_offset_hours: { type: 'number' },
                      latest: {
                        oneOf: [{ $ref: '#/components/schemas/Measurement' }, { type: 'null' }],
                      },
                      recent7_avg: { $ref: '#/components/schemas/MetricTriple' },
                      diff_vs_prev7: { $ref: '#/components/schemas/MetricTriple' },
                      baseline: {
                        type: 'object',
                        properties: {
                          date: { type: ['string', 'null'], format: 'date' },
                          diff: { $ref: '#/components/schemas/MetricTriple' },
                        },
                      },
                      last_sync_at: { type: ['string', 'null'], format: 'date-time' },
                      intake_today: {
                        oneOf: [{ $ref: '#/components/schemas/DailyIntake' }, { type: 'null' }],
                      },
                      goal: {
                        type: 'object',
                        description: '目標（体重・脂肪量kg）。未設定の指標はnull',
                        properties: {
                          weight_kg: { type: ['number', 'null'] },
                          fat_mass_kg: { type: ['number', 'null'] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/measurements': {
        get: {
          operationId: 'getDailySeries',
          summary: '日次平均と7日移動平均の時系列（計測がある日のみ）',
          parameters: rangeParams,
          responses: {
            '200': {
              description: '日次時系列',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      days: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/DayPoint' },
                      },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
          },
        },
      },
      '/api/raw': {
        get: {
          operationId: 'getRawMeasurements',
          summary: '計測1回ごとの明細（新しい順、最大2000件）',
          parameters: rangeParams,
          responses: {
            '200': {
              description: '計測明細',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      measurements: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Measurement' },
                      },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
          },
        },
      },
      '/api/status': {
        get: {
          operationId: 'getStatus',
          summary: 'データ同期状態（初期インポート状況・最終同期・最新計測日時）',
          responses: {
            '200': {
              description: '同期状態',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      import_status: { type: ['string', 'null'] },
                      import_error: { type: ['string', 'null'] },
                      last_sync_at: { type: ['string', 'null'], format: 'date-time' },
                      latest_measured_at: { type: ['string', 'null'], format: 'date-time' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/menus': {
        get: {
          operationId: 'getMenus',
          summary: '食事メニュー（マスタ）一覧・検索（利用頻度順: 直近90日の記録回数→最終使用→名前）',
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: false,
              description: 'メニュー名の部分一致検索',
              schema: { type: 'string' },
            },
            {
              name: 'archived',
              in: 'query',
              required: false,
              description: '1を指定するとアーカイブ済みメニューも含める（既定は除外）',
              schema: { type: 'string', enum: ['0', '1'] },
            },
          ],
          responses: {
            '200': {
              description: 'メニュー一覧（最大500件）',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      menus: { type: 'array', items: { $ref: '#/components/schemas/Menu' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/meals': {
        get: {
          operationId: 'getMealLogs',
          summary: '食事記録（メニュー名・倍率・実効kcal/PFC付き、新しい順、最大2000件）',
          parameters: rangeParams,
          responses: {
            '200': {
              description: '食事記録一覧',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      meals: { type: 'array', items: { $ref: '#/components/schemas/MealLog' } },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
          },
        },
      },
      '/api/meals/daily': {
        get: {
          operationId: 'getDailyIntake',
          summary: '日次の摂取カロリー・PFC合計',
          parameters: rangeParams,
          responses: {
            '200': {
              description: '日次摂取量の時系列',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      days: { type: 'array', items: { $ref: '#/components/schemas/DailyIntake' } },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
          },
        },
      },
      '/api/exercise/menus': {
        get: {
          operationId: 'getExerciseMenus',
          summary: '運動種目（マスタ）一覧・検索（利用頻度順: 直近90日の記録回数→最終使用→名前）',
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: false,
              description: '種目名の部分一致検索',
              schema: { type: 'string' },
            },
            {
              name: 'category',
              in: 'query',
              required: false,
              description: 'cardio=有酸素 / strength=筋トレ で絞る',
              schema: { type: 'string', enum: ['cardio', 'strength'] },
            },
            {
              name: 'archived',
              in: 'query',
              required: false,
              description: '1を指定するとアーカイブ済みも含める（既定は除外）',
              schema: { type: 'string', enum: ['0', '1'] },
            },
          ],
          responses: {
            '200': {
              description: '種目一覧（最大500件）',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      menus: { type: 'array', items: { $ref: '#/components/schemas/ExerciseMenu' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/exercise/logs': {
        get: {
          operationId: 'getExerciseLogs',
          summary: '運動記録（有酸素は消費kcal、筋トレはセット明細・総ボリューム付き、新しい順、最大2000件）',
          parameters: rangeParams,
          responses: {
            '200': {
              description: '運動記録一覧',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      logs: { type: 'array', items: { $ref: '#/components/schemas/ExerciseLog' } },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
          },
        },
      },
      '/api/exercise/daily': {
        get: {
          operationId: 'getDailyExercise',
          summary: '日次の基礎代謝（Katch-McArdle推定）・運動消費kcal・総ボリューム（期間内の全日を返す）',
          parameters: rangeParams,
          responses: {
            '200': {
              description: '日次運動量の時系列',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      days: { type: 'array', items: { $ref: '#/components/schemas/DailyExercise' } },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
          },
        },
      },
      '/api/metabolism': {
        get: {
          operationId: 'getMetabolism',
          summary:
            '直近28日の実測データからの実効消費カロリー推定（推定TDEE・モデル比の補正値）。' +
            '摂取記録が8割未満・体重7日平均が両端で取れない・実日数14日未満のときは insufficient_data',
          responses: {
            '200': {
              description: '実効代謝の推定（7700kcal/kg換算の近似。体組成変化が混ざるとブレる参考値）',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['ok', 'insufficient_data'] },
                      window_days: { type: 'integer' },
                      span_days: { type: 'integer' },
                      intake_days: { type: 'integer' },
                      avg_intake_kcal: { type: 'number' },
                      weight_change_kg: { type: 'number' },
                      estimated_tdee_kcal: { type: 'number' },
                      model_tdee_kcal: { type: ['number', 'null'] },
                      correction_kcal_per_day: { type: ['number', 'null'] },
                      reason: {
                        type: 'string',
                        enum: ['intake_coverage', 'no_weight_avg', 'short_span'],
                      },
                    },
                    required: ['status', 'window_days'],
                  },
                },
              },
            },
          },
        },
      },
      '/api/coaching': {
        get: {
          operationId: 'listCoachingNotes',
          summary: 'AIコーチ講評の履歴（新しい順、最大200件）',
          parameters: rangeParams,
          responses: {
            '200': {
              description: '講評一覧',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      notes: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/CoachingNote' },
                      },
                    },
                  },
                },
              },
            },
            '400': errorResponse,
          },
        },
      },
      '/api/coaching/latest': {
        get: {
          operationId: 'getLatestCoaching',
          summary: 'AIコーチの最新講評（daily=日次 / weekly=週次。未生成はnull）',
          responses: {
            '200': {
              description: '各kindの最新講評',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      daily: {
                        oneOf: [{ $ref: '#/components/schemas/CoachingNote' }, { type: 'null' }],
                      },
                      weekly: {
                        oneOf: [{ $ref: '#/components/schemas/CoachingNote' }, { type: 'null' }],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        MetricTriple: metricTripleSchema,
        DayPoint: {
          type: 'object',
          description: '1日分の日次平均と7日移動平均（kg）',
          properties: {
            d: { type: 'string', format: 'date' },
            weight: { type: ['number', 'null'] },
            fat_mass: { type: ['number', 'null'] },
            fat_free_mass: { type: ['number', 'null'] },
            weight_7d_avg: { type: ['number', 'null'] },
            fat_mass_7d_avg: { type: ['number', 'null'] },
            fat_free_mass_7d_avg: { type: ['number', 'null'] },
          },
        },
        Measurement: {
          type: 'object',
          description: '計測1回分。質量はkg、fat_ratioは%',
          properties: {
            measured_at: { type: 'string', format: 'date-time' },
            weight: { type: ['number', 'null'] },
            fat_mass: { type: ['number', 'null'] },
            fat_free_mass: { type: ['number', 'null'] },
            fat_ratio: { type: ['number', 'null'] },
          },
        },
        Menu: {
          type: 'object',
          description: '食事メニュー（マスタ）。1食分のカロリー・PFCを保持する',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            calories: { type: 'number' },
            protein_g: { type: ['number', 'null'] },
            fat_g: { type: ['number', 'null'] },
            carbs_g: { type: ['number', 'null'] },
            note: { type: ['string', 'null'] },
            archived: { type: 'boolean' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        MealLog: {
          type: 'object',
          description:
            '食事記録1件。menu_name/calories/protein_g/fat_g/carbs_gは記録時点のメニュー値のスナップショット。' +
            'effective_*はmultiplierを乗じた実効値',
          properties: {
            id: { type: 'string' },
            menu_id: { type: 'string' },
            eaten_at: { type: 'string', format: 'date-time' },
            meal_type: { type: ['string', 'null'], enum: ['breakfast', 'lunch', 'dinner', 'snack', null] },
            multiplier: { type: 'number' },
            menu_name: { type: 'string' },
            calories: { type: 'number' },
            protein_g: { type: ['number', 'null'] },
            fat_g: { type: ['number', 'null'] },
            carbs_g: { type: ['number', 'null'] },
            created_at: { type: 'string', format: 'date-time' },
            effective_calories: { type: 'number' },
            effective_protein_g: { type: ['number', 'null'] },
            effective_fat_g: { type: ['number', 'null'] },
            effective_carbs_g: { type: ['number', 'null'] },
          },
        },
        DailyIntake: {
          type: 'object',
          description:
            '1日分の食事摂取量の合計。caloriesは全記録の合計。' +
            'protein_g/fat_g/carbs_gは栄養素が入力済みの記録のみの部分合計（未入力の記録は含まれない）。' +
            'PFC比率はP×4/F×9/C×4kcalに換算し3者内で正規化して算出する（caloriesで割ると食物繊維等の差で100%を超えうるため不可）',
          properties: {
            d: { type: 'string', format: 'date' },
            count: { type: 'integer' },
            calories: { type: 'number' },
            protein_g: { type: ['number', 'null'] },
            fat_g: { type: ['number', 'null'] },
            carbs_g: { type: ['number', 'null'] },
          },
        },
        ExerciseMenu: {
          type: 'object',
          description: '運動種目（マスタ）。cardioはmets、strengthはmuscle_group/is_bodyweightを持つ',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            category: { type: 'string', enum: ['cardio', 'strength'] },
            mets: { type: ['number', 'null'], description: '有酸素の運動強度（安静時比）' },
            muscle_group: { type: ['string', 'null'] },
            is_bodyweight: { type: 'boolean' },
            bodyweight_factor: {
              type: 'number',
              description: '自重種目のボリューム補正係数0〜1（実効重量=追加重量+体重×係数。既定1.0）',
            },
            note: { type: ['string', 'null'] },
            archived: { type: 'boolean' },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        ExerciseSet: {
          type: 'object',
          description:
            '筋トレ1セット。effective_weight_kgは自重種目なら記録時の体重×bodyweight_factorを加算した実効重量、volume=reps×実効重量',
          properties: {
            set_index: { type: 'integer' },
            reps: { type: 'integer' },
            weight_kg: { type: ['number', 'null'] },
            effective_weight_kg: { type: 'number' },
            volume: { type: 'number' },
          },
        },
        ExerciseLog: {
          type: 'object',
          description:
            '運動記録1件。menu_name等は記録時点のスナップショット。cardioはduration_min/mets/caloriesを持ち、' +
            'strengthはsets（明細）とtotal_volume（総ボリューム）を持つ。caloriesは METs×体重×時間 の推定消費kcal',
          properties: {
            id: { type: 'string' },
            menu_id: { type: 'string' },
            performed_at: { type: 'string', format: 'date-time' },
            category: { type: 'string', enum: ['cardio', 'strength'] },
            menu_name: { type: 'string' },
            note: { type: ['string', 'null'] },
            is_bodyweight: { type: 'boolean' },
            bodyweight_factor: { type: 'number' },
            duration_min: { type: ['number', 'null'] },
            mets: { type: ['number', 'null'] },
            body_weight_kg: { type: ['number', 'null'] },
            calories: { type: ['number', 'null'] },
            created_at: { type: 'string', format: 'date-time' },
            sets: { type: 'array', items: { $ref: '#/components/schemas/ExerciseSet' } },
            total_volume: { type: ['number', 'null'] },
          },
        },
        CoachingNote: {
          type: 'object',
          description:
            'AIコーチの講評1件。kind=daily（前日分のライト講評）| weekly（週次の深掘り総括）。' +
            'dateは生成対象のローカル日付、contentは講評本文',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: ['daily', 'weekly'] },
            date: { type: 'string', format: 'date' },
            content: { type: 'string' },
            model: { type: ['string', 'null'] },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        DailyExercise: {
          type: 'object',
          description:
            '1日分のエネルギー・運動量。bmrはKatch-McArdle（370 + 21.6×除脂肪体重）による基礎代謝の推定kcal' +
            '（その日以前で最新の実測FFMを使用。実測が無い期間はnull。日常活動・食事誘発熱産生は含まない）。' +
            'calories_burnedは有酸素の消費kcal合計、strength_volumeは筋トレの総ボリューム合計（該当なしはnull）。' +
            '総消費 = bmr + calories_burned',
          properties: {
            d: { type: 'string', format: 'date' },
            bmr: { type: ['number', 'null'] },
            calories_burned: { type: ['number', 'null'] },
            strength_volume: { type: ['number', 'null'] },
            cardio_count: { type: 'integer' },
            strength_count: { type: 'integer' },
          },
        },
      },
    },
  };
}
