-- 運動記録: 種目マスタ + セッション記録 + 筋トレのセット明細（食事と同じスナップショット方式）
CREATE TABLE exercise_menus (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL,               -- 'cardio' | 'strength'
  mets          REAL,                        -- cardio用: 運動強度（安静時比）
  muscle_group  TEXT,                        -- strength任意: 胸/背中/脚 等（自由文）
  is_bodyweight INTEGER NOT NULL DEFAULT 0,  -- strength用: 自重種目なら1
  note          TEXT,
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE exercise_logs (
  id             TEXT PRIMARY KEY,
  menu_id        TEXT NOT NULL REFERENCES exercise_menus(id),
  performed_at   TEXT NOT NULL,              -- ISO8601 UTC（集計はTZ_OFFSET_HOURSのローカル日付境界）
  category       TEXT NOT NULL,              -- snapshot: 'cardio' | 'strength'
  menu_name      TEXT NOT NULL,             -- snapshot
  note           TEXT,
  is_bodyweight  INTEGER NOT NULL DEFAULT 0, -- snapshot: strengthの自重判定（実効重量に使う）
  duration_min   REAL,                       -- cardio: 実施時間（分）
  mets           REAL,                       -- cardio snapshot: 記録時のMETs
  body_weight_kg REAL,                       -- snapshot: 消費kcal算出/自重ボリュームに使う凍結体重
  calories       REAL,                       -- cardio: 算出結果 kcal
  created_at     TEXT NOT NULL
);

CREATE TABLE exercise_sets (
  id         TEXT PRIMARY KEY,
  log_id     TEXT NOT NULL REFERENCES exercise_logs(id) ON DELETE CASCADE,
  set_index  INTEGER NOT NULL,               -- 1始まりの並び順
  reps       INTEGER NOT NULL,
  weight_kg  REAL                            -- 追加/バーの重量。NULL/0 = 純自重
);

CREATE INDEX idx_exercise_logs_performed_at ON exercise_logs (performed_at);
CREATE INDEX idx_exercise_menus_archived_name ON exercise_menus (archived, name);
CREATE INDEX idx_exercise_sets_log ON exercise_sets (log_id, set_index);
