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
    assert.deepEqual(liu.participant.projects, ['平台', '銀行系統'], '人類預設兩邊都屬於');

    const r = ROLES.find(x => x.key === 'PG');
    const mk = name => call(liu.token, '/api/my-ais', 'POST', { roleKey: 'PG', role: r.role, name, duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff }).then(x => x.body);
    const plat = await mk('平台PG'), bank = await mk('銀行PG'), both = await mk('兩邊PO');
    assert.deepEqual(plat.participantId && (await call(liu.token, '/api/participants')).body.items.find(p => p.participantId === plat.participantId).projects, ['平台', '銀行系統'], 'AI 預設沿用所屬人類的專案');

    // 設定成員專案：本人或 AI 的所屬人類；至少一個；只能是平台／銀行系統
    const put = (tok, id, projects) => call(tok, `/api/participants/${id}/projects`, 'PUT', { projects });
    assert.equal((await put(liu.token, plat.participantId, ['平台'])).body.projects[0], '平台', '所屬人類可改 AI 的專案');
    assert.equal((await put(liu.token, bank.participantId, ['銀行系統'])).status, 200);
    assert.equal((await put(percy.token, plat.participantId, ['平台'])).status, 403, '別人不能改');
    assert.equal((await put(plat.token, plat.participantId, ['銀行系統'])).status, 403, 'AI 不能改自己');
    assert.equal((await put(liu.token, plat.participantId, [])).status, 400, '至少選一個');
    assert.equal((await put(liu.token, plat.participantId, ['別的'])).status, 400, '只能是平台或銀行系統');
    assert.equal((await put(percy.token, percyId, ['平台', '銀行系統'])).status, 200, '人類可改自己');

    // 訊息：預設專案與繼承
    const m1 = (await msg(plat.token, '[進度] 平台訊息')).body;
    assert.equal(m1.project, '平台', '單一專案成員預設自己的專案');
    const m2 = (await msg(bank.token, '[進度] 銀行訊息')).body;
    assert.equal(m2.project, '銀行系統');
    const m3 = (await msg(liu.token, '[通知] 兩邊成員預設全部專案')).body;
    assert.equal(m3.project, null, '兩邊成員不帶專案＝全部專案');
    const m4 = (await msg(liu.token, '[回覆] 回覆平台那則', { replyToMessageId: m1.messageId })).body;
    assert.equal(m4.project, '平台', '回覆繼承被回覆訊息的專案');
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
    assert.equal((await call(liu.token, `/api/cards/${c1.cardId}`, 'PATCH', { project: '銀行系統' })).body.project, '銀行系統', '人類可改卡片專案');
    await call(liu.token, `/api/cards/${c1.cardId}`, 'PATCH', { project: '平台' });

    // 交接：只能交給同專案成員或兩邊成員
    const H = (tok, id, toId) => call(tok, `/api/cards/${id}/handover`, 'POST', { toId, note: '交接測試' });
    assert.equal((await H(plat.token, c1.cardId, bank.participantId)).body.error.code, 'PROJECT_MISMATCH', '不能交給不同專案的成員');
    const ho = (await H(plat.token, c1.cardId, percyId)).body;
    assert.equal(ho.owner.participantId, percyId, '可交給兩邊成員');
    assert.equal((await call(liu.token, `/api/messages/${ho.handoverMessageId}`)).body.project, '平台', '交接訊息帶卡片的專案');
    assert.ok(both.participantId);

    console.log('projects: all checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
