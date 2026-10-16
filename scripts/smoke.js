// 冒煙測試：用暫存資料庫啟動 server，走過接入協定的主要行為。
// 用法：npm run smoke
//       SMOKE_BASE=http://localhost:8787 npm run smoke   （對已啟動的服務測試，例如 wrangler dev）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = 3999;
const EXTERNAL = process.env.SMOKE_BASE;
const BASE = EXTERNAL || `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-switch-'));

async function call(token, p, method = 'GET', body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
}
const errCode = r => r.body?.error?.code;

function startServer(env = {}) {
  if (EXTERNAL) return { server: null, ready: Promise.resolve() };
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ...env }, stdio: 'pipe',
  });
  const ready = new Promise((res, rej) => {
    server.stdout.on('data', d => { if (String(d).includes('已啟動')) res(); });
    server.on('exit', c => rej(new Error('server exited ' + c)));
  });
  return { server, ready };
}
async function stopServer(server) {
  if (!server) return;
  const exited = new Promise(res => server.once('exit', res));
  server.kill();
  await exited; // Windows 需等程序結束、釋放資料庫檔案
}

(async () => {
  let { server, ready } = startServer();
  await ready;
  try {
    // 加入
    const percy = (await call(null, '/api/join', 'POST', { name: 'Percy', role: 'PO' })).body;
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'UX' })).body;
    assert.ok(percy.token && liu.token, 'join');
    // C-146 B：之後加入的人類預設沒有專案，由群組管理員（最早加入的 Percy）加入
    assert.equal((await call(percy.token, `/api/participants/${liu.participant.participantId}/projects`, 'PUT', { projects: ['平台', '銀行系統'] })).status, 200, '管理員把劉昱志加入專案');
    assert.equal(errCode(await call(null, '/api/join', 'POST', { name: 'percy' })), 'NAME_TAKEN');

    // 角色範本
    const roles = (await call(null, '/api/roles')).body;
    for (const k of ['PO', 'PM', 'SM', 'BA', 'SA', 'SD', 'UX', 'PG', 'DBA', 'QA', 'SEC', 'SRE', 'TW', 'DA', 'custom']) {
      assert.ok(roles.items.some(r => r.key === k), `角色 ${k}`);
    }
    for (const r of ROLES) {
      for (const f of ['role', 'suffix', 'duties', 'style', 'autonomy', 'mustConfirm', 'handoff']) {
        assert.ok(r[f] && r[f].length <= 1000, `${r.key}.${f}`);
      }
    }

    // 建立 AI：六題必填
    const ux = ROLES.find(r => r.key === 'UX');
    const aiBody = { projects: ['平台', '銀行系統'], roleKey: 'UX', role: ux.role, name: '劉昱志的使用體驗助手', duties: ux.duties, style: ux.style,
      autonomy: ux.autonomy, mustConfirm: ux.mustConfirm, handoff: ux.handoff };
    assert.equal(errCode(await call(liu.token, '/api/my-ais', 'POST', { ...aiBody, style: '   ' })), 'INVALID_REQUEST', '空白題目被拒');
    const ai = (await call(liu.token, '/api/my-ais', 'POST', aiBody)).body;
    assert.ok(ai.token && ai.expiresAt, 'create ai');
    assert.equal(errCode(await call(ai.token, '/api/my-ais')), 'FORBIDDEN');
    const me = (await call(ai.token, '/api/me')).body;
    assert.equal(me.memberType, 'ai');
    assert.equal(me.ownerName, '劉昱志');
    assert.equal(me.settings.mustConfirm, ux.mustConfirm);

    // 首次基準：只拿 nextCursor
    await call(percy.token, '/api/messages', 'POST', { text: '歷史訊息', requestId: 'req_h1' });
    const baseline = (await call(ai.token, '/api/messages?limit=50')).body;
    assert.equal(baseline.items.length, 1);

    // 發文：requestId 必填、@名字不通知、recipientIds 才通知
    assert.equal(errCode(await call(percy.token, '/api/messages', 'POST', { text: 'x' })), 'INVALID_REQUEST');
    const plain = await call(percy.token, '/api/messages', 'POST', { text: '@劉昱志的使用體驗助手 只是文字', requestId: 'req_p1' });
    assert.deepEqual(plain.body.recipients, [], '正文 @ 不通知');
    const m1 = await call(percy.token, '/api/messages', 'POST', {
      text: '請設計原型', requestId: 'req_p2', recipientIds: [ai.participantId] });
    assert.equal(m1.status, 201);

    // 增量讀取
    const inc = (await call(ai.token, `/api/messages?limit=50&after=${baseline.nextCursor}`)).body;
    assert.deepEqual(inc.items.map(m => m.text), ['@劉昱志的使用體驗助手 只是文字', '請設計原型']);
    assert.equal(errCode(await call(ai.token, '/api/messages?after=garbage')), 'INVALID_CURSOR');

    // 通知與 ACK
    const notif = (await call(ai.token, '/api/notifications?status=pending')).body;
    assert.equal(notif.items.length, 1);
    assert.deepEqual(notif.items[0].reasons, ['mention']);

    // 冪等：同 requestId 同內容 → 200；不同內容 → 409
    const ack = { text: '[接單] 收到', requestId: 'req_ack_' + m1.body.messageId, replyToMessageId: m1.body.messageId };
    const r1 = await call(ai.token, '/api/messages', 'POST', ack);
    const r2 = await call(ai.token, '/api/messages', 'POST', ack);
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 200);
    assert.equal(r1.body.messageId, r2.body.messageId);
    assert.equal(errCode(await call(ai.token, '/api/messages', 'POST', { ...ack, text: '不同內容' })), 'IDEMPOTENCY_CONFLICT');

    const pNotif = (await call(percy.token, '/api/notifications')).body;
    assert.deepEqual(pNotif.items[0].reasons, ['reply'], '被回覆者收到 reply 通知');

    const acked = (await call(ai.token, '/api/notifications/ack', 'POST', { notificationIds: [notif.items[0].notificationId, m1.body.messageId] })).body;
    assert.deepEqual(acked.confirmedIds, [notif.items[0].notificationId], 'messageId 不會被當成通知');
    assert.equal((await call(ai.token, '/api/notifications')).body.items.length, 0);

    // @所有人
    assert.equal(errCode(await call(percy.token, '/api/messages', 'POST',
      { text: 'x', requestId: 'req_bad', audience: 'all', recipientIds: [ai.participantId] })), 'INVALID_REQUEST');
    const all = (await call(percy.token, '/api/messages', 'POST', { text: '全員注意', requestId: 'req_all', audience: 'all' })).body;
    assert.equal(all.audience, 'all');
    const allN = (await call(ai.token, '/api/notifications')).body.items;
    assert.deepEqual(allN[0].reasons, ['all']);

    // 載入更早歷史
    const latest = (await call(liu.token, '/api/messages?limit=2')).body;
    assert.equal(latest.hasMore, true);
    const older = (await call(liu.token, `/api/messages?limit=100&before=${latest.olderCursor}`)).body;
    assert.ok(older.items.length >= 1 && older.items.at(-1).sequence < latest.items[0].sequence);

    // 複製到我的 AI
    const onboarding = (await call(liu.token, `/api/my-ais/${ai.participantId}/onboarding`)).body.text;
    for (const s of [ai.token, '/api/docs/ai-integration', ux.mustConfirm, 'req_checkin_' + ai.participantId, 'state.json']) {
      assert.ok(onboarding.includes(s), `onboarding 含 ${s.slice(0, 20)}`);
    }

    // 重發與停用
    const re = (await call(liu.token, `/api/my-ais/${ai.participantId}/reissue`, 'POST')).body;
    assert.notEqual(re.token, ai.token);
    assert.equal(errCode(await call(ai.token, '/api/me')), 'INVALID_TOKEN', '舊 Token 失效');
    await call(liu.token, `/api/my-ais/${ai.participantId}/disable`, 'POST');
    assert.equal(errCode(await call(re.token, '/api/me')), 'INVALID_TOKEN', '停用');
    await call(liu.token, `/api/my-ais/${ai.participantId}/enable`, 'POST');

    // 文件與靜態檔
    const doc = await (await fetch(BASE + '/api/docs/ai-integration')).text();
    assert.ok(doc.includes(BASE) && !doc.includes('{{BASE_URL}}'));
    assert.equal((await fetch(BASE + '/')).status, 200);
    const traversal = await (await fetch(BASE + '/..%2fserver.js')).text();
    assert.ok(!traversal.includes('createServer') && !traversal.includes('import '), '不可讀取 public 以外的檔案');

    // Token 過期：以極短 TTL 重啟（外部服務無法改設定，略過）
    if (EXTERNAL) { console.log('smoke: all checks passed (external, TTL test skipped)'); return; }
    await stopServer(server);
    ({ server, ready } = startServer({ AI_TOKEN_TTL_HOURS: '0.0000001' }));
    await ready;
    const re2 = (await call(liu.token, `/api/my-ais/${ai.participantId}/reissue`, 'POST')).body;
    await new Promise(r => setTimeout(r, 50));
    assert.equal(errCode(await call(re2.token, '/api/me')), 'TOKEN_EXPIRED');

    console.log('smoke: all checks passed');
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
