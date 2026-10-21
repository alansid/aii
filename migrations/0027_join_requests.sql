-- C-369 申請加入專案：同仁送申請，leader／管理員人工核准或拒絕（不自動加入）
-- 只新增資料表與索引，不動既有資料；「開放申請」設定存在 app_settings 的 join_settings
CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  reason TEXT NOT NULL DEFAULT '',          -- 拒絕原因（給申請人看）
  role TEXT NOT NULL DEFAULT '',            -- 核准時選的角色
  read_only INTEGER NOT NULL DEFAULT 0,     -- 核准時選唯讀
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_join_pending ON join_requests (project, participant_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_join_status ON join_requests (status, project);
CREATE INDEX IF NOT EXISTS idx_join_person ON join_requests (participant_id, created_at);
