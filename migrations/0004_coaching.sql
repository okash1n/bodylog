-- AIコーチング講評。生成はGitHub Actions上のAgent SDK（POST /api/coaching で保存）、
-- WorkerはSlack配信とダッシュボード表示のみを担う（Worker内でAI推論はしない）
CREATE TABLE coaching_notes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('daily', 'weekly')),
  date       TEXT NOT NULL,                             -- 生成対象のローカル日付 YYYY-MM-DD
  content    TEXT NOT NULL,                             -- 講評本文（Slack mrkdwn互換の軽い装飾を想定）
  model      TEXT,                                      -- 生成に使ったモデル名（参考情報）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, date)                                   -- 同日の再生成はupsert
);
