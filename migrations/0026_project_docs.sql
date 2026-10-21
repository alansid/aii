-- C-365 專案文件區：每個專案長期保存的文件（本體存 R2，這裡只存目錄與中繼資料）。npm run cf:db:migrate -- migrations/0026_project_docs.sql
-- 資料夾最多兩層（parent_id 為空＝第一層）；刪除只標記，紀錄留著（本體從 R2 刪掉）
CREATE TABLE IF NOT EXISTS doc_folders (id TEXT PRIMARY KEY, project TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, deleted_at TEXT, deleted_by TEXT);
CREATE INDEX IF NOT EXISTS idx_doc_folders ON doc_folders (project, deleted_at);
CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, project TEXT NOT NULL, folder_id TEXT, name TEXT NOT NULL, ext TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, uploader_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, deleted_by TEXT);
CREATE INDEX IF NOT EXISTS idx_docs ON docs (project, deleted_at);
