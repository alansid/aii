// C-223 帳號密碼登入驗收測試：設定與修改、登入、錯誤訊息、同帳號鎖定、改密碼登出其他帳密裝置、帳號不重複、
// 邀請時順便設、重設登入清掉密碼、主機救援連結、AI 一律拒絕、只存雜湊、安全通知只給本人。
// 用法：npm run test:password
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ROLES } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3997;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pwd-'));
let logs = '';
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TEAM_CACHE_MS: '0', OPEN_JOIN: '0', AUTH_FAIL_LIMIT: '500' }, stdio: 'pipe',
});
const ready = new Promise((res, rej) => {
  server.stdout.on('data', d => { logs += d; if (String(d).includes('已啟動')) res(); });
  server.stderr.on('data', d => { logs += d; });
  server.on('exit', c => rej(new Error('server exited ' + c)));
});
const call = async (token, p, method = 'GET', body, headers = {}) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const iphone = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' };
const win = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };
const login = (username, password, h = win) => call(null, '/api/auth/password', 'POST', { username, password }, h);
const tokenOf = url => url.split('/invite/')[1];
const PW = 'correct horse 1';
const PW2 = 'battery staple 2';

(async () => {
  await ready;
  try {
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
    const liuDev = (await call(null, '/api/auth/code', 'POST', { code: liu.token })).body.token;
    const h = (await call(null, '/api/health')).body;
    assert.ok(h.loginMethods.includes('password') && h.loginMethods.includes('rescue'), '登入方式多了帳號密碼與救援');

    // 5. 第一次設定：帳號＋新密碼；檢查規則
    assert.deepEqual((await call(liuDev, '/api/me/password')).body, { set: false, username: null, updatedAt: null });
    let r = await call(liuDev, '/api/me/password', 'PUT', { username: 'ab', newPassword: PW });
    assert.equal(r.status, 400); assert.match(r.body.error.message, /4～30 字/);
    r = await call(liuDev, '/api/me/password', 'PUT', { username: 'yu chih', newPassword: PW });
    assert.equal(r.status, 400, '帳號不能有空白');
    r = await call(liuDev, '/api/me/password', 'PUT', { username: 'yuchih.admin', newPassword: 'short' });
    assert.equal(r.status, 400); assert.match(r.body.error.message, /至少 8 碼/);
    r = await call(liuDev, '/api/me/password', 'PUT', { username: 'yuchih.admin', newPassword: PW, newPasswordAgain: PW + 'x' });
    assert.equal(r.status, 400); assert.match(r.body.error.message, /不一樣/);
    r = await call(liuDev, '/api/me/password', 'PUT', { username: 'yuchih.admin' });
    assert.equal(r.status, 400, '第一次要有新密碼');
    r = await call(liuDev, '/api/me/password', 'PUT', { username: 'YuChih.Admin', newPassword: PW, newPasswordAgain: PW });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.set, true); assert.equal(r.body.username, 'yuchih.admin', '不分大小寫（存小寫）');
    assert.ok(r.body.updatedAt);
    assert.ok(!JSON.stringify(r.body).includes(PW) && !('pwd_hash' in r.body) && !('hash' in r.body), '6. 不回傳密碼或雜湊');

    // 6. 只存加鹽慢雜湊
    const sdb = new DatabaseSync(path.join(dataDir, 'switch.db'));
    const row = sdb.prepare('SELECT * FROM credentials').get();
    assert.match(row.pwd_hash, /^pbkdf2-sha256\$100000\$/);
    assert.ok(!row.pwd_hash.includes(PW));

    // 2～4. 登入成功：這台記住，「我的裝置」顯示「帳號密碼登入 · Safari（iPhone）」
    r = await login('YUCHIH.admin', PW, iphone);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pwdDev1 = r.body.token;
    assert.match(pwdDev1, /^dv_/);
    assert.equal(r.body.participant.name, '劉昱志');
    const devs = (await call(liuDev, '/api/devices')).body.items;
    assert.ok(devs.some(d => d.label === '帳號密碼登入 · Safari（iPhone）'), JSON.stringify(devs));
    // 8. 安全通知只給本人：收件匣的安全通知，不是群組訊息
    let notes = (await call(liuDev, '/api/me/notices')).body.items;
    assert.equal(notes.length, 1); assert.equal(notes[0].kind, 'password_login'); assert.equal(notes[0].detail, '帳號密碼登入 · Safari（iPhone）');
    const msgs = (await call(liuDev, '/api/messages?limit=50')).body.items || [];
    assert.ok(!msgs.some(m => /帳號密碼/.test(m.text)), '不發群組訊息');

    // 3. 錯誤只說「帳號或密碼不對」，不分哪個錯
    const wrongPw = await login('yuchih.admin', 'wrong password!');
    const noUser = await login('nobody.here', 'wrong password!');
    assert.equal(wrongPw.status, 400); assert.equal(noUser.status, 400);
    assert.equal(wrongPw.body.error.message, '帳號或密碼不對。');
    assert.equal(noUser.body.error.message, wrongPw.body.error.message, '帳號不存在與密碼錯同一句');
    assert.equal(noUser.body.error.code, wrongPw.body.error.code);
    // 連錯 5 次鎖 15 分鐘；鎖住時密碼對也不放行（前面已錯 1 次）
    for (let i = 0; i < 3; i++) assert.equal((await login('yuchih.admin', 'wrong password!')).status, 400);
    r = await login('yuchih.admin', 'wrong password!');
    assert.equal(r.status, 429, '第 5 次就鎖'); assert.equal(r.body.error.code, 'ACCOUNT_LOCKED');
    assert.equal(r.body.error.message, '輸錯太多次，請 15 分鐘後再試。');
    r = await login('yuchih.admin', PW);
    assert.equal(r.status, 429, '鎖住時密碼對也不放行');
    // 不存在的帳號也一樣會鎖（不透露帳號有沒有人用）
    for (let i = 0; i < 4; i++) await login('nobody.here', 'wrong password!');
    assert.equal((await login('nobody.here', 'wrong password!')).status, 429);
    // 解鎖（模擬 15 分鐘後）
    sdb.prepare('UPDATE login_fails SET locked_until = ?').run(Date.now() - 60_000);
    r = await login('yuchih.admin', PW);
    assert.equal(r.status, 200, '15 分鐘後可以再登入 ' + JSON.stringify(r.body));
    const pwdDev2 = r.body.token;
    // 成功後計數歸零：再錯 4 次不會鎖
    for (let i = 0; i < 4; i++) assert.equal((await login('yuchih.admin', 'wrong password!')).status, 400);
    assert.equal((await login('yuchih.admin', PW)).status, 200);

    // 7. 改密碼：要先填目前密碼；其他帳密登入的裝置一起登出，這台不登出，配對／登入碼裝置不受影響
    r = await call(pwdDev1, '/api/me/password', 'PUT', { currentPassword: 'nope nope nope', newPassword: PW2, newPasswordAgain: PW2 });
    assert.equal(r.status, 400); assert.equal(r.body.error.code, 'WRONG_PASSWORD');
    r = await call(pwdDev1, '/api/me/password', 'PUT', { newPassword: PW2, newPasswordAgain: PW2 });
    assert.equal(r.status, 400, '沒填目前密碼不能改');
    r = await call(pwdDev1, '/api/me/password', 'PUT', { currentPassword: PW, newPassword: PW2, newPasswordAgain: PW2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.loggedOut, 2, '其他兩台帳密裝置登出');
    assert.equal((await call(pwdDev1, '/api/me')).status, 200, '這台不登出');
    assert.equal((await call(pwdDev2, '/api/me')).status, 401, '其他帳密裝置登出');
    assert.equal((await call(liuDev, '/api/me')).status, 200, '登入碼換的裝置不受影響');
    assert.equal((await login('yuchih.admin', PW)).status, 400, '舊密碼失效');
    assert.equal((await login('yuchih.admin', PW2)).status, 200, '新密碼可用');
    // 只改帳號（要目前密碼），不登出別台
    r = await call(liuDev, '/api/me/password', 'PUT', { username: 'yuchih', currentPassword: PW2 });
    assert.equal(r.status, 200); assert.equal(r.body.username, 'yuchih'); assert.equal(r.body.loggedOut, 0);
    assert.equal((await login('yuchih', PW2)).status, 200);
    r = await call(liuDev, '/api/me/password', 'PUT', { username: 'yuchih', currentPassword: PW2 });
    assert.equal(r.status, 400, '沒有要改的內容');

    // 10. AI 不能設也不能用帳密登入
    const rr = ROLES.find(x => x.key === 'PG');
    const ai = (await call(liuDev, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: rr.role, name: '劉PG', duties: rr.duties, style: rr.style, autonomy: rr.autonomy, mustConfirm: rr.mustConfirm, handoff: rr.handoff })).body;
    r = await call(ai.token, '/api/me/password', 'PUT', { username: 'ai.user', newPassword: PW, newPasswordAgain: PW });
    assert.equal(r.status, 403, 'AI 不能設帳密');
    assert.equal((await call(ai.token, '/api/me/password')).status, 403);
    assert.equal((await call(ai.token, '/api/me/notices')).status, 403, 'AI 讀不到安全通知');
    // 就算資料庫被塞了 AI 的帳密也不放行
    sdb.prepare('INSERT INTO credentials (participant_id, username, pwd_hash, updated_at) SELECT ?, ?, pwd_hash, 0 FROM credentials LIMIT 1').run(ai.participantId, 'ai.sneaky');
    assert.equal((await login('ai.sneaky', PW2)).status, 400, 'AI 一律拒絕');
    sdb.prepare('DELETE FROM credentials WHERE participant_id = ?').run(ai.participantId);

    // 12. 邀請時順便設帳號密碼（選填）
    let inv = (await call(liuDev, '/api/invites', 'POST', { name: '王小明', projects: ['平台'] })).body;
    let tok = tokenOf(inv.url);
    r = await call(null, '/api/auth/invite', 'POST', { token: tok, name: '王小明', username: 'xiaoming.wang' });
    assert.equal(r.status, 400, '填了一格就要三格都對'); assert.match(r.body.error.message, /至少 8 碼/);
    // 13. 帳號全群組不重複（不分大小寫）
    r = await call(null, '/api/auth/invite', 'POST', { token: tok, name: '王小明', username: 'YUCHIH', password: PW, passwordAgain: PW });
    assert.equal(r.status, 409); assert.equal(r.body.error.message, '這個帳號已經有人用了，換一個。');
    r = await call(null, '/api/auth/invite', 'POST', { token: tok, name: '王小明', username: 'xiaoming.wang', password: PW, passwordAgain: PW + '!' });
    assert.equal(r.status, 400, '兩次不一樣');
    assert.equal((await call(null, '/api/auth/invite/peek', 'POST', { token: tok })).body.valid, true, '檢查沒過時邀請連結還能用');
    r = await call(null, '/api/auth/invite', 'POST', { token: tok, name: '王小明', username: 'Xiaoming.Wang', password: PW, passwordAgain: PW }, iphone);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const wangDev = r.body.token, wangId = r.body.participant.participantId;
    assert.equal((await call(wangDev, '/api/me/password')).body.username, 'xiaoming.wang');
    assert.equal((await login('xiaoming.wang', PW)).status, 200, '非管理員設過帳密就能登入');
    // 不設也能加入（三格都空）
    inv = (await call(liuDev, '/api/invites', 'POST', { name: '李大華', projects: ['平台'] })).body;
    r = await call(null, '/api/auth/invite', 'POST', { token: tokenOf(inv.url), name: '李大華', username: '', password: '', passwordAgain: '' });
    assert.equal(r.status, 200);
    const leeDev = r.body.token;
    assert.equal((await call(leeDev, '/api/me/password')).body.set, false);
    // 13. 修改時也檢查重複
    r = await call(leeDev, '/api/me/password', 'PUT', { username: 'xiaoming.wang', newPassword: PW, newPasswordAgain: PW });
    assert.equal(r.status, 409);
    // C-239：最短 8 碼——7 碼被擋、剛好 8 碼可以存、可以登入
    r = await call(leeDev, '/api/me/password', 'PUT', { username: 'dahua.lee', newPassword: '1234567', newPasswordAgain: '1234567' });
    assert.equal(r.status, 400, 'C-239：7 碼被擋'); assert.match(r.body.error.message, /至少 8 碼/);
    assert.equal((await call(leeDev, '/api/me/password', 'PUT', { username: 'dahua.lee', newPassword: '12345678', newPasswordAgain: '12345678' })).status, 200, 'C-239：8 碼可存（補設）');
    assert.equal((await login('dahua.lee', '12345678')).status, 200, 'C-239：8 碼可以登入');
    await call(leeDev, '/api/me/notices/read', 'POST', { ids: (await call(leeDev, '/api/me/notices')).body.items.map(n => n.id) }); // 剛才的登入通知先讀掉
    // 安全通知只給本人
    assert.equal((await call(leeDev, '/api/me/notices')).body.items.length, 0);
    const wangNotes = (await call(wangDev, '/api/me/notices')).body.items;
    assert.equal(wangNotes.length, 1, '王小明自己收到帳密登入通知');
    assert.equal((await call(leeDev, '/api/me/notices/read', 'POST', { ids: [wangNotes[0].id] })).status, 200);
    assert.equal((await call(wangDev, '/api/me/notices')).body.items.length, 1, '別人不能把我的通知標已讀');
    await call(wangDev, '/api/me/notices/read', 'POST', { ids: [wangNotes[0].id] });
    assert.equal((await call(wangDev, '/api/me/notices')).body.items.length, 0);

    // 14. 管理員「重設登入」一起清掉帳號密碼，可用新邀請連結重設
    r = await call(liuDev, `/api/participants/${wangId}/reset-login`, 'POST');
    assert.equal(r.status, 200);
    assert.equal((await login('xiaoming.wang', PW)).status, 400, '密碼清掉');
    r = await call(null, '/api/auth/invite', 'POST', { token: tokenOf(r.body.url), username: 'xiaoming.wang', password: PW2, passwordAgain: PW2 });
    assert.equal(r.status, 200, '重設登入的連結也能順便設：' + JSON.stringify(r.body));
    assert.equal(r.body.participant.participantId, wangId);
    assert.equal((await login('xiaoming.wang', PW2)).status, 200);

    // 9. 主機救援：只能在主機跑，一次性、15 分鐘、只救管理員，用了發通知
    await call(liuDev, '/api/me/notices/read', 'POST', { ids: (await call(liuDev, '/api/me/notices')).body.items.map(n => n.id) });
    const out = spawnSync(process.execPath, [path.join(__dirname, 'admin-rescue.js'), '--local', dataDir, '--base', BASE], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    const url = out.stdout.match(/https?:\/\/\S+\/rescue\/(\S+)/);
    assert.ok(url, out.stdout);
    const rtok = url[1];
    assert.ok(!logs.includes(rtok), '伺服器日誌沒有救援連結');
    const linkRow = sdb.prepare('SELECT * FROM rescue_links').get();
    assert.ok(linkRow.created_by.includes('@'), '記下誰產生');
    assert.ok(linkRow.expires_at - linkRow.created_at === 15 * 60_000);
    assert.ok(!JSON.stringify(linkRow).includes(rtok), '只存雜湊');
    notes = (await call(liuDev, '/api/me/notices')).body.items;
    assert.ok(notes.some(n => n.kind === 'rescue_link'), '產生時通知管理員');
    r = await call(null, '/api/auth/rescue', 'POST', { token: rtok }, win);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.participant.name, '劉昱志', '救的是管理員');
    assert.ok((await call(liuDev, '/api/devices')).body.items.some(d => d.label === '救援登入 · Chrome（Windows）'));
    notes = (await call(liuDev, '/api/me/notices')).body.items;
    assert.ok(notes.some(n => n.kind === 'rescue_login' && n.detail === '救援登入 · Chrome（Windows）'), '用了也發通知');
    r = await call(null, '/api/auth/rescue', 'POST', { token: rtok });
    assert.equal(r.status, 400, '用一次就失效'); assert.equal(r.body.error.code, 'RESCUE_INVALID');
    // 過期
    spawnSync(process.execPath, [path.join(__dirname, 'admin-rescue.js'), '--local', dataDir, '--base', BASE], { encoding: 'utf8' });
    const out2 = spawnSync(process.execPath, [path.join(__dirname, 'admin-rescue.js'), '--local', dataDir, '--base', BASE], { encoding: 'utf8' });
    const rtok2 = out2.stdout.match(/\/rescue\/(\S+)/)[1];
    sdb.prepare('UPDATE rescue_links SET expires_at = ? WHERE used_at IS NULL').run(Date.now() - 60_000);
    assert.equal((await call(null, '/api/auth/rescue', 'POST', { token: rtok2 })).status, 400, '15 分鐘後失效');
    assert.equal(sdb.prepare('SELECT COUNT(*) AS n FROM rescue_links').get().n, 3, '每次產生都有紀錄');
    // 網頁沒有產生救援連結的 API
    for (const p of ['/api/rescue', '/api/admin/rescue', '/api/auth/rescue/create']) assert.notEqual((await call(liuDev, p, 'POST', {})).status, 200);

    // 6. 密碼沒有進日誌
    assert.ok(![PW, PW2].some(p => logs.includes(p)), '日誌沒有密碼');
    sdb.close();
    console.log('password-test 全部通過');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
