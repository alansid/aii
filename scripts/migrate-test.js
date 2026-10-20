// 遷移指令（scripts/migrate.js）把 SQL 接成一行送出：行尾的「-- 註解」要拿掉，不然後面的 SQL 全變成註解
// 修正前：0024_skills.sql 欄位後面的註解會讓建表 SQL 被截斷（C-346 部署前發現）
// 只 import 清理函式來測，絕不執行 migrate.js 本身（那會連正式庫）
// 用法：node scripts/migrate-test.js
import fs from 'node:fs';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

try {
  const src = fs.readFileSync(new URL('./migrate.js', import.meta.url), 'utf8');
  assert.ok(/export const cleanSql/.test(src) && /fileURLToPath\(import\.meta\.url\) === fs\.realpathSync\(process\.argv\[1\]\)/.test(src), 'migrate.js 被 import 時不會連正式庫');
  const { cleanSql } = await import('./migrate.js');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.sql'))) assert.ok(!cleanSql(fs.readFileSync(new URL(f, dir), 'utf8')).includes('--'), `${f}：送出的 SQL 不能殘留註解`);
  const db = new DatabaseSync(':memory:');
  db.exec(cleanSql(fs.readFileSync(new URL('0024_skills.sql', dir), 'utf8')));
  const cols = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  assert.ok(cols('skills').includes('review_note') && cols('skills').includes('roles'), 'skills 每個欄位都建出來（修正前在第一個行尾註解就斷掉）');
  assert.deepEqual(cols('skill_installs'), ['ai_id', 'skill_id', 'at']);
  console.log('migrate-test：全部通過');
} catch (e) {
  console.error('migrate-test 失敗：', e.message);
  process.exitCode = 1;
}
