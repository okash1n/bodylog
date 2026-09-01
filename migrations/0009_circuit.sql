-- サーキット/複合メニュー: 1ラウンド分の構成（既存 strength 種目への参照 + 回数）。NULL = 通常種目。
-- 記録時にサーバが構成種目の通常ログ + セットへ展開して凍結するため、
-- この定義を後から編集しても過去ログは一切変わらない（スナップショット不変性は展開結果が担う）。
ALTER TABLE exercise_menus ADD COLUMN circuit_json TEXT; -- '[{"menu_id":"…","reps":5},…]'

-- 同一実施を束ねるグループ（親ログの id。親自身も group_id = 自id を持つ）。NULL = 単独記録
ALTER TABLE exercise_logs ADD COLUMN group_id TEXT;

CREATE INDEX idx_exercise_logs_group ON exercise_logs (group_id);
