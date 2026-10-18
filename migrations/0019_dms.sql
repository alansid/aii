-- C-270 私訊自己的 AI。npm run cf:db:migrate-dms
-- 只新增資料表與索引，不改既有資料
CREATE TABLE IF NOT EXISTS dms (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, human_id TEXT NOT NULL, ai_id TEXT NOT NULL, from_id TEXT NOT NULL, text TEXT NOT NULL, project TEXT, request_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (from_id, request_id));
CREATE INDEX IF NOT EXISTS idx_dms_pair ON dms (human_id, ai_id, seq);
