// 團隊狀態驗收測試：狀態推斷、可能斷線、尚未回應、等人決定、Token 到期提醒。
// 用法：npm run test:team
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3997;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-team-'));
const ENV = { STALE_MINUTES: '0.03', UNANSWERED_MINUTES: '0.02', AI_TOKEN_TTL_HOURS: '1' }; // 約 1.8 秒、1.2 秒；Token 1 小時（< 2 小時會被提醒）

function startServer() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ...ENV }, stdio: 'pipe',
  });
  const ready = new Promise((res, rej) => {
    server.stdout.on('data', d => { if (String(d).includes('已啟動')) res(); });
    server.on('exit', c => rej(new Error('server exited ' + c)));
  });
  return { server, ready };
}
async function stopServer(server) {
  const exited = new Promise(res => server.once('exit', res));
  server.kill();
  await exited;
}
const call = async (token, p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let n = 0;
const post = (token, text, extra = {}) => call(token, '/api/messages', 'POST', { text, requestId: 'req_t' + (++n), ...extra }).then(r => r.body);

(async () => {
  let { server, ready } = startServer();
  await ready;
  try {
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'UX' })).body;
    const r = ROLES.find(x => x.key === 'PG');
    const mk = name => call(liu.token, '/api/my-ais', 'POST', { roleKey: 'PG', role: r.role, name, duties: r.duties,
      style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff }).then(x => x.body);
    const pg = await mk('劉昱志的程式開發助手');
    const po = await mk('劉昱志的產品規劃助手');
    assert.equal((await call(null, '/api/join', 'POST', { name: '平台通知' })).body.error.code, 'INVALID_REQUEST', '保留名稱');

    const team = () => call(liu.token, '/api/team-status').then(x => x.body);
    const member = (t, id) => t.members.find(m => m.participantId === id);

    // 從未連線的 AI → 可能斷線（尚未連線）
    let t = await team();
    assert.equal(member(t, pg.participantId).stale, true, '從未連線 → stale');
    assert.equal(member(t, pg.participantId).status, null, '沒有訊息 → 沒有狀態');

    // 狀態推斷
    await post(pg.token, '[AI 簽到] 我是程式開發助手');
    assert.equal(member(await team(), pg.participantId).status.state, 'idle', '簽到 → 空閒');
    assert.equal(member(await team(), pg.participantId).stale, false, '剛呼叫過 API → 不是 stale');
    await post(pg.token, '[接單] 實作團隊狀態列\n細節…');
    t = await team();
    assert.equal(member(t, pg.participantId).status.state, 'working', '接單 → 進行中');
    assert.equal(member(t, pg.participantId).status.title, '實作團隊狀態列', '取第一行當工作名稱');
    await post(pg.token, '一般聊天不帶標籤');
    assert.equal(member(await team(), pg.participantId).status.state, 'working', '沒標籤的訊息不改變狀態');
    await post(pg.token, '[UX 完成・請核准 commit] 原型完成');
    assert.equal(member(await team(), pg.participantId).status.state, 'idle', '[UX 完成・…] → 空閒');
    await post(pg.token, '[受阻] 等 BA 規格');
    assert.equal(member(await team(), pg.participantId).status.state, 'blocked', '受阻 → 卡住');

    // 等人決定：[需確認] 直到人類回覆
    const ask = await post(po.token, '[需確認] 是否先做 P1＋P4？');
    t = await team();
    assert.equal(member(t, po.participantId).status.state, 'waiting');
    assert.ok(t.decisions.some(d => d.messageId === ask.messageId), '列入等你決定');
    await post(pg.token, '[回覆] 技術上可行', { replyToMessageId: ask.messageId });
    assert.ok((await team()).decisions.some(d => d.messageId === ask.messageId), 'AI 回覆不算決定');
    await post(liu.token, 'OK 請開工', { replyToMessageId: ask.messageId });
    assert.ok(!(await team()).decisions.some(d => d.messageId === ask.messageId), '人類回覆後移出清單');

    // 尚未回應：指派超過時限仍未 ACK
    const assign = await post(liu.token, '請處理 X', { recipientIds: [pg.participantId] });
    assert.ok(!(await team()).unanswered.some(u => u.messageId === assign.messageId), '剛指派 → 還不算');
    await sleep(1500);
    t = await team();
    assert.ok(t.unanswered.some(u => u.messageId === assign.messageId && u.name === '劉昱志的程式開發助手'), '超過時限 → 尚未回應');
    assert.ok(member(t, pg.participantId).pendingCount >= 1);
    const notif = (await call(pg.token, '/api/notifications')).body.items.find(x => x.messageId === assign.messageId);
    await call(pg.token, '/api/notifications/ack', 'POST', { notificationIds: [notif.notificationId] });
    assert.ok(!(await team()).unanswered.some(u => u.messageId === assign.messageId), 'ACK 後移除');

    // 可能斷線：超過 stale 時限沒呼叫 API
    await sleep(2000);
    assert.equal(member(await team(), pg.participantId).stale, true, '超過時限 → 可能斷線');

    // Token 到期提醒：Token 1 小時 < 2 小時 → 排程提醒所屬人類；重啟不重複
    t = await team();
    assert.equal(member(t, pg.participantId).tokenExpiringSoon, true, 'Token 快到期');
    await stopServer(server);
    ({ server, ready } = startServer());
    await ready; await sleep(400); // 啟動時執行一次排程
    const msgs = (await call(liu.token, '/api/messages?limit=100')).body.items;
    const warns = msgs.filter(m => m.author.memberType === 'system');
    assert.equal(warns.length, 2, '兩個 AI 各一則提醒');
    assert.ok(warns.every(m => m.author.name === '平台通知' && m.recipients[0].name === '劉昱志' && m.text.includes('重發 Token')));
    const inbox = (await call(liu.token, '/api/notifications')).body.items;
    assert.ok(inbox.some(x => x.sender.name === '平台通知'), '所屬人類收到通知');
    await stopServer(server);
    ({ server, ready } = startServer());
    await ready; await sleep(400);
    const again = (await call(liu.token, '/api/messages?limit=100')).body.items.filter(m => m.author.memberType === 'system');
    assert.equal(again.length, 2, '同一個到期時間不重複提醒');

    // 系統身分不出現在成員名單與團隊狀態，也不收 @所有人
    assert.ok(!(await call(liu.token, '/api/participants')).body.items.some(p => p.name === '平台通知'));
    assert.ok(!(await team()).members.some(m => m.name === '平台通知'));
    const all = await post(liu.token, '全體注意', { audience: 'all' });
    assert.ok(!all.recipients.some(x => x.name === '平台通知'));

    console.log('team: all checks passed');
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
