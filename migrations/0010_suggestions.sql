-- AI 建議：npm run cf:db:migrate-suggestions
-- AI 建議（第三階段）：AI 想改別人的卡片或替別人建卡片時，只能提建議，由人類採用或略過
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  card_seq INTEGER,
  payload TEXT NOT NULL,
  basis_message_id TEXT,
  why TEXT NOT NULL DEFAULT '',
  request_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_by TEXT, resolved_at TEXT, result_card_seq INTEGER
);
CREATE INDEX IF NOT EXISTS idx_suggestions_state ON suggestions (state, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestions_request ON suggestions (from_id, request_id);
