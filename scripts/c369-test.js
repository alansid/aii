// C-369 測試：申請加入專案（leader 打開才看得到；只有人類能申請；leader／管理員人工核准或拒絕，不自動加入）
// 隔離與權限：沒開放看不到、非 leader 與 AI 403、核准前不是成員、核准後才是（角色、唯讀、異動紀錄、通知）
// 用法：node scripts/c369-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-c369-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

try {
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('劉昱志', 'PO'); // 管理員
  const wang = await join('王小明', 'UX'), chen = await join('陳大文', 'PG'), wu = await join('吳大同', 'PG');
  const id = p => p.participant.participantId;
  const setPj = (p, projects) => call(liu.token, `/api/participants/${id(p)}/projects`, 'PUT', { projects });
  await setPj(liu, ['平台', '銀行系統']); await setPj(wang, ['平台']); await setPj(chen, ['銀行系統']); await setPj(wu, ['銀行系統']);
  assert.equal((await call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: id(wang), leaderOf: ['平台'] }] })).status, 200);
  const ai = (await call(chen.token, '/api/my-ais', 'POST', { projects: ['銀行系統'], roleKey: 'PG', role: 'PG', name: '陳的AI', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiTok = (await db.get('SELECT token FROM participants WHERE id = ?', ai.participantId)).token;
  const list = tok => call(tok, '/api/join/projects');
  const apply = (tok, pj, note) => call(tok, `/api/projects/${encodeURIComponent(pj)}/join-requests`, 'POST', { note });
  const myProjects = async tok => (await call(tok, '/api/me')).body.projects;

  // 1. 預設關：非成員看不到、不能申請；只有 leader／管理員能打開
  assert.deepEqual((await list(chen.token)).body.items, [], '沒開放的專案看不到');
  assert.equal((await apply(chen.token, '平台')).body.error.code, 'JOIN_CLOSED');
  assert.equal((await call(chen.token, '/api/projects/平台/join-settings', 'PUT', { open: true })).status, 403, '非 leader 不能打開');
  let r = await call(wang.token, '/api/projects/平台/join-settings', 'PUT', { open: true, note: '外食熱量 POC，歡迎 UX' });
  assert.equal(r.status, 200); assert.equal(r.body.open, true);
  assert.equal((await call(wang.token, '/api/projects')).body.join['平台'].open, true, '專案清單帶開放設定');
  // 2. 開放後：只露名稱、說明、leader、人數；隔離不變（專案清單仍看不到）
  const it = (await list(chen.token)).body.items;
  assert.equal(it.length, 1); assert.equal(it[0].id, '平台'); assert.equal(it[0].note, '外食熱量 POC，歡迎 UX');
  assert.deepEqual(it[0].leaders, ['王小明']); assert.ok(it[0].members >= 2);
  assert.ok(!(await call(chen.token, '/api/projects')).body.items.some(p => p.id === '平台'), '還不是成員，專案清單看不到');
  assert.ok(!('平台' in ((await call(chen.token, '/api/projects')).body.join || {})), '開放設定也不外流到專案清單');
  // 3. 只有人類能申請；已是成員有清楚訊息
  assert.equal((await list(aiTok)).status, 403, 'AI 不能看申請清單');
  assert.equal((await apply(aiTok, '平台')).status, 403, 'AI 不能申請');
  assert.equal((await apply(liu.token, '平台')).body.error.code, 'ALREADY_MEMBER');
  // 4. 送出：不自動加入；重送＝審核中；通知 leader
  r = await apply(chen.token, '平台', '我想幫忙做手機畫面');
  assert.equal(r.status, 200); assert.equal(r.body.status, 'pending');
  assert.equal((await apply(chen.token, '平台')).body.error.code, 'JOIN_PENDING');
  assert.ok(!(await myProjects(chen.token)).includes('平台'), '送出不會加入');
  assert.equal((await list(chen.token)).body.items[0].status, 'pending');
  assert.ok((await call(wang.token, '/api/me/notices')).body.items.some(n => n.kind === 'join_request' && n.detail.includes('陳大文')), '通知 leader');
  assert.equal((await call(wang.token, '/api/projects')).body.join['平台'].pending, 1, '待審數');
  // 5. 誰能審：leader、管理員；其他人與 AI 403
  const reqs = (await call(wang.token, '/api/join-requests')).body.items;
  assert.equal(reqs.length, 1); assert.equal(reqs[0].name, '陳大文'); assert.equal(reqs[0].note, '我想幫忙做手機畫面');
  assert.deepEqual((await call(wu.token, '/api/join-requests')).body.items, [], '非 leader 看不到待審');
  assert.equal((await call(wu.token, `/api/join-requests/${reqs[0].id}/approve`, 'POST', {})).status, 403);
  assert.equal((await call(aiTok, `/api/join-requests/${reqs[0].id}/approve`, 'POST', {})).status, 403);
  assert.equal((await call(chen.token, `/api/join-requests/${reqs[0].id}/approve`, 'POST', {})).status, 403, '申請人不能自己核准');
  // 6. 拒絕要寫原因；申請人收到；可隨時再申請，看得到上次原因
  assert.equal((await call(wang.token, `/api/join-requests/${reqs[0].id}/reject`, 'POST', { reason: ' ' })).status, 400);
  assert.equal((await call(wang.token, `/api/join-requests/${reqs[0].id}/reject`, 'POST', { reason: '目前人夠了' })).status, 200);
  assert.ok((await call(chen.token, '/api/me/notices')).body.items.some(n => n.kind === 'join_rejected' && n.detail.includes('目前人夠了')));
  const again = (await list(chen.token)).body.items[0];
  assert.equal(again.status, null); assert.equal(again.lastRejected.reason, '目前人夠了');
  assert.equal((await call(wang.token, `/api/join-requests/${reqs[0].id}/approve`, 'POST', {})).body.error.code, 'JOIN_DECIDED');
  assert.equal((await apply(chen.token, '平台', '再試一次')).status, 200, '被拒可隨時再申請');
  // 7. 核准：選角色＋唯讀 → 才變成員、角色、唯讀、異動紀錄、通知
  const r2 = (await call(wang.token, '/api/join-requests')).body.items[0];
  assert.equal(r2.lastRejected.reason, '目前人夠了', '審核時看得到上次被拒');
  r = await call(wang.token, `/api/join-requests/${r2.id}/approve`, 'POST', { role: 'UX', readOnly: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const me = (await call(chen.token, '/api/me')).body;
  assert.ok(me.projects.includes('平台'), '核准後是成員'); assert.ok(me.readOnlyIn.includes('平台'), '唯讀');
  assert.equal(me.projectRoles?.['平台'] ?? (await call(liu.token, '/api/participants')).body.items.find(p => p.participantId === id(chen)).projectRoles['平台'], 'UX', '角色');
  const ev = (await call(wang.token, '/api/projects/平台/events')).body.items.map(e => e.text).join('\n');
  assert.match(ev, /王小明 核准 陳大文 加入（UX），唯讀/);
  assert.ok((await call(chen.token, '/api/me/notices')).body.items.some(n => n.kind === 'join_approved'));
  assert.equal((await apply(chen.token, '平台')).body.error.code, 'ALREADY_MEMBER');
  // 8. 管理員不是 leader 也能審；封存的專案有清楚訊息
  await call(liu.token, '/api/projects/銀行系統/join-settings', 'PUT', { open: true });
  r = await apply(wang.token, '銀行系統');
  const bank = (await call(liu.token, '/api/join-requests?project=銀行系統')).body.items[0];
  assert.equal(bank.name, '王小明');
  assert.equal((await call(liu.token, `/api/join-requests/${bank.id}/approve`, 'POST', { role: 'PO' })).status, 200, '管理員能核准');
  const np = (await call(liu.token, '/api/projects', 'POST', { name: '封存測試' })).body;
  const pid = (np.items || []).find(p => p.name === '封存測試')?.id || np.id;
  await call(liu.token, `/api/projects/${encodeURIComponent(pid)}/join-settings`, 'PUT', { open: true });
  await call(liu.token, `/api/projects/${encodeURIComponent(pid)}/archive`, 'POST');
  assert.ok(!(await list(chen.token)).body.items.some(p => p.id === pid), '封存的不列');
  assert.equal((await apply(chen.token, pid)).body.error.code, 'PROJECT_ARCHIVED');
  console.log('c369-test：全部通過');
} catch (e) {
  console.error('c369-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
