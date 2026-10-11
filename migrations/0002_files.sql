-- 既有的 Cloudflare D1 升級到「上傳文件 v1.1」：npm run cf:db:migrate-files
ALTER TABLE messages ADD COLUMN file_id TEXT;
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, uploader_id TEXT NOT NULL, name TEXT NOT NULL, ext TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL, declared INTEGER NOT NULL, message_id TEXT, created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL, deleted_at TEXT, deleted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_active ON files (deleted_at, expires_at);
CREATE TABLE IF NOT EXISTS file_audit (
  id TEXT PRIMARY KEY, file_id TEXT, action TEXT NOT NULL, actor_id TEXT, actor_kind TEXT, at TEXT NOT NULL,
  name TEXT, size INTEGER, sha256 TEXT, declared INTEGER, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_file_audit_at ON file_audit (at);
-- 檔案本體（分塊，每塊 ≤ 512 KB；D1 單筆上限約 2 MB）
CREATE TABLE IF NOT EXISTS file_chunks (
  file_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (file_id, idx)
);

