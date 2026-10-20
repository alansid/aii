// 對正式 D1 執行 migration：npm run cf:db:migrate -- migrations/0002_files.sql（或 node scripts/migrate.js <檔>）
// 用 --command 直接送 SQL（wrangler 的 --file 匯入在部分帳號權限下會回 Authentication error）。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = process.argv[2];
if (!file) { console.error('用法：node scripts/migrate.js <sql 檔>'); process.exit(1); }
const sql = fs.readFileSync(file, 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join(' ');
// Windows 需透過 shell 執行 npx，SQL 要整段加引號，否則會被拆成多個參數
const win = process.platform === 'win32';
const sqlArg = win ? `"${sql.replace(/"/g, '\\"')}"` : sql;
const r = spawnSync('npx', ['--yes', 'wrangler@4', 'd1', 'execute', 'aigile-switch', '--remote', '--command', sqlArg],
  { stdio: 'inherit', shell: win });
process.exit(r.status ?? 1);
