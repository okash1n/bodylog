/**
 * AIコーチング生成ワークフロー（GitHub Actions coaching.yml）の起動。
 *
 * GitHub の schedule は遅延する（実績で毎晩10〜18分、2026-08-27は3時間44分で日付をまたいだ）ため、
 * 時刻どおり発火する Cloudflare cron（5分毎）から、23:30 ローカルを過ぎた最初の tick で
 * workflow_dispatch により起動する。対象日を date 入力で明示するので、ランナーの起動が
 * 遅れても生成対象日はずれない。coaching.yml の schedule はフォールバックとして残る
 * （schedule 実行側は対象日の講評が既にあればスキップする。generate.mjs 参照）。
 *
 * GITHUB_DISPATCH_TOKEN / GITHUB_DISPATCH_REPO 未設定なら何もしない（任意機能）。
 * 注意: 対象日は TZ_OFFSET_HOURS で計算する。生成ジョブ側の COACHING_TZ_OFFSET_HOURS（既定9）と
 * 異なるオフセットにすると、渡した日付が未来日として拒否されうる（両者を同じ値に保つこと）。
 */
import type { Env } from './types';
import { offsetHours } from './util';
import { sendAdminAlert } from './slack';

/** 起動時刻（ローカル分）。既定23:55のダイジェスト前に生成が終わるよう23:30（coaching.yml の cron と同じ狙い） */
const DISPATCH_MINUTES = 23 * 60 + 30;
/** 二重起動防止の settings キー（値 = 最後に起動を試みたローカル日付） */
const DISPATCH_SETTING_KEY = 'coaching_dispatch_last';
const DISPATCH_WORKFLOW = 'coaching.yml';
const DISPATCH_REF = 'main';

/**
 * 23:30 ローカルを過ぎた最初の5分毎tickで coaching.yml を workflow_dispatch する。
 * 成否にかかわらずその日の試行は1回だけ（失敗時は管理者アラートを送り、GitHub側の
 * schedule 実行にフォールバックする。5分毎に GitHub API やアラートを叩き続けないため）。
 */
export async function dispatchCoachingIfDue(
  env: Env,
  nowMs: number = Date.now(),
): Promise<{ dispatched: boolean }> {
  const token = env.GITHUB_DISPATCH_TOKEN;
  const repo = env.GITHUB_DISPATCH_REPO;
  if (!token || !repo) return { dispatched: false };

  const local = new Date(nowMs + offsetHours(env) * 3_600_000);
  const nowMinutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (nowMinutes < DISPATCH_MINUTES) return { dispatched: false };
  const today = local.toISOString().slice(0, 10);

  // その日の起動をアトミックにクレームする（値が今日と異なるときだけ書き換え、変更0行=クレーム済み）。
  // 後続tickや、稀に重なりうるcron実行との二重起動をSELECT→書き込みのレースなしで防ぐ
  const claim = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?1, ?2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE value <> excluded.value`,
  )
    .bind(DISPATCH_SETTING_KEY, today)
    .run();
  if ((claim.meta.changes ?? 0) === 0) return { dispatched: false };

  let failure: string | null = null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${DISPATCH_WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'bodylog-worker',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: DISPATCH_REF, inputs: { date: today } }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (res.status !== 204) {
      failure = `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`;
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  if (failure !== null) {
    console.error('[coaching-dispatch] workflow dispatch failed:', failure);
    await sendAdminAlert(
      env,
      `AIコーチング生成ワークフローの起動に失敗しました（${failure}）。今夜はGitHub側のschedule実行にフォールバックします。GITHUB_DISPATCH_TOKENの失効・権限（Actions: Read and write）を確認してください`,
    );
    return { dispatched: false };
  }
  console.info(`[coaching-dispatch] dispatched ${DISPATCH_WORKFLOW} for ${today}`);
  return { dispatched: true };
}
