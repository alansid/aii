// 團隊狀態驗收測試：狀態推斷、可能斷線、尚未回應、等人決定、Token 到期提醒。
// 用法：npm run test:team
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ROLES } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3997;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-team-'));
const ENV = { STALE_MINUTES: '0.03', UNANSWERED_MINUTES: '0.02', AI_TOKEN_TTL_HOURS: '1', TEAM_CACHE_MS: '0' }; // 約 1.8 秒、1.2 秒；Token 1 小時（< 2 小時會被提醒）

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
const post = (token, text, extra = {}) => call(token, '/api/messages', 'POST', { text, requestId: 'req_t' + (++n), project: 'all', ...extra }).then(r => r.body); // C-172：兩邊成員要明確帶專案

(async () => {
  let { server, ready } = startServer();
  await ready;
  try {
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'UX' })).body;
    const r = ROLES.find(x => x.key === 'PG');
    const mk = name => call(liu.token, '/api/my-ais', 'POST', { projects: ['平台', '銀行系統'], roleKey: 'PG', role: r.role, name, duties: r.duties,
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

    // 尚未回應：指派超過時限仍未 ACK（只列 AI，C-153）
    const assign = await post(liu.token, '請處理 X', { recipientIds: [pg.participantId] });
    await post(pg.token, '[需確認] 請昱志看一下', { recipientIds: [liu.participant.participantId] });
    assert.ok(!(await team()).unanswered.some(u => u.messageId === assign.messageId), '剛指派 → 還不算');
    await sleep(1500);
    t = await team();
    assert.ok(t.unanswered.some(u => u.messageId === assign.messageId && u.name === '劉昱志的程式開發助手'), '超過時限 → 尚未回應');
    assert.ok(member(t, pg.participantId).pendingCount >= 1);
    assert.ok(!t.unanswered.some(u => u.participantId === liu.participant.participantId), 'C-153：人類被指派不列入尚未回應');
    const notif = (await call(pg.token, '/api/notifications')).body.items.find(x => x.messageId === assign.messageId);
    await call(pg.token, '/api/notifications/ack', 'POST', { notificationIds: [notif.notificationId] });
    assert.ok(!(await team()).unanswered.some(u => u.messageId === assign.messageId), 'ACK 後移除');

    // 可能斷線：超過 stale 時限沒呼叫 API
    await sleep(2000);
    assert.equal(member(await team(), pg.participantId).stale, true, '超過時限 → 可能斷線');

    // Token 快到期：團隊狀態標示，但排程不再發群組提醒訊息（改由網頁只給所屬人類看）
    t = await team();
    assert.equal(member(t, pg.participantId).tokenExpiringSoon, true, 'Token 快到期');
    await stopServer(server);
    ({ server, ready } = startServer());
    await ready; await sleep(400); // 啟動時執行一次排程
    const msgs = (await call(liu.token, '/api/messages?limit=100')).body.items;
    assert.equal(msgs.filter(m => m.author.memberType === 'system').length, 0, '不發群組提醒');
    // 重發：舊 Token 立即失效、新效期約 7 天（測試環境以 AI_TOKEN_TTL_HOURS 設定為準）
    const oldTok = pg.token;
    const re = (await call(liu.token, `/api/my-ais/${pg.participantId}/reissue`, 'POST')).body;
    assert.notEqual(re.token, oldTok);
    assert.equal((await call(oldTok, '/api/me')).status, 401, '舊 Token 失效');
    assert.equal((await call(re.token, '/api/me')).status, 200, '新 Token 可用');
    pg.token = re.token;
    // 頭像文字：人類改自己的、人類改名下 AI 的；最多 2 個字
    assert.equal((await call(liu.token, '/api/me', 'PATCH', { avatar: '🐱' })).body.avatar, '🐱');
    assert.equal((await call(liu.token, '/api/me', 'PATCH', { avatar: '太長了' })).status, 400, '超過 2 字');
    const pgAv = (await call(liu.token, `/api/my-ais/${pg.participantId}`, 'PATCH', { avatar: '工程' })).body;
    assert.equal(pgAv.avatar, '工程');
    const avList = (await call(liu.token, '/api/participants')).body.items;
    assert.equal(avList.find(p => p.participantId === pg.participantId).avatar, '工程', '成員名單帶頭像');
    assert.equal((await call(liu.token, '/api/me', 'PATCH', { avatar: '' })).body.avatar, null, '清除後回預設');
    // 頭像圖片：上傳、讀取、格式檢查、刪除
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const putImg = (tok, path, body, type = 'image/png') => fetch(BASE + path, { method: 'PUT', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': type }, body }).then(async r => ({ status: r.status, body: await r.json() }));
    const up = await putImg(liu.token, '/api/me/avatar', png);
    assert.equal(up.status, 200); assert.ok(up.body.avatarImg, '有圖片版本');
    const got = await fetch(BASE + '/api/avatars/' + up.body.participantId, { headers: { Authorization: 'Bearer ' + liu.token } });
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await got.arrayBuffer()), png, '讀回相同內容');
    assert.equal((await putImg(liu.token, '/api/me/avatar', new TextEncoder().encode('<svg/>'), 'image/svg+xml')).status, 400, '拒絕非 png/jpg/webp');
    assert.equal((await putImg(liu.token, `/api/my-ais/${pg.participantId}/avatar`, png)).status, 200, '可替名下 AI 上傳');
    assert.equal((await putImg(pg.token, `/api/my-ais/${pg.participantId}/avatar`, png)).status, 403, 'AI 不能用 my-ais');
    assert.equal((await call(liu.token, '/api/me/avatar', 'DELETE')).body.avatarImg, null, '刪除後回文字頭像');
    // 未讀通知數：只計數，和收件匣筆數一致
    const cnt = (await call(liu.token, '/api/notifications/count')).body.pending;
    assert.equal(cnt, (await call(liu.token, '/api/notifications?status=pending&limit=100')).body.items.length, '通知數一致');

    // 系統身分不出現在成員名單與團隊狀態，也不收 @所有人
    assert.ok(!(await call(liu.token, '/api/participants')).body.items.some(p => p.name === '平台通知'));
    assert.ok(!(await team()).members.some(m => m.name === '平台通知'));
    const all = await post(liu.token, '全體注意', { audience: 'all' });
    assert.ok(!all.recipients.some(x => x.name === '平台通知'));

    // 「等你決定」清除規則（方案 B）
    const poR = ROLES.find(x => x.key === 'PO');
    const realPo = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台', '銀行系統'], roleKey: 'PO', role: poR.role, name: '劉昱志的PO', duties: poR.duties,
      style: poR.style, autonomy: poR.autonomy, mustConfirm: poR.mustConfirm, handoff: poR.handoff })).body;
    const ask1 = await post(realPo.token, '[需確認] 提案一');
    const ask2 = await post(realPo.token, '[需確認] 提案二');
    const ask3 = await post(realPo.token, '[需確認] 提案三');
    const dec = () => team().then(x => x.decisions);
    // 已處理：人類可以，AI 403
    assert.equal((await call(pg.token, `/api/decisions/${ask1.messageId}/resolve`, 'POST')).status, 403, 'AI 按已處理 → 403');
    assert.ok((await dec()).some(d => d.messageId === ask1.messageId));
    const res = await call(liu.token, `/api/decisions/${ask1.messageId}/resolve`, 'POST');
    assert.equal(res.status, 200); assert.equal(res.body.resolvedBy, liu.participant.participantId, '記錄誰處理');
    assert.ok(!(await dec()).some(d => d.messageId === ask1.messageId), '人類按已處理 → 移出');
    assert.equal((await call(liu.token, `/api/decisions/${assign.messageId}/resolve`, 'POST')).body.error.code, 'INVALID_REQUEST', '非 [需確認] 不能處理');
    // [決策紀錄]：只有 PO 角色的 AI 回覆才移出
    await post(pg.token, '[決策紀錄] 劉昱志已同意', { replyToMessageId: ask2.messageId });
    let d2 = (await dec()).find(d => d.messageId === ask2.messageId);
    assert.ok(d2, '其他 AI 的 [決策紀錄] 不移出');
    assert.equal(d2.replyCount, 1, '後續回覆 1 則');
    await post(realPo.token, '補充說明', { replyToMessageId: ask2.messageId });
    assert.equal((await dec()).find(d => d.messageId === ask2.messageId).replyCount, 2, '後續回覆 2 則');
    await post(realPo.token, '[決策紀錄] 劉昱志已核准方案 B', { replyToMessageId: ask2.messageId });
    assert.ok(!(await dec()).some(d => d.messageId === ask2.messageId), 'PO 的 [決策紀錄] → 移出');
    assert.equal(member(await team(), realPo.participantId).status.state, 'idle', '[決策紀錄] → 空閒');
    assert.ok((await dec()).some(d => d.messageId === ask3.messageId && d.replyCount === 0), '未處理的仍在');

    // brief=1：與我無關的訊息只回前 80 字
    const long = '長'.repeat(200);
    const cur = (await call(pg.token, '/api/messages?limit=1')).body.nextCursor;
    const toPo = await post(liu.token, long, { recipientIds: [realPo.participantId] });
    const pgOwn = await post(pg.token, '[進度] 我自己的訊息');
    const replyPg = await post(liu.token, long, { replyToMessageId: pgOwn.messageId });
    const toAll = await post(liu.token, long, { audience: 'all' });
    const view = async (tok) => (await call(tok, `/api/messages?limit=50&brief=1&after=${cur}`)).body.items;
    const pgView = await view(pg.token);
    const by = (items, id) => items.find(m => m.messageId === id);
    assert.equal(by(pgView, toPo.messageId).truncated, true, '與我無關 → 截斷');
    assert.equal(by(pgView, toPo.messageId).text.length, 81, '80 字＋…');
    assert.equal(by(pgView, toPo.messageId).textLength, 200);
    assert.equal(by(pgView, replyPg.messageId).text, long, '回覆我的訊息 → 完整');
    assert.equal(by(pgView, toAll.messageId).text, long, '@所有人 → 完整');
    assert.equal(by(await view(realPo.token), toPo.messageId).text, long, '指定我的 → 完整');
    assert.equal((await call(pg.token, `/api/messages?limit=50&after=${cur}`)).body.items.find(m => m.messageId === toPo.messageId).text, long, '不帶 brief → 完整');
    assert.equal((await call(pg.token, `/api/messages/${toPo.messageId}`)).body.text, long, '單則查詢 → 完整');

    // 所在環境：建立、顯示、修改、接入設定名冊
    const roles = (await call(null, '/api/roles')).body;
    const inside = roles.environments.find(e => e.key === '行內');
    assert.ok(inside && inside.note.includes('必須先確認'), '有行內環境範本');
    const ba = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台', '銀行系統'], roleKey: 'BA', role: '需求分析', name: '劉昱志的需求分析助手',
      environment: '行內', duties: 'd', style: 's', autonomy: 'a', mustConfirm: `m\n${inside.note}`, handoff: 'h' })).body;
    assert.equal(ba.environment, '行內');
    assert.equal((await call(ba.token, '/api/me')).body.environment, '行內', '/api/me 帶環境');
    const plist = (await call(liu.token, '/api/participants')).body.items;
    assert.equal(plist.find(p => p.name === '劉昱志的需求分析助手').environment, '行內', '成員名單帶環境');
    assert.equal(plist.find(p => p.name === '劉昱志').environment, null, '未設定 → null');
    assert.equal(member(await team(), ba.participantId).environment, '行內', '團隊狀態帶環境');
    const ob = (await call(liu.token, `/api/my-ais/${ba.participantId}/onboarding`)).body.text;
    assert.ok(ob.includes('所在環境：行內'), '接入設定寫出自己的環境');
    assert.ok(ob.includes('十、團隊成員與所在環境') && ob.includes('劉昱志的需求分析助手（你）'), '接入設定有團隊名冊');
    assert.ok(!ob.includes('平台通知'), '名冊不含系統身分');
    // C-147：勾選「允許自動啟動待命」才寫已同意；行內／投信不論勾不勾都先問
    const obIn = (await call(liu.token, `/api/my-ais/${ba.participantId}/onboarding?autoStandby=1`)).body.text;
    assert.ok(!obIn.includes('所屬人類已同意自動啟動待命') && obIn.includes('公司電腦可能不允許背景程式'), '行內勾選仍先問');
    assert.ok(!ob.includes('所屬人類已同意自動啟動待命') && ob.includes('並詢問是否同意啟動'), '沒帶參數照舊先問');
    const watcherSha = createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'public', 'watcher.mjs'))).digest('hex');
    assert.ok(ob.includes(watcherSha), '接入設定的 watcher SHA-256 與 public/watcher.mjs 一致');
    for (const s of ['/watcher.mjs', 'Node 22', 'watcher.env', `AIGILE_ME=${ba.participantId}`, '要求停止', '401 INVALID_TOKEN', '429 RATE_LIMITED']) {
      assert.ok(ob.includes(s), `接入設定含 ${s}`);
    }
    // C-249：空資料夾第一次接入不算受阻；不是 git 資料夾就略過 .gitignore
    assert.ok(ob.includes('找不到 .aigile 是正常的') && ob.includes('自己建 .aigile/') && ob.includes('不是 git 資料夾 → 略過這步，不算受阻'), '接入設定說明空資料夾與 .gitignore 的處理');
    assert.ok(!ob.includes('已被 .gitignore 排除'), '不再假設 .aigile/ 已被 .gitignore 排除');
    assert.ok(ob.includes('第一段只寫一句給人看的白話結論') && ob.includes('空一行之後才寫細節'), 'C-260：接入設定要求結論在前');
    assert.ok(ob.includes('用 replyFrom 標出「要回覆」的人，一則最多一位') && ob.includes('[需確認] 一定要用 replyFrom'), 'C-259：接入設定說明 replyFrom');
    const waitSha = createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'public', 'aigile-wait.mjs'))).digest('hex');
    assert.ok(ob.includes(waitSha) && ob.includes('aigile-wait.mjs --agent') && ob.includes('不要用 Monitor') && ob.includes('BELL_FILE=') && ob.includes('PID_FILE='), 'C-246：接入設定用等待腳本、門鈴檔');
    assert.ok(ob.includes('## 十四、私訊') && ob.includes('GET /api/dm') && ob.includes('私訊不能拿來授權 commit、push、部署'), 'C-270：接入設定有私訊一節');
    assert.ok(!ob.includes('${owner') && !ob.includes('${agent') && !ob.includes('${base'), '接入設定沒有沒替換的變數');
    // C-251：本機跳不出選項的 AI 改用 [需確認]＋選項：或決策卡；授權仍在本機問
    assert.ok(ob.includes('不論你的本機介面跳不跳得出選項') && ob.includes('規格 3.9.1') && ob.includes('已發到網頁，請在網頁選') && ob.includes('照上面的規定仍在本機對話問'), 'C-265：要人選擇一律發到網頁，授權仍在本機');
    const upd = (await call(liu.token, `/api/my-ais/${ba.participantId}`, 'PATCH', { environment: '行外' })).body;
    assert.equal(upd.environment, '行外', '可修改環境');
    assert.equal((await call(liu.token, `/api/my-ais/${ba.participantId}`, 'PATCH', { environment: 'x'.repeat(21) })).body.error.code, 'INVALID_REQUEST', '環境上限 20 字');
    const obOut = (await call(liu.token, `/api/my-ais/${ba.participantId}/onboarding?autoStandby=1`)).body.text;
    assert.ok(obOut.includes('所屬人類已同意自動啟動待命') && obOut.includes('做到第 8 步（啟動待命）後'), '行外勾選 → 自動啟動待命');
    const obOutNo = (await call(liu.token, `/api/my-ais/${ba.participantId}/onboarding`)).body.text;
    assert.ok(!obOutNo.includes('所屬人類已同意自動啟動待命') && obOutNo.includes('沒有預先同意自動啟動'), '行外沒勾 → 先問');
    const msg = await post(ba.token, '[AI 簽到] 我是 BA');
    assert.equal(msg.author.environment, '行外', '訊息作者帶環境');

    // C-114 待命心跳：watcher 標頭記下待命；有心跳的 AI 疑似斷線門檻放寬到 60 分鐘
    const hbRes = await fetch(BASE + '/api/notifications/count', { headers: { Authorization: `Bearer ${ba.token}`, 'X-Aigile-Source': 'watcher' } });
    assert.equal(hbRes.status, 200, '未讀數端點可帶 watcher 標頭');
    await sleep(2500); // 超過一般斷線門檻（約 1.8 秒）
    const hbm = (await call(liu.token, '/api/team-status')).body.members.find(m => m.participantId === ba.participantId);
    assert.equal(hbm.standby, true, 'watcher 心跳後顯示待命中');
    assert.equal(hbm.stale, false, '有 watcher 心跳的 AI 不會在一般門檻內被標可能斷線');

    console.log('team: all checks passed');
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
