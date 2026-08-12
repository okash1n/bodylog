-- 食事記録 Phase 1: メニュー（マスタ）と記録（スナップショット方式）
CREATE TABLE menus (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  calories   REAL NOT NULL,
  protein_g  REAL,
  fat_g      REAL,
  carbs_g    REAL,
  note       TEXT,
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE meal_logs (
  id         TEXT PRIMARY KEY,
  menu_id    TEXT NOT NULL REFERENCES menus(id),
  eaten_at   TEXT NOT NULL,
  meal_type  TEXT,
  multiplier REAL NOT NULL DEFAULT 1.0,
  menu_name  TEXT NOT NULL,
  calories   REAL NOT NULL,
  protein_g  REAL,
  fat_g      REAL,
  carbs_g    REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_meal_logs_eaten_at ON meal_logs (eaten_at);
CREATE INDEX idx_menus_archived_name ON menus (archived, name);
