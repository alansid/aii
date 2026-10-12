-- 成員「所在環境」欄位：npm run cf:db:migrate-env
ALTER TABLE participants ADD COLUMN env TEXT NOT NULL DEFAULT '';
