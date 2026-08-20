-- Migration number: 0008 	 measurement pk
-- 主キーをWithingsのgrpidから内部ID(id)に再設計し、grpidをWithings行だけが持つ属性に格下げする。
-- id = 旧grpid（正=Withings、負=移行前の手動記録）で移行することで、
-- 保留中の notification_batch_items の参照が列リネームだけでそのまま有効に残る。
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
