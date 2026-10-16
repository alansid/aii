-- C-146 A 專案隔離：npm run cf:db:migrate-isolation
-- isolation_since＝上線當下；之前的舊訊息兩邊都看得到（昱志第 952 則、PO 第 953 則），之後的新訊息依專案隔離
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('isolation_since', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
