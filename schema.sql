-- bodylog D1 schema（参照用スナップショット。migrations/ 0001〜0009 適用後の実スキーマと一致させる）
-- 正はあくまで migrations/ の積み上げ（テスト・デプロイとも migrations/ を直接適用する）。
-- migration を追加したら、このファイルも同じ変更で更新すること。
-- 生成・検証方法: 空の SQLite に migrations/*.sql を順に適用し、sqlite_master と一致することを確認する。

CREATE TABLE tokens (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),  -- 1行のみ（シングルユーザー）
  userid              TEXT,
  access_token        TEXT,
  refresh_token       TEXT,
  expires_at          TEXT,
  refresh_lease_owner TEXT,  -- リフレッシュ単一フライト用lease（所有者）
  refresh_lease_until TEXT   -- lease期限（UTC, datetime('now')比較可能な形式）
);
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,  -- 'baseline_date' / 'last_sync_at' / 'oauth_state' / 'subscribed_callback_url' / 'import_status' / 'import_cursor' / 'import_error' など
  value TEXT
);
CREATE TABLE webhook_inbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  payload      TEXT NOT NULL,
  received_at  TEXT DEFAULT (datetime('now')),
  processed_at TEXT,
  attempts     INTEGER DEFAULT 0,
  last_error   TEXT
);
CREATE TABLE notification_batch_items (
  measurement_id    INTEGER PRIMARY KEY,  -- 一意制約がclaimを兼ねる（並行時も二重登録されない）
  batch_id TEXT NOT NULL
);
CREATE TABLE notification_batches (
  batch_id        TEXT NOT NULL,
  destination_id  TEXT NOT NULL,          -- SLACK_WEBHOOKS の安定ID
  status          TEXT DEFAULT 'pending', -- pending / sending / sent / dead
  attempts        INTEGER DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  sent_at         TEXT,
  UNIQUE (batch_id, destination_id)
);
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
, bodyweight_factor REAL NOT NULL DEFAULT 1.0, circuit_json TEXT);
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
, bodyweight_factor REAL NOT NULL DEFAULT 1.0, group_id TEXT);
CREATE TABLE exercise_sets (
  id         TEXT PRIMARY KEY,
  log_id     TEXT NOT NULL REFERENCES exercise_logs(id) ON DELETE CASCADE,
  set_index  INTEGER NOT NULL,               -- 1始まりの並び順
  reps       INTEGER NOT NULL,
  weight_kg  REAL                            -- 追加/バーの重量。NULL/0 = 純自重
);
CREATE TABLE coaching_notes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('daily', 'weekly')),
  date       TEXT NOT NULL,                             -- 生成対象のローカル日付 YYYY-MM-DD
  content    TEXT NOT NULL,                             -- 講評本文（Slack mrkdwn互換の軽い装飾を想定）
  model      TEXT,                                      -- 生成に使ったモデル名（参考情報）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, date)                                   -- 同日の再生成はupsert
);
CREATE TABLE "measurements" (
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
CREATE INDEX idx_measurements_measured_at ON measurements (measured_at);
CREATE INDEX idx_exercise_logs_group ON exercise_logs (group_id);
CREATE INDEX idx_webhook_inbox_unprocessed ON webhook_inbox (processed_at, attempts);
CREATE INDEX idx_batch_items_batch ON notification_batch_items (batch_id);
CREATE INDEX idx_batches_pending ON notification_batches (status, next_attempt_at);
CREATE INDEX idx_meal_logs_eaten_at ON meal_logs (eaten_at);
CREATE INDEX idx_menus_archived_name ON menus (archived, name);
CREATE INDEX idx_exercise_logs_performed_at ON exercise_logs (performed_at);
CREATE INDEX idx_exercise_menus_archived_name ON exercise_menus (archived, name);
CREATE INDEX idx_exercise_sets_log ON exercise_sets (log_id, set_index);
CREATE INDEX idx_meal_logs_menu_eaten ON meal_logs (menu_id, eaten_at);
CREATE INDEX idx_exercise_logs_menu_performed ON exercise_logs (menu_id, performed_at);
