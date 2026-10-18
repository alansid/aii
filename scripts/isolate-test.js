// C-248 驗收測試：Cloudflare 會同時跑好幾份程式（isolate），各有自己的成員快取。
// 新成員在 A 註冊，接著的請求落到 B（B 的快取還沒有他），不能出現 500。
// 用法：node scripts/isolate-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-isolate-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const mk = () => createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', teamCacheMs: '60000' } });
const A = mk(), B = mk(); // 兩份程式、同一個資料庫
const BASE = 'http://localhost';
const call = async (app, token, p, method = 'GET', body) => {
  const r = await app(new Request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined }), BASE);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
// 新成員登入後網頁第一批會打的 API
const FIRST_LOAD = ['/api/me', '/api/projects', '/api/participants', '/api/messages?limit=50', '/api/team-status',
  '/api/cards?limit=200&counts=1', '/api/suggestions?state=pending', '/api/notifications?status=pending&limit=50&order=desc', '/api/me/notices'];

const origError = console.error;
let errors = [];
console.error = (...a) => { errors.push(a.map(String).join(' ')); };
try {
  const liu = (await call(A, null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  assert.ok(liu.token, '第一位人類可以加入');
  const inv = await call(A, liu.token, '/api/invites', 'POST', { name: '陳昭宇', roles: { 平台: 'PG' }, projects: ['平台'] });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const ivToken = inv.body.url.split('/invite/')[1];

  // B 先暖好快取（裡面還沒有新成員）
  for (const p of FIRST_LOAD) assert.equal((await call(B, liu.token, p)).status, 200, `暖快取 ${p}`);

  // 在 A 註冊
  const reg = await call(A, null, '/api/auth/invite', 'POST', { token: ivToken, name: '陳昭宇' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  const chen = reg.body.token;

  // 新成員第一批請求落在 B：全部要 200
  for (const p of FIRST_LOAD) {
    const r = await call(B, chen, p);
    assert.equal(r.status, 200, `新成員在另一份程式 ${p} → ${r.status} ${JSON.stringify(r.body)}`);
  }
  const msgs = (await call(B, chen, '/api/messages?limit=50')).body.items;
  const join = msgs.find(m => /陳昭宇 已加入/.test(m.text));
  assert.ok(join, '新成員看得到自己的加入通知');
  assert.equal(join.author.name, '陳昭宇', '作者是新成員本人，不是空白或問號');

  // 邀請人（劉昱志）在 B 看到「已加入」通知與訊息：也不能 500
  for (const p of ['/api/messages?limit=50', '/api/notifications?status=pending&limit=50&order=desc', '/api/team-status', '/api/participants']) {
    const r = await call(B, liu.token, p);
    assert.equal(r.status, 200, `邀請人在另一份程式 ${p} → ${r.status} ${JSON.stringify(r.body)}`);
  }
  const notif = (await call(B, liu.token, '/api/notifications?status=pending&limit=50')).body.items.find(n => /已加入/.test(n.preview || ''));
  assert.ok(notif, '邀請人收到加入通知');
  assert.equal(notif.sender.name, '陳昭宇');
  const ppl = (await call(B, liu.token, '/api/participants')).body;
  assert.ok((ppl.items || ppl).some(p => p.name === '陳昭宇'), '成員名單看得到新成員');

  assert.deepEqual(errors.filter(e => /TypeError|Cannot read/.test(e)), [], '不應有程式例外');
  console.error = origError;
  console.log('isolate-test：全部通過');
} catch (e) {
  console.error = origError;
  console.error('isolate-test 失敗：', e.message);
  if (errors.length) console.error('伺服器錯誤紀錄：\n' + errors.slice(0, 5).join('\n'));
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} // Windows：資料庫檔還開著時刪不掉，留給系統暫存清理
}
