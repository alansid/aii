// 對正式 D1 執行 migration：node scripts/migrate.js migrations/0002_files.sql
// 用 --command 直接送 SQL（wrangler 的 --file 匯入在部分帳號權限下會回 Authentication error）。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = process.argv[2];
if (!file) { console.error('用法：node scripts/migrate.js <sql 檔>'); process.exit(1); }
const sql = fs.readFileSync(file, 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join(' ');
const r = spawnSync('npx', ['--yes', 'wrangler@4', 'd1', 'execute', 'aigile-switch', '--remote', '--command', sql],
  { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
