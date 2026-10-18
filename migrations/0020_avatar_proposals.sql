-- C-272 AI 產頭像、人類按套用才換。npm run cf:db:migrate-avatar-proposals
-- 只新增資料表與索引，不改既有資料
CREATE TABLE IF NOT EXISTS avatar_proposals (id TEXT PRIMARY KEY, human_id TEXT NOT NULL, ai_id TEXT NOT NULL, dm_id TEXT, mime TEXT, data BLOB, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, decided_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_avprop_status ON avatar_proposals (status, created_at);
