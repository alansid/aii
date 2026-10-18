// C-255 驗收測試：文件稽核紀錄的權限。管理員看全站；一般成員只看自己專案的檔案紀錄＋自己的操作。
// 用法：node scripts/audit-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-audit-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1' } });
const BASE = 'http://localhost';
const call = async (token, p, method = 'GET', body, raw) => {
  const r = await app(new Request(BASE + p, { method, headers: { 'Content-Type': raw ? 'text/plain' : 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined) }), BASE);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const up = (tok, name, project) => call(tok, `/api/files?name=${encodeURIComponent(name)}&declared=true&project=${encodeURIComponent(project)}`, 'POST', null, `內容 ${name}`);
const audit = async tok => (await call(tok, '/api/files/audit?limit=500')).body;
const names = a => new Set(a.items.map(x => x.name));

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body; // 第一位＝管理員，屬所有專案
  const chen = (await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  const bob = (await call(null, '/api/join', 'POST', { name: '銀行人', role: 'QA' })).body;
  assert.equal((await call(liu.token, `/api/participants/${chen.participant.participantId}/projects`, 'PUT', { projects: ['平台'] })).status, 200);
  assert.equal((await call(liu.token, `/api/participants/${bob.participant.participantId}/projects`, 'PUT', { projects: ['銀行系統'] })).status, 200);

  assert.equal((await up(liu.token, '平台規格.txt', '平台')).status, 201);
  assert.equal((await up(liu.token, '銀行規格.txt', '銀行系統')).status, 201);
  assert.equal((await up(liu.token, '公告.txt', 'all')).status, 201);
  assert.equal((await up(bob.token, '銀行自己的.txt', '銀行系統')).status, 201);
  // 被拒的上傳（沒聲明）：沒有檔案、沒有專案
  assert.equal((await call(bob.token, '/api/files?name=x.txt&project=銀行系統', 'POST', null, 'x')).status, 400);
  assert.equal((await call(chen.token, '/api/files?name=y.txt&project=平台', 'POST', null, 'y')).status, 400);

  // 管理員：全站
  const a = await audit(liu.token);
  assert.equal(a.scope, 'all');
  for (const n of ['平台規格.txt', '銀行規格.txt', '公告.txt', '銀行自己的.txt', 'x.txt', 'y.txt']) assert.ok(names(a).has(n), `管理員看得到 ${n}`);

  // 平台一般成員：只有平台的檔案＋自己的操作
  const c = await audit(chen.token);
  assert.equal(c.scope, 'mine');
  assert.ok(names(c).has('平台規格.txt'), '看得到自己專案的檔案紀錄');
  assert.ok(names(c).has('y.txt'), '看得到自己被拒的上傳');
  for (const n of ['銀行規格.txt', '銀行自己的.txt', 'x.txt', '公告.txt']) assert.ok(!names(c).has(n), `平台成員看不到 ${n}`);

  // 銀行一般成員：反過來
  const b = await audit(bob.token);
  assert.ok(names(b).has('銀行規格.txt') && names(b).has('銀行自己的.txt') && names(b).has('x.txt'));
  for (const n of ['平台規格.txt', 'y.txt', '公告.txt']) assert.ok(!names(b).has(n), `銀行成員看不到 ${n}`);

  // AI 仍然不能看稽核
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: '程式開發', name: '平台PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  assert.equal((await call(ai.token, '/api/files/audit')).status, 403, '稽核僅限人類');
  console.log('audit-test：全部通過');
} catch (e) {
  console.error('audit-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} // Windows：資料庫檔還開著時刪不掉
}
