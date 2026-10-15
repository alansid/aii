-- AI 工作記憶雲端同步（C-108）：npm run cf:db:migrate-ai-state
CREATE TABLE IF NOT EXISTS ai_state (
  participant_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
