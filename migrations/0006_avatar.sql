-- 成員「頭像文字」欄位：npm run cf:db:migrate-avatar
ALTER TABLE participants ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
