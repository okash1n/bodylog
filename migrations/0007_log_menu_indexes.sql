-- Migration number: 0007 	 log menu indexes
-- メニュー/種目一覧の利用頻度順ORDER BY（menu_id相関サブクエリ）が使うインデックス。
-- 無くてもSQLiteのAUTOMATIC INDEXで動くが、その場構築はログ件数に比例して悪化するため固定化する。
CREATE INDEX IF NOT EXISTS idx_meal_logs_menu_eaten ON meal_logs (menu_id, eaten_at);
CREATE INDEX IF NOT EXISTS idx_exercise_logs_menu_performed ON exercise_logs (menu_id, performed_at);
