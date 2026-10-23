-- PLAT-240 技能同步進度：每隻 AI 一列（主人按同步、AI 開始／結束、成功或失敗的最後一行、工具、同步工具的 SHA-256）
-- 只加不刪：舊版程式不讀這張表、不寫 place 欄，照常能跑
CREATE TABLE IF NOT EXISTS skill_syncs (
  ai_id TEXT PRIMARY KEY,
  requested_at TEXT,
  requested_by TEXT,
  started_at TEXT,
  finished_at TEXT,
  ok INTEGER,
  last_line TEXT,
  tool TEXT,
  setup_sha TEXT
);
-- 裝在哪一類位置：own＝AI 自己的代號資料夾、shared＝共用區（.claude/skills、.agents/skills）；舊腳本不回報＝NULL
ALTER TABLE skill_installs ADD COLUMN place TEXT;
