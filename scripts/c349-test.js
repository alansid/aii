// C-349 驗收測試：卡片認領＋接手紀錄＋結構化交接
// 修正前：10/20 C-333 退回時兩台 PG 同時改同一處，卡上看不出誰正在做；AI 用量用完或 /clear 後接手，也不知道前一位做到哪
// 修正後：[接單]／[進度] 帶 cardId＝認領；別人正在做時回 cardClaim 提示先接手；接手留紀錄並通知對方；
//         交接可寫四欄（做到哪、改了什麼、下一步、注意），讀卡最先看到；網頁顯示認領者與交接四欄
// 用法：node scripts/c349-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-c349-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8'), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let seq = 0;

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const mk = async name => { const a = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; return { id: a.participantId, name, tok: (await db.get('SELECT token FROM participants WHERE id = ?', a.participantId)).token }; };
  const A = await mk('甲PG'), B = await mk('乙PG'), C = await mk('丙UX');
  const post = (who, text, cardId) => call(who.tok, '/api/messages', 'POST', { project: '平台', requestId: 'm' + (++seq), text, cardId, recipientIds: [], replyFrom: [] });
  const card = (await call(liu.token, '/api/cards', 'POST', { requestId: 'c1', project: '平台', title: '修登入頁', ownerId: A.id, status: '待處理' })).body;
  const other = (await call(liu.token, '/api/cards', 'POST', { requestId: 'c2', project: '平台', title: '沒人做的卡', ownerId: A.id, status: '待處理' })).body;
  const get = async who => (await call(who.tok, `/api/cards/${card.cardId}`)).body;

  // 1) 負責人 [接單] 帶 cardId＝認領；讀卡最先看到「誰在做」
  let r = await post(A, '[接單] 開始修登入頁', card.cardId);
  assert.equal(r.status, 201); assert.equal(r.body.cardClaim, undefined, '沒人在做：不提示');
  let d = await get(A);
  assert.equal(d.claim?.by?.participantId, A.id, '認領者是甲'); assert.ok(d.claim.at, '有開始時間');
  assert.deepEqual(Object.keys(d).slice(0, 5), ['cardId', 'title', 'status', 'owner', 'claim'], '認領放在最前面');
  assert.ok(d.log.some(l => l.via === '認領' && l.text.includes('甲PG') && l.text.includes('開始做')), '認領有紀錄');
  r = await post(A, '[進度] 改了一半', card.cardId);
  assert.equal(r.body.cardClaim, undefined, '自己再發 [進度] 不提示');
  assert.equal((await get(A)).log.filter(l => l.via === '認領').length, 1, '自己再發不重複記');

  // 2) 第二個 AI 也對同一張卡 [接單]：訊息照發，但回 cardClaim 提示先接手；認領不變
  r = await post(B, '[接單] 這段我來修', card.cardId);
  assert.equal(r.status, 201, '不是鎖定，訊息照發');
  assert.equal(r.body.cardClaim?.participantId, A.id, '提示誰在做'); assert.equal(r.body.cardClaim.name, '甲PG');
  assert.match(r.body.cardClaim.hint, new RegExp(`/api/cards/${card.cardId}/takeover`), '提示怎麼接手');
  assert.equal((await get(B)).claim.by.participantId, A.id, '認領還是甲');

  // 3) 接手：別人在做要寫原因；留紀錄、通知原本在做的人；認領改成自己
  assert.equal((await call(B.tok, `/api/cards/${card.cardId}/takeover`, 'POST', {})).status, 400, '沒寫原因不能接手');
  r = await call(B.tok, `/api/cards/${card.cardId}/takeover`, 'POST', { reason: '甲用量用完了' });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.claim.by.participantId, B.id); assert.equal(r.body.previousClaim.by.participantId, A.id);
  d = await get(A);
  assert.equal(d.claim.by.participantId, B.id, '認領改成乙');
  assert.equal(d.owner.participantId, A.id, '負責人不變');
  assert.ok(d.log.some(l => l.via === '認領' && l.text.includes('乙PG 接手') && l.text.includes('甲用量用完了')), '接手有紀錄（含原本是誰、原因）');
  const noti = (await call(A.tok, '/api/notifications?status=pending')).body.items;
  assert.ok(noti.some(n => n.messageId === r.body.takeoverMessageId), '原本在做的甲收到通知');
  assert.equal(noti.find(n => n.messageId === r.body.takeoverMessageId).wake, false, '只是知會（replyFrom: []）');
  assert.equal((await call(B.tok, `/api/cards/${card.cardId}/takeover`, 'POST', {})).body.alreadyClaimed, true, '已經是自己：不重複記');
  r = await call(C.tok, `/api/cards/${other.cardId}/takeover`, 'POST', {});
  assert.equal(r.status, 200, '沒人在做：直接認領，原因選填'); assert.equal(r.body.previousClaim, undefined);

  // 4) 清單帶 claim（未結案、有人在做的才有）
  const items = (await call(liu.token, '/api/cards?status=open')).body.items;
  assert.equal(items.find(c => c.cardId === card.cardId).claim.by.participantId, B.id, '清單看得到誰在做');
  assert.equal(items.find(c => c.cardId === other.cardId).claim.by.participantId, C.id);

  // 5) 結構化交接四欄：API 讀卡最先看到；交接後認領清空，等接手的人 [接單]
  assert.equal((await call(A.tok, `/api/cards/${card.cardId}/handover`, 'POST', { toId: C.id, progress: '只寫做到哪' })).status, 400, '四欄至少要做到哪與下一步');
  r = await call(A.tok, `/api/cards/${card.cardId}/handover`, 'POST', { toId: C.id, progress: '登入頁改完，手機版沒測', changes: 'public/app.js 登入表單、src/login.js', nextStep: '手機 Safari 測一次再交 QA', caution: '別動 login.js 的配對碼那段' });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  d = await get(C);
  assert.equal(d.claim, undefined, '交接後沒人認領，等接手的人 [接單]');
  assert.deepEqual(Object.keys(d).slice(0, 5), ['cardId', 'title', 'status', 'owner', 'handover'], '交接放在最前面');
  assert.equal(d.handover.from.participantId, A.id); assert.equal(d.handover.to.participantId, C.id);
  assert.deepEqual([d.handover.progress, d.handover.changes, d.handover.nextStep, d.handover.caution], ['登入頁改完，手機版沒測', 'public/app.js 登入表單、src/login.js', '手機 Safari 測一次再交 QA', '別動 login.js 的配對碼那段']);
  assert.ok(!d.log.some(l => l.via === '交接'), '四欄的原始資料不混在 log 裡');
  assert.ok(d.log.some(l => l.text.startsWith('交接 甲PG → 丙UX：做到哪：登入頁改完')), 'log 照舊有一行交接');
  const hm = (await call(C.tok, `/api/messages/${r.body.handoverMessageId}`)).body.text;
  assert.match(hm, /• 做到哪：登入頁改完/); assert.match(hm, /• 改了什麼：public\/app\.js/); assert.match(hm, /• 下一步：手機 Safari/); assert.match(hm, /• 注意：別動/);
  assert.deepEqual(d.untrusted_content.filter(k => ['progress', 'changes', 'nextStep', 'caution'].includes(k)), ['progress', 'changes', 'nextStep', 'caution'], '四欄算人寫內容（C-348 標記）');
  r = await post(C, '[接單] 收到，接著測手機', card.cardId);
  assert.equal(r.body.cardClaim, undefined, '交接後接手的人 [接單] 不用再 takeover');
  assert.equal((await get(C)).claim.by.participantId, C.id, '接手的人認領');
  assert.equal((await get(C)).handover.progress, '登入頁改完，手機版沒測', '交接四欄還看得到');

  // 6) 舊用法：只寫 note 照收
  r = await call(C.tok, `/api/cards/${card.cardId}/handover`, 'POST', { toId: A.id, note: '測完了，交回' });
  assert.equal(r.status, 200);
  d = await get(A);
  assert.equal(d.handover.note, '測完了，交回'); assert.equal(d.handover.progress, undefined);

  // 7) 結案的卡不能接手、也不顯示認領；決策卡不用認領
  await call(A.tok, `/api/cards/${card.cardId}`, 'PATCH', { status: '已完成', version: d.version });
  assert.equal((await call(B.tok, `/api/cards/${card.cardId}/takeover`, 'POST', { reason: 'x' })).body.error?.code, 'CARD_CLOSED');
  const dec = (await call(liu.token, '/api/cards', 'POST', { requestId: 'c3', project: '平台', type: '決策', title: '要不要做', question: '？', deciderId: liu.participant.participantId })).body;
  assert.equal((await call(A.tok, `/api/cards/${dec.cardId}/takeover`, 'POST', {})).body.error?.code, 'NO_CLAIM_DECISION');

  // 8) 規格寫明；網頁顯示認領者與交接四欄
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.match(spec, /takeover/); assert.match(spec, /cardClaim/); assert.match(spec, /progress.*nextStep/);
  const web = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(web, /正在做/, '網頁顯示誰正在做'); assert.match(web, /做到哪/); assert.match(web, /改了什麼/); assert.match(web, /h\.caution/); assert.match(web, /上一棒交接/);
  console.log('c349-test：全部通過');
} catch (e) {
  console.error('c349-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
