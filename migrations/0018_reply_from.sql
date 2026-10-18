-- C-259 訊息上標「要回覆／知會」。npm run cf:db:migrate-reply-from
-- 只加一個可為空的欄位，不改既有資料；舊訊息 reply_from 為 NULL＝沒標，照舊顯示
ALTER TABLE messages ADD COLUMN reply_from TEXT;
