// 新登入（C-202）驗收測試：邀請連結、被邀請頁資料、裝置與 6 位數配對、登入碼長期保留／換一組、重設登入、AI Token 不變。
// 用法：npm run test:login
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3996;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-login-'));

// 正式環境的設定：不開放自己加入（OPEN_JOIN=0）
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TEAM_CACHE_MS: '0', OPEN_JOIN: '0', AUTH_FAIL_LIMIT: '15' }, stdio: 'pipe',
});
const ready = new Promise((res, rej) => {
  server.stdout.on('data', d => { if (String(d).includes('已啟動')) res(); });
  server.on('exit', c => rej(new Error('server exited ' + c)));
});
const call = async (token, p, method = 'GET', body, headers = {}) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ua = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' };
const tokenOf = url => url.split('/invite/')[1];

(async () => {
  await ready;
  try {
    // 群組還沒有人：登入頁顯示「建立群組」，第一位可以自己加入（成為管理員）
    let h = (await call(null, '/api/health')).body;
    assert.equal(h.setup, true, '沒有人類時 setup=true');
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
    assert.ok(liu.token, '第一位人類可以自己加入');
    h = (await call(null, '/api/health')).body;
    assert.equal(h.setup, false);
    assert.equal(h.adminName, '劉昱志', '登入頁顯示管理員名字');
    assert.deepEqual(h.loginMethods, ['invite', 'pair', 'code', 'password', 'rescue'], '身分來源是可替換的一層（C-223 加帳號密碼、主機救援）');
    // 9. 拿掉群組密碼自己加入
    const j2 = await call(null, '/api/join', 'POST', { name: '路人', role: 'PG' });
    assert.equal(j2.status, 403);
    assert.equal(j2.body.error.code, 'JOIN_CLOSED');
    assert.match(j2.body.error.message, /劉昱志/);

    // 把劉昱志的網頁換成裝置登入（網頁登入後自動用登入碼換）
    const liuDev = (await call(null, '/api/auth/code', 'POST', { code: liu.token })).body.token;
    assert.match(liuDev, /^dv_/, '登入碼換成這台裝置的登入');
    const meDev = (await call(liuDev, '/api/me')).body;
    assert.equal(meDev.authKind, 'device');
    assert.equal((await call(liu.token, '/api/me')).body.authKind, 'code');

    // AI（12. AI 的 Token 不變）
    const r = ROLES.find(x => x.key === 'PG');
    const ai = (await call(liuDev, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: r.role, name: '劉PG', duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff })).body;
    assert.equal((await call(ai.token, '/api/me')).status, 200);
    assert.equal((await call(null, '/api/auth/code', 'POST', { code: ai.token })).body.error.code, 'AI_TOKEN', 'AI Token 不能登入網頁');

    // 1. 只有管理員能邀請：名字、角色、專案 → 一次性連結；C-308 起預設 24 小時
    const inv = await call(liuDev, '/api/invites', 'POST', { name: '王小明', role: 'UX', projects: ['平台'] });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.match(inv.body.url, /\/invite\/[A-Za-z0-9_-]{40,}$/);
    const left = Date.parse(inv.body.invite.expiresAt) - Date.now();
    assert.ok(left > 23.9 * 3_600_000 && left <= 24 * 3_600_000, '預設 24 小時有效（C-308）');
    assert.equal(inv.body.invite.status, '有效');
    assert.equal((await call(liuDev, '/api/invites', 'POST', { name: '王小明' })).body.error.code, 'INVITE_EXISTS', '同名已有有效邀請');
    assert.equal((await call(liuDev, '/api/invites', 'POST', { name: '劉昱志' })).body.error.code, 'NAME_TAKEN');

    // 2. 重新產生：舊的立刻失效
    const t1 = tokenOf(inv.body.url);
    const regen = (await call(liuDev, `/api/invites/${inv.body.invite.id}/regenerate`, 'POST')).body;
    const t2 = tokenOf(regen.url);
    assert.notEqual(t1, t2);
    assert.equal((await call(null, '/api/auth/invite/peek', 'POST', { token: t1 })).body.valid, false, '重新產生後舊連結失效');
    // 5. 打開有效連結看到的資料
    const peek = (await call(null, '/api/auth/invite/peek', 'POST', { token: t2 })).body;
    assert.equal(peek.valid, true);
    assert.equal(peek.inviterName, '劉昱志');
    assert.equal(peek.groupName, '昱志的血汗勞工');
    assert.equal(peek.name, '王小明');
    assert.equal(peek.role, 'UX');
    assert.deepEqual(peek.projects.map(p => p.name), ['平台']);

    // 加入（可改名字）→ 這台裝置記住
    const join = await call(null, '/api/auth/invite', 'POST', { token: t2, name: '王小明' }, ua);
    assert.equal(join.status, 200, JSON.stringify(join.body));
    const wangDev = join.body.token;
    assert.match(wangDev, /^dv_/);
    const wang = (await call(wangDev, '/api/me')).body;
    assert.equal(wang.name, '王小明');
    assert.deepEqual(wang.projects, ['平台'], '專案照邀請');
    assert.equal(wang.role, 'UX');
    // 6. 用過就失效（不分原因）
    const again = await call(null, '/api/auth/invite', 'POST', { token: t2, name: '王小明2' });
    assert.equal(again.body.error.code, 'INVITE_INVALID');
    const peek2 = (await call(null, '/api/auth/invite/peek', 'POST', { token: t2 })).body;
    assert.deepEqual(peek2, { valid: false, adminName: '劉昱志' }, '失效只回管理員名字，不說原因');
    // 4. 通知管理員「X 已加入」
    const notes = (await call(liuDev, '/api/notifications?status=pending&limit=50')).body.items;
    assert.ok(notes.some(n => /王小明 已加入/.test(n.preview)), '管理員收到「王小明 已加入」');
    // 3. 邀請清單：已使用
    let list = (await call(liuDev, '/api/invites')).body.items;
    assert.equal(list.find(i => i.name === '王小明').status, '已使用');
    assert.equal(list.find(i => i.name === '王小明').usedByName, '王小明');
    assert.equal((await call(wangDev, '/api/invites')).body.error.code, 'NOT_ADMIN', '只有管理員看得到邀請');
    assert.equal((await call(wangDev, '/api/invites', 'POST', { name: '某人' })).body.error.code, 'NOT_ADMIN', '只有管理員能邀請');

    // 取消、重發
    const inv2 = (await call(liuDev, '/api/invites', 'POST', { name: '陳大華', role: 'QA', projects: [] })).body;
    await call(liuDev, `/api/invites/${inv2.invite.id}/cancel`, 'POST');
    assert.equal((await call(null, '/api/auth/invite/peek', 'POST', { token: tokenOf(inv2.url) })).body.valid, false, '取消後失效');
    list = (await call(liuDev, '/api/invites')).body.items;
    assert.equal(list.find(i => i.name === '陳大華').status, '已取消');
    const re = (await call(liuDev, `/api/invites/${inv2.invite.id}/regenerate`, 'POST')).body;
    assert.equal(re.invite.status, '有效', '重發：同樣內容、新連結');
    assert.equal(re.invite.role, 'QA');
    assert.equal((await call(liuDev, '/api/invites')).body.items.filter(i => i.name === '陳大華').length, 1, '重發不多一筆');
    assert.equal((await call(liuDev, `/api/invites/${inv.body.invite.id}/regenerate`, 'POST')).body.error.code, 'INVITE_USED');
    const chen = (await call(null, '/api/auth/invite', 'POST', { token: tokenOf(re.url), name: '陳小華' })).body;
    assert.equal(chen.participant.name, '陳小華', '被邀請的人可以改名字');
    assert.deepEqual(chen.participant.projects, [], '沒選專案＝還沒有專案');

    // 7. 我的裝置：列每台，可登出這台；配對碼 6 位數、5 分鐘、一次性
    let devs = (await call(wangDev, '/api/devices')).body.items;
    assert.equal(devs.length, 1);
    assert.equal(devs[0].label, 'Safari · iPhone', '列出瀏覽器');
    assert.equal(devs[0].current, true);
    const pc = (await call(wangDev, '/api/devices/pair-code', 'POST')).body;
    assert.match(pc.code, /^\d{6}$/);
    const pl = Date.parse(pc.expiresAt) - Date.now();
    assert.ok(pl > 4 * 60_000 && pl <= 5 * 60_000, '5 分鐘');
    // 8. 登入頁輸入 6 位數字即登入
    const paired = await call(null, '/api/auth/pair', 'POST', { code: pc.code }, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36 Edg/130.0' });
    assert.equal(paired.status, 200);
    const wangDev2 = paired.body.token;
    assert.equal((await call(wangDev2, '/api/me')).body.name, '王小明');
    assert.equal((await call(null, '/api/auth/pair', 'POST', { code: pc.code })).body.error.code, 'LOGIN_FAILED', '配對碼一次性');
    devs = (await call(wangDev2, '/api/devices')).body.items;
    assert.equal(devs.length, 2);
    assert.equal(devs.find(d => d.current).label, 'Edge · Windows');
    // 產生新配對碼，舊的作廢
    const pa = (await call(wangDev, '/api/devices/pair-code', 'POST')).body;
    const pb = (await call(wangDev, '/api/devices/pair-code', 'POST')).body;
    if (pa.code !== pb.code) assert.equal((await call(null, '/api/auth/pair', 'POST', { code: pa.code })).status, 400, '新配對碼產生後舊的作廢');
    // 登出這台（從別台登出手機）
    const phone = devs.find(d => !d.current);
    assert.equal((await call(wangDev2, `/api/devices/${phone.id}/logout`, 'POST')).status, 200);
    const out = await call(wangDev, '/api/me');
    assert.equal(out.status, 401, '被登出的裝置不能再用');
    assert.match(out.body.error.message, /已登出/);
    // 網頁登出：只登出這台
    const pc2 = (await call(wangDev2, '/api/devices/pair-code', 'POST')).body;
    const wangDev3 = (await call(null, '/api/auth/pair', 'POST', { code: pc2.code })).body.token;
    await call(wangDev3, '/api/auth/logout', 'POST');
    assert.equal((await call(wangDev3, '/api/me')).status, 401);
    assert.equal((await call(wangDev2, '/api/me')).status, 200, '其他裝置不受影響');

    // 10. 換一組登入碼：舊的立刻失效，已登入的裝置不受影響
    const code0 = (await call(wangDev2, '/api/me/login-code')).body.code;
    assert.ok(code0 && !code0.startsWith('dv_'));
    const code1 = (await call(wangDev2, '/api/me/rotate-code', 'POST')).body.code;
    assert.notEqual(code0, code1);
    assert.equal((await call(null, '/api/auth/code', 'POST', { code: code0 })).status, 400, '舊登入碼失效');
    assert.equal((await call(wangDev2, '/api/me')).status, 200, '已登入的裝置不受影響');
    const viaCode = (await call(null, '/api/auth/code', 'POST', { code: code1 })).body.token;
    assert.match(viaCode, /^dv_/, '新登入碼可以登入');

    // 11. 重設登入：新邀請連結、作廢舊登入碼、登出該人所有裝置
    assert.equal((await call(wangDev2, `/api/participants/${wang.participantId}/reset-login`, 'POST')).body.error.code, 'NOT_ADMIN');
    assert.equal((await call(liuDev, `/api/participants/${meDev.participantId}/reset-login`, 'POST')).body.error.code, 'RESET_SELF');
    const reset = (await call(liuDev, `/api/participants/${wang.participantId}/reset-login`, 'POST')).body;
    assert.equal(reset.invite.kind, 'reset');
    assert.equal((await call(wangDev2, '/api/me')).status, 401, '所有裝置登出');
    assert.equal((await call(viaCode, '/api/me')).status, 401);
    assert.equal((await call(null, '/api/auth/code', 'POST', { code: code1 })).status, 400, '舊登入碼作廢');
    const rpeek = (await call(null, '/api/auth/invite/peek', 'POST', { token: tokenOf(reset.url) })).body;
    assert.equal(rpeek.kind, 'reset');
    assert.equal(rpeek.name, '王小明');
    const back = (await call(null, '/api/auth/invite', 'POST', { token: tokenOf(reset.url), name: '亂改' })).body;
    assert.equal(back.participant.participantId, wang.participantId, '重設登入的連結回到原本身分（名字不能改）');
    assert.equal(back.participant.name, '王小明');
    assert.equal((await call(back.token, '/api/me')).body.projects[0], '平台');

    // 登入碼長期有效：人類登入碼不再受 token_expires_at 限制
    assert.equal((await call(liu.token, '/api/me')).status, 200);
    // 12. 這一路下來 AI Token 不變
    assert.equal((await call(ai.token, '/api/me')).status, 200, 'AI Token 照舊可用');

    // 猜配對碼：失敗太多次會被擋
    let last;
    for (let i = 0; i < 16; i++) last = await call(null, '/api/auth/pair', 'POST', { code: '000000' });
    assert.equal(last.status, 429, '失敗太多次被擋');
    assert.equal(last.body.error.code, 'TOO_MANY_ATTEMPTS');

    console.log('✅ login-test 全部通過');
  } catch (e) {
    console.error('❌', e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
