-- 專案欄位（平台／銀行系統）：npm run cf:db:migrate-projects
ALTER TABLE participants ADD COLUMN projects TEXT NOT NULL DEFAULT '平台,銀行系統';
ALTER TABLE messages ADD COLUMN project TEXT;
ALTER TABLE cards ADD COLUMN project TEXT NOT NULL DEFAULT '平台';
UPDATE cards SET project = '銀行系統' WHERE title LIKE '[銀行系統]%';
CREATE INDEX IF NOT EXISTS idx_messages_project_seq ON messages(project, seq);
