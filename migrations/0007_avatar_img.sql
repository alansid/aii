-- 頭像圖片：npm run cf:db:migrate-avatar-img
ALTER TABLE participants ADD COLUMN avatar_v INTEGER NOT NULL DEFAULT 0;
-- 頭像圖片（256×256，網頁裁切後上傳；不會過期）
CREATE TABLE IF NOT EXISTS avatars (
  participant_id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
