// C-302 重現測試：只跑 schema.sql 建出的新資料庫，要有 migrations 加過的每個欄位與索引
// 修正前：schema.sql 的 messages 沒有 project 欄位（只靠 migration 0012 與本機 db-node 補），
// POC 站用 schema.sql 建表 → 專案清單 API 出錯，畫面「0 個專案」（昱志 10/19 在 POC 站）
// 用法：node scripts/schema-test.js
import fs from 'node:fs';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

const root = new URL('../', import.meta.url);
const db = new DatabaseSync(':memory:');
try {
  db.exec(fs.readFileSync(new URL('src/schema.sql', root), 'utf8'));
  const cols = t => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
  const idx = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(r => r.name));
  const miss = [];
  const dropped = new Set();
  for (const f of fs.readdirSync(new URL('migrations/', root)).filter(f => f.endsWith('.sql'))) for (const [, n] of fs.readFileSync(new URL('migrations/' + f, root), 'utf8').replace(/--.*$/gm, '').matchAll(/DROP INDEX\s+(?:IF EXISTS\s+)?(\w+)/gi)) dropped.add(n);
  for (const f of fs.readdirSync(new URL('migrations/', root)).filter(f => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(new URL('migrations/' + f, root), 'utf8').replace(/--.*$/gm, '');
    for (const [, t, c] of sql.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/gi)) {
      if (!cols(t).has(c)) miss.push(`${f}: ${t}.${c}`);
    }
    for (const [, t] of sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/gi)) {
      if (!cols(t).size) miss.push(`${f}: 表 ${t}`);
    }
    for (const [, name] of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)/gi)) {
      if (!idx.has(name) && !dropped.has(name)) miss.push(`${f}: 索引 ${name}`);
    }
  }
  assert.deepEqual(miss, [], 'schema.sql 少了 migrations 加的欄位／索引：' + miss.join('、'));
  console.log('schema-test：全部通過');
} catch (e) {
  console.error('schema-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  db.close();
}
