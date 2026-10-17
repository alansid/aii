// C-218 人類紀錄卡：人類記內容；AI 平常看不到、主動查才讀得到（只能讀）；整理完可標已完成＋註明已整理到哪張；不發群組訊息。
// 用法：npm run test:notes
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3990;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-notes-'));
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TEAM_CACHE_MS: '0', CARD_STALE_HOURS: '0' }, stdio: 'pipe',
});
const ready = new Promise((res, rej) => {
  server.stdout.on('data', d => { if (String(d).includes('已啟動')) res(); });
  server.on('exit', c => rej(new Error('server exited ' + c)));
});
const call = async (token, p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

(async () => {
  await ready;
  try {
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
    const kang = (await call(null, '/api/join', 'POST', { name: '康旭', role: 'BA' })).body;
    await call(liu.token, `/api/participants/${kang.participant.participantId}/projects`, 'PUT', { projects: ['平台'] });
    const r = ROLES.find(x => x.key === 'PG');
    const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: r.role, name: '小幫手', duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff })).body;
    const msgCount = async () => (await call(liu.token, '/api/messages?limit=100')).body.items.length;
    const card = (tok, body) => call(tok, '/api/cards', 'POST', { requestId: 'r' + Math.random(), project: '平台', ...body });

    // 1. 只有人類能建；預設進行中；負責人、等誰只能人類
    const m0 = await msgCount();
    const n1 = (await card(liu.token, { type: '人類紀錄', title: '跟康旭談試用回饋', reason: '第一層看不懂', ownerId: kang.participant.participantId })).body;
    assert.equal(n1.type, '人類紀錄');
    assert.equal(n1.status, '進行中', '人類紀錄預設進行中');
    assert.equal((await card(ai.token, { type: '人類紀錄', title: 'AI 建' })).body.error?.code, 'HUMAN_ONLY', 'AI 不能建人類紀錄');
    assert.equal((await card(liu.token, { type: '人類紀錄', title: 'AI 負責', ownerId: ai.participantId })).body.error?.code, 'HUMAN_NOTE_HUMANS', '負責人不能是 AI');
    assert.equal(await msgCount(), m0, '建立人類紀錄（即使指定了負責人）不發群組訊息');
    const n2 = (await card(liu.token, { type: '人類紀錄', title: '改文字內容', reason: '按鈕文字太長' })).body;
    const w1 = (await card(liu.token, { title: '一般工作卡' })).body;

    // 5. 紀錄：只有人類、只存卡上
    const m1 = await msgCount();
    assert.equal((await call(liu.token, `/api/cards/${n1.cardId}/notes`, 'POST', { text: '先問 PO 能不能改名' })).body.notes.length, 1);
    await call(kang.token, `/api/cards/${n1.cardId}/notes`, 'POST', { text: '叫「公告」比較好懂' });
    assert.equal((await call(ai.token, `/api/cards/${n1.cardId}/notes`, 'POST', { text: 'AI 寫' })).status, 403, 'AI 不能寫紀錄');
    assert.equal((await call(liu.token, `/api/cards/${w1.cardId}/notes`, 'POST', { text: 'x' })).status, 400, '一般卡不用紀錄');
    assert.equal(await msgCount(), m1, '紀錄不發群組訊息');

    // 2. AI 平常的列表、增量都不含
    const aiList = (await call(ai.token, '/api/cards')).body.items.map(c => c.cardId);
    assert.ok(aiList.includes(w1.cardId) && !aiList.includes(n1.cardId), 'AI 的列表不含人類紀錄');
    assert.ok(!(await call(ai.token, '/api/cards?since=2000-01-01T00:00:00.000Z')).body.items.some(c => c.type === '人類紀錄'), 'AI 的增量不含');
    assert.ok(!(await call(ai.token, '/api/cards?status=open')).body.items.some(c => c.type === '人類紀錄'));
    assert.ok((await call(liu.token, '/api/cards')).body.items.some(c => c.cardId === n1.cardId), '人類看得到');
    // 4. AI 主動查讀得到（含紀錄）
    const aiNotes = (await call(ai.token, '/api/cards?type=人類紀錄&project=平台')).body.items;
    assert.deepEqual(aiNotes.map(c => c.cardId).sort(), [n1.cardId, n2.cardId].sort(), 'AI 主動查 type=人類紀錄 一次拿全部');
    assert.equal(aiNotes.find(c => c.cardId === n1.cardId).notes.length, 2, '連紀錄一起');
    const one = (await call(ai.token, `/api/cards/${n1.cardId}`)).body;
    assert.equal(one.notes.map(n => n.text).join('|'), '先問 PO 能不能改名|叫「公告」比較好懂', 'AI 用卡號讀得到紀錄');
    assert.ok(!one.log.some(l => l.via === '紀錄'), '紀錄不混在變更紀錄裡');
    // AI 只能讀
    assert.equal((await call(ai.token, `/api/cards/${n1.cardId}`, 'PATCH', { title: '改' })).body.error?.code, 'HUMAN_NOTE_READONLY', 'AI 不能改');
    assert.equal((await call(ai.token, `/api/cards/${n1.cardId}`, 'PATCH', { ownerId: ai.participantId })).status, 403, 'AI 不能認領');
    assert.equal((await call(ai.token, `/api/cards/${n1.cardId}/handover`, 'POST', { toId: liu.participant.participantId, note: 'x' })).status, 403, 'AI 不能交接');
    assert.equal((await call(ai.token, `/api/cards/${n1.cardId}/verify`, 'POST')).status, 403, 'AI 不能驗證');
    assert.equal((await call(ai.token, '/api/suggestions', 'POST', { requestId: 's1', kind: 'status', cardId: n1.cardId, status: '已完成', why: 'x' })).status, 403, 'AI 不能對人類紀錄提建議');

    // PO 第 1578 則：AI 整理成新卡後，把原卡標已完成並註明去處
    const merged = (await card(ai.token, { title: '整理：改文字內容與跨專案頻道名稱' })).body;
    assert.equal((await call(ai.token, `/api/cards/${n1.cardId}`, 'PATCH', { status: '已完成', mergedInto: n2.cardId })).status, 400, '不能整理到另一張人類紀錄');
    assert.equal((await call(ai.token, `/api/cards/${n1.cardId}`, 'PATCH', { status: '已完成', mergedInto: merged.cardId, title: '偷改' })).status, 403, '只能帶 status 與 mergedInto');
    const m2 = await msgCount();
    const done1 = (await call(ai.token, `/api/cards/${n1.cardId}`, 'PATCH', { status: '已完成', mergedInto: merged.cardId })).body;
    assert.equal(done1.status, '已完成');
    assert.equal(done1.mergedInto, merged.cardId, '留下「已整理到」');
    await call(ai.token, `/api/cards/${n2.cardId}`, 'PATCH', { status: '已完成', mergedInto: merged.cardId });
    assert.equal(await msgCount(), m2, 'AI 收尾也不發群組訊息');
    assert.ok((await call(liu.token, `/api/cards/${n1.cardId}`)).body.log.some(l => l.text === `已整理到 ${merged.cardId}`), '變更紀錄寫「已整理到」');
    assert.deepEqual((await call(liu.token, `/api/cards/${merged.cardId}`)).body.mergedFrom, [n1.cardId, n2.cardId], '新卡列出整理自哪些');
    assert.equal((await call(liu.token, '/api/cards')).body.items.find(c => c.cardId === n1.cardId).mergedInto, merged.cardId, '列表也帶 mergedInto');
    assert.equal((await call(ai.token, `/api/cards/${n1.cardId}`, 'PATCH', { status: '已完成', mergedInto: merged.cardId })).body.error?.code, 'ALREADY_DONE');

    // 3. 人類之間交接照常，但不發群組訊息
    const n3 = (await card(liu.token, { type: '人類紀錄', title: '交接測試' })).body;
    const m3 = await msgCount();
    const h = (await call(liu.token, `/api/cards/${n3.cardId}/handover`, 'POST', { toId: kang.participant.participantId, note: '你接著記' })).body;
    assert.equal(h.owner.participantId, kang.participant.participantId, '交接成功');
    assert.equal(h.handoverMessageId, null);
    assert.equal(await msgCount(), m3, '交接不發群組訊息');
    assert.equal((await call(liu.token, `/api/cards/${n3.cardId}/handover`, 'POST', { toId: ai.participantId, note: 'x' })).body.error?.code, 'HUMAN_NOTE_HUMANS', '不能交給 AI');
    await call(liu.token, `/api/cards/${n3.cardId}`, 'PATCH', { status: '受阻' });
    assert.equal(await msgCount(), m3, '改狀態不發群組訊息');

    // 7. 改類型：決策卡不能改；AI 負責的卡要先換人類
    const dec = (await card(liu.token, { type: '決策', title: '決策' })).body;
    assert.equal((await call(liu.token, `/api/cards/${dec.cardId}`, 'PATCH', { type: '人類紀錄' })).body.error?.code, 'TYPE_LOCKED', '決策卡不能改成人類紀錄');
    const aiOwned = (await card(ai.token, { title: 'AI 的卡', ownerId: ai.participantId })).body;
    assert.equal((await call(liu.token, `/api/cards/${aiOwned.cardId}`, 'PATCH', { type: '人類紀錄' })).body.error?.code, 'HUMAN_NOTE_HUMANS', 'AI 負責的卡要先換人類');
    assert.equal((await call(liu.token, `/api/cards/${aiOwned.cardId}`, 'PATCH', { type: '人類紀錄', ownerId: liu.participant.participantId })).body.type, '人類紀錄', '換人類負責人同時改類型可以');
    assert.ok(!(await call(ai.token, '/api/cards')).body.items.some(c => c.cardId === aiOwned.cardId), '改成人類紀錄後 AI 列表就看不到');
    // 8. 人類紀錄 → 工作：紀錄可以刪掉
    await call(liu.token, `/api/cards/${aiOwned.cardId}/notes`, 'POST', { text: '私下的紀錄' });
    const back = (await call(liu.token, `/api/cards/${aiOwned.cardId}`, 'PATCH', { type: '工作', publishNotes: false })).body;
    assert.equal(back.type, '工作');
    const backOne = (await call(ai.token, `/api/cards/${aiOwned.cardId}`)).body;
    assert.equal(backOne.notes, undefined, '一般卡沒有 notes');
    assert.ok(!JSON.stringify(backOne).includes('私下的紀錄'), '不勾公開＝紀錄刪掉');
    assert.ok((await call(ai.token, '/api/cards')).body.items.some(c => c.cardId === aiOwned.cardId), '改回工作卡後 AI 看得到');
    // 團隊狀態不算人類紀錄（AI 也看團隊狀態）
    const ts = (await call(ai.token, '/api/team-status')).body.members.find(m => m.participantId === kang.participant.participantId);
    assert.ok(!ts.work || ts.work.source !== 'card' || !String(ts.work.title || '').includes('交接測試'), '團隊狀態不含人類紀錄');

    console.log('notes: all checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
