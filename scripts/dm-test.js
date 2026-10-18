// C-270 驗收測試：私訊自己的 AI（專案開關、只限自己的 AI、第三者看不到內容與數量）。
// 用法：node scripts/dm-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-dm-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
const BASE = 'http://localhost';
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), BASE);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const SECRET = '這是只有兩方知道的私訊內容';
let n = 0;
const dm = (tok, b) => call(tok, '/api/dm', 'POST', { requestId: 'd' + (++n), ...b });

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const chen = (await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  const L = liu.participant.participantId, Cn = chen.participant.participantId;
  await call(liu.token, `/api/participants/${Cn}/projects`, 'PUT', { projects: ['平台'] });
  const mkAi = (tok, name) => call(tok, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }).then(x => x.body);
  const pgL = await mkAi(liu.token, '劉的PG'), pgC = await mkAi(chen.token, '陳的PG');

  // 預設關：不能送，但讀得到（空的）
  let r = await dm(liu.token, { aiId: pgL.participantId, text: '嗨' });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'DM_DISABLED', '預設關');
  r = await call(liu.token, `/api/dm?aiId=${pgL.participantId}`);
  assert.equal(r.status, 200); assert.equal(r.body.canSend, false);

  // 只有管理員或 leader 能開
  assert.equal((await call(chen.token, '/api/projects/平台/dm', 'PUT', { on: true })).status, 403, '一般成員不能開');
  r = await call(liu.token, '/api/projects/平台/dm', 'PUT', { on: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.find(p => p.id === '平台').dm.on, true, '專案回應帶 dm.on');
  assert.equal(r.body.items.find(p => p.id === '銀行系統').dm.on, false, '別的專案預設關');

  // 只能私訊自己名下的 AI
  assert.equal((await dm(liu.token, { aiId: pgC.participantId, text: '嗨' })).body.error?.code, 'DM_NOT_YOUR_AI');
  assert.equal((await dm(liu.token, { aiId: Cn, text: '嗨' })).body.error?.code, 'DM_NOT_YOUR_AI', '不能私訊人類');

  // 人類 → 自己的 AI：AI 收到 dm 通知、未讀數有算
  r = await dm(liu.token, { aiId: pgL.participantId, text: SECRET });
  assert.equal(r.status, 201); const d1 = r.body.dmId;
  const na = (await call(pgL.token, '/api/notifications?status=pending')).body.items;
  assert.ok(na.some(x => x.messageId === d1 && x.dm === true && x.reasons[0] === 'dm' && x.preview === SECRET), 'AI 收到私訊通知');
  assert.equal((await call(pgL.token, '/api/notifications/count')).body.pending, 1, '私訊算進未讀數（watcher 會叫醒）');
  // AI 讀、回：一律回給所屬人類（帶 aiId 也沒用）
  r = await call(pgL.token, '/api/dm');
  assert.equal(r.body.items[0].text, SECRET);
  r = await dm(pgL.token, { text: '收到，我看 C-262', aiId: pgC.participantId });
  assert.equal(r.status, 201, 'AI 回私訊');
  const nl = (await call(liu.token, '/api/notifications?status=pending')).body.items.find(x => x.dm);
  assert.ok(nl && nl.sender.participantId === pgL.participantId, '人類收到「我的 AI 回你了」');
  assert.equal((await call(pgC.token, '/api/dm')).body.items.length, 0, '別人的 AI 看不到');
  r = await call(pgC.token, `/api/dm?aiId=${pgL.participantId}`);
  assert.equal(r.status, 200); assert.equal(r.body.items.length, 0, 'AI 帶別人的 aiId 也只讀自己的對話（aiId 被忽略）');
  assert.ok(!JSON.stringify(r.body).includes(SECRET), 'AI 帶別人 aiId 讀不到別人的私訊');
  // 人類打開對話＝已讀
  r = await call(liu.token, `/api/dm?aiId=${pgL.participantId}`);
  assert.equal(r.body.items.length, 2); assert.equal(r.body.canSend, true);
  assert.ok(!(await call(liu.token, '/api/notifications?status=pending')).body.items.some(x => x.dm), '打開對話後通知已讀');

  // 第三者：讀不到內容、看不到數量
  assert.equal((await call(chen.token, `/api/dm?aiId=${pgL.participantId}`)).status, 403, '別人不能讀');
  assert.equal((await call(chen.token, `/api/messages/${d1}`)).status, 404, '私訊不在群組訊息');
  for (const tok of [liu.token, chen.token]) {
    const all = JSON.stringify((await call(tok, '/api/messages?limit=100')).body);
    assert.ok(!all.includes(SECRET), '群組訊息沒有私訊內容');
  }
  const team = (await call(chen.token, '/api/team-status')).body;
  assert.ok(!JSON.stringify(team).includes(SECRET), '團隊狀態沒有私訊內容');
  assert.equal(team.members.find(m => m.participantId === pgL.participantId).pendingCount, 0, '團隊狀態的待處理數不算私訊');
  assert.equal(team.unanswered.length, 0);

  // 冪等
  const same = { requestId: 'same', aiId: pgL.participantId, text: '同一則' };
  const a1 = await call(liu.token, '/api/dm', 'POST', same), a2 = await call(liu.token, '/api/dm', 'POST', same);
  assert.equal(a1.body.dmId, a2.body.dmId, '同 requestId 同內容＝同一則');
  assert.equal((await call(liu.token, '/api/dm', 'POST', { ...same, text: '不同' })).status, 409);

  // 關掉：舊私訊雙方看得到、不能再送
  await call(liu.token, '/api/projects/平台/dm', 'PUT', { on: false });
  assert.equal((await dm(liu.token, { aiId: pgL.participantId, text: '還能送嗎' })).body.error?.code, 'DM_DISABLED');
  assert.equal((await dm(pgL.token, { text: '還能回嗎' })).body.error?.code, 'DM_DISABLED');
  r = await call(liu.token, `/api/dm?aiId=${pgL.participantId}`);
  assert.equal(r.body.items.length, 3, '舊私訊還看得到'); assert.equal(r.body.canSend, false);
  assert.equal((await call(pgL.token, '/api/dm')).body.items.length, 3);
  const ev = (await call(liu.token, '/api/projects/平台/events?limit=5')).body.items || [];
  assert.ok(ev.some(e => /關閉成員私訊/.test(e.text)), '開關記在專案異動紀錄');
  console.log('dm-test：全部通過');
} catch (e) {
  console.error('dm-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} // Windows：資料庫檔還開著時刪不掉
}
