#!/usr/bin/env bash
# 実値（カスタムドメイン・32桁hex・UUID 形状の識別子）の混入を fail-closed で検査する。
# パブリックリポジトリのため、検出しても値そのものは出力しない（種別・ファイル・行のみ）。
# 対象は git 管理下のファイル（wrangler.toml と 00- 作業ディレクトリは管理外なので自然に対象外）。
# AGENTS.md の「コミット前に実値の混入を検索で確認する」を CI で自動化・常設化するもの。
set -u

fail=0
files=$(git ls-files | grep -v -e '^package-lock.json$' -e '^src/dashboard/vendor/')

# 1) 32桁以上の hex（ID/secret 形状）。英字a-fと数字の両方を含むもののみ
#    （純数字のテスト用文字列や全ゼロの番兵値を誤検知しないため）
hex_hits=$(echo "$files" | xargs grep -noE '[0-9a-f]{32,}' /dev/null 2>/dev/null |
  awk -F: '$3 ~ /[a-f]/ && $3 ~ /[0-9]/ {print $1":"$2}')
if [ -n "$hex_hits" ]; then
  while IFS= read -r loc; do
    echo "::error::32桁hex形状の値を検出: ${loc}（値は表示しない）"
  done <<< "$hex_hits"
  fail=1
fi

# 2) UUID 形状
uuid_hits=$(echo "$files" | xargs grep -lnE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' /dev/null 2>/dev/null || true)
if [ -n "$uuid_hits" ]; then
  while IFS= read -r loc; do
    echo "::error::UUID形状の値を検出: ${loc}（値は表示しない）"
  done <<< "$uuid_hits"
  fail=1
fi

# 3) wrangler.toml の routes に設定されたカスタムドメイン（実行環境にある場合のみ。
#    example.com / localhost は文書用の許可値なので除外）
if [ -f wrangler.toml ]; then
  domains=$(grep -oE 'pattern *= *"[^"]+"' wrangler.toml | sed -E 's/.*"([^"]+)".*/\1/' | tr -d '\r' |
    grep -E '^[A-Za-z0-9*][A-Za-z0-9.*-]+\.[A-Za-z0-9-]+$' | grep -v -e '\.example\.com$' -e '^localhost$' | sort -u)
  for d in $domains; do
    hits=$(echo "$files" | xargs grep -lF -- "$d" /dev/null 2>/dev/null || true)
    if [ -n "$hits" ]; then
      while IFS= read -r h; do
        echo "::error::wrangler.tomlのカスタムドメインを検出: ${h}（値は表示しない）"
      done <<< "$hits"
      fail=1
    fi
  done
fi

if [ "$fail" -eq 0 ]; then
  echo "実値スキャン: 検出なし"
fi
exit "$fail"
