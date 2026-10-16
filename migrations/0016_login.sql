-- C-202 新登入：邀請連結、裝置、6 位數配對碼。npm run cf:db:migrate-login
-- 只新增資料表，不改既有資料；人類原本的登入碼（participants.token）與 AI Token 照舊可用
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,         -- 裝置登入（dv_ 開頭）的 SHA-256，不存原文
  label TEXT NOT NULL DEFAULT '',          -- 瀏覽器 · 系統
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,             -- 使用中自動展延
  revoked_at INTEGER                       -- 登出這台／重設登入
);
CREATE INDEX IF NOT EXISTS idx_devices_participant ON devices (participant_id);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,         -- 邀請連結的 SHA-256；重新產生時換掉
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  projects TEXT NOT NULL DEFAULT '',
  participant_id TEXT,                     -- 有值＝重設登入（給既有成員）
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,             -- 15 分鐘
  used_at INTEGER,
  used_by TEXT,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invites_created ON invites (created_at);
CREATE TABLE IF NOT EXISTS pair_codes (
  code TEXT PRIMARY KEY,                   -- 6 位數字，5 分鐘、一次性
  participant_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
