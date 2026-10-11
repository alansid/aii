// 冒煙測試：啟動一個暫存資料庫的 server，跑過人類加入、建立 AI、發訊息、通知、游標、冪等與 Token 重發。
// 用法：npm run smoke
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-switch-'));

async function call(token, p, method = 'GET', body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir }, stdio: 'pipe',
  });
  await new Promise((res, rej) => {
    server.stdout.on('data', d => { if (String(d).includes('已啟動')) res(); });
    server.on('exit', c => rej(new Error('server exited ' + c)));
  });
  try {
    const percy = (await call(null, '/api/join', 'POST', { name: 'Percy', role: 'PO' })).body;
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'UX' })).body;
    assert.ok(percy.token && liu.token, 'join');
    assert.equal((await call(null, '/api/join', 'POST', { name: 'percy' })).body.error.code, 'NAME_TAKEN');

    const ai = (await call(liu.token, '/api/my-ais', 'POST', { name: '劉昱志的使用體驗助手', role: '使用體驗', duties: '設計流程' })).body;
    assert.ok(ai.token, 'create ai');
    assert.equal((await call(ai.token, '/api/my-ais')).body.error.code, 'HUMAN_ONLY');

    const m1 = await call(percy.token, '/api/messages', 'POST', { text: '@劉昱志的使用體驗助手 請設計原型' });
    assert.equal(m1.status, 201);
    assert.deepEqual(m1.body.recipients.map(r => r.name), ['劉昱志的使用體驗助手'], '@ 長名稱優先，不誤中 @劉昱志');

    const page1 = (await call(ai.token, '/api/messages?limit=50')).body;
    assert.equal(page1.items.length, 1);
    const notif = (await call(ai.token, '/api/notifications?status=pending')).body;
    assert.equal(notif.items.length, 1);
    assert.deepEqual(notif.items[0].reasons, ['mention']);

    const ack = { text: '[接單] 收到', requestId: 'req_ack_' + m1.body.messageId, replyToMessageId: m1.body.messageId };
    const r1 = await call(ai.token, '/api/messages', 'POST', ack);
    const r2 = await call(ai.token, '/api/messages', 'POST', ack);
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.duplicate, true);
    assert.equal(r1.body.messageId, r2.body.messageId, '冪等');

    const pNotif = (await call(percy.token, '/api/notifications')).body;
    assert.deepEqual(pNotif.items[0].reasons, ['reply'], '被回覆者收到 reply 通知');

    await call(ai.token, `/api/notifications/${notif.items[0].notificationId}/ack`, 'POST');
    assert.equal((await call(ai.token, '/api/notifications')).body.items.length, 0, 'ack');

    const page2 = (await call(ai.token, `/api/messages?after=${page1.nextCursor}`)).body;
    assert.equal(page2.items.length, 1, '游標只回傳之後的訊息');
    assert.equal(page2.items[0].messageId, r1.body.messageId);
    const page3 = (await call(ai.token, `/api/messages?after=${page2.nextCursor}`)).body;
    assert.equal(page3.items.length, 0);
    assert.equal(page3.nextCursor, page2.nextCursor, '無新訊息時游標不變');

    const re = (await call(liu.token, `/api/my-ais/${ai.participantId}/reissue`, 'POST')).body;
    assert.notEqual(re.token, ai.token);
    assert.equal((await call(ai.token, '/api/me')).body.error.code, 'INVALID_TOKEN', '舊 Token 失效');

    await call(liu.token, `/api/my-ais/${ai.participantId}/disable`, 'POST');
    assert.equal((await call(re.token, '/api/me')).body.error.code, 'TOKEN_EXPIRED', '停用');

    const onboarding = (await call(liu.token, `/api/my-ais/${ai.participantId}/onboarding`)).body.text;
    assert.ok(onboarding.includes(re.token) && onboarding.includes('/docs/ai-guide.md'));

    const guide = await (await fetch(BASE + '/docs/ai-guide.md')).text();
    assert.ok(guide.includes(BASE) && !guide.includes('{{BASE_URL}}'));
    assert.equal((await fetch(BASE + '/')).status, 200);
    assert.equal((await fetch(BASE + '/..%2fserver.js')).status, 404, '不可讀取 public 以外的檔案');

    console.log('smoke: all checks passed');
  } finally {
    const exited = new Promise(res => server.once('exit', res));
    server.kill();
    await exited; // Windows 需等程序結束、釋放資料庫檔案後才能刪除
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
