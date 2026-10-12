-- 「等你決定」已處理紀錄：npm run cf:db:migrate-decisions
-- 「等你決定」清單：人類按「已處理」的紀錄
CREATE TABLE IF NOT EXISTS decision_resolutions (
  message_id TEXT PRIMARY KEY,
  resolved_by TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);
