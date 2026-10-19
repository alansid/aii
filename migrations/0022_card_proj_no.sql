-- C-310 卡片專案內連號（顯示成 專案代號-號碼，例如 PLAT-12）。npm run cf:db:migrate-card-proj-no
-- 加一個欄位；舊卡依建立順序在各自專案內從 1 補號；同專案不重號。C-xxx 照舊永久可用
ALTER TABLE cards ADD COLUMN proj_no INTEGER;
UPDATE cards SET proj_no = (SELECT COUNT(*) FROM cards c2 WHERE c2.project = cards.project AND (c2.created_at < cards.created_at OR (c2.created_at = cards.created_at AND c2.seq <= cards.seq)));
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_proj_no ON cards (project, proj_no);
