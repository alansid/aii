// C-259 驗收測試：訊息上標「要回覆／知會」（replyFrom）。
// 用法：node scripts/ask-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-ask-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000' } });
const BASE = 'http://localhost';
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined }), BASE);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let n = 0;
const post = (tok, b) => call(tok, '/api/messages', 'POST', { project: '平台', requestId: 'r' + (++n), text: '測試 ' + n, ...b });
const askOf = (m, id) => m.recipients.find(r => r.participantId === id)?.ask;

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const chen = (await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  const L = liu.participant.participantId, C = chen.participant.participantId;
  await call(liu.token, `/api/participants/${C}/projects`, 'PUT', { projects: ['平台'] });
  const mk = name => call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }).then(x => x.body);
  const pg = await mk('RVVW'), ux = await mk('UX');
  const U = ux.participantId;

  // 沒帶 replyFrom、多位收件人：不標（照舊）
  let r = await post(pg.token, { recipientIds: [L, U] });
  assert.equal(r.status, 201);
  assert.equal(r.body.replyFrom, null, '多人沒指定＝不標');
  assert.equal(askOf(r.body, L), undefined, '不標時收件人沒有 ask');
  // 沒帶 replyFrom、一位收件人：他要回覆
  r = await post(pg.token, { recipientIds: [L] });
  assert.deepEqual(r.body.replyFrom, [L]);
  assert.equal(askOf(r.body, L), true);
  // AI 指定兩位要回覆：保留第一位，其他降為知會，回應帶 warnings
  r = await post(pg.token, { recipientIds: [L, U], replyFrom: [L, U] });
  assert.equal(r.status, 201, 'AI 指定兩位不回錯');
  assert.deepEqual(r.body.replyFrom, [L]);
  assert.equal(askOf(r.body, U), false, '第二位降為知會');
  assert.ok(r.body.warnings?.[0]?.includes('最多指定一位'), '回應帶提醒');
  const aiMsg = r.body.messageId;
  // 通知帶 ask
  const nl = (await call(liu.token, '/api/notifications?status=pending&limit=50')).body.items.find(x => x.messageId === aiMsg);
  assert.equal(nl.ask, true, '要回覆的人通知 ask=true');
  const nu = (await call(ux.token, '/api/notifications?status=pending&limit=50')).body.items.find(x => x.messageId === aiMsg);
  assert.equal(nu.ask, false, '知會的人通知 ask=false');
  // replyFrom 的人不在 recipientIds：一併成為收件人
  r = await post(pg.token, { recipientIds: [U], replyFrom: [L] });
  assert.ok(r.body.recipients.some(x => x.participantId === L), 'replyFrom 的人自動成為收件人');
  assert.equal(askOf(r.body, L), true); assert.equal(askOf(r.body, U), false);
  // 人類可以多人要回覆
  r = await post(liu.token, { recipientIds: [C, U], replyFrom: [C, U] });
  assert.deepEqual(r.body.replyFrom.sort(), [C, U].sort(), '人類不限制要回覆人數');
  assert.equal(r.body.warnings, undefined);
  // 人類 replyFrom 空陣列：全部知會
  r = await post(liu.token, { recipientIds: [C, U], replyFrom: [] });
  assert.deepEqual(r.body.replyFrom, []); assert.equal(askOf(r.body, C), false);
  // @所有人：一律知會；帶了 replyFrom 也忽略並提醒
  r = await post(pg.token, { audience: 'all', replyFrom: [L] });
  assert.deepEqual(r.body.replyFrom, []);
  assert.ok(r.body.recipients.every(x => x.ask === false), '@所有人全部是知會');
  assert.ok(r.body.warnings?.[0]?.includes('@所有人'));
  // 格式錯誤
  assert.equal((await post(pg.token, { recipientIds: [L], replyFrom: L })).status, 400, 'replyFrom 要是陣列');
  assert.equal((await post(pg.token, { recipientIds: [L], replyFrom: ['p_nobody'] })).status, 404, 'replyFrom 要是有效成員');
  // 冪等：沒帶 replyFrom 的重送照舊回 200
  const b0 = { project: '平台', requestId: 'same', text: '重送', recipientIds: [L] };
  assert.equal((await call(pg.token, '/api/messages', 'POST', b0)).status, 201);
  assert.equal((await call(pg.token, '/api/messages', 'POST', b0)).status, 200, '同內容重送＝200');
  assert.equal((await call(pg.token, '/api/messages', 'POST', { ...b0, replyFrom: [L] })).status, 409, '同 requestId 改帶 replyFrom＝不同內容');
  // C-276：對已結案的卡發接單／進度回 warnings（不擋）
  const cd = (await call(pg.token, '/api/cards', 'POST', { title: '舊卡', type: '工作', project: '平台', requestId: 'oldcard' })).body;
  await call(liu.token, `/api/cards/${cd.cardId}`, 'PATCH', { status: '已完成', version: cd.version });
  r = await post(pg.token, { cardId: cd.cardId, text: '[接單] 新功能' });
  assert.equal(r.status, 201, '不擋'); assert.ok(r.body.warnings?.some(w => w.includes('新工作請開新卡')), '已結案的卡回提醒');
  r = await post(pg.token, { cardId: cd.cardId, text: '[完成] 補一句' });
  assert.ok(!r.body.warnings, '完成類訊息不提醒');
  // 讀訊息列表也帶 ask
  const list = (await call(liu.token, '/api/messages?limit=50')).body.items;
  assert.equal(list.find(m => m.messageId === aiMsg).recipients.find(x => x.participantId === U).ask, false, '列表也帶 ask');
  console.log('ask-test：全部通過');
} catch (e) {
  console.error('ask-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} // Windows：資料庫檔還開著時刪不掉
}
