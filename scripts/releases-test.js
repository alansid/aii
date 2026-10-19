// C-291 版本紀錄與流程圖
// - 產生的版本紀錄要新的在上面、時間一律 UTC、事故對照兩邊都標到
//   （重現測試：修正前 commit 時間 +08:00、部署時間 UTC 用字串排，v0.73.0 排到下面）
// - 要登入才讀得到，不放 public（重現測試：C-291 退回，/releases.json、/flows.md 不登入就讀得到）
// 用法：node scripts/releases-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const root = new URL('../', import.meta.url);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-rel-'));
try {
  execFileSync('node', ['scripts/releases.mjs'], { cwd: root, encoding: 'utf8' });
  const j = JSON.parse(fs.readFileSync(new URL('generated/releases.json', root), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')).version;
  assert.ok(j.items.length > 100, '有版本資料');
  assert.ok(j.items.every(r => /Z$/.test(r.at)), '時間一律 UTC（Z 結尾）');
  for (let i = 1; i < j.items.length; i++) assert.ok(Date.parse(j.items[i - 1].at) >= Date.parse(j.items[i].at), `新的在上面：${j.items[i - 1].version} 要在 ${j.items[i].version} 前面`);
  assert.equal(j.current, pkg, 'current＝package.json 版本');
  assert.ok(j.items.find(r => r.version === '0.58.8')?.causes.some(c => c.fix === 'C-248'), 'v0.58.8 標「造成 C-248」');
  assert.ok(j.items.find(r => r.version === '0.66.2')?.fixes.some(f => f.cause === 'C-256'), 'v0.66.2 標「修正 C-256 造成的」');
  assert.ok(j.items.find(r => r.version === '0.72.6')?.cards.includes('C-290'), '版本對應到卡片');

  // 不放 public（外人讀不到）；要登入才讀得到
  assert.ok(!fs.existsSync(new URL('public/releases.json', root)) && !fs.existsSync(new URL('public/flows.md', root)), 'public 沒有版本紀錄與流程圖');
  const flowsText = fs.readFileSync(new URL('docs/flows.md', root), 'utf8');
  const db = openNodeDb(path.join(dataDir, 'switch.db'));
  const app = createApp({ db, storage: dbStorage(db), docText: '', flowsText, releases: j, config: { openJoin: '1', rateLimitPerMin: '10000' } });
  const get = async (p, token) => { const r = await app(new Request('http://localhost' + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} }), 'http://localhost'); return { status: r.status, text: await r.text() }; };
  assert.equal((await get('/api/releases')).status, 401, '不登入讀不到版本紀錄');
  assert.equal((await get('/api/flows')).status, 401, '不登入讀不到流程圖');
  const liu = await (await app(new Request('http://localhost/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '劉昱志', role: 'PO' }) }), 'http://localhost')).json();
  const r1 = await get('/api/releases', liu.token);
  assert.equal(r1.status, 200); assert.equal(JSON.parse(r1.text).items.length, j.items.length, '登入讀得到版本紀錄');
  const r2 = await get('/api/flows', liu.token);
  assert.equal(r2.status, 200); assert.ok(r2.text.includes('## 一、登入（L）'), '登入讀得到流程圖');
  console.log('releases-test：全部通過');
} catch (e) {
  console.error('releases-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
