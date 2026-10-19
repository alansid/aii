// C-280 驗收測試：跟自己的 AI 討論、生成專案專屬新角色
// 用法：node scripts/role-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-role-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
const BASE = 'http://localhost';
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), BASE);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const DEF = { role: '營養師', key: 'nut', duties: '每週依外食資料提出菜單與熱量建議', style: '白話、附數字來源', autonomy: '整理菜單、算熱量', mustConfirm: '改熱量規則、加新食物分類', handoff: '交 PG 實作；UX 看畫面' };
const rolesOf = (r, pj) => r.body.items.find(p => p.id === pj).roles;

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body; // 第一位＝管理員
  const chen = (await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  const L = liu.participant.participantId, Cn = chen.participant.participantId;
  await call(liu.token, `/api/participants/${Cn}/projects`, 'PUT', { projects: ['平台'] });
  const mkAi = (tok, name, extra = {}) => call(tok, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x', ...extra });
  const pgL = (await mkAi(liu.token, '劉的PG')).body, pgC = (await mkAi(chen.token, '陳的PG')).body;
  await call(liu.token, '/api/projects/平台/dm', 'PUT', { on: true });

  // AI 只能提案；人類不能直接送提案
  assert.equal((await call(liu.token, '/api/role-proposals', 'POST', { project: '平台', ...DEF })).status, 403, '人類不能送角色提案');
  assert.equal((await call(pgL.token, '/api/role-proposals', 'POST', { project: '銀行系統', ...DEF })).status, 400, '不是 AI 所屬的專案');
  assert.equal((await call(pgL.token, '/api/role-proposals', 'POST', { project: '平台', ...DEF, key: 'N1' })).status, 400, '代碼要 2～4 個英文字母');
  let r = await call(pgL.token, '/api/role-proposals', 'POST', { project: '平台', ...DEF, key: 'PG', requestId: 'rp1' });
  assert.equal(r.status, 201); assert.ok(r.body.conflict, '跟內建代碼衝突：照收，卡上提示');
  const P0 = r.body.proposalId;
  assert.equal((await call(pgL.token, '/api/role-proposals', 'POST', { project: '平台', ...DEF, key: 'PG', requestId: 'rp1' })).body.proposalId, P0, '同 requestId 不重複建');
  r = await call(pgL.token, '/api/role-proposals', 'POST', { project: '平台', ...DEF, requestId: 'rp2' });
  assert.equal(r.status, 201); assert.equal(r.body.conflict, null);
  const P1 = r.body.proposalId;

  // 私訊卡、清單
  r = await call(liu.token, `/api/dm?aiId=${pgL.participantId}`);
  const card = r.body.items.find(x => x.roleProposal?.proposalId === P1);
  assert.ok(card && card.roleProposal.status === 'pending' && card.roleProposal.draft.key === 'NUT' && card.roleProposal.canCreate === true, '私訊帶角色提案卡（管理員可建）');
  assert.ok(r.body.items.find(x => x.roleProposal?.proposalId === P0).roleProposal.conflict, '衝突的卡帶提示');
  assert.equal((await call(liu.token, '/api/dm/summary')).body.items[0].text, '🧩 有角色提案');

  // 不能建：AI 自己、別人、衝突沒改
  assert.equal((await call(pgL.token, `/api/role-proposals/${P1}/create`, 'POST', {})).status, 403, 'AI 不能自己建立');
  assert.equal((await call(chen.token, `/api/role-proposals/${P1}/create`, 'POST', {})).status, 404, '別人不能建');
  assert.equal((await call(liu.token, `/api/role-proposals/${P0}/create`, 'POST', {})).status, 409, '代碼衝突沒改不能建');

  // 一般成員（不是 leader）收到自己 AI 的提案也不能建
  r = await call(pgC.token, '/api/role-proposals', 'POST', { project: '平台', ...DEF, key: 'DIET', role: '營養顧問' });
  const PC = r.body.proposalId;
  r = await call(chen.token, `/api/dm?aiId=${pgC.participantId}`);
  assert.equal(r.body.items.find(x => x.roleProposal?.proposalId === PC).roleProposal.canCreate, false, '一般成員看到不能建');
  assert.equal((await call(chen.token, `/api/role-proposals/${PC}/create`, 'POST', {})).status, 403, '一般成員不能建');
  await call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: Cn, leaderOf: ['平台'] }] });
  assert.equal((await call(chen.token, `/api/role-proposals/${PC}/create`, 'POST', { role: '營養顧問' })).status, 200, '變成 leader 就能建');

  // 管理員建立（可以改字）
  r = await call(liu.token, `/api/role-proposals/${P1}/create`, 'POST', { duties: '改過的職責' });
  assert.equal(r.status, 200); assert.equal(r.body.proposal.status, 'created');
  let nut = rolesOf(r, '平台').find(d => d.key === 'NUT');
  assert.ok(nut && nut.duties === '改過的職責' && nut.status === 'active' && nut.inUse === 0, '建立後在本專案角色');
  assert.equal(rolesOf(r, '銀行系統').length, 0, '別的專案沒有');
  assert.equal((await call(liu.token, `/api/role-proposals/${P1}/create`, 'POST', {})).status, 409, '建過不能再建');
  // 略過、24 小時作廢
  assert.equal((await call(liu.token, `/api/role-proposals/${P0}/skip`, 'POST')).body.proposal.status, 'skipped');
  r = await call(pgL.token, '/api/role-proposals', 'POST', { project: '平台', ...DEF, key: 'OLD', role: '舊角色' });
  const old = JSON.parse((await db.get('SELECT value FROM app_settings WHERE key = ?', 'rprop:' + r.body.proposalId)).value);
  old.createdAt -= 25 * 3600_000;
  await db.run('UPDATE app_settings SET value = ? WHERE key = ?', JSON.stringify(old), 'rprop:' + old.id);
  assert.equal((await call(liu.token, `/api/role-proposals/${old.id}/create`, 'POST', {})).status, 409, '過期不能建');

  // 建 AI、設人類角色都能用；只在該專案
  r = await mkAi(liu.token, '劉的營養師', { roleKey: 'NUT', role: '營養師' });
  assert.equal(r.status, 201, '建 AI 可用本專案角色'); const nutAi = r.body;
  assert.equal((await mkAi(liu.token, '劉的營養師2', { roleKey: 'NUT', role: '營養師', projects: ['銀行系統'] })).status, 400, '別的專案不能用');
  assert.ok((await call(nutAi.token, '/api/me/onboarding').catch(() => null)) !== null);
  await call(liu.token, `/api/participants/${L}/project-roles`, 'PUT', { projectRoles: { '平台': '營養師' } }).catch(() => {});

  // 專案設定 › 角色：改、停用、刪除
  assert.equal((await call(pgL.token, '/api/projects/平台/roles/NUT', 'PUT', { status: 'disabled' })).status, 403, 'AI 不能管理');
  r = await call(liu.token, '/api/projects/平台/roles/NUT', 'PUT', { handoff: '改過的交接' });
  nut = rolesOf(r, '平台').find(d => d.key === 'NUT');
  assert.equal(nut.handoff, '改過的交接'); assert.equal(nut.inUse, 1, '1 個 AI 在用');
  r = await call(liu.token, '/api/projects/平台/roles/NUT', 'PUT', { status: 'disabled' });
  assert.equal(rolesOf(r, '平台').find(d => d.key === 'NUT').status, 'disabled');
  assert.equal((await mkAi(liu.token, '劉的營養師3', { roleKey: 'NUT', role: '營養師' })).status, 400, '停用後不能新選');
  assert.equal((await call(liu.token, `/api/my-ais/${nutAi.participantId}`, 'PATCH', { duties: '照舊' })).status, 200, '停用後在用的照舊能存');
  assert.equal((await call(liu.token, '/api/projects/平台/roles/NUT', 'DELETE')).status, 409, '有人在用不能刪');
  await call(liu.token, `/api/my-ais/${nutAi.participantId}`, 'PATCH', { roleKey: 'PG', role: '程式開發' });
  assert.equal((await call(liu.token, '/api/projects/平台/roles/NUT', 'DELETE')).status, 200, '沒人用就能刪');
  const ev = (await call(liu.token, '/api/projects/平台/events?limit=10')).body.items || [];
  assert.ok(ev.some(e => /建立本專案角色「營養師」/.test(e.text)) && ev.some(e => /刪除本專案角色/.test(e.text)), '記在專案異動紀錄');
  // C-283 短版接入：一次性連結（15 分鐘、只能讀一次、重產讓舊的失效、只有所屬人類能產）
  const raw = async p => { const res = await app(new Request(BASE + p), BASE); return { status: res.status, text: await res.text(), cc: res.headers.get('cache-control') }; };
  assert.equal((await call(chen.token, `/api/my-ais/${pgL.participantId}/onboarding-link`, 'POST', {})).status, 404, '別人不能產');
  assert.equal((await call(pgL.token, `/api/my-ais/${pgL.participantId}/onboarding-link`, 'POST', {})).status, 403, 'AI 不能產');
  let ol = (await call(liu.token, `/api/my-ais/${pgL.participantId}/onboarding-link`, 'POST', {})).body;
  const oldLink = ol.url.replace(BASE, '');
  ol = (await call(liu.token, `/api/my-ais/${pgL.participantId}/onboarding-link`, 'POST', {})).body;
  const path1 = ol.url.replace(BASE, '');
  assert.equal((await raw(oldLink)).status, 410, '重產後舊連結失效');
  assert.equal((await raw(path1.slice(0, -2) + 'xx')).status, 410, '亂猜的不行');
  let got = await raw(path1);
  assert.equal(got.status, 200); assert.ok(got.text.includes(pgL.token) && got.text.includes('劉的PG'), '讀到完整接入設定（含 Token）'); assert.equal(got.cc, 'no-store');
  assert.equal((await raw(path1)).status, 410, '只能讀一次');
  ol = (await call(liu.token, `/api/my-ais/${pgL.participantId}/onboarding-link`, 'POST', {})).body;
  const rec = JSON.parse((await db.get("SELECT value FROM app_settings WHERE key = ?", 'olink:' + pgL.participantId)).value);
  assert.ok(!JSON.stringify(rec).includes(ol.url.split('.').pop()), '只存雜湊');
  rec.exp = Date.now() - 1; await db.run('UPDATE app_settings SET value = ? WHERE key = ?', JSON.stringify(rec), 'olink:' + pgL.participantId);
  assert.equal((await raw(ol.url.replace(BASE, ''))).status, 410, '15 分鐘過期');
  console.log('role-test：全部通過');
} catch (e) {
  console.error('role-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
