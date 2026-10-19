// C-294 重現測試：人類成員可設「唯讀」（以專案為單位）
// 修正前沒有唯讀：被設唯讀的人照樣能發訊息、建卡、私訊（readOnlyIn 會被忽略）
// 用法：node scripts/readonly-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-ro-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
const BASE = 'http://localhost';
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), BASE);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let n = 0;
const msg = (tok, b) => call(tok, '/api/messages', 'POST', { requestId: 'm' + (++n), project: '平台', ...b });
const code = r => r.body.error?.code;

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body; // 管理員
  const chen = (await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  const L = liu.participant.participantId, Cn = chen.participant.participantId;
  await call(liu.token, `/api/participants/${Cn}/projects`, 'PUT', { projects: ['平台'] });
  const mkAi = (tok, name) => call(tok, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }).then(r => r.body);
  const pgC = await mkAi(chen.token, '陳的PG');
  await call(liu.token, '/api/projects/平台/dm', 'PUT', { on: true });
  const card = (await call(chen.token, '/api/cards', 'POST', { requestId: 'c1', project: '平台', title: '陳負責的卡', ownerId: Cn, status: '進行中' })).body;
  const aiCard = (await call(pgC.token, '/api/cards', 'POST', { requestId: 'c2', project: '平台', title: 'AI 負責的卡', ownerId: pgC.participantId, status: '進行中' })).body;
  const M = (tok, changes, dryRun) => call(tok, '/api/members/matrix', 'PUT', { changes, dryRun });

  // 設唯讀：先看影響（他和名下 AI 的卡會退回）
  let r = await M(liu.token, [{ id: Cn, readOnlyIn: ['平台'] }], true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.roChanges[0].returnedCards.sort(), [card.cardId, aiCard.cardId].sort(), '先列出會退回的卡');
  assert.equal((await M(chen.token, [{ id: L, readOnlyIn: ['平台'] }])).status, 403, '一般成員不能設');
  assert.equal(code(await M(liu.token, [{ id: L, readOnlyIn: ['平台'] }])), 'INVALID_REQUEST', '管理員不能設唯讀');
  assert.equal(code(await M(liu.token, [{ id: pgC.participantId, readOnlyIn: ['平台'] }])), 'INVALID_REQUEST', '只能設人類');
  r = await M(liu.token, [{ id: Cn, readOnlyIn: ['平台'] }]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.readOnly['平台'], [Cn], '專案清單帶唯讀名單');
  const c1 = (await call(liu.token, `/api/cards/${card.cardId}`)).body;
  assert.ok(c1.owner === null && c1.status === '待處理', '他的卡退回待處理、未指派');
  assert.equal((await call(liu.token, `/api/cards/${aiCard.cardId}`)).body.owner, null, '他 AI 的卡也退回');
  assert.deepEqual((await call(chen.token, '/api/me')).body.readOnlyIn, ['平台'], '/api/me 帶 readOnlyIn');
  assert.deepEqual((await call(pgC.token, '/api/me')).body.readOnlyIn, ['平台'], 'AI 跟著唯讀');

  // 唯讀的人：看得到，寫入一律 403 READ_ONLY
  assert.equal((await call(chen.token, '/api/messages?limit=5')).status, 200, '看得到訊息');
  assert.equal((await call(chen.token, `/api/cards/${card.cardId}`)).status, 200, '看得到卡片');
  assert.equal(code(await msg(chen.token, { text: '我想說話' })), 'READ_ONLY', '不能發訊息');
  assert.equal(code(await msg(chen.token, { text: '回覆', replyToMessageId: (await msg(liu.token, { text: "公告" })).body.messageId })), 'READ_ONLY', '不能回覆');
  assert.equal(code(await call(chen.token, '/api/cards', 'POST', { requestId: 'c3', project: '平台', title: 'x' })), 'READ_ONLY', '不能建卡');
  assert.equal(code(await call(chen.token, `/api/cards/${card.cardId}`, 'PATCH', { next: 'x', version: c1.version })), 'READ_ONLY', '不能改卡');
  assert.equal(code(await call(chen.token, `/api/cards/${card.cardId}/handover`, 'POST', { toId: L, version: c1.version, note: 'x' })), 'READ_ONLY', '不能交接');
  assert.equal(code(await call(chen.token, `/api/cards/${card.cardId}/messages`, 'POST', { text: 'x', requestId: 'cm1' })), 'READ_ONLY', '不能在卡上留言');
  assert.equal(code(await call(chen.token, '/api/dm', 'POST', { aiId: pgC.participantId, text: '嗨', requestId: 'd1' })), 'READ_ONLY', '不能私訊');
  assert.equal(code(await call(chen.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: '程式開發', name: '陳的PG2', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })), 'READ_ONLY', '不能在唯讀的專案建 AI');
  const up = await app(new Request(BASE + '/api/files?project=平台&name=a.txt&declared=1', { method: 'POST', headers: { Authorization: `Bearer ${chen.token}`, 'Content-Type': 'text/plain' }, body: 'hello' }), BASE);
  assert.equal((await up.json()).error?.code, 'READ_ONLY', '不能上傳');
  assert.equal(code(await msg(pgC.token, { text: 'AI 想說話' })), 'READ_ONLY', '他的 AI 也不能發訊息');
  // 可以回報／許願（昱志第 2 題選 A）
  assert.equal((await call(chen.token, '/api/wishes', 'POST', { title: '想要可以發言' })).status, 201, '可以許願');
  assert.equal((await call(chen.token, '/api/reports', 'POST', { title: '回報一下' })).status, 201, '可以回報');

  // 別人那邊：不能 @ 他、不能交給他、不能當決策者；@所有人跳過他
  assert.equal(code(await msg(liu.token, { text: '@陳昭宇 看一下', recipientIds: [Cn] })), 'READ_ONLY_RECIPIENT', '不能 @ 唯讀的人');
  r = await msg(liu.token, { text: '@所有人 公告', audience: 'all' });
  assert.ok(r.status === 201 && !r.body.recipients.some(x => x.participantId === Cn), '@所有人跳過唯讀的人');
  const c2 = (await call(liu.token, '/api/cards', 'POST', { requestId: 'c4', project: '平台', title: '劉的卡', ownerId: L })).body;
  assert.equal(code(await call(liu.token, `/api/cards/${c2.cardId}/handover`, 'POST', { toId: Cn, version: c2.version, note: 'x' })), 'READ_ONLY_MEMBER', '不能交給唯讀的人');
  assert.equal(code(await call(liu.token, '/api/cards', 'POST', { requestId: 'c5', project: '平台', title: '指派給唯讀', ownerId: Cn })), 'READ_ONLY_MEMBER', '不能指派給唯讀的人');
  assert.equal(code(await call(liu.token, '/api/cards', 'POST', { requestId: 'c6', project: '平台', type: '決策', title: '要決定', deciderId: Cn, question: 'A 還是 B？', options: ['A', 'B'] })), 'READ_ONLY_MEMBER', '不能當決策者');
  assert.equal(code(await M(liu.token, [{ id: Cn, leaderOf: ['平台'] }])), 'INVALID_REQUEST', '唯讀的人不能當 leader');

  // 改回一般成員就能發
  await M(liu.token, [{ id: Cn, readOnlyIn: [] }]);
  assert.equal((await msg(chen.token, { text: '我回來了' })).status, 201, '改回一般就能發訊息');
  assert.deepEqual((await call(chen.token, '/api/me')).body.readOnlyIn, [], '改回一般');

  // 邀請時就選唯讀
  r = await call(liu.token, '/api/invites', 'POST', { name: '王唯讀', projects: ['平台'], readOnly: ['平台'] });
  assert.equal(r.status, 201); assert.deepEqual(r.body.invite.readOnly, ['平台'], '邀請帶唯讀');
  assert.equal(code(await call(liu.token, '/api/invites', 'POST', { name: '李錯', projects: ['平台'], readOnly: ['銀行系統'] })), 'INVALID_REQUEST', '唯讀專案要先勾選');
  const tok = r.body.url.split('/invite/')[1];
  const joined = (await call(null, '/api/auth/invite', 'POST', { token: tok })).body;
  assert.ok(joined.token, '用邀請加入');
  assert.deepEqual((await call(joined.token, '/api/me')).body.readOnlyIn, ['平台'], '加入就是唯讀');
  console.log('readonly-test：全部通過');
} catch (e) {
  console.error('readonly-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
