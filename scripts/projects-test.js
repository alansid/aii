// 專案欄位（平台／銀行系統）驗收測試：成員專案設定、訊息預設與繼承、過濾與游標、卡片必填專案、交接限同專案。
// 用法：npm run test:projects
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3995;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-proj-'));

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TEAM_CACHE_MS: '0' }, stdio: 'pipe',
});
const ready = new Promise((res, rej) => {
  server.stdout.on('data', d => { if (String(d).includes('已啟動')) res(); });
  server.on('exit', c => rej(new Error('server exited ' + c)));
});
const call = async (token, p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let n = 0;
const rid = () => 'req_p' + (++n);
const msg = (tok, text, extra = {}) => call(tok, '/api/messages', 'POST', { requestId: rid(), text, ...extra });

(async () => {
  await ready;
  try {
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'UX' })).body;
    const percy = (await call(null, '/api/join', 'POST', { name: 'Percy', role: 'PO' })).body;
    const liuId = liu.participant.participantId, percyId = percy.participant.participantId;
    assert.deepEqual(liu.participant.projects, ['平台', '銀行系統'], '群組第一位（建立者）預設所有專案');
    assert.deepEqual(percy.participant.projects, [], '之後加入的人類預設沒有專案');
    await call(liu.token, `/api/participants/${percyId}/projects`, 'PUT', { projects: ['平台', '銀行系統'] }); // 管理員（最早加入的劉昱志）加入 Percy

    const r = ROLES.find(x => x.key === 'PG');
    const mk = name => call(liu.token, '/api/my-ais', 'POST', { projects: ['平台', '銀行系統'], roleKey: 'PG', role: r.role, name, duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff }).then(x => x.body);
    const plat = await mk('平台PG'), bank = await mk('銀行PG'), both = await mk('兩邊PO');
    assert.deepEqual(plat.participantId && (await call(liu.token, '/api/participants')).body.items.find(p => p.participantId === plat.participantId).projects, ['平台', '銀行系統'], '新增 AI 時選的專案（這裡選兩邊）');

    // 設定成員專案：只有群組管理員（C-146 B）；至少一個；只能是現有專案
    const put = (tok, id, projects) => call(tok, `/api/participants/${id}/projects`, 'PUT', { projects });
    assert.equal((await put(liu.token, plat.participantId, ['平台'])).body.projects[0], '平台', '管理員可改 AI 的專案');
    assert.equal((await put(liu.token, bank.participantId, ['銀行系統'])).status, 200);
    assert.equal((await put(percy.token, plat.participantId, ['平台'])).status, 403, '別人不能改');
    assert.equal((await put(plat.token, plat.participantId, ['銀行系統'])).status, 403, 'AI 不能改自己');
    assert.equal((await put(liu.token, plat.participantId, [])).status, 400, '至少選一個');
    assert.equal((await put(liu.token, plat.participantId, ['別的'])).status, 400, '只能是平台或銀行系統');
    assert.equal((await put(percy.token, percyId, ['平台', '銀行系統'])).body.error?.code, 'NOT_ADMIN', '一般成員不能自己改（只能看）');
    assert.equal((await put(liu.token, percyId, ['平台', '銀行系統'])).status, 200, '管理員可改別人');

    // 訊息：預設專案與繼承
    const m1 = (await msg(plat.token, '[進度] 平台訊息')).body;
    assert.equal(m1.project, '平台', '單一專案成員預設自己的專案');
    const m2 = (await msg(bank.token, '[進度] 銀行訊息')).body;
    assert.equal(m2.project, '銀行系統');
    assert.equal((await msg(liu.token, '[通知] 兩邊成員沒帶專案')).body.error?.code, 'PROJECT_REQUIRED', 'C-172：兩邊成員不帶專案擋下');
    const m3 = (await msg(liu.token, '[通知] 兩邊成員明確發全部專案', { project: 'all' })).body;
    assert.equal(m3.project, null, '要發全部專案必須明確帶 all');
    assert.equal((await msg(liu.token, '[回覆] 回覆平台那則', { replyToMessageId: m1.messageId })).body.error?.code, 'PROJECT_REQUIRED', 'C-172：兩邊成員回覆也要帶專案');
    const m4 = (await msg(liu.token, '[回覆] 回覆平台那則', { replyToMessageId: m1.messageId, project: '平台' })).body;
    assert.equal(m4.project, '平台');
    const m5 = (await msg(liu.token, '[回覆] 明確指定銀行系統', { project: '銀行系統' })).body;
    assert.equal(m5.project, '銀行系統');
    const m6 = (await msg(plat.token, '[通知] 平台成員發全部專案', { project: 'all' })).body;
    assert.equal(m6.project, null, 'all＝全部專案');
    assert.equal((await msg(plat.token, '[進度] 越界', { project: '銀行系統' })).body.error.code, 'PROJECT_FORBIDDEN', '不能發不屬於的專案');
    assert.equal((await msg(plat.token, '[進度] 亂填', { project: 'x' })).status, 400);

    // 過濾：含「全部專案」；mine；沒帶參數維持現狀；游標推進到最新
    const ids = res => res.body.items.map(m => m.messageId);
    const pAll = await call(liu.token, '/api/messages?limit=100');
    assert.ok(ids(pAll).includes(m1.messageId) && ids(pAll).includes(m2.messageId), '沒帶 project 不過濾');
    const pf = await call(liu.token, '/api/messages?limit=100&project=平台');
    assert.ok(ids(pf).includes(m1.messageId) && ids(pf).includes(m3.messageId) && ids(pf).includes(m4.messageId), '平台過濾含平台與全部專案');
    assert.ok(!ids(pf).includes(m2.messageId) && !ids(pf).includes(m5.messageId), '平台過濾不含銀行系統');
    const mine = await call(plat.token, '/api/messages?limit=100&project=mine');
    assert.ok(!ids(mine).includes(m2.messageId) && ids(mine).includes(m1.messageId), 'mine 依我的專案');
    const mineBoth = await call(liu.token, '/api/messages?limit=100&project=mine');
    assert.ok(ids(mineBoth).includes(m2.messageId), '兩邊成員 mine 不過濾');
    assert.equal((await call(liu.token, '/api/messages?project=xx')).status, 400);
    const first = await call(plat.token, '/api/messages?limit=2&after=' + encodeURIComponent((await call(plat.token, '/api/messages?limit=1')).body.nextCursor) + '&project=銀行系統');
    assert.equal(first.body.items.length, 0, '游標在最新之後，沒有新訊息');
    const before = (await call(plat.token, '/api/messages?limit=100')).body.nextCursor;
    await msg(bank.token, '[進度] 銀行又一則');
    const empty = await call(plat.token, `/api/messages?after=${encodeURIComponent(before)}&project=mine`);
    assert.equal(empty.body.items.length, 0, '平台成員看不到銀行訊息');
    assert.notEqual(empty.body.nextCursor, before, '過濾後游標仍推進到最新，不重掃不相關訊息');

    // 卡片：必填專案；單一專案成員自動帶；越界；過濾；改專案
    assert.equal((await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '兩邊成員沒填專案' })).status, 400, '兩邊成員建卡必填專案');
    const c1 = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '平台卡', project: '平台', ownerId: plat.participantId })).body;
    assert.equal(c1.project, '平台');
    const c2 = (await call(bank.token, '/api/cards', 'POST', { requestId: rid(), title: '銀行卡' })).body;
    assert.equal(c2.project, '銀行系統', '單一專案成員自動帶自己的專案');
    assert.equal((await call(plat.token, '/api/cards', 'POST', { requestId: rid(), title: '越界', project: '銀行系統' })).body.error.code, 'PROJECT_FORBIDDEN');
    const lf = (await call(liu.token, '/api/cards?project=平台')).body.items.map(c => c.cardId);
    assert.ok(lf.includes(c1.cardId) && !lf.includes(c2.cardId), '卡片依專案過濾');
    assert.equal((await call(liu.token, `/api/cards/${c1.cardId}`, 'PATCH', { project: '銀行系統' })).body.error?.code, 'PROJECT_MISMATCH', 'C-146 B：負責人不屬於新專案時擋下');
    assert.equal((await call(liu.token, `/api/cards/${c1.cardId}`, 'PATCH', { project: '銀行系統', ownerId: null })).body.project, '銀行系統', '人類可改卡片專案（同時改負責人）');
    await call(liu.token, `/api/cards/${c1.cardId}`, 'PATCH', { project: '平台', ownerId: plat.participantId });

    // 交接：只能交給同專案成員或兩邊成員
    const H = (tok, id, toId) => call(tok, `/api/cards/${id}/handover`, 'POST', { toId, note: '交接測試' });
    assert.equal((await H(plat.token, c1.cardId, bank.participantId)).body.error.code, 'PROJECT_MISMATCH', '不能交給不同專案的成員');
    const ho = (await H(plat.token, c1.cardId, percyId)).body;
    assert.equal(ho.owner.participantId, percyId, '可交給兩邊成員');
    assert.equal((await call(liu.token, `/api/messages/${ho.handoverMessageId}`)).body.project, '平台', '交接訊息帶卡片的專案');
    assert.ok(both.participantId);


    // ===== C-146 B：專案管理 =====
    const pl = (await call(liu.token, '/api/projects')).body.items;
    assert.deepEqual(pl.map(p => p.id), ['平台', '銀行系統'], '預設兩個專案，id 沿用名稱');
    assert.equal((await call(bank.token, '/api/projects', 'POST', { name: 'AI 不能建' })).status, 403, 'AI 不能新增專案');
    assert.equal((await call(liu.token, '/api/projects', 'POST', { name: '平台' })).body.error.code, 'NAME_TAKEN', '同名擋下');
    assert.equal((await call(liu.token, '/api/projects', 'POST', { name: '' })).status, 400, '名稱不能空');
    const mkp = await call(liu.token, '/api/projects', 'POST', { name: '新專案甲' });
    assert.equal(mkp.status, 201); const newId = mkp.body.id;
    const withNew = (await call(liu.token, '/api/participants')).body.items;
    assert.ok(withNew.find(p => p.participantId === liuId).projects.includes(newId), '建立者在新專案');
    assert.ok(!withNew.find(p => p.participantId === plat.participantId).projects.includes(newId), '一般成員不會自動加入新專案');
    // 新專案可用：設成員專案、發卡片
    assert.equal((await put(liu.token, plat.participantId, ['平台', newId])).status, 200, '可把成員加入新專案');
    const nc = (await call(liu.token, '/api/cards', 'POST', { requestId: 'req_np1', title: '新專案的卡', project: newId })).body;
    assert.equal(nc.project, newId, '新專案可以建卡');
    // 改名：只改 name，id 不變，卡片仍屬於它
    assert.equal((await call(liu.token, `/api/projects/${newId}`, 'PATCH', { name: '新專案乙' })).status, 200);
    assert.equal((await call(liu.token, '/api/projects')).body.items.find(p => p.id === newId).name, '新專案乙');
    assert.equal((await call(liu.token, `/api/cards/${nc.cardId}`)).body.project, newId, '改名後卡片仍屬同一專案');
    // 封存：有未結案卡擋下；結案後可封存；封存後不能再選、可還原
    assert.equal((await call(liu.token, `/api/projects/${newId}/archive`, 'POST')).body.error.code, 'HAS_OPEN_CARDS', '有未結案卡不能封存');
    await call(liu.token, `/api/cards/${nc.cardId}`, 'PATCH', { status: '已完成' });
    assert.equal((await call(liu.token, `/api/projects/${newId}/archive`, 'POST')).status, 200, '卡片結案後可封存');
    assert.equal((await call(liu.token, '/api/cards', 'POST', { requestId: 'req_np2', title: '封存後建卡', project: newId })).status, 400, '封存的專案不能再建卡');
    assert.equal((await call(liu.token, `/api/projects/${newId}/unarchive`, 'POST')).status, 200, '可還原');
    // 新增 AI 必須選專案：人類有兩個以上專案又沒帶 → 400
    const noProj = await call(liu.token, '/api/my-ais', 'POST', { roleKey: 'PG', role: r.role, name: '沒選專案', duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff });
    assert.equal(noProj.status, 400, '多個專案又沒選 → 要求必選');
    // ===== C-146 B（UX 第 857 則、PO 第 889 則）=====
    // ① 只有群組管理員（最早加入的人類）能管理專案與成員
    const pr = (await call(percy.token, '/api/projects')).body;
    assert.equal(pr.adminId, liuId, '群組管理員＝最早加入的人類');
    assert.ok(pr.crossRoleIds.includes(percyId), 'PO 是跨專案角色');
    assert.equal((await call(percy.token, '/api/projects', 'POST', { name: '非管理員' })).body.error?.code, 'NOT_ADMIN', '非管理員不能新增專案');
    assert.equal((await call(percy.token, `/api/projects/${newId}`, 'PATCH', { name: 'x' })).body.error?.code, 'NOT_ADMIN', '非管理員不能改名');
    // ③ 跨專案角色固定，不能移出
    assert.equal((await put(liu.token, percyId, ['平台'])).body.error?.code, 'CROSS_ROLE_FIXED', 'PO 不能被移出專案');
    // ⑥ AI 的專案不能超出所屬人類
    const lone = (await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body;
    const loneId = lone.participant.participantId;
    await put(liu.token, loneId, ['平台']);
    const loneAi = (await call(lone.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: r.role, name: '小明PG', duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff })).body;
    assert.equal((await call(lone.token, '/api/my-ais', 'POST', { projects: ['銀行系統'], roleKey: 'PG', role: r.role, name: '小明PG2', duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff })).body.error?.code, 'OWNER_NOT_IN_PROJECT', '新增 AI 不能超出自己的專案');
    assert.equal((await put(liu.token, loneAi.participantId, ['平台', '銀行系統'])).body.error?.code, 'OWNER_NOT_IN_PROJECT', '管理員也不能讓 AI 超出所屬人類');
    // ⑦ 一般成員只能看
    assert.equal((await put(lone.token, loneId, ['平台', '銀行系統'])).body.error?.code, 'NOT_ADMIN', '一般成員不能自己加入專案');
    // ④ 移出前預告退回幾張卡；移出後卡片退回待處理、未指派
    const oc = (await call(liu.token, '/api/cards', 'POST', { requestId: 'req_mv1', title: '小明PG 的平台卡', project: '平台', ownerId: loneAi.participantId, status: '進行中' })).body;
    const dry = (await call(liu.token, '/api/projects/平台/members', 'PUT', { dryRun: true, memberIds: pr.items.length && (await call(liu.token, '/api/participants')).body.items.filter(p => (p.projects || []).includes('平台') && p.participantId !== loneId).map(p => p.participantId) })).body;
    assert.equal(dry.error?.code, 'NEEDS_ONE_PROJECT', '只屬於這個專案的人不能直接移出');
    await put(liu.token, loneId, ['平台', '銀行系統']);
    await put(liu.token, loneAi.participantId, ['平台', '銀行系統']);
    const keep = (await call(liu.token, '/api/participants')).body.items.filter(p => (p.projects || []).includes('平台') && p.participantId !== loneAi.participantId).map(p => p.participantId);
    const dry2 = (await call(liu.token, '/api/projects/平台/members', 'PUT', { dryRun: true, memberIds: keep })).body;
    assert.deepEqual(dry2.impact.map(x => [x.name, x.returnedCards]), [['小明PG', [oc.cardId]]], '預告：1 張卡會退回待處理');
    assert.equal((await call(liu.token, `/api/cards/${oc.cardId}`)).body.owner?.participantId, loneAi.participantId, 'dryRun 不改資料');
    assert.equal((await call(liu.token, '/api/projects/平台/members', 'PUT', { memberIds: keep })).status, 200);
    const oc2 = (await call(liu.token, `/api/cards/${oc.cardId}`)).body;
    assert.ok(!oc2.owner && oc2.status === '待處理', '移出後卡片未指派、退回待處理');
    // ⑤ 異動紀錄
    const ev = (await call(percy.token, '/api/projects/平台/events')).body.items.map(e => e.text);
    assert.ok(ev.some(t => t.includes('移除 小明PG（1 張卡退回待處理）')) && ev.some(t => t.includes('加入 王小明')), '異動紀錄記下加入與移除');
    assert.ok((await call(liu.token, `/api/projects/${newId}/events`)).body.items.some(e => e.text.includes('改名：新專案甲 → 新專案乙')), '異動紀錄記下改名');
    // PO 第 889 則：指派、收件人只能選同專案成員，跨專案擋下並說明
    assert.equal((await call(liu.token, '/api/cards', 'POST', { requestId: 'req_x1', title: '跨專案指派', project: '平台', ownerId: bank.participantId })).body.error?.code, 'PROJECT_MISMATCH', '負責人不同專案擋下');
    assert.equal((await call(liu.token, '/api/cards', 'POST', { requestId: 'req_x2', title: '跨專案等誰', project: '平台', waitForId: bank.participantId })).body.error?.code, 'PROJECT_MISMATCH', '等誰不同專案擋下');
    const xm = await msg(plat.token, '[回覆] 指定銀行 PG', { project: '平台', recipientIds: [bank.participantId] });
    assert.equal(xm.body.error?.code, 'PROJECT_MISMATCH', '收件人不同專案擋下');
    assert.ok(xm.body.error.message.includes('銀行PG'), '錯誤訊息說明是誰');
    assert.equal((await msg(plat.token, '[回覆] 全部專案可指定', { project: 'all', recipientIds: [bank.participantId] })).status, 201, '全部專案的訊息可指定任何人');
    // ===== C-146 A 隔離（UX 第 948 則 5–7）：伺服器擋，不只畫面 =====
    await put(liu.token, plat.participantId, ['平台']);
    await put(liu.token, bank.participantId, ['銀行系統']);
    const bm = (await msg(bank.token, '[進度] 銀行內部進度', { project: '銀行系統' })).body;
    const am = (await msg(bank.token, '[通知] 跨專案公告', { project: 'all' })).body;
    const platAll = (await call(plat.token, '/api/messages?limit=100')).body.items.map(m => m.messageId);
    assert.ok(!platAll.includes(bm.messageId), '只屬平台的成員，不帶 project 也讀不到銀行系統訊息');
    assert.ok(platAll.includes(am.messageId), '全部專案（跨專案頻道）的訊息人人看得到');
    assert.equal((await call(plat.token, `/api/messages/${bm.messageId}`)).status, 404, '單則讀取也擋');
    assert.ok((await call(liu.token, '/api/messages?limit=100')).body.items.some(m => m.messageId === bm.messageId), '兩邊成員看得到');
    const allBank = (await msg(liu.token, '[通知] 銀行系統全體注意', { project: '銀行系統', audience: 'all' })).body;
    const platN = (await call(plat.token, '/api/notifications?limit=100')).body.items.map(n => n.messageId);
    const bankN = (await call(bank.token, '/api/notifications?limit=100')).body.items.map(n => n.messageId);
    assert.ok(!platN.includes(allBank.messageId) && bankN.includes(allBank.messageId), '@所有人只送到該專案成員');
    const rp = (await msg(bank.token, '[回覆] 銀行 PG 回自己那則', { replyToMessageId: bm.messageId })).body;
    assert.equal(rp.project, '銀行系統', '單一專案成員回覆＝自己的專案');
    const bc = (await call(liu.token, '/api/cards', 'POST', { requestId: 'req_iso1', title: '銀行專案的卡', project: '銀行系統' })).body;
    assert.ok(!(await call(plat.token, '/api/cards?limit=200')).body.items.some(c => c.cardId === bc.cardId), '只屬平台的成員看不到銀行系統的卡');
    assert.equal((await call(plat.token, `/api/cards/${bc.cardId}`)).body.error?.code, 'CARD_FORBIDDEN', 'C-181：卡片詳情回 403 沒權限（不寫專案名）');
    assert.equal((await call(plat.token, '/api/cards/C-99999')).status, 404, '真的不存在才回 404');
    assert.ok((await call(liu.token, '/api/cards?limit=200')).body.items.some(c => c.cardId === bc.cardId), '兩邊成員看得到兩邊的卡');
    const after0 = (await call(plat.token, '/api/messages?limit=1')).body.nextCursor;
    await msg(bank.token, '[進度] 銀行又一則（隔離）', { project: '銀行系統' });
    const inc = (await call(plat.token, `/api/messages?after=${encodeURIComponent(after0)}`)).body;
    assert.equal(inc.items.length, 0, '輪詢拿不到別專案的新訊息');
    assert.notEqual(inc.nextCursor, after0, '游標仍推進到最新');
    // ===== C-172：外流情境（UX 第 1148 則）=====
    assert.equal((await msg(liu.token, '[需確認] 兩邊成員沒帶專案')).body.error?.code, 'PROJECT_REQUIRED', '兩邊成員沒帶 project 擋下');
    assert.equal((await msg(liu.token, '[回覆] 回覆也要帶', { replyToMessageId: am.messageId })).body.error?.code, 'PROJECT_REQUIRED', '兩邊成員回覆全部專案訊息也要帶');
    const bankReply = (await msg(bank.token, '[完成] 銀行內容回覆跨專案訊息', { replyToMessageId: am.messageId })).body;
    assert.equal(bankReply.project, '銀行系統', '只屬一個專案的人回覆全部專案訊息＝自己的專案，不繼承');
    const bankAll = (await msg(bank.token, '[通知] 明確發全部專案', { replyToMessageId: am.messageId, project: 'all' })).body;
    assert.equal(bankAll.project, null, '明確帶 all 才是全部專案');
    assert.equal((await msg(liu.token, '[進度]【銀行系統】標題寫銀行卻發全部', { project: 'all' })).body.error?.code, 'PROJECT_TEXT_MISMATCH', '開頭【銀行系統】卻發全部專案');
    assert.equal((await msg(bank.token, '【平台】單一專案的人標題寫別的專案')).body.error?.code, 'PROJECT_TEXT_MISMATCH');
    const tagged = (await msg(liu.token, '[進度]【銀行系統】正確帶專案', { project: '銀行系統' })).body;
    assert.equal(tagged.project, '銀行系統');
    assert.equal((await msg(liu.token, '[通知]【全部專案】公告', { project: 'all' })).body.project, null, '【全部專案】可以發 all');
    const upload = (tok, extra = '') => fetch(`${BASE}/api/files?name=a.txt&declared=true${extra}`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: 'hello' }).then(r => r.json());
    assert.equal((await upload(liu.token)).error?.code, 'PROJECT_REQUIRED', '上傳文件附的訊息也要帶專案');
    const upOk = await upload(liu.token, '&project=' + encodeURIComponent('銀行系統'));
    assert.equal(upOk.message?.project, '銀行系統', '上傳文件可帶 project');
    assert.equal((await upload(bank.token)).message?.project, '銀行系統', '單一專案成員上傳不帶＝自己的專案');
    const platSees = (await call(plat.token, '/api/messages?limit=100')).body.items.map(m => m.messageId);
    assert.ok(![bankReply.messageId, tagged.messageId, upOk.message?.messageId].some(id => platSees.includes(id)), '只屬平台的帳號拿不到上面情境產生的任何銀行系統訊息');
    // PO 第 967 則：通知列表也隔離。兩邊成員先收到銀行系統的指定，被移出銀行系統後就不再列出
    await put(liu.token, both.participantId, ['平台', '銀行系統']);
    const toBoth = (await msg(liu.token, '[需確認] 給兩邊 PG', { project: '銀行系統', recipientIds: [both.participantId] })).body;
    assert.ok((await call(both.token, '/api/notifications?limit=100')).body.items.some(n => n.messageId === toBoth.messageId), '屬於銀行系統時收得到');
    await put(liu.token, both.participantId, ['平台']);
    const bn = (await call(both.token, '/api/notifications?limit=100')).body.items;
    assert.ok(!bn.some(n => n.messageId === toBoth.messageId), '移出銀行系統後，銀行系統的通知不再列出');
    assert.equal((await call(both.token, '/api/notifications/count')).body.pending, bn.length, '未讀數與列表一致');
    // C-155：亂碼攔截（U+FFFD 或連續 4 個以上問號，網址除外）
    assert.equal((await msg(plat.token, '[進度] ???? 中文變問號了', { project: 'all' })).body.error?.code, 'INVALID_ENCODING', 'AI 發的連續問號擋下');
    assert.equal((await msg(liu.token, '這是什麼????', { project: 'all' })).status, 201, '人類在網頁打 ???? 不擋（UX 第 994 則）');
    assert.equal((await msg(plat.token, '[回覆] 全形？？？？不擋', { project: 'all' })).status, 201, '全形問號不擋');
    assert.equal((await msg(liu.token, '[進度] 壞掉的字�', { project: 'all' })).body.error?.code, 'INVALID_ENCODING', 'U+FFFD 擋下');
    assert.equal((await msg(liu.token, '[進度] 真的嗎???', { project: 'all' })).status, 201, '3 個問號不擋');
    assert.equal((await msg(liu.token, '[進度] 連結 https://x.test/a?q=????&b=1 請看', { project: 'all' })).status, 201, '網址裡的問號不擋');
    console.log('projects: all checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
