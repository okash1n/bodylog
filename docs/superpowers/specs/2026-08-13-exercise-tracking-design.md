# 運動記録（有酸素＋筋トレ・メニュー方式）設計

日付: 2026-08-13
ステータス: 実装済み（Phase 1・2 とも。実装後の変更は本文中の更新注記を参照）

このドキュメント内のURL例は `weight.example.com` を使う（実環境の設定値はこのリポジトリに書かない。CLAUDE.md参照）。

## 目的

体重・食事に続き、運動を記録できるようにする。食事と同じく**必ず事前登録したメニュー（種目）から**記録する。

得たいものは2つ:

1. **有酸素の消費カロリー**を摂取カロリーと同じ土俵に載せ、エネルギーの出入りを見る
2. **筋トレの負荷（漸進性・総ボリューム）**を、実測の除脂肪体重の推移と並べて相関として見る

### 正直さの原則（重要）

- 「その運動が脂肪を何kg減らした / 筋肉を何kg増やした」という**1回の運動への体組成変化の帰属は記録しない**。体組成変化は食事・睡眠・累積負荷などが絡む全身の結果で、1セッションに切り出す妥当な方法がないため。寄与は「運動量」と「実測体組成の推移」を重ねて相関として見せることで表現する。
- 統合ビューの「ネット」は **`摂取 − 運動消費`** であって、基礎代謝（BMR/TDEE）を含む真のエネルギー収支ではない。BMRを推定して混ぜると数字が捏造になるため入れない。ラベルは必ず「摂取−運動消費」と明記し、真の収支を装わない。
  - **後続の変更**（`2026-08-13-bmr-burn-design.md`）: 消費に Katch-McArdle 式による基礎代謝の推定を含める方針に変えた。現行の「ネット（カロリー収支）」は `摂取 −（基礎代謝＋運動消費）` で、推定であること・内訳（基礎/運動）を UI と API 説明に明示する。以下の「摂取−運動消費」に関する記述は当時の設計

## フェーズ分割

一気に作ると検証しづらいので2段階に分ける。各フェーズ単独で動作・デプロイ可能。

- **Phase 1（有酸素）**: 有酸素メニュー（METs）＋記録（時間→消費kcal自動算出）＋消費kcalの日次集計＋既存体重グラフへの「摂取／消費／ネット」統合＋Slackダイジェスト＋MCP読み書き。食事の型をほぼ流用するため軽い。
- **Phase 2（筋トレ）**: 種目メニュー＋セット明細（可変セット {レップ, 重量}）＋自重の負荷算入＋総ボリュームの日次集計＋運動タブ内の「総ボリューム×除脂肪体重」グラフ＋筋トレ用の記録UI/履歴/MCP。3テーブル目・専用UIで重い。

本スペックは Phase 1・Phase 2 の両方の設計を含む（実装計画は別ファイルで分割する）。

## 決定事項

- 記録は必ずメニュー参照（`menu_id`）。自由文の直接記録は提供しない（食事と同じ）
- メニューは `category`（`'cardio'` | `'strength'`）で有酸素／筋トレを分ける。器（記録項目）が異なる
- 有酸素の消費kcal = `METs × 体重kg × 時間h × 1.05`。体重は `performed_at` 時点の直近 measurements を使い、**記録時に凍結**（後で体重が変わっても過去記録は不変）
- 筋トレは種目ごとに**可変のセット明細** {レップ, 重量} を持つ。総ボリューム = Σ(レップ × 実効重量)
- 自重種目（懸垂・腕立て等）は種目に `is_bodyweight` フラグ。実効重量 = `weight_kg（追加分, 0可）＋ 記録時に凍結した体重kg`。これで自重種目もウェイト種目と同じkgボリューム軸に乗る
- 読み取りは既存方針どおり**全公開**（運動明細・メニュー含む）。書き込みのみ認証（既存のOAuth 2.1 / `/rw/` を流用）
  - **後続の変更**: `/rw/` プレフィックスは廃止し、書き込みは読み取りと同じ `{base}/api/*` パスにメソッドで同居させてハンドラごとに Bearer を検証する。MCP は `/mcp` の単一エンドポイント（OAuth 必須）に一本化。読み取りの公開/非公開は `READ_ACCESS`（`2026-08-20-read-access-control-design.md`）で選べる。以下の `/rw/` に関する記述は当時の設計
- MCPからできる操作: 種目検索・記録の読み書き・**明示依頼時のみ**種目作成。編集・アーカイブ・削除はダッシュボードUI専用（食事と同じ方針）
  - **2026-08-26 更新（GitHub Issue #1）**: MCP にも `update_exercise_menu` / `archive_exercise_menu` / `delete_exercise_log` を追加した（運動記録の編集は REST 同様に無く、削除→再記録）。同日、自己ベスト集計 `get_exercise_records` も追加（docs/superpowers/specs/2026-08-26-exercise-records-design.md）

## データモデル（D1マイグレーション 0003）

食事と同じスナップショット方式（記録時にメニュー由来の値を凍結し、後からメニューを編集しても過去記録は不変）。

```sql
-- 種目マスタ（有酸素・筋トレ共用。categoryで使う列が変わる）
CREATE TABLE exercise_menus (
  id           TEXT PRIMARY KEY,             -- uuid
  name         TEXT NOT NULL,
  category     TEXT NOT NULL,                -- 'cardio' | 'strength'
  mets         REAL,                         -- cardio必須: 運動強度（安静時比）
  muscle_group TEXT,                         -- strength任意: 胸/背中/脚/肩/腕/体幹/全身 等（自由文）
  is_bodyweight INTEGER NOT NULL DEFAULT 0,  -- strength: 自重種目なら1
  note         TEXT,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 1記録 = 1種目のセッション（スナップショット）
CREATE TABLE exercise_logs (
  id            TEXT PRIMARY KEY,            -- uuid
  menu_id       TEXT NOT NULL REFERENCES exercise_menus(id),
  performed_at  TEXT NOT NULL,               -- ISO8601 UTC（集計はTZ_OFFSET_HOURSのローカル日付境界）
  category      TEXT NOT NULL,               -- snapshot: 'cardio' | 'strength'
  menu_name     TEXT NOT NULL,               -- snapshot
  note          TEXT,
  is_bodyweight INTEGER NOT NULL DEFAULT 0,  -- snapshot: strengthの自重判定（実効重量に使う）
  -- cardio専用（strengthではNULL）
  duration_min  REAL,                        -- 実施時間（分）
  mets          REAL,                        -- snapshot: 記録時のMETs
  body_weight_kg REAL,                       -- snapshot: 算出/ボリュームに使う凍結体重
  calories      REAL,                        -- 算出結果 kcal
  created_at    TEXT NOT NULL
);
-- body_weight_kg は cardio では消費kcal算出に、strength(is_bodyweight)では実効重量に使う共用列
-- is_bodyweight/body_weight_kg を log 側に凍結するのは、後で種目マスタを編集しても過去記録の実効重量を不変に保つため

-- 筋トレのセット明細（cardioでは行を作らない）
CREATE TABLE exercise_sets (
  id         TEXT PRIMARY KEY,               -- uuid
  log_id     TEXT NOT NULL REFERENCES exercise_logs(id) ON DELETE CASCADE,
  set_index  INTEGER NOT NULL,               -- 1始まりの並び順
  reps       INTEGER NOT NULL,
  weight_kg  REAL                            -- 追加/バーの重量。NULL/0 = 純自重
);

CREATE INDEX idx_exercise_logs_performed_at ON exercise_logs (performed_at);
CREATE INDEX idx_exercise_menus_archived_name ON exercise_menus (archived, name);
CREATE INDEX idx_exercise_sets_log ON exercise_sets (log_id, set_index);
```

### 算出ロジック（読み取り時に計算する派生値）

- **有酸素 消費kcal**（記録時に凍結して `exercise_logs.calories` に保存）:
  `calories = mets × body_weight_kg × (duration_min / 60) × 1.05`
- **筋トレ セット実効重量**:
  `effective = (weight_kg || 0) + (is_bodyweight ? body_weight_kg : 0)`
  - `is_bodyweight` は種目マスタ由来だが、過去記録の不変性のため `exercise_logs` 記録時に自重判定と `body_weight_kg` を凍結する
- **筋トレ セットボリューム**: `reps × effective`
- **筋トレ セッション総ボリューム**: `Σ セットボリューム`
- **日次総ボリューム**: その日の全 strength ログの総ボリュームの合計

### 体重スナップショットの解決

- `performed_at` のローカル日付以前で最も新しい `measurements.weight` を使う
- 該当日以前に計測が1件も無い場合: cardioは体重が無いと消費kcalを出せないので**記録を拒否**（400、「体重の実測がまだ無い」旨）。strength自重種目も同様に拒否。ウェイト種目（`is_bodyweight=0`）は体重不要なので許可

## API / MCP

食事と同じく、公開読み取りREST ＋ OAuth書き込み（`/rw/`）＋ MCP（読み公開・書き `/rw/mcp`）。

### 公開読み取りREST（`serveXxx` を dashboard ルータに追加）

- `GET /api/exercise/menus?q=&archived=` — 種目一覧（`category` でフィルタ可: `?category=cardio`）
- `GET /api/exercise/logs?from=&to=`（相対レンジ対応） — 記録明細（strengthはセット配列を同梱）
- `GET /api/exercise/daily?from=&to=` — 日次集計 `{ date, calories_burned, strength_volume }`

### OAuth書き込み（`/rw/` 配下、既存のトークン検証を流用）

- `POST /rw/exercise/menus` — 種目作成 / `PATCH` `DELETE`（アーカイブ）
- `POST /rw/exercise/logs` — 記録作成（cardio: `{menu_id, performed_at, duration_min, note?}` / strength: `{menu_id, performed_at, sets:[{reps, weight_kg?}], note?}`） / `DELETE`（記録削除、setsはCASCADE）

### MCP（ツール 7 → 11 本）

- 読み（公開 read 用MCPと `/rw/mcp` の両方に載せる）:
  - `search_exercise_menus(q?, category?)`
  - `get_exercise_logs(from?, to?)`
- 書き（`/rw/mcp` のみ）:
  - `create_exercise_menu(...)` — **明示依頼時のみ**
  - `log_exercise(...)` — cardio/strength両対応

## 統合ビュー（既存の体重グラフ / `src/dashboard/app.js`）

有酸素の消費kcalは摂取kcalと同じ単位なので既存グラフに統合する。**軸は既存の kg（左）＋ kcal（右）の2つに収め、3軸目は作らない**（dataviz鉄則）。

- カロリー右軸 `yKcal` に、既存の摂取（棒）に加えて「消費（棒 or 別色）」「ネット＝摂取−運動消費（線 or 棒）」を表現する
- トグルは既存の「カロリーを重ねる」を拡張: 摂取のみ / 摂取＋消費＋ネット を切替（既定は現状維持＝摂取のみ、消費データがある日だけ意味を持つ）
- ネットのラベルは「ネット（摂取−運動消費）」と明記
- 日次テーブルに「消費 kcal」「ネット kcal」列を追加
- 配色: 既存の摂取カロリー＝緑を維持。消費・ネットは検証済みパレットから追加し `scripts/validate_palette.js` でライト/ダーク両モードを検証してから確定する

## 運動タブ（筋トレ可視化・`src/dashboard/`）

新規「運動」タブ（体重・食事と並ぶ。`index.html` のタブ、`panel-exercise`）。食事タブと機能パリティ。

- **記録フォーム**: 種目検索（fzf挙動、候補は入力前から表示）＋記録日（数日遡り可、既定は今日）＋
  - cardio選択時: 時間（分）入力 → 消費kcalプレビュー
  - strength選択時: セット入力（行を動的に増減。各行 {レップ, 重量}。自重種目は重量欄を「追加重量（任意）」表示）
- **メニュー管理**（`<details>`）: 種目の追加（category切替でMETs欄／筋群・自重欄を出し分け）・一覧・アーカイブ
- **履歴テーブル（直近50日）**: 日付グルーピング。cardio行は「時間・消費kcal」、strength行は「セット（例: `40×10, 42.5×8, 45×6`）・総ボリューム」。日次合計（消費kcal / 総ボリューム）
- **筋トレボリュームグラフ**: 日次総ボリューム（棒）× 除脂肪体重（線）の2軸。「運動した時期に除脂肪体重が維持/増加しているか」を目視で。muscle_group別フィルタは v1 では出さず、将来の拡張余地として残す

## Slackダイジェスト（`src/slack.ts`）

Phase 1 で当日の運動消費を追加する。既存の当日「摂取」行の直後に:

- `*消費(有酸素)* : 320 kcal`（当日 cardio の合計。0/無しの日は行を出さない）
- `*ネット* : 1530 kcal (摂取−運動消費)`（摂取と消費の両方がある日のみ）

筋トレの総ボリュームはダイジェストには含めない（kcalと単位が違い、1行の要約に馴染まないため。ダッシュボードで見る）。

## テスト方針

- 既存同様 vitest + workers pool（ローカル `wrangler.toml` 参照）。日付seedは固定時刻 `${ymd}T03:00:00Z`（JST正午）
- Phase 1: 消費kcal算出（METs式・体重スナップショット解決・体重欠損時の拒否）、日次集計、`/rw/exercise/logs` の認証、MCP `log_exercise`(cardio)、Slackダイジェストの消費/ネット行、既存グラフの摂取/消費/ネット統合の描画アサーション
- Phase 2: セット明細のCRUD、自重の実効重量・ボリューム算出、日次総ボリューム集計、strengthのMCP/REST、運動タブのDOMアサーション、ボリューム×除脂肪体重グラフ

## セキュリティ / 公開リポジトリ配慮

- 実ドメイン・アカウントID・シークレット値・個人実測データを一切書かない（CLAUDE.md）
- 無認証の書き込みKV増幅と同種のリスクは無い（書き込みは全て `/rw/` = OAuth必須）。読み取り公開の増幅は既存と同じ扱い（WAFレート制限でカバー）

## やらないこと（YAGNI / スコープ外）

- 1回の運動への体組成変化の帰属（記録項目として持たない。上記「正直さの原則」）
- BMR/TDEEの推定と真のエネルギー収支
- muscle_group別のボリューム内訳グラフ（将来拡張）
- 心拍・GPS・外部デバイス連携
- 運動アドバイス・スコアリング（食事Phase 3相当の評価は対象外）
