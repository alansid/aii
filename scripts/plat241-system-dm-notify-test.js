// PLAT-241 測試：平台通知（from 'system'）的私訊讓 GET /api/notifications 整個 500（昱志 10/24 收件匣「伺服器錯誤」）
// 修正後：通知列得出來、寄件人顯示「平台通知」、participantId 是那段對話的 AI（「打開私訊」開得到）；不因 'system' 每次重讀成員表
// 用法：node scripts/plat241-system-dm-notify-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p241-'));
const raw = openNodeDb(path.join(dataDir, 'switch.db'));
let reads = 0; // 整張成員表被讀幾次
const db = new Proxy(raw, { get: (t, k) => k === 'all' ? (sql, ...a) => { if (/^SELECT \* FROM participants$/.test(String(sql).trim())) reads++; return t.all(sql, ...a); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k] });
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const a = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name: 'PG一號', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  assert.ok(a.participantId, JSON.stringify(a));
  const ai = { id: a.participantId, tok: (await raw.get('SELECT token FROM participants WHERE id = ?', a.participantId)).token };
  // AI 同步技能失敗 → 平台通知私訊給主人（PLAT-240），跟技能新版通知一樣是 from 'system'
  const f = await call(ai.tok, '/api/me/skills/sync-status', 'POST', { state: 'failed', lastLine: '技能：pg-rules 下載失敗' });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.ok(await raw.get("SELECT 1 FROM dms WHERE from_id = 'system' AND human_id = ?", liu.participant.participantId), '有平台通知私訊');
  // 一般通知照舊：主人在群組點名 AI
  const m = await call(liu.token, '/api/messages', 'POST', { requestId: 'm1', project: '平台', text: '請看一下', replyFrom: [ai.id] });
  assert.equal(m.status, 201, JSON.stringify(m.body));

  // 1. 收件匣不再 500
  const n = await call(liu.token, '/api/notifications?status=pending&limit=50&order=desc');
  assert.equal(n.status, 200, '收件匣不能 500：' + JSON.stringify(n.body));
  const sys = n.body.items.find(x => x.preview.includes('同步技能失敗'));
  assert.ok(sys, '平台通知那則列得出來');
  assert.equal(sys.sender.name, '平台通知', '名稱同私訊對話裡的「平台通知」');
  assert.equal(sys.sender.participantId, ai.id, 'participantId 是那段對話的 AI，「打開私訊」才開得到');
  assert.equal(sys.dm, true);
  const an = await call(ai.tok, '/api/notifications');
  assert.equal(an.status, 200);
  const mine = an.body.items.find(x => x.preview === '請看一下');
  assert.equal(mine.sender.name, '劉昱志', '一般通知寄件人照舊');
  assert.equal(mine.sender.participantId, liu.participant.participantId);
  assert.ok(mine.sender.shortCode, '代碼照舊');
  // 待處理數（watcher 用）也走同一段
  assert.equal((await call(liu.token, '/api/notifications/count')).status, 200);
  // 私訊對話看得到、名稱一致
  const dm = await call(liu.token, `/api/dm?aiId=${ai.id}`);
  assert.equal(dm.body.items.find(x => x.from.participantId === 'system').from.name, '平台通知');

  // 2. 不因 'system' 每次重讀整張成員表
  await call(liu.token, '/api/dm/summary'); // 先暖好快取
  const sys2 = await call(ai.tok, '/api/me/skills/sync-status', 'POST', { state: 'failed', lastLine: '再一次失敗' });
  assert.equal(sys2.status, 200);
  reads = 0;
  for (let i = 0; i < 3; i++) assert.equal((await call(liu.token, '/api/notifications?status=pending&limit=50')).status, 200);
  assert.equal(reads, 0, `讀通知不該為了 'system' 重讀成員表（讀了 ${reads} 次）`);
  console.log('plat241-system-dm-notify-test：全部通過');
} catch (e) {
  console.error('plat241-system-dm-notify-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { raw.close?.(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
