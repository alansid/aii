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
  env TEXT NOT NULL DEFAULT '',            -- 所在環境：行內／行外／投信…
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
  file_id TEXT,                            -- 附帶的上傳文件
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
-- 上傳文件（需求 v1.1，方案 B）：中繼資料
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  uploader_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  declared INTEGER NOT NULL,               -- 上傳者已聲明不含程式碼與客戶個資
  message_id TEXT,                         -- 自動發出的群組訊息
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,             -- 毫秒；超過即視為不存在並由排程清除
  deleted_at TEXT,
  deleted_by TEXT                          -- participantId，或 system（到期清除）
);
CREATE INDEX IF NOT EXISTS idx_files_active ON files (deleted_at, expires_at);
-- 稽核：上傳、下載、刪除、拒絕、到期清除
CREATE TABLE IF NOT EXISTS file_audit (
  id TEXT PRIMARY KEY,
  file_id TEXT,
  action TEXT NOT NULL,                    -- upload | download | delete | reject | expire
  actor_id TEXT,
  actor_kind TEXT,                         -- human | ai | system
  at TEXT NOT NULL,
  name TEXT,
  size INTEGER,
  sha256 TEXT,
  declared INTEGER,
  detail TEXT                              -- 拒絕原因等
);
CREATE INDEX IF NOT EXISTS idx_file_audit_at ON file_audit (at);
-- 檔案本體（分塊，每塊 ≤ 512 KB；D1 單筆上限約 2 MB）
CREATE TABLE IF NOT EXISTS file_chunks (
  file_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (file_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_participants_owner ON participants (owner_id);
-- 查詢效能索引（降低 D1 讀取量）
CREATE INDEX IF NOT EXISTS idx_notif_status_created ON notifications (status, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages (reply_to);

-- 「等你決定」清單：人類按「已處理」的紀錄
CREATE TABLE IF NOT EXISTS decision_resolutions (
  message_id TEXT PRIMARY KEY,
  resolved_by TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);

