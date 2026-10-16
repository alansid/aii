-- 專案空間化（C-146 B）：專案清單改存資料表，可新增／改名／封存。npm run cf:db:migrate-project-space
-- id 沿用既有專案名稱（訊息、卡片、成員欄位存的值不用改）；之後改名只改 name。
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO projects (id, name, archived, created_at) VALUES ('平台', '平台', 0, '2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO projects (id, name, archived, created_at) VALUES ('銀行系統', '銀行系統', 0, '2026-01-01T00:00:00.000Z');
-- 專案異動紀錄：建立、改名、封存、還原、成員加入／移除
CREATE TABLE IF NOT EXISTS project_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_id TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_events ON project_events (project_id, id);
