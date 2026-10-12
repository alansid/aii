-- 查詢效能索引：npm run cf:db:migrate-indexes
-- 查詢效能索引（降低 D1 讀取量）
CREATE INDEX IF NOT EXISTS idx_notif_status_created ON notifications (status, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages (reply_to);
