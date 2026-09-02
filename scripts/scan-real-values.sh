#!/usr/bin/env bash
# 実値（カスタムドメイン・32桁hex・UUID 形状の識別子）の混入を fail-closed で検査する。
# パブリックリポジトリのため、検出しても値そのものは出力しない（種別・ファイル・行のみ）。
# 対象は git 管理下のファイル（wrangler.toml と 00- 作業ディレクトリは管理外なので自然に対象外）。
# AGENTS.md の「コミット前に実値の混入を検索で確認する」を CI で自動化・常設化するもの。
#
# fail-closed の担保:
# - ファイル名は NUL 区切り（ls-files -z / xargs -0）で扱い、空白・引用符入りでも分割されない
# - grep は -a でバイナリもテキストとして走査（バイナリ内の実値も検出する）
# - grep の実行エラー（stderr出力 / xargs自体の失敗）は検査失敗としてスキャン全体を失敗させる
#   （xargs は子プロセスの「マッチなし exit 1」も 123 に畳むため、エラー判定は stderr で行う）
set -u

fail=0
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

list_files() {
  git ls-files -z | grep -zv -e '^package-lock.json$' -e '^src/dashboard/vendor/'
}

# grep を全対象へ実行し、ヒットを $tmpdir/out へ書く。実行エラーはスキャン全体を exit 2 で落とす
run_grep() {
  list_files | xargs -0 grep -a "$@" /dev/null > "$tmpdir/out" 2> "$tmpdir/err"
  local code=$?
  if [ -s "$tmpdir/err" ] || [ "$code" -ge 124 ]; then
    echo "::error::実値スキャンの grep 実行に失敗しました。検査をスキップせず失敗にします"
    sed -n '1,3p' "$tmpdir/err" >&2
    exit 2
  fi
}

report() { # $1 = 種別ラベル。stdin = 検出位置（値を含まない file:line）
  while IFS= read -r loc; do
    [ -n "$loc" ] || continue
    echo "::error::${1}を検出: ${loc}（値は表示しない）"
    fail=1
  done
}

# 1) 32桁以上の hex（ID/secret 形状、大文字小文字を問わない）。
#    英字a-fと数字の両方を含むもののみ（純数字のテスト用文字列や全ゼロの番兵値を誤検知しないため）
run_grep -inoE '[0-9a-f]{32,}'
# パイプで report へ渡すと fail=1 がサブシェルに落ちるため、ファイル経由でリダイレクトする
awk -F: '{t=tolower($3)} t ~ /[a-f]/ && t ~ /[0-9]/ {print $1":"$2}' "$tmpdir/out" > "$tmpdir/hex"
report '32桁hex形状の値' < "$tmpdir/hex"

# 2) UUID 形状（大文字小文字を問わない）
run_grep -ilE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
report 'UUID形状の値' < "$tmpdir/out"

# 3) wrangler.toml の routes に設定されたカスタムドメイン（実行環境にある場合のみ。
#    example.com / localhost は文書用の許可値なので除外）
if [ -f wrangler.toml ]; then
  domains=$(grep -oE 'pattern *= *"[^"]+"' wrangler.toml | sed -E 's/.*"([^"]+)".*/\1/' | tr -d '\r' |
    grep -E '^[A-Za-z0-9*][A-Za-z0-9.*-]+\.[A-Za-z0-9-]+$' | grep -v -e '\.example\.com$' -e '^localhost$' | sort -u)
  for d in $domains; do
    run_grep -ilF -- "$d"
    report 'wrangler.tomlのカスタムドメイン' < "$tmpdir/out"
  done
fi

if [ "$fail" -eq 0 ]; then
  echo "実値スキャン: 検出なし"
fi
exit "$fail"
