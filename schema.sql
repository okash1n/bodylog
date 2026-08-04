-- Migration number: 0001 	 init
CREATE TABLE IF NOT EXISTS measurements (
  grpid         INTEGER PRIMARY KEY,  -- Withingsのmeasure group ID（再送・修正に対して一意）
  measured_at   TEXT NOT NULL,        -- ISO8601（UTCで保存。ローカル日付変換は集計時）
  weight        REAL,
  fat_ratio     REAL,
  fat_free_mass REAL,
  raw_json      TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_measurements_measured_at ON measurements (measured_at);

CREATE TABLE IF NOT EXISTS tokens (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),  -- 1行のみ（シングルユーザー）
  userid              TEXT,
  access_token        TEXT,
  refresh_token       TEXT,
  expires_at          TEXT,
  refresh_lease_owner TEXT,  -- リフレッシュ単一フライト用lease（所有者）
  refresh_lease_until TEXT   -- lease期限（UTC, datetime('now')比較可能な形式）
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,  -- 'baseline_date' / 'last_sync_at' / 'oauth_state' / 'subscribed_callback_url' / 'import_status' / 'import_cursor' / 'import_error' など
  value TEXT
);

CREATE TABLE IF NOT EXISTS webhook_inbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  payload      TEXT NOT NULL,
  received_at  TEXT DEFAULT (datetime('now')),
  processed_at TEXT,
  attempts     INTEGER DEFAULT 0,
  last_error   TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_unprocessed ON webhook_inbox (processed_at, attempts);

CREATE TABLE IF NOT EXISTS notification_batch_items (
  grpid    INTEGER PRIMARY KEY,  -- 一意制約がclaimを兼ねる（並行時も二重登録されない）
  batch_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON notification_batch_items (batch_id);

CREATE TABLE IF NOT EXISTS notification_batches (
  batch_id        TEXT NOT NULL,
  destination_id  TEXT NOT NULL,          -- SLACK_WEBHOOKS の安定ID
  status          TEXT DEFAULT 'pending', -- pending / sending / sent / dead
  attempts        INTEGER DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  sent_at         TEXT,
  UNIQUE (batch_id, destination_id)
);
CREATE INDEX IF NOT EXISTS idx_batches_pending ON notification_batches (status, next_attempt_at);
