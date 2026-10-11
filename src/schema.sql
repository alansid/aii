-- Aigile-Switch 資料表（本機 node:sqlite 與 Cloudflare D1 共用）
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                      -- human | ai
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL DEFAULT '',
  role_key TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL UNIQUE,               -- 顯示用短代碼，如 TG57
  owner_id TEXT,                           -- AI 所屬的人類
  duties TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  autonomy TEXT NOT NULL DEFAULT '',
  must_confirm TEXT NOT NULL DEFAULT '',
  handoff TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL UNIQUE,
  token_expires_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  author_id TEXT NOT NULL,
  text TEXT NOT NULL,
  reply_to TEXT,
  request_id TEXT,
  audience TEXT,
  payload_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (author_id, request_id)
);
CREATE TABLE IF NOT EXISTS message_recipients (
  message_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  PRIMARY KEY (message_id, participant_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reasons TEXT NOT NULL,                   -- JSON 陣列：mention | reply | all
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | acked
  created_at TEXT NOT NULL,
  acked_at TEXT,
  UNIQUE (recipient_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications (recipient_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_participants_owner ON participants (owner_id);
