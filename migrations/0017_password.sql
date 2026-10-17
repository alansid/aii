-- C-223 帳號密碼登入。npm run cf:db:migrate-password
-- 只新增資料表，不改既有資料；配對、邀請、登入碼照舊可用
CREATE TABLE IF NOT EXISTS credentials (
  participant_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pwd_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_fails (
  username TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rescue_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  participant_id TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_device TEXT
);
CREATE TABLE IF NOT EXISTS account_notices (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_account_notices ON account_notices (participant_id, created_at);
