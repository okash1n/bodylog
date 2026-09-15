/**
 * generate.mjs / replay.mjs が共用する環境変数・HTTP・出力先の小さなヘルパー。
 * Node の API（child_process・fs）に触れるので Workers プールのテストからは読み込まない。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** 必須の環境変数（前後の空白は無視）。無ければメッセージを出して終了する */
export function requiredEnv(name) {
  const v = (process.env[name] ?? '').trim();
  if (!v) {
    console.error(`missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

/** '1' / 'true'（大文字小文字不問）を真とみなすフラグ判定 */
export function isOn(v) {
  return /^(1|true)$/i.test((v ?? '').trim());
}

/** bodylog API の GET（常に Bearer を付ける。READ_ACCESS=private でも読めるようにし、public では無視される） */
export function makeGetJson(base, secret, { timeoutMs = 15_000 } = {}) {
  return async (p) => {
    const res = await fetch(`${base}${p}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`GET ${p} -> HTTP ${res.status}`);
    return res.json();
  };
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return { status: r.status, out: (r.stdout ?? '').trim() };
}

/**
 * dry-run / 再現評価の書き出し先が「git 管理下のリポジトリ内で、かつ ignore されていない」場合に拒否する。
 * 書き出す内容には講評本文・健康データ・COACHING_PROFILE 本文が含まれるため、うっかり追跡対象に
 * 置くとパブリックリポジトリへ push されうる（実値スキャンはこの種の内容を検出しない）。
 * リポジトリ外、または .gitignore 済みの場所（既定は coaching/out/）なら通す。
 * COACHING_ALLOW_TRACKED_OUTPUT=1 で明示的に上書きできる。
 * @returns {string} 解決済みの絶対パス
 */
export function assertSafeOutputPath(target, { allowTracked = isOn(process.env.COACHING_ALLOW_TRACKED_OUTPUT) } = {}) {
  const abs = path.resolve(target);
  if (allowTracked) return abs;
  const dir = path.dirname(abs);
  const top = git(['rev-parse', '--show-toplevel'], dir);
  if (top.status !== 0 || !top.out) return abs; // リポジトリ外（または git 不在）は対象外
  const rel = path.relative(top.out, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return abs; // 別のツリー
  const ignored = git(['check-ignore', '-q', abs], top.out);
  if (ignored.status === 0) return abs;
  throw new Error(
    `output path ${abs} is inside the git repository and not ignored. ` +
      'Use coaching/out/ (gitignored) or a path outside the repository, or set COACHING_ALLOW_TRACKED_OUTPUT=1.',
  );
}
