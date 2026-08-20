-- Migration number: 0006 	 measurement source
-- 手動体重記録の出所区別。既存行（Withings由来）は 'withings' のまま。
-- 手動記録は grpid に負の整数を採番して同居する（Withingsのgrpidは常に正）。
ALTER TABLE measurements ADD COLUMN source TEXT NOT NULL DEFAULT 'withings';
