// C-293 重現測試：新人／新 AI 預設不跨專案（角色是 PO、SM 也不自動跨），只能管理員手動開；現有名單照舊
// 修正前：角色是 PO／SM 就自動算跨專案（黃紹軒、他的 AI、產品規劃助手都中）
// 用法：node scripts/cross-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-cross-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const mk = () => createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
let app = mk();
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const cross = async tok => (await call(tok, '/api/projects')).body.crossRoleIds;
const mkAi = (tok, name, roleKey) => call(tok, '/api/my-ais', 'POST', { projects: ['平台'], roleKey, role: roleKey, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }).then(r => r.body);

try {
  // 修正前就在的人：直接寫進資料庫、沒有 cross_roles 設定（模擬上線前的正式資料）
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const sm = (await call(null, '/api/join', 'POST', { name: '老SM', role: 'SM' })).body;
  const oldPo = await mkAi(liu.token, '舊產品規劃助手', 'PO');
  await db.run("DELETE FROM app_settings WHERE key = 'cross_roles'");
  app = mk(); // 新部署：第一次載入時把舊規則寫成固定名單
  let c = await cross(liu.token);
  for (const [who, p] of [['劉昱志', liu.participant], ['老SM', sm.participant], ['舊產品規劃助手', oldPo]]) assert.ok(c.includes(p.participantId), `現有名單照舊：${who}`);
  assert.ok(JSON.parse((await db.get("SELECT value FROM app_settings WHERE key = 'cross_roles'")).value).frozen, '寫成固定名單並標記');

  // 之後新加入的：角色是 PO／SM 也不跨
  const huang = (await call(null, '/api/join', 'POST', { name: '黃紹軒', role: 'PO' })).body;
  const newSm = (await call(null, '/api/join', 'POST', { name: '新SM', role: 'SM' })).body;
  const huangAi = await mkAi(liu.token, '黃的PO', 'PO');
  c = await cross(liu.token);
  for (const [who, id] of [['黃紹軒', huang.participant.participantId], ['新SM', newSm.participant.participantId], ['新的 PO AI', huangAi.participantId]]) assert.ok(!c.includes(id), `新成員不自動跨專案：${who}`);

  // 只能管理員手動開；手動關掉的不會被舊規則加回來
  const M = (tok, changes) => call(tok, '/api/members/matrix', 'PUT', { changes });
  await M(liu.token, [{ id: huang.participant.participantId, crossRole: true }]);
  assert.ok((await cross(liu.token)).includes(huang.participant.participantId), '管理員手動開');
  await M(liu.token, [{ id: sm.participant.participantId, crossRole: false, projects: ['平台'] }]);
  app = mk(); // 再部署一次
  c = await cross(liu.token);
  assert.ok(!c.includes(sm.participant.participantId), '手動關掉的不會被舊規則加回來');
  assert.ok(c.includes(huang.participant.participantId) && c.includes(liu.participant.participantId), '其他照舊');
  console.log('cross-test：全部通過');
} catch (e) {
  console.error('cross-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
