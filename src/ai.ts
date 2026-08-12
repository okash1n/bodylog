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
  return `# Withings Weight Tracker

個人の体重・体組成（Withings体重計、1ユーザー分）を記録・公開しているサービスのAPI。
すべて読み取り専用・認証不要。

## データの読み方

- 単位: 質量（weight / fat_mass / fat_free_mass）はkg、fat_ratioのみ%
- fat_mass（脂肪量）は weight - fat_free_mass から導出した値
- 日付の境界はUTC${tzOffsetHours >= 0 ? '+' : ''}${tzOffsetHours} のローカル日付
- 期間指定は days=N（今日を末尾とする直近N日、当日含む）か from/to=YYYY-MM-DD。併用不可、最大${LIMITS.API_MAX_RANGE_DAYS}日

## エンドポイント

- GET ${root}/api/summary — 最新計測・直近7日平均・前週比・基準日比の要約。まずこれを見る
- GET ${root}/api/measurements?days=90 — 日次平均と7日移動平均の時系列
- GET ${root}/api/raw?days=30 — 計測1回ごとの明細（新しい順、最大2000件）
- GET ${root}/api/status — データ同期状態（最終同期・最新計測日時）
- GET ${root}/openapi.json — このAPIのOpenAPI 3.1定義（ChatGPTカスタムGPTのActionsにはこれを登録する）
- POST ${root}/mcp — MCP（Model Context Protocol）エンドポイント。Streamable HTTP・認証なし

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
      title: 'Withings Weight Tracker API',
      version: '1.0.0',
      description:
        `個人の体重・体組成（Withings体重計、1ユーザー分）の読み取り専用API。認証不要。` +
        `質量の単位はkg（fat_ratioのみ%）。fat_massは weight - fat_free_mass の導出値。` +
        `日付の境界はUTC${tzOffsetHours >= 0 ? '+' : ''}${tzOffsetHours}のローカル日付。`,
    },
    servers: [{ url: apiRoot(origin, base) }],
    paths: {
      '/api/summary': {
        get: {
          operationId: 'getWeightSummary',
          summary: '体重データの要約（最新計測・直近7日平均・前週比・基準日比）',
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
      },
    },
  };
}
