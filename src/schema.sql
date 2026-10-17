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
  avatar TEXT NOT NULL DEFAULT '',         -- 頭像文字（空白＝自動：AI 角色代碼、人類名字首字）
  avatar_v INTEGER NOT NULL DEFAULT 0,     -- 頭像圖片版本（0＝沒有圖片；圖片存在 avatars）
  token TEXT NOT NULL UNIQUE,
  token_expires_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  standby_at INTEGER NOT NULL DEFAULT 0,  -- watcher 最近一次待命心跳
  projects TEXT NOT NULL DEFAULT '平台,銀行系統'  -- 所屬專案（逗號分隔，至少一個）
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
-- 頭像圖片（256×256，網頁裁切後上傳；不會過期）
CREATE TABLE IF NOT EXISTS avatars (
  participant_id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

-- 查詢效能索引（降低 D1 讀取量）
CREATE INDEX IF NOT EXISTS idx_notif_status_created ON notifications (status, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages (reply_to);

-- 「等你決定」清單：人類按「已處理」的紀錄
CREATE TABLE IF NOT EXISTS decision_resolutions (
  message_id TEXT PRIMARY KEY,
  resolved_by TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);
-- 工作卡片（第一階段）：顯示編號 C-(seq+100)
CREATE TABLE IF NOT EXISTS cards (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT '工作',
  title TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  owner_id TEXT,
  status TEXT NOT NULL DEFAULT '待整理',
  next TEXT NOT NULL DEFAULT '',
  blocker TEXT NOT NULL DEFAULT '',
  wait_for_id TEXT,
  criteria TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  request_id TEXT,
  done_by TEXT, done_at TEXT,
  verified_by TEXT, verified_at TEXT,
  decider_id TEXT, proposer_id TEXT,        -- 決策卡片：指定決策者、提案人
  question TEXT NOT NULL DEFAULT '', recommendation TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '',         -- 選項，JSON 陣列
  impact TEXT NOT NULL DEFAULT '', after_next TEXT NOT NULL DEFAULT '',
  decision_result TEXT, decision_by TEXT, decision_at TEXT, decision_note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_updated ON cards (updated_at);
CREATE INDEX IF NOT EXISTS idx_cards_status ON cards (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_request ON cards (created_by, request_id);
CREATE TABLE IF NOT EXISTS card_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  by_id TEXT NOT NULL,
  via TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_log_card ON card_log (card_seq, id);
CREATE TABLE IF NOT EXISTS card_msgs (
  card_seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (card_seq, message_id)
);
-- AI 建議（第三階段）：AI 想改別人的卡片或替別人建卡片時，只能提建議，由人類採用或略過
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- create | status
  from_id TEXT NOT NULL,
  card_seq INTEGER,                   -- status 建議針對的卡片
  payload TEXT NOT NULL,              -- JSON：create 的卡片欄位，或 status 的 { to, waitForId }
  basis_message_id TEXT,
  why TEXT NOT NULL DEFAULT '',
  request_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',   -- pending | applied | skipped
  created_at TEXT NOT NULL,
  resolved_by TEXT, resolved_at TEXT, result_card_seq INTEGER
);
CREATE INDEX IF NOT EXISTS idx_suggestions_state ON suggestions (state, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestions_request ON suggestions (from_id, request_id);

-- AI 工作記憶（C-108）：每個 AI 一列，JSON 文字，內容相同就不重寫
CREATE TABLE IF NOT EXISTS ai_state (
  participant_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 專案清單（C-146 B）：id 沿用既有專案名稱，改名只改 name
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO projects (id, name, archived, created_at) VALUES ('平台', '平台', 0, '2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO projects (id, name, archived, created_at) VALUES ('銀行系統', '銀行系統', 0, '2026-01-01T00:00:00.000Z');
-- 專案異動紀錄（C-146 B）：建立、改名、封存、還原、成員加入／移除
CREATE TABLE IF NOT EXISTS project_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_id TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_events ON project_events (project_id, id);
-- C-146 A：系統設定。isolation_since＝隔離起算時間，之前的舊訊息兩邊都看得到（當跨專案頻道）
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('isolation_since', '1970-01-01T00:00:00.000Z');

-- C-202 新登入：邀請連結、裝置、6 位數配對碼
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

-- C-223 帳號密碼登入（只存加鹽慢雜湊）、同帳號輸錯鎖定、主機救援連結、只給本人看的安全通知
CREATE TABLE IF NOT EXISTS credentials (
  participant_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,           -- 小寫；全群組不重複
  pwd_hash TEXT NOT NULL,                  -- pbkdf2-sha256$次數$鹽$雜湊
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_fails (
  username TEXT PRIMARY KEY,               -- 不存在的帳號也記，鎖不鎖不透露帳號有沒有人用
  count INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rescue_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,         -- 只能由主機上的 npm run admin-rescue 產生
  participant_id TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',     -- 主機使用者@主機名稱
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,             -- 15 分鐘
  used_at INTEGER,
  used_device TEXT
);
CREATE TABLE IF NOT EXISTS account_notices (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  kind TEXT NOT NULL,                      -- password_login／rescue_login／rescue_link
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_account_notices ON account_notices (participant_id, created_at);
