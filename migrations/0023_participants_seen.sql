-- C-316 成員在線狀態只讀最近有活動的人（成員表改成寫入才整張重讀）。npm run cf:db:migrate-people-seen
-- 只加索引，不改資料
CREATE INDEX IF NOT EXISTS idx_participants_seen ON participants (last_seen_at);
