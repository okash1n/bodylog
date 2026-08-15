-- 自重種目のボリューム補正係数。実効重量 = 追加重量 + 体重 × bodyweight_factor（自重種目のみ）。
-- 全体重を持ち上げる種目（懸垂等）は1.0のまま、体の一部しか動かさない種目（コア系サーキット等）を
-- 現実的な負荷に補正する。logs側は記録時点の係数のスナップショット（種目の後変更に影響されない）
ALTER TABLE exercise_menus ADD COLUMN bodyweight_factor REAL NOT NULL DEFAULT 1.0;
ALTER TABLE exercise_logs ADD COLUMN bodyweight_factor REAL NOT NULL DEFAULT 1.0;
