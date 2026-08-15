import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import {
  formatBurnLine,
  formatExerciseLine,
  formatIntakeLine,
  formatNetLine,
  immediateDestinations,
  parseDestinations,
  parseDigestTime,
  runDailyDigest,
  runDailyDigestIfDue,
} from '../src/slack';
import type { DailyExercise, DailyIntake } from '../src/types';
import { createMenu, logMeal } from '../src/meals';
import { createExerciseMenu, logExercise } from '../src/exercise';
import { upsertCoachingNote } from '../src/coaching';
import { offsetHours, ymdWithOffset } from '../src/util';
import { insertMeasurement, resetTables, setSetting, stubFetch, testEnv } from './helpers';

const SLACK_HOST = 'hooks.slack.com';
const SLACK_PATH = '/services/T0/B0/X';
const ORIGIN = 'https://origin.example';

function envWith(webhooks: string): Env {
  return { ...testEnv, SLACK_WEBHOOKS: webhooks };
}

const DAILY_ENV = envWith('[{"id":"night","url":"https://hooks.slack.com/services/T0/B0/X","mode":"daily"}]');

describe('通知モード', () => {
  it('mode省略はimmediate扱い・不正modeはthrow', () => {
    expect(parseDestinations(testEnv)[0].mode).toBe('immediate');
    expect(() =>
      parseDestinations(envWith('[{"id":"a","url":"https://hooks.slack.com/x","mode":"hourly"}]')),
    ).toThrow();
  });

  it('immediateDestinations は daily を除外し immediate/both を含む', () => {
    const env = envWith(
      '[{"id":"a","url":"https://hooks.slack.com/a"},{"id":"b","url":"https://hooks.slack.com/b","mode":"daily"},{"id":"c","url":"https://hooks.slack.com/c","mode":"both"}]',
    );
    expect(immediateDestinations(env).map((d) => d.id)).toEqual(['a', 'c']);
  });
});

describe('runDailyDigest', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('当日の計測があればダイジェストを1通送り、再実行しても二重送信しない', async () => {
    await insertMeasurement({
      grpid: 9001,
      measured_at: new Date().toISOString(),
      weight: 82.9,
      fat_free_mass: 62.0,
    });
    const stub = stubFetch().on({
      host: SLACK_HOST,
      path: SLACK_PATH,
      method: 'POST',
      times: 1,
      reply: () => new Response('ok'),
    });

    const first = await runDailyDigest(DAILY_ENV, ORIGIN);
    expect(first.queued).toBe(1);
    const posts = stub.requests({ host: SLACK_HOST });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain('日次サマリー');
    expect(posts[0].body).toContain('計測 1 回');
    expect(posts[0].body).toContain('82.9 kg');
    expect(posts[0].body).toContain('20.9 kg'); // 脂肪量 = 82.9 - 62.0
    expect(posts[0].body).toContain('og.png?v=');

    // 同日再実行はUNIQUE制約で投入0（送信もされない）
    const second = await runDailyDigest(DAILY_ENV, ORIGIN);
    expect(second.queued).toBe(0);
    expect(stub.requests({ host: SLACK_HOST })).toHaveLength(1);
  });

  it('当日の摂取・消費（基礎+運動）・ネットがダイジェスト本文に載る（E2E配線の検証）', async () => {
    // FFM 62 → BMR = 370 + 21.6×62 = 1709.2
    await insertMeasurement({
      grpid: 9301,
      measured_at: new Date().toISOString(),
      weight: 80,
      fat_free_mass: 62.0,
    });
    const menu = await createMenu(testEnv, { name: 'テスト定食', calories: 700 });
    await logMeal(testEnv, { menu_id: menu.id });
    const ex = await createExerciseMenu(testEnv, { name: 'ラン', category: 'cardio', mets: 8 });
    await logExercise(testEnv, { menu_id: ex.id, duration_min: 30 }); // 8×80×0.5×1.05 = 336
    const stub = stubFetch().on({
      host: SLACK_HOST,
      path: SLACK_PATH,
      method: 'POST',
      times: 1,
      reply: () => new Response('ok'),
    });

    await runDailyDigest(DAILY_ENV, ORIGIN);
    const body = stub.requests({ host: SLACK_HOST })[0].body;
    expect(body).toContain('*摂取* : 700 kcal');
    expect(body).toContain('*消費* : 2045 kcal (基礎 1709 + 運動 336)');
    expect(body).toContain('*カロリー収支* : -1345 kcal');
  });

  it('当日のAI講評が保存済みならダイジェスト本文に差し込まれる', async () => {
    await insertMeasurement({
      grpid: 9401,
      measured_at: new Date().toISOString(),
      weight: 82.0,
      fat_free_mass: 62.0,
    });
    await upsertCoachingNote(testEnv, {
      kind: 'daily',
      date: ymdWithOffset(new Date().toISOString(), offsetHours(testEnv)),
      content: '今日の総括テスト。明日はタンパク質を増やす。',
      model: null,
    });
    const stub = stubFetch().on({
      host: SLACK_HOST,
      path: SLACK_PATH,
      method: 'POST',
      times: 1,
      reply: () => new Response('ok'),
    });
    await runDailyDigest(DAILY_ENV, ORIGIN);
    const body = stub.requests({ host: SLACK_HOST })[0].body;
    expect(body).toContain('AIコーチ');
    expect(body).toContain('今日の総括テスト');
  });

  it('当日の計測がなければ何も送らない', async () => {
    stubFetch(); // 未登録fetchはthrowするので、呼ばれないことの検証を兼ねる
    const result = await runDailyDigest(DAILY_ENV, ORIGIN);
    expect(result.queued).toBe(0);
  });

  it('daily/both の通知先がなければ何もしない', async () => {
    await insertMeasurement({ grpid: 9002, measured_at: new Date().toISOString(), weight: 80 });
    stubFetch();
    const result = await runDailyDigest(testEnv, ORIGIN); // mode省略=immediateのみ
    expect(result.queued).toBe(0);
  });
});

describe('digest_time（送信時刻設定）', () => {
  beforeEach(async () => {
    await resetTables();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parseDigestTime: 既定23:55・不正値フォールバック・23:55超はclamp', () => {
    expect(parseDigestTime(null)).toBe(23 * 60 + 55);
    expect(parseDigestTime('21:00')).toBe(21 * 60);
    expect(parseDigestTime('00:00')).toBe(0);
    expect(parseDigestTime('24:00')).toBe(23 * 60 + 55);
    expect(parseDigestTime('abc')).toBe(23 * 60 + 55);
    expect(parseDigestTime('23:59')).toBe(23 * 60 + 55); // その日のうちにtickが来ないためclamp
  });

  it('通知先ごとのdigest_time/digest_targetをパースし、不正値はthrow', () => {
    const env = envWith(
      '[{"id":"a","url":"https://hooks.slack.com/a","mode":"daily","digest_time":"07:00","digest_target":"previous"},{"id":"b","url":"https://hooks.slack.com/b","mode":"daily"}]',
    );
    const [a, b] = parseDestinations(env);
    expect(a.digestTimeMinutes).toBe(7 * 60);
    expect(a.digestTarget).toBe('previous');
    expect(b.digestTimeMinutes).toBeNull(); // 全体設定に従う
    expect(b.digestTarget).toBe('same');
    expect(() =>
      parseDestinations(envWith('[{"id":"x","url":"https://hooks.slack.com/x","digest_time":"7時"}]')),
    ).toThrow();
    expect(() =>
      parseDestinations(envWith('[{"id":"x","url":"https://hooks.slack.com/x","digest_target":"tomorrow"}]')),
    ).toThrow();
  });

  it('runDailyDigestIfDue: digest_time=00:00 なら常に送信対象', async () => {
    await setSetting('digest_time', '00:00');
    await insertMeasurement({ grpid: 9101, measured_at: new Date().toISOString(), weight: 81 });
    const stub = stubFetch().on({
      host: SLACK_HOST,
      path: SLACK_PATH,
      method: 'POST',
      times: 1,
      reply: () => new Response('ok'),
    });
    const result = await runDailyDigestIfDue(DAILY_ENV, ORIGIN);
    expect(result.queued).toBe(1);
    expect(stub.requests({ host: SLACK_HOST })).toHaveLength(1);
  });

  it('digest_target=previous は前日分のダイジェストを送る', async () => {
    const env = envWith(
      '[{"id":"morning","url":"https://hooks.slack.com/services/T0/B0/X","mode":"daily","digest_time":"00:00","digest_target":"previous"}]',
    );
    // 前日の計測のみ挿入（当日は0件）
    await insertMeasurement({
      grpid: 9201,
      measured_at: new Date(Date.now() - 86_400_000).toISOString(),
      weight: 79.5,
      fat_free_mass: 60.0,
    });
    const stub = stubFetch().on({
      host: SLACK_HOST,
      path: SLACK_PATH,
      method: 'POST',
      times: 1,
      reply: () => new Response('ok'),
    });
    const result = await runDailyDigestIfDue(env, ORIGIN);
    expect(result.queued).toBe(1);
    const body = stub.requests({ host: SLACK_HOST })[0].body;
    expect(body).toContain('日次サマリー');
    expect(body).toContain('79.5 kg');
  });
});

describe('ダイジェストの摂取カロリー行', () => {
  it('カロリー+PFC+比率（4/9/4換算・3者内正規化）を整形する', () => {
    expect(
      formatIntakeLine({ d: '2026-08-12', count: 3, calories: 1850.4, protein_g: 90.2, fat_g: 55, carbs_g: 210 }),
    ).toBe('*摂取* : 1850 kcal (P90.2 F55 C210 = 21:29:50%)');
  });
  it('PFCが全てnullならカロリーのみ', () => {
    expect(
      formatIntakeLine({ d: '2026-08-12', count: 1, calories: 700, protein_g: null, fat_g: null, carbs_g: null }),
    ).toBe('*摂取* : 700 kcal');
  });
  it('PFCが一部だけでも入力済み分を出す', () => {
    expect(
      formatIntakeLine({ d: '2026-08-12', count: 2, calories: 900, protein_g: 30, fat_g: null, carbs_g: 100 }),
    ).toBe('*摂取* : 900 kcal (P30 C100)');
  });
  it('記録なし（null）は行を出さない', () => {
    expect(formatIntakeLine(null)).toBeNull();
  });
});

describe('ダイジェストの消費（基礎+運動）・ネット行', () => {
  const intake = (cal: number): DailyIntake => ({ d: '2026-08-12', count: 2, calories: cal, protein_g: null, fat_g: null, carbs_g: null });
  const ex = (bmr: number | null, burned: number | null, volume: number | null): DailyExercise => ({
    d: '2026-08-12', bmr, calories_burned: burned, strength_volume: volume,
    cardio_count: burned ? 1 : 0, strength_count: volume ? 1 : 0,
  });

  it('基礎代謝＋運動の合計と内訳を整形する', () => {
    expect(formatBurnLine(ex(1750.4, 320.6, null))).toBe('*消費* : 2071 kcal (基礎 1750 + 運動 321)');
  });
  it('運動なしの日は基礎代謝のみで毎日出す', () => {
    expect(formatBurnLine(ex(1750, null, null))).toBe('*消費* : 1750 kcal (基礎代謝)');
    expect(formatBurnLine(ex(1750, null, 1200))).toBe('*消費* : 1750 kcal (基礎代謝)'); // 筋トレはkcal算入しない
  });
  it('FFM実測が無くbmrがnullなら運動分のみ。両方無ければ行を出さない', () => {
    expect(formatBurnLine(ex(null, 320.6, null))).toBe('*消費* : 321 kcal (運動)');
    expect(formatBurnLine(null)).toBeNull();
    expect(formatBurnLine(ex(null, 0, null))).toBeNull();
    expect(formatBurnLine(ex(null, null, 1200))).toBeNull();
  });
  it('ネットは摂取−総消費（赤字は負値で出る）', () => {
    expect(formatNetLine(intake(1850), ex(1750, 320, null))).toBe('*カロリー収支* : -220 kcal');
    expect(formatNetLine(intake(1850), ex(null, 320, null))).toBe('*カロリー収支* : 1530 kcal');
  });
  it('ネットは摂取と消費の両方がある日だけ出す', () => {
    expect(formatNetLine(null, ex(1750, 320, null))).toBeNull();
    expect(formatNetLine(intake(1850), null)).toBeNull();
    expect(formatNetLine(intake(1850), ex(null, 0, null))).toBeNull();
  });

  it('運動内訳行: 筋トレ件数・ボリューム / 有酸素件数・kcal。どちらも無い日は出さない', () => {
    expect(formatExerciseLine({ d: '2026-08-15', bmr: 1700, calories_burned: 417.4, strength_volume: 6463.2, cardio_count: 3, strength_count: 13 }))
      .toBe('*運動* : 筋トレ 13件 (Vol 6463) | 有酸素 3件 (417 kcal)');
    expect(formatExerciseLine({ d: '2026-08-15', bmr: 1700, calories_burned: null, strength_volume: 1200, cardio_count: 0, strength_count: 2 }))
      .toBe('*運動* : 筋トレ 2件 (Vol 1200)');
    expect(formatExerciseLine({ d: '2026-08-15', bmr: 1700, calories_burned: 300, strength_volume: null, cardio_count: 1, strength_count: 0 }))
      .toBe('*運動* : 有酸素 1件 (300 kcal)');
    expect(formatExerciseLine({ d: '2026-08-15', bmr: 1700, calories_burned: null, strength_volume: null, cardio_count: 0, strength_count: 0 })).toBeNull();
    expect(formatExerciseLine(null)).toBeNull();
  });
});
