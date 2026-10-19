// C-300 重現測試：全新的站（沒有「平台」「銀行系統」）也能用；回報收件專案可設定
// 修正前：回報寫死送進「平台」，新站沒有這個專案，回報誰都看不到（昱志 10/19 在 POC 站）
// 用法：node scripts/newsite-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-new-'));
const mk = (file, opts) => { const db = openNodeDb(path.join(dataDir, file), opts); return { db, app: createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000' } }) }; };
const caller = app => async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

try {
  // 全新的站：沒有任何專案 → 第一次啟動自動建「平台維運」，第一個人（管理員）在裡面
  const { app } = mk('new.db', { legacyProjects: false });
  const call = caller(app);
  assert.equal((await call(null, '/api/health')).body.setup, true, '還沒有人');
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  let r = await call(liu.token, '/api/projects');
  const ops = r.body.items.find(p => p.name === '平台維運');
  assert.ok(ops, '自動建「平台維運」');
  assert.ok(!r.body.items.some(p => p.id === '平台' || p.id === '銀行系統'), '新站不自帶「平台」「銀行系統」');
  assert.equal(r.body.feedbackProject, ops.id, '回報收件專案＝平台維運');
  assert.ok((await call(liu.token, '/api/me')).body.projects.includes(ops.id), '管理員在平台維運');

  // 回報、看得到、許願可以整理
  r = await call(liu.token, '/api/reports', 'POST', { title: '新站回報看得到嗎' });
  assert.equal(r.status, 201);
  r = await call(liu.token, '/api/reports');
  assert.equal(r.status, 200, '管理員看得到回報'); assert.equal(r.body.items[0].title, '新站回報看得到嗎');
  assert.equal((await call(liu.token, '/api/wishes')).body.canEdit, true, '可以整理願望');

  // 管理員改收件專案：只有那個專案的人看得到
  const pj2 = (await call(liu.token, '/api/projects', 'POST', { name: '外食減脂助手' })).body.id;
  const huang = (await call(null, '/api/join', 'POST', { name: '黃紹軒', role: 'PG' })).body;
  await call(liu.token, `/api/participants/${huang.participant.participantId}/projects`, 'PUT', { projects: [pj2] });
  assert.equal((await call(huang.token, '/api/settings/feedback-project', 'PUT', { project: pj2 })).status, 403, '只有管理員能設');
  assert.equal((await call(liu.token, '/api/settings/feedback-project', 'PUT', { project: 'nope' })).status, 400);
  r = await call(liu.token, '/api/settings/feedback-project', 'PUT', { project: pj2 });
  assert.equal(r.body.feedbackProject, pj2, '改成外食減脂助手');
  assert.equal((await call(huang.token, '/api/reports')).status, 200, '收件專案的成員看得到');
  assert.equal((await call(huang.token, '/api/reports', 'POST', { title: '從外食回報' })).status, 201);

  // 原本的站：照舊收在「平台」
  const legacy = caller(mk('legacy.db').app);
  const a = (await legacy(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  r = await legacy(a.token, '/api/projects');
  assert.equal(r.body.feedbackProject, '平台', '原本的站照舊用「平台」');
  assert.ok(!r.body.items.some(p => p.name === '平台維運'), '原本的站不多建平台維運');
  console.log('newsite-test：全部通過');
} catch (e) {
  console.error('newsite-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
