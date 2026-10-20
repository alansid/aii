-- C-346 角色技能庫：技能包（每個版本一列）與主人允許（含腳本的版本）。npm run cf:db:migrate-skills
-- 只新增資料表，不動既有資料
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,                 -- sk_xxx，一個版本一列
  project TEXT NOT NULL,
  name TEXT NOT NULL,                  -- 技能名稱＝資料夾名（小寫英數與 -）
  version INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL,                 -- JSON [{ path, text }]
  sha256 TEXT NOT NULL,                -- 整包雜湊（依路徑排序的 [路徑, 內容]）
  size INTEGER NOT NULL,
  has_scripts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                -- pending | published | rejected | superseded | removed
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_skills_project ON skills (project, name, version);
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills (status, project);
CREATE TABLE IF NOT EXISTS skill_allows (
  ai_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,              -- 允許的是「這一版」，新版要重新允許
  by_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (ai_id, skill_id)
);
