// 對正式 D1 執行 migration：npm run cf:db:migrate -- migrations/0002_files.sql（或 node scripts/migrate.js <檔>）
// 用 --command 直接送 SQL（wrangler 的 --file 匯入在部分帳號權限下會回 Authentication error）。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 整行註解拿掉；行尾的「-- 註解」也要拿掉，不然接成一行後，後面的 SQL 全變成註解（C-346 0024 部署前發現）
export const cleanSql = text => text.split(/\r?\n/).filter(l => !l.trim().startsWith('--')).map(l => l.replace(/\s+--.*$/, '')).join(' ');

// 只有直接執行這支才會連正式庫；被測試 import 時不做任何事
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const file = process.argv[2];
  if (!file) { console.error('用法：node scripts/migrate.js <sql 檔>'); process.exit(1); }
  const sql = cleanSql(fs.readFileSync(file, 'utf8'));
  // Windows 需透過 shell 執行 npx，SQL 要整段加引號，否則會被拆成多個參數
  const win = process.platform === 'win32';
  const sqlArg = win ? `"${sql.replace(/"/g, '\\"')}"` : sql;
  const r = spawnSync('npx', ['--yes', 'wrangler@4', 'd1', 'execute', 'aigile-switch', '--remote', '--command', sqlArg],
    { stdio: 'inherit', shell: win });
  process.exit(r.status ?? 1);
}
