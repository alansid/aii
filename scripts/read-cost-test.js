// C-316 驗收測試：D1 讀取優化
// ④ 成員表改成「有寫入才整張重讀」：雲端好幾份程式共用版本記號；沒寫入時只讀版本 1 列＋最近有活動的人
// ⑤ 個人待處理通知：索引順著讀、讀到 LIMIT 就停（不再整批讀出來排序）
// ① 團隊狀態：網頁 5 分鐘才輪詢一次、伺服器快取 180 秒
// 用法：node scripts/read-cost-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-readcost-'));
const raw = openNodeDb(path.join(dataDir, 'switch.db'));
// 數「整張成員表」被讀了幾次
let fullReads = 0;
const db = { ...raw, all: (sql, ...a) => { if (/^SELECT \* FROM participants$/.test(sql.trim())) fullReads++; return raw.all(sql, ...a); } };
const mk = () => createApp({ db, storage: dbStorage(raw), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', peopleCheckMs: '50' } });
const A = mk(), B = mk(); // 兩份程式共用同一個資料庫
const call = (app, token, p, method = 'GET', body) => app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost')
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
  const liu = (await call(A, null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const chen = (await call(A, null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  const C = chen.participant.participantId;
  // 暖身：新資料庫第一次載入會寫一次跨專案名單（一次性），先讓兩份程式都過了這一步
  for (let i = 0; i < 3; i++) { await call(B, liu.token, '/api/projects'); await call(A, liu.token, '/api/projects'); await call(B, liu.token, '/api/participants'); await call(A, liu.token, '/api/participants'); await sleep(70); }

  // 沒有寫入：過了檢查間隔也不整張重讀（修正前每 30 秒整張讀）
  fullReads = 0;
  for (let i = 0; i < 6; i++) { await sleep(70); await call(B, liu.token, '/api/participants'); await call(A, chen.token, '/api/participants'); }
  assert.equal(fullReads, 0, `沒寫入不整張重讀（讀了 ${fullReads} 次）`);

  // A 改了成員資料 → B 下一次檢查就看到（靠版本記號，不靠到期）
  await call(A, liu.token, `/api/participants/${C}/projects`, 'PUT', { projects: ['銀行系統'] });
  await sleep(70);
  const seen = (await call(B, liu.token, '/api/participants')).body.items.find(p => p.participantId === C);
  assert.deepEqual(seen.projects, ['銀行系統'], '另一份程式也看到新的所屬專案');
  assert.ok(fullReads >= 1 && fullReads <= 3, `有寫入才重讀（${fullReads} 次）`);

  // 在線狀態照樣更新：陳在 A 有動作，B 看得到他在線
  await raw.run('UPDATE participants SET last_seen_at = 0 WHERE id = ?', C); // 先當作很久沒來
  await call(A, liu.token, `/api/participants/${C}/projects`, 'PUT', { projects: ['平台'] }); await sleep(70);
  await call(B, liu.token, '/api/participants'); await call(A, liu.token, '/api/participants'); // 兩邊都因這次寫入重讀一次
  fullReads = 0;
  await call(A, chen.token, '/api/me'); // 陳上線（寫 last_seen_at）
  await sleep(70);
  const on = (await call(B, liu.token, '/api/participants')).body.items.find(p => p.participantId === C);
  assert.equal(on.isOnline, true, '在線狀態跟得上（只補最近有活動的人）');
  assert.equal(fullReads, 0, '補在線狀態不用整張重讀');

  // ⑤ 個人待處理通知：查詢計畫不用另外排序（讀到 LIMIT 就停）
  const plan = (await raw.all("EXPLAIN QUERY PLAN SELECT n.* FROM notifications n WHERE n.recipient_id = 'x' AND n.status = 'pending' ORDER BY n.created_at DESC, n.rowid DESC LIMIT 50")).map(r => r.detail).join(' | ');
  assert.match(plan, /idx_notif_recipient/, '用個人通知索引：' + plan);
  assert.ok(!/TEMP B-TREE/.test(plan), '不用暫存排序：' + plan);
  const src = fs.readFileSync(new URL('../src/core.js', import.meta.url), 'utf8');
  assert.ok(src.includes("'n.created_at DESC, n.rowid DESC'"), '程式用 rowid 當第二排序鍵');
  // 索引：在線狀態用
  assert.ok((await raw.all("SELECT name FROM sqlite_master WHERE name = 'idx_participants_seen'")).length, '有 participants(last_seen_at) 索引');

  // ① 團隊狀態：網頁 5 分鐘輪詢、伺服器快取 180 秒
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /Date\.now\(\) - lastTeamPoll > 300_000/, '網頁團隊狀態 5 分鐘輪詢一次');
  assert.match(src, /TEAM_CACHE_MS_DEFAULT = 180_000/, '伺服器快取 180 秒');
  console.log('read-cost-test：全部通過');
} catch (e) {
  console.error('read-cost-test 失敗：', e.message, (e.stack.split('\n').find(l => l.includes('read-cost-test.js')) || '').trim());
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
