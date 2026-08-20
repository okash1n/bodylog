# measurements 主キー再設計 設計

日付: 2026-08-20
ステータス: 承認済み（スタンドアロン化のアプローチ検討時にユーザーが3案から選択済み）

## 目的

`measurements` の主キーを Withings の `grpid` から汎用の内部ID `id` に再設計し、`grpid` を「Withings由来の行だけが持つ属性」に格下げする。スタンドアロン化で導入した「手動記録は負のgrpidを採番する」暫定方式を廃止し、入力源が増えても歪まないモデルにする。

## 非目標

- 読み取りAPIレスポンスの互換性破壊（`/api/raw` の `id`/`source` フィールドは維持）
- 既存データ・保留中通知の破棄（すべて移行する）
- notification_batches / webhook_inbox 等、measurements 以外のテーブルの再設計

## 新スキーマ（migration 0008、テーブル再構築）

```sql
CREATE TABLE measurements_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT, -- 内部計測ID
  source        TEXT NOT NULL DEFAULT 'withings',  -- 'withings' | 'manual'
  grpid         INTEGER UNIQUE,                    -- Withings measure group ID（manual行はNULL。UNIQUEはNULL複数可）
  measured_at   TEXT NOT NULL,
  weight        REAL,
  fat_ratio     REAL,
  fat_free_mass REAL,
  raw_json      TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
INSERT INTO measurements_new (id, source, grpid, measured_at, weight, fat_ratio, fat_free_mass, raw_json, created_at, updated_at)
SELECT grpid, source, CASE WHEN grpid > 0 THEN grpid END, measured_at, weight, fat_ratio, fat_free_mass, raw_json, created_at, updated_at
FROM measurements;
DROP TABLE measurements;
ALTER TABLE measurements_new RENAME TO measurements;
CREATE INDEX IF NOT EXISTS idx_measurements_measured_at ON measurements (measured_at);
ALTER TABLE notification_batch_items RENAME COLUMN grpid TO measurement_id;
```

移行の要点:

- **`id` = 旧 `grpid`**（正=Withings、負=移行前の手動記録）とすることで、保留中の `notification_batch_items` の参照が列リネームだけでそのまま有効に残る
- Withings行だけ `grpid` 列に値をコピーし、手動行（旧grpid<0）は NULL
- AUTOINCREMENT により、以後の新規行のidは `sqlite_sequence` 基準で単調増加（過去の巨大なWithings grpidより大きい正の値）。削除されたidは再利用されない（通知claimのPK衝突防止）
- 既存の負idの手動記録はそのまま残り、削除APIでも従来どおり消せる

## コード変更

### src/ingest.ts（Withings取り込み）

- UPSERT: `INSERT INTO measurements (grpid, measured_at, ...) VALUES ... ON CONFLICT(grpid) DO UPDATE ...`（`source` はDEFAULT 'withings'）。conflict targetは `grpid` のUNIQUE制約
- 通知claim: 従来は「claim（grpidでitems挿入）→UPSERT」の順だったが、items が `measurement_id` を要するため **「UPSERT→claim→batches登録」** の順に変える（同一 `db.batch()`=1トランザクションなので原子性は不変）。claimは
  `INSERT OR IGNORE INTO notification_batch_items (measurement_id, batch_id) SELECT id, ?2 FROM measurements WHERE grpid = ?1`
  とし、新規claim判定は該当statementの `meta.changes > 0`（結果配列のインデックスがUPSERT分だけ後ろにずれる点に注意）

### src/weight.ts（手動記録）

- 負ID採番を廃止し、素の `INSERT INTO measurements (source, measured_at, ...) VALUES ('manual', ...)` に簡素化
- 同一トランザクション内の後続文は「自分が挿入した行 = `(SELECT MAX(id) FROM measurements)`」で参照する（AUTOINCREMENTで単調、トランザクション内に他の挿入は無い）
- 削除は `DELETE FROM measurements WHERE id = ?1 AND source = 'manual'`（負の旧IDも正の新IDも同じ式で消える）

### src/queries.ts（読み取り）

- `getRawMeasurements`: `SELECT id, source, ...`（`grpid AS id` のエイリアス廃止）
- `getLatestForBatch`: `JOIN measurements m ON m.id = i.measurement_id`、`ORDER BY m.measured_at DESC, m.id DESC`
- `getLatestMeasurement`: `ORDER BY measured_at DESC, id DESC`
- 同時刻タイブレークの並びが grpid順→id順 に変わるが、同一計測時刻の複数行という縁のケースのみで実害なし

### その他

- `src/types.ts`: `RawMeasurement.id` のコメント更新（内部ID。負値は移行前の手動記録のみ）
- `src/ai.ts`: openapi `Measurement.id` の説明を「サーバ内部の計測ID」に更新
- `README.md`: 手順10の「IDは負の整数」記述を内部IDに更新
- `test/helpers.ts` の `insertMeasurement` はWithings行のseed用として `grpid` 指定のまま維持（スキーマ上 `grpid` 列に入る）

## テスト

- 既存全テストが新スキーマで通ること（apply-migrations が 0008 を適用）
- `test/weight.test.ts`: 手動記録のidが正の値で単調増加すること（負ID採番の検証を置換）、通知enqueueが `measurement_id` で行われること
- `test/raw-api.test.ts`: 手動行の `id > 0`・`source='manual'`、Withings行の `id = grpid`
- `test/ingest.test.ts`: UPSERT→claim順序変更後も、webhook経由のclaim判定（新規のみ通知）が機能すること（既存テストで担保、必要なら追加）
- MCP `log_weight`: idが正の値になるようアサーション更新
- 移行同等性: テスト内で「旧形式相当のデータ（正grpid行・負grpid手動行）を0007時点スキーマに投入→0008適用→行数・値・items参照が保たれる」検証は、apply-migrations の仕組み上難しいため実施しない。代わりに本番適用前にD1エクスポート（バックアップ）を取り、適用後に行数一致を確認する

## リスクと対策

- **テーブル再構築を伴う本番マイグレーション**: 適用前に `wrangler d1 export` でバックアップ取得。D1 Time Travel（30日）も復元手段として利用可能。適用後に `COUNT(*)` の前後一致と最新行の値を確認する
- 5分毎cronとの競合: マイグレーションはトランザクション内で行われ、単一ユーザー・低頻度書き込みのため実質競合しない。万一cron側が旧スキーマ前提のクエリで失敗しても、次tickの再実行で回復する（デプロイ順序: CI は migration → deploy の順なので、旧コードが新スキーマを踏む窓が数十秒ある。旧コードのクエリは `grpid` 列参照が `INSERT INTO measurements (grpid, ...)`＝新スキーマでも有効、`ON CONFLICT(grpid)`＝UNIQUE制約で有効、読み取りは `grpid AS id`＝列が残るので有効。**旧コード×新スキーマは全クエリ互換**であることを設計条件とする。ただし旧weight.tsの負ID採番INSERTだけは grpid列に負値を入れてしまうが、この窓で手動記録が走る確率は無視できる。例外は通知claim: 旧コードの `INSERT INTO notification_batch_items (grpid, ...)` は列リネーム後に失敗するが、webhook取り込みは inbox 永続化＋5分毎cronの再試行で回復する設計なので、通知が数分遅れるだけで欠落しない）
