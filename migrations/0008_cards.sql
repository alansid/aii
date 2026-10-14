-- 工作卡片第一階段：npm run cf:db:migrate-cards
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
