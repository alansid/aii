-- 決策卡片欄位：npm run cf:db:migrate-card-decisions
ALTER TABLE cards ADD COLUMN decider_id TEXT;
ALTER TABLE cards ADD COLUMN proposer_id TEXT;
ALTER TABLE cards ADD COLUMN question TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN recommendation TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN options TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN impact TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN after_next TEXT NOT NULL DEFAULT '';
ALTER TABLE cards ADD COLUMN decision_result TEXT;
ALTER TABLE cards ADD COLUMN decision_by TEXT;
ALTER TABLE cards ADD COLUMN decision_at TEXT;
ALTER TABLE cards ADD COLUMN decision_note TEXT NOT NULL DEFAULT '';
