// C-317 重現測試：卡片交來交去一直停在「待整理」
// 修正前：PO 建卡是待整理，交給 UX 還是待整理、再交 PG 也還是待整理；接手的 AI 發 [接單] 也不會改（昱志 10/19 18:54 demo）
// 修正後：交接時待整理 → 待處理（等 X 接手）；負責人發 [接單]／[進度] 帶 cardId → 自動改進行中
// 用法：node scripts/card-start-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-cardstart-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let n = 0;
const msg = (tok, text, cardId) => call(tok, '/api/messages', 'POST', { requestId: 'm' + (++n), project: '平台', text, ...(cardId ? { cardId } : {}) });
const st = async id => (await call(liu.token, `/api/cards/${id}`)).body;
let liu;

try {
  liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const mkAi = async (roleKey, name) => { const a = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey, role: roleKey, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; return { ...a, token: (await db.get('SELECT token FROM participants WHERE id = ?', a.participantId)).token }; };
  const po = await mkAi('PO', 'claude-PO'), ux = await mkAi('UX', 'UX'), pg = await mkAi('PG', '程式助手');

  // PO 建卡（沒帶狀態）＝待整理，負責人是自己
  let c = (await call(po.token, '/api/cards', 'POST', { requestId: 'c1', project: '平台', title: 'demo 卡', ownerId: po.participantId })).body;
  assert.equal(c.status, '待整理');
  // PO 交給 UX → 待處理（等 UX 接手），交接訊息寫清楚
  let r = await call(po.token, `/api/cards/${c.cardId}/handover`, 'POST', { toId: ux.participantId, note: '請出設計', version: c.version });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, '待處理', '交接後不留在待整理（修正前還是待整理）');
  const ho = (await call(liu.token, `/api/messages/${r.body.handoverMessageId}`)).body;
  assert.match(ho.text, /待整理 → 待處理，等 UX 接手/, '交接訊息寫等誰接手');

  // 不是負責人發 [接單] 不會改
  await msg(pg.token, '[接單] 我來看看', c.cardId);
  assert.equal((await st(c.cardId)).status, '待處理', '不是負責人不改');
  // 負責人 UX 發 [接單] 帶 cardId → 進行中（用 PLAT-1 也可以）
  r = await msg(ux.token, '[接單] 開始出設計', c.key);
  assert.equal(r.status, 201); assert.equal(r.body.cardStatus, '進行中', '回應告訴它卡已改進行中');
  let card = await st(c.cardId);
  assert.equal(card.status, '進行中', '負責人接單 → 進行中');
  // UX 交給 PG：進行中照舊（交接不改進行中的狀態）
  r = await call(ux.token, `/api/cards/${c.cardId}/handover`, 'POST', { toId: pg.participantId, note: '請實作', version: card.version });
  assert.equal(r.body.status, '進行中');
  // 卡片紀錄看得到是誰的 [接單] 改的
  const full = (await call(liu.token, `/api/cards/${c.cardId}?include=log`)).body;
  const logs = JSON.stringify(full);
  assert.match(logs, /UX 發了 \[接單\]：狀態 待處理 → 進行中/, '卡片紀錄留下是誰改的');

  // [進度] 也算；沒帶 cardId、一般訊息、已完成的卡都不動
  const d = (await call(liu.token, '/api/cards', 'POST', { requestId: 'c2', project: '平台', title: '第二張', ownerId: pg.participantId, status: '待處理' })).body;
  assert.equal((await st(d.cardId)).status, '待處理', '建卡時就是待處理');
  await msg(pg.token, '[接單] 沒帶卡號');
  assert.equal((await st(d.cardId)).status, '待處理', '沒帶 cardId 不改');
  await msg(pg.token, '看了一下', d.cardId);
  assert.equal((await st(d.cardId)).status, '待處理', '不是 [接單]／[進度] 不改');
  await msg(pg.token, '[進度] 做一半', d.cardId);
  assert.equal((await st(d.cardId)).status, '進行中', '[進度] 也改進行中');
  const e = (await call(liu.token, '/api/cards', 'POST', { requestId: 'c3', project: '平台', title: '受阻的', ownerId: pg.participantId, status: '受阻', blocker: '等人' })).body;
  await msg(pg.token, '[進度] 還在等', e.cardId);
  assert.equal((await st(e.cardId)).status, '受阻', '受阻不自動改');

  // 接入設定補一句
  const ob = (await call(liu.token, `/api/my-ais/${pg.participantId}/onboarding`)).body.text;
  assert.match(ob, /發 \[接單\]（或 \[進度\]）帶 cardId，伺服器會自動把卡從「待整理／待處理」改成「進行中」/, '接入設定說明接單會改進行中');
  console.log('card-start-test：全部通過');
} catch (e) {
  console.error('card-start-test 失敗：', e.message, (e.stack.split('\n').find(l => l.includes('card-start-test.js')) || '').trim());
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
