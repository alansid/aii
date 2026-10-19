-- C-281 回報問題＋許願池。npm run cf:db:migrate-feedback
-- 只新增資料表與索引，不改既有資料
CREATE TABLE IF NOT EXISTS reports (seq INTEGER PRIMARY KEY AUTOINCREMENT, reporter_id TEXT NOT NULL, reporter_project TEXT, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', context TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT '未整理', severity TEXT NOT NULL DEFAULT '', card_id TEXT, merged_into INTEGER, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports (reporter_id, created_at);
CREATE TABLE IF NOT EXISTS report_shots (id TEXT PRIMARY KEY, report_seq INTEGER NOT NULL, mime TEXT NOT NULL, data BLOB, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_report_shots_report ON report_shots (report_seq);
CREATE INDEX IF NOT EXISTS idx_report_shots_created ON report_shots (created_at);
CREATE TABLE IF NOT EXISTS wishes (seq INTEGER PRIMARY KEY AUTOINCREMENT, author_id TEXT NOT NULL, author_project TEXT, title TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '收到', status_note TEXT NOT NULL DEFAULT '', card_id TEXT, votes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_wishes_author ON wishes (author_id, created_at);
CREATE TABLE IF NOT EXISTS wish_votes (wish_seq INTEGER NOT NULL, participant_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (wish_seq, participant_id));
