-- 待命心跳：npm run cf:db:migrate-standby
-- watcher 每 15 分鐘呼叫未讀數端點並帶 X-Aigile-Source: watcher，伺服器記下最近一次時間
ALTER TABLE participants ADD COLUMN standby_at INTEGER NOT NULL DEFAULT 0;
