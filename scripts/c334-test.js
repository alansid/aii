// C-334 驗收測試（Fable 健檢 B5、B7、R1，不動資料表）：待處理通知不再無限累積
// 修正前：
//   B5 回覆「已離開／停用／刪除」成員的訊息照樣給他一則通知，沒人會確認，永遠待處理（團隊狀態每次都讀它）
//   B7 原訊息已不在的通知：未讀數算它、清單不列它 → 等待腳本一直被叫醒卻沒東西可處理
//   R1 人類幾乎不確認通知，待處理越積越多，團隊狀態每次整批讀
// 用法：node scripts/c334-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-c334-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const pendingOf = async id => (await db.get("SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND status = 'pending'", id)).n;
let seq = 0;
const say = (tok, body) => call(tok, '/api/messages', 'POST', { project: '平台', requestId: 'r' + (++seq), ...body });

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const wang = (await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiTok = (await db.get('SELECT token FROM participants WHERE id = ?', ai.participantId)).token;
  const W = wang.participant.participantId;

  // B5：王小明離開後，回覆他的舊訊息不再給他通知
  await call(liu.token, `/api/participants/${W}/projects`, 'PUT', { projects: ['平台'] });
  const old = (await say(wang.token, { text: '我是王小明的舊訊息' })).body;
  assert.ok(old.messageId, '王小明的舊訊息發得出去：' + JSON.stringify(old).slice(0, 200));
  assert.equal((await call(wang.token, '/api/leave', 'POST', {})).status < 300, true, '王小明離開');
  const before = await pendingOf(W);
  assert.equal((await say(liu.token, { text: '回覆已離開的人', replyToMessageId: old.messageId })).status, 201);
  assert.equal(await pendingOf(W), before, '回覆已離開成員不產生通知（修正前多一則永遠待處理）');

  // B7：原訊息不在了 → 清單會把它確認掉，未讀數跟著歸零
  //（只屬部分專案的成員，未讀數本來就檢查訊息在不在；看得到全部專案的成員才會對不上，例如劉昱志）
  const liuId0 = liu.participant.participantId;
  const m = (await say(aiTok, { text: '給劉昱志', recipientIds: [liuId0] })).body;
  await db.run('DELETE FROM messages WHERE id = ?', m.messageId); // 模擬手動清掉的訊息
  { const c = (await call(liu.token, '/api/notifications/count')).body; assert.equal(c.pending, 1, '未讀數原本算它：' + JSON.stringify(c)); }
  assert.deepEqual((await call(liu.token, '/api/notifications?status=pending')).body.items, [], '清單不列它');
  assert.equal((await call(liu.token, '/api/notifications/count')).body.pending, 0, '清單看過後未讀數歸零（修正前一直是 1，等待腳本空轉）');

  // R1：每天一次自動確認——人類超過 7 天沒處理的、已離開成員的；AI 的不動
  await say(liu.token, { text: '給王小明（離開前就有的通知）', recipientIds: [] });
  await db.run("INSERT INTO notifications (id, recipient_id, message_id, reasons, created_at) VALUES ('n_left', ?, ?, '[\"mention\"]', ?)", W, old.messageId, new Date().toISOString());
  const liuId = liu.participant.participantId;
  const m2 = (await say(aiTok, { text: '給劉昱志', recipientIds: [liuId] })).body;
  const m3 = (await say(liu.token, { text: '給 AI 的舊通知', recipientIds: [ai.participantId] })).body;
  assert.ok(m2.messageId && m3.messageId, '測試資料：' + JSON.stringify([m2, m3]).slice(0, 300));
  const longAgo = new Date(Date.now() - 8 * 86400_000).toISOString();
  await db.run('UPDATE notifications SET created_at = ? WHERE message_id IN (?, ?)', longAgo, m2.messageId, m3.messageId);
  const m4 = (await say(aiTok, { text: '給劉昱志的新通知', recipientIds: [liuId] })).body;
  assert.equal(await app.autoAckPending(), 0, '不是台灣 03:00 那次排程就不做（一天只做一次）');
  const n = await app.autoAckPending(true);
  assert.equal(n, 2, '確認了 2 則：已離開成員的、人類 8 天前的');
  const st = async (rid, mid) => (await db.get('SELECT status FROM notifications WHERE recipient_id = ? AND message_id = ?', rid, mid)).status;
  assert.equal(await st(W, old.messageId), 'acked', '已離開成員的待處理確認掉');
  assert.equal(await st(liuId, m2.messageId), 'acked', '人類超過 7 天的確認掉');
  assert.equal(await st(liuId, m4.messageId), 'pending', '人類新的不動');
  assert.equal(await st(ai.participantId, m3.messageId), 'pending', 'AI 的就算舊也不動（AI 該處理）');
  const ts = (await call(liu.token, '/api/team-status')).body.members.find(x => x.participantId === liuId);
  assert.equal(ts.pendingCount, 1, '團隊狀態的待處理數跟著變少');
  assert.ok(fs.readFileSync(new URL('../src/core.js', import.meta.url), 'utf8').includes('pendingAutoAcked: await autoAckPending()'), '排程有接上');
  console.log('c334-test：全部通過');
} catch (e) {
  console.error('c334-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
