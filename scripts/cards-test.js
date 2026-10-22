// 工作卡片驗收測試（第一階段）：建立、權限、狀態連動、驗證規則、紀錄、增量讀取、衝突。
// 用法：npm run test:cards
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-cards-'));

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TEAM_CACHE_MS: '0', CARD_STALE_HOURS: '0', ARCHIVE_EVERY_MS: '0', RATE_LIMIT_PER_MIN: '600' }, stdio: 'pipe',
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
const rid = () => 'req_c' + (++n);

(async () => {
  await ready;
  try {
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'UX' })).body;
    const percy = (await call(null, '/api/join', 'POST', { name: 'Percy', role: 'PO' })).body;
    // 專案：卡片必填專案；測試成員設成單一專案（平台），AI 沿用所屬人類的專案
    await call(liu.token, `/api/participants/${liu.participant.participantId}/projects`, 'PUT', { projects: ['平台'] });
    const r = ROLES.find(x => x.key === 'PG');
    const mk = name => call(liu.token, '/api/my-ais', 'POST', { roleKey: 'PG', role: r.role, name, duties: r.duties,
      style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff }).then(x => x.body);
    const pg = await mk('PG助手'), qa = await mk('QA助手');
    const liuId = liu.participant.participantId;
    if (!pg.participantId) throw new Error('建立 AI 失敗：' + JSON.stringify(pg));

    // 建立：必填、長度、預設狀態、編號、紀錄
    assert.equal((await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '  ' })).status, 400, '標題必填');
    assert.equal((await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: 'x'.repeat(101) })).status, 400, '標題上限');
    assert.equal((await call(liu.token, '/api/cards', 'POST', { title: 'no rid' })).status, 400, 'requestId 必填');
    const msg = (await call(liu.token, '/api/messages', 'POST', { requestId: rid(), text: '[需確認] 頭像要不要上傳圖片？' })).body;
    const c1req = rid();
    const c1 = (await call(liu.token, '/api/cards', 'POST', { requestId: c1req, title: '頭像支援上傳圖片', reason: '昱志回饋', ownerId: pg.participantId, messageIds: [msg.messageId] })).body;
    assert.match(c1.cardId, /^[A-Z]{2,5}-\d+$/); assert.match(c1.legacyId, /^C-\d+$/); // C-382：cardId＝專案卡號
    assert.equal(c1.status, '待整理'); assert.equal(c1.owner.participantId, pg.participantId); assert.equal(c1.version, 1);
    const again = await call(liu.token, '/api/cards', 'POST', { requestId: c1req, title: '頭像支援上傳圖片' });
    assert.equal(again.status, 200); assert.equal(again.body.cardId, c1.cardId, '同 requestId 不重複建立');
    const blk = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), type: '阻塞', title: 'BA Token 過期' })).body;
    assert.equal(blk.status, '受阻', '阻塞卡預設受阻');

    // AI 權限：不能指派給別人、不能改別人的卡；可建自己的、改自己負責的
    assert.equal((await call(pg.token, '/api/cards', 'POST', { requestId: rid(), title: 'x', ownerId: qa.participantId })).status, 403, 'AI 不能指派別人');
    const own = (await call(pg.token, '/api/cards', 'POST', { requestId: rid(), title: 'PG 自己的工作' })).body;
    assert.equal(own.createdBy.participantId, pg.participantId);
    assert.equal((await call(pg.token, `/api/cards/${own.cardId}`, 'PATCH', { next: '先寫 API' })).status, 200, 'AI 可改自己建立且未指派的卡');
    assert.equal((await call(qa.token, `/api/cards/${c1.cardId}`, 'PATCH', { next: '亂改' })).body.error.code, 'NOT_CARD_OWNER', 'AI 不能改別人的卡');
    assert.equal((await call(pg.token, `/api/cards/${c1.cardId}`, 'PATCH', { ownerId: qa.participantId })).body.error.code, 'ASSIGN_OTHERS', 'AI 不能轉給別人');
    // 認領：未指派＋待整理／待處理＋非決策，AI 可把負責人設為自己
    const free = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '無人認領的工作' })).body;
    assert.equal((await call(qa.token, `/api/cards/${free.cardId}`, 'PATCH', { next: '亂改' })).body.error.code, 'NOT_CARD_OWNER', '沒認領前不能改');
    assert.equal((await call(qa.token, `/api/cards/${free.cardId}`, 'PATCH', { ownerId: pg.participantId })).body.error.code, 'NOT_CARD_OWNER', '認領只能認領給自己');
    const claimed = (await call(qa.token, `/api/cards/${free.cardId}`, 'PATCH', { ownerId: qa.participantId, status: '進行中' })).body;
    assert.equal(claimed.owner.participantId, qa.participantId, '認領成功');
    assert.ok((await call(qa.token, `/api/cards/${free.cardId}`)).body.log.some(l => l.text.includes('認領')), '紀錄註明認領');
    assert.equal((await call(pg.token, `/api/cards/${free.cardId}`, 'PATCH', { ownerId: pg.participantId })).body.error.code, 'NOT_CARD_OWNER', '不能搶已有負責人的卡');
    await call(liu.token, `/api/cards/${free.cardId}`, 'PATCH', { ownerId: null }); // 人類改派回未指派，不影響後面的團隊狀態斷言
    // 交接：負責人把卡交給指定成員，附說明；C-241 起狀態維持（不再改回待處理），接手者收到群組 @ 通知
    const rel = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '[平台] 接力測試', ownerId: pg.participantId, status: '進行中' })).body;
    const H = (tok, id, body) => call(tok, `/api/cards/${id}/handover`, 'POST', body);
    assert.equal((await H(qa.token, rel.cardId, { toId: qa.participantId, note: 'x' })).body.error.code, 'NOT_CARD_OWNER', '非負責 AI 不能交接');
    assert.equal((await H(pg.token, rel.cardId, { toId: qa.participantId })).status, 400, '交接說明必填');
    assert.equal((await H(pg.token, rel.cardId, { toId: pg.participantId, note: 'x' })).body.error.code, 'SAME_OWNER', '不能交給自己');
    assert.equal((await H(pg.token, rel.cardId, { toId: qa.participantId, note: 'x'.repeat(301) })).status, 400, '交接說明上限');
    const ho = (await H(pg.token, rel.cardId, { toId: qa.participantId, note: 'API 已完成，請接畫面' })).body;
    assert.equal(ho.owner.participantId, qa.participantId, '負責人換成接手者');
    assert.equal(ho.status, '進行中', 'C-241：交接後狀態維持（進行中還是進行中）');
    const hmsg = (await call(liu.token, `/api/messages/${ho.handoverMessageId}`)).body;
    assert.ok(hmsg.text.startsWith('[交接] 【平台】' + rel.cardId + ' 接力測試 → @QA助手：API 已完成'), '自動發 [交接] 群組訊息，專案標記取自標題前綴');
    assert.ok(hmsg.recipients.some(r => r.participantId === qa.participantId), '@ 接手者');
    const relDetail = (await call(liu.token, `/api/cards/${rel.cardId}`)).body;
    assert.ok(relDetail.log.some(l => l.text.startsWith('交接 PG助手 → QA助手：') && l.text.endsWith('（狀態維持：進行中）')), '紀錄留下交接歷程與狀態');
    assert.ok(!relDetail.log.some(l => /狀態 進行中 → 待處理/.test(l.text)), 'C-241：不再有改回待處理的紀錄');
    assert.ok(hmsg.text.endsWith('（狀態維持：進行中）'), 'C-241：交接訊息寫出狀態維持');
    assert.ok(relDetail.messageIds.includes(ho.handoverMessageId), '交接訊息關聯到卡片');
    assert.equal((await H(pg.token, rel.cardId, { toId: qa.participantId, note: '再交' })).body.error.code, 'NOT_CARD_OWNER', '交出後不能再交');
    const toHuman = (await H(qa.token, rel.cardId, { toId: liuId, note: '請你看' })).body;
    assert.equal(toHuman.owner.participantId, liuId, 'AI 可以交給人類');
    // C-242：AI 交給人類＝請人類驗收 → 待確認、等誰＝那位人類；訊息寫「等你驗收」
    assert.equal(toHuman.status, '待確認', 'C-242：AI 交給人類變待確認');
    assert.equal(toHuman.waitFor?.participantId, liuId, 'C-242：等誰＝那位人類');
    assert.ok((await call(liu.token, `/api/messages/${toHuman.handoverMessageId}`)).body.text.endsWith('（等你驗收）'), 'C-242：交接訊息寫等你驗收');
    // 退回：只有負責驗收的人；原因必填；卡回到交過來的 AI、狀態回進行中、原因回覆到交接訊息
    const RJ = (tok, id, body) => call(tok, `/api/cards/${id}/reject`, 'POST', body);
    assert.equal((await RJ(qa.token, rel.cardId, { reason: 'x' })).status, 403, 'C-242：AI 不能退回');
    assert.equal((await RJ(liu.token, rel.cardId, {})).status, 400, 'C-242：退回原因必填');
    const rj = await RJ(liu.token, rel.cardId, { reason: '手機版按鈕還是擠在一起' });
    assert.equal(rj.status, 200, JSON.stringify(rj.body));
    assert.equal(rj.body.owner.participantId, qa.participantId, 'C-242：退回給交過來的 AI');
    assert.equal(rj.body.status, '進行中', 'C-242：狀態回進行中');
    assert.equal(rj.body.waitFor, null, 'C-242：不再等人');
    const rjMsg = (await call(liu.token, `/api/messages/${rj.body.rejectMessageId}`)).body;
    assert.equal(rjMsg.replyToMessageId, toHuman.handoverMessageId, 'C-242：原因回覆到交接訊息');
    assert.ok(rjMsg.text.startsWith('[退回]') && rjMsg.recipients.some(r => r.participantId === qa.participantId), 'C-242：通知那個 AI');
    assert.equal((await RJ(liu.token, rel.cardId, { reason: '再退' })).body.error.code, 'NOT_VERIFYING', 'C-242：不是等驗收的卡不能退回');
    // 人類交給 AI、人類交給人類：狀態維持
    const hh = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '人類交出', ownerId: liuId, status: '進行中' })).body;
    assert.equal((await H(liu.token, hh.cardId, { toId: qa.participantId, note: '給你' })).body.status, '進行中', 'C-242：人類交給 AI 照 C-241 維持');
    await call(liu.token, `/api/cards/${hh.cardId}`, 'PATCH', { status: '已完成' }); // 不影響後面「QA 沒負責卡片」的斷言
    // 顧問回饋：受阻交出去維持受阻；原本待確認（不是請人類驗收）交出去 → 進行中、清掉等誰
    const blkH = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '卡住的卡', ownerId: pg.participantId, status: '受阻', blocker: '等測試機' })).body;
    assert.equal((await H(pg.token, blkH.cardId, { toId: qa.participantId, note: '你接' })).body.status, '受阻', '受阻交接維持受阻');
    await call(liu.token, `/api/cards/${blkH.cardId}`, 'PATCH', { status: '已完成' });
    const wc = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '等人的卡', ownerId: liuId, status: '待確認', waitForId: pg.participantId })).body;
    const wcH = (await H(liu.token, wc.cardId, { toId: pg.participantId, note: '交給你' })).body;
    assert.ok(wcH.status === '進行中' && wcH.waitFor === null, '原本待確認交出去 → 進行中、清掉等誰：' + JSON.stringify({ s: wcH.status, w: wcH.waitFor }));
    await call(liu.token, `/api/cards/${wc.cardId}`, 'PATCH', { status: '已完成' });
    // 驗收通過＝人類標已完成（C-168 人類完成即驗收）
    const reHo = (await H(qa.token, rel.cardId, { toId: liuId, note: '修好了' })).body;
    assert.equal(reHo.status, '待確認');
    const ok = (await call(liu.token, `/api/cards/${rel.cardId}`, 'PATCH', { status: '已完成' })).body;
    assert.ok(ok.status === '已完成' && ok.verified, 'C-242：人類標已完成＝驗收通過');
    const noPrefix = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '無前綴接力', ownerId: pg.participantId })).body;
    const np = (await H(pg.token, noPrefix.cardId, { toId: liuId, note: 'ok' })).body;
    assert.ok((await call(liu.token, `/api/messages/${np.handoverMessageId}`)).body.text.startsWith(`[交接] 【${noPrefix.project}】${noPrefix.cardId} 無前綴接力`), 'C-146 A：專案標記取自卡片的專案欄位');
    const withPrefix = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: `[${noPrefix.project}] 舊式前綴`, project: noPrefix.project, ownerId: pg.participantId })).body;
    const wp = (await H(pg.token, withPrefix.cardId, { toId: liuId, note: 'ok' })).body;
    assert.ok((await call(liu.token, `/api/messages/${wp.handoverMessageId}`)).body.text.startsWith(`[交接] 【${noPrefix.project}】${withPrefix.cardId} 舊式前綴 →`), '舊卡標題前綴在通知裡去掉，不重複');
    const decH = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), type: '決策', title: '決策不能交', question: '？' })).body;
    assert.equal((await H(liu.token, decH.cardId, { toId: qa.participantId, note: 'x' })).body.error.code, 'NO_HANDOVER_DECISION', '決策卡不能交接');
    const busy = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '已進行中但無人', status: '進行中' })).body;
    assert.equal((await call(qa.token, `/api/cards/${busy.cardId}`, 'PATCH', { ownerId: qa.participantId })).body.error.code, 'NOT_CARD_OWNER', '進行中的未指派卡不能認領');
    const decFree = (await call(liu.token, "/api/cards", "POST", { requestId: rid(), type: "決策", title: "決策不能認領", question: '要不要？' })).body;
    assert.equal((await call(qa.token, `/api/cards/${decFree.cardId}`, "PATCH", { ownerId: qa.participantId })).body.error.code, "NOT_CARD_OWNER", "決策卡不能認領");
    const upd = (await call(pg.token, `/api/cards/${c1.cardId}`, 'PATCH', { status: '進行中', next: '做裁切', waitForId: liuId })).body;
    assert.equal(upd.status, '進行中'); assert.equal(upd.waitFor.name, '劉昱志'); assert.equal(upd.version, 2);

    // 版本衝突
    assert.equal((await call(liu.token, `/api/cards/${c1.cardId}`, 'PATCH', { version: 1, next: '舊版' })).status, 409, '版本不符回 409');

    // 完成與驗證：完成者不能自己驗證，別人可以；離開已完成會清掉標記
    const done = (await call(pg.token, `/api/cards/${c1.cardId}`, 'PATCH', { status: '已完成' })).body;
    assert.equal(done.done.by.participantId, pg.participantId, '記錄完成者');
    assert.equal((await call(pg.token, `/api/cards/${c1.cardId}/verify`, 'POST')).body.error.code, 'SELF_VERIFY', '完成者不能自己驗證');
    assert.equal((await call(liu.token, `/api/cards/${blk.cardId}/verify`, 'POST')).body.error.code, 'NOT_DONE', '未完成不能驗證');
    const ver = (await call(qa.token, `/api/cards/${c1.cardId}/verify`, 'POST')).body;
    assert.equal(ver.verified.by.participantId, qa.participantId, '其他 AI 可以驗證');
    assert.equal((await call(liu.token, `/api/cards/${c1.cardId}/verify`, 'POST')).body.error.code, 'ALREADY_VERIFIED');
    assert.equal((await call(percy.token, `/api/cards/${c1.cardId}/verify`, 'POST')).body.error.code, 'CARD_FORBIDDEN', 'C-333 B1：不屬於卡片專案的人不能驗證');
    const reopen = (await call(liu.token, `/api/cards/${c1.cardId}`, 'PATCH', { status: '進行中' })).body;
    assert.equal(reopen.done, null); assert.equal(reopen.verified, null, '重開後清掉完成與驗證');

    // 詳情：紀錄（含來源網頁／API）、關聯訊息
    const detail = (await call(liu.token, `/api/cards/${c1.cardId}`)).body;
    assert.equal(detail.messageIds[0], msg.messageId, "來源訊息排第一；之後的卡片動作通知也會關聯到卡片");
    const texts = detail.log.map(l => l.text);
    for (const t of ['建立卡片（類型：工作）', '狀態 待整理 → 進行中', '等誰改為 劉昱志', '標為已完成', '標為已驗證', '移除已驗證標記']) assert.ok(texts.includes(t), '紀錄：' + t);
    assert.ok(detail.log.some(l => l.via === 'API' && l.by.participantId === pg.participantId), 'AI 的操作標為 API');
    assert.ok(detail.log.some(l => l.via === '網頁' && l.by.participantId === liuId), '人類的操作標為網頁');
    assert.equal((await call(pg.token, `/api/cards/${c1.cardId}/messages`, 'POST', { messageId: msg.messageId })).status, 200, '負責人可關聯訊息');

    // 列表：預設不含已封存、open、since 增量、關鍵字
    await call(liu.token, `/api/cards/${blk.cardId}`, 'PATCH', { status: '已封存' });
    const all = (await call(liu.token, '/api/cards')).body.items.map(c => c.cardId);
    assert.ok(!all.includes(blk.cardId), '預設不含已封存');
    assert.ok((await call(liu.token, '/api/cards?include=archived')).body.items.some(c => c.cardId === blk.cardId));
    const since = (await call(liu.token, '/api/cards?include=archived')).body.nextSince;
    assert.equal((await call(liu.token, `/api/cards?since=${encodeURIComponent(since)}`)).body.items.filter(c => !c.staleHint).length, 0, '沒有變動就沒有資料（過時的卡會固定帶回，不算）');
    await call(liu.token, `/api/cards/${own.cardId}`, 'PATCH', { title: 'PG 自己的工作（改）' });
    const delta = (await call(liu.token, `/api/cards?since=${encodeURIComponent(since)}`)).body.items.filter(c => !c.staleHint);
    assert.deepEqual(delta.map(c => c.cardId), [own.cardId], 'since 只回變動的卡片');
    assert.equal((await call(liu.token, '/api/cards?q=' + encodeURIComponent('頭像'))).body.items[0].cardId, c1.cardId, '關鍵字搜尋');
    assert.equal((await call(liu.token, '/api/cards?status=壞掉')).status, 400);
    assert.equal((await call(liu.token, '/api/cards/C-99999')).status, 404);

    // ===== 第二階段：決策卡片 =====
    const dreq = { requestId: rid(), type: '決策', title: '頭像上傳存哪裡？', question: '頭像上傳要存在哪裡、誰能改？', recommendation: '存在 D1，瀏覽器先縮成 256px', options: ['同意', '改存 R2'], impact: 'UX、PG', afterNext: '交 PG 實作', deciderId: liuId };
    const d1 = (await call(pg.token, '/api/cards', 'POST', dreq)).body;
    assert.equal(d1.type, '決策'); assert.equal(d1.status, '待確認', '決策卡建立即待確認');
    assert.equal(d1.waitFor.participantId, liuId, '等決策者'); assert.equal(d1.decision.decider.participantId, liuId);
    assert.equal(d1.decision.proposer.participantId, pg.participantId); assert.deepEqual(d1.decision.options, ['同意', '改存 R2']);
    // AI 建決策卡預設決策者＝所屬人類；決策者必須是人類
    const dDefault = (await call(pg.token, '/api/cards', 'POST', { requestId: rid(), type: '決策', title: '預設決策者' })).body;
    assert.equal(dDefault.decision.decider.participantId, liuId, 'AI 預設決策者是所屬人類');
    assert.equal((await call(pg.token, '/api/cards', 'POST', { requestId: rid(), type: '決策', title: 'x', deciderId: qa.participantId })).status, 400, '決策者不能是 AI');
    assert.equal((await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: 'x', question: 'q' })).status, 400, '非決策卡不能填問題');
    assert.equal((await call(liu.token, '/api/cards', 'POST', { requestId: rid(), type: '決策', title: 'x', options: ['不同意'] })).status, 400, '選項不能和內建決定重名');
    assert.equal((await call(liu.token, '/api/cards', 'POST', { requestId: rid(), type: '決策', title: 'x', options: ['a', 'b', 'c', 'd', 'e'] })).status, 400, '選項最多 4 個');
    // 只有指定決策者能決定（其他人類、AI 都不行）
    assert.equal((await call(percy.token, `/api/cards/${d1.cardId}/decide`, 'POST', { result: '同意' })).body.error.code, 'NOT_DECIDER', '其他人類不能決定');
    assert.equal((await call(pg.token, `/api/cards/${d1.cardId}/decide`, 'POST', { result: '同意' })).body.error.code, 'NOT_DECIDER', '提案的 AI 不能自己決定');
    assert.equal((await call(pg.token, `/api/cards/${d1.cardId}`, 'PATCH', { status: '已完成' })).body.error.code, 'USE_DECIDE', '不能繞過決策直接標完成');
    assert.equal((await call(liu.token, `/api/cards/${d1.cardId}`, 'PATCH', { type: '工作' })).body.error.code, 'TYPE_LOCKED');
    assert.equal((await call(liu.token, `/api/cards/${d1.cardId}/decide`, 'POST', { result: '亂寫' })).status, 400, '結果要在選項內');
    assert.equal((await call(liu.token, `/api/cards/${d1.cardId}/decide`, 'POST', { result: '不同意' })).status, 400, '不同意要寫原因');
    // 要求補充：球回提案人；提案人補充後自動回到決策者
    const sup = (await call(liu.token, `/api/cards/${d1.cardId}/decide`, 'POST', { result: '要求補充', note: '請補上檔案大小上限' })).body;
    assert.equal(sup.status, '待確認'); assert.equal(sup.waitFor.participantId, pg.participantId, '等提案人補充');
    assert.equal(sup.decision.result, null, '尚未決定');
    const filled = (await call(pg.token, `/api/cards/${d1.cardId}`, 'PATCH', { recommendation: '存在 D1，256px webp，單檔 200 KB 內' })).body;
    assert.equal(filled.waitFor.participantId, liuId, '補充後自動回到決策者');
    // 同意：記錄決定、完成者是決策者、其他人才能驗證
    const dec = (await call(liu.token, `/api/cards/${d1.cardId}/decide`, 'POST', { result: '改存 R2', note: '先不考慮付費' })).body;
    assert.equal(dec.status, '已完成'); assert.equal(dec.decision.result, '改存 R2'); assert.equal(dec.decision.by.participantId, liuId);
    assert.equal(dec.decision.note, '先不考慮付費'); assert.equal(dec.waitFor, null); assert.equal(dec.done.by.participantId, liuId);
    assert.equal((await call(liu.token, `/api/cards/${d1.cardId}/decide`, 'POST', { result: '同意' })).body.error.code, 'DECIDED', '不能重複決定');
    assert.equal((await call(pg.token, `/api/cards/${d1.cardId}`, 'PATCH', { question: '偷改問題' })).body.error.code, 'DECIDED', '決定後不能改內容');
    assert.equal((await call(liu.token, `/api/cards/${d1.cardId}/verify`, 'POST')).body.error.code, 'SELF_VERIFY', '決策者不能自己驗證');
    assert.equal((await call(qa.token, `/api/cards/${d1.cardId}/verify`, 'POST')).status, 200);
    const dlog = (await call(liu.token, `/api/cards/${d1.cardId}`)).body.log.map(l => l.text);
    for (const t of ['要求補充：請補上檔案大小上限', '決定：改存 R2（先不考慮付費）']) assert.ok(dlog.includes(t), '紀錄：' + t);
    assert.ok(dlog.some(t => t.startsWith('已補充，改為等')), '紀錄：補充後回決策者');
    // 不同意：帶原因完成；重開（改回待確認）會撤回決定並重新等決策者
    const d2 = (await call(pg.token, '/api/cards', 'POST', { ...dreq, requestId: rid(), title: '第二個決策', options: [] })).body;
    assert.deepEqual(d2.decision.options, [], '沒有選項時預設「同意」');
    const no = (await call(liu.token, `/api/cards/${d2.cardId}/decide`, 'POST', { result: '不同意', note: '範圍太大' })).body;
    assert.equal(no.decision.result, '不同意'); assert.equal(no.decision.note, '範圍太大');
    const re = (await call(liu.token, `/api/cards/${d2.cardId}`, 'PATCH', { status: '待確認' })).body;
    assert.equal(re.decision.result, null, '重開後決定撤回'); assert.equal(re.waitFor.participantId, liuId, '重開後再等決策者'); assert.equal(re.verified, null);
    assert.equal((await call(liu.token, `/api/cards/${d2.cardId}/decide`, 'POST', { result: '同意' })).status, 200, '預設選項「同意」');
    // 換決策者只有人類能做，且等的人跟著換
    const d3 = (await call(liu.token, '/api/cards', 'POST', { ...dreq, requestId: rid(), title: '第三個決策' })).body;
    assert.equal((await call(pg.token, `/api/cards/${d3.cardId}`, 'PATCH', { deciderId: percy.participant.participantId })).status, 403, 'AI 不能換決策者');
    const sw = (await call(liu.token, `/api/cards/${d3.cardId}`, 'PATCH', { deciderId: percy.participant.participantId })).body;
    assert.equal(sw.decision.decider.name, 'Percy'); assert.equal(sw.waitFor.name, 'Percy');
    assert.equal((await call(liu.token, `/api/cards/${d3.cardId}/decide`, 'POST', { result: '同意' })).body.error.code, 'NOT_DECIDER', '原決策者換掉後不能決定');
    assert.equal((await call(percy.token, `/api/cards/${d3.cardId}/decide`, 'POST', { result: '同意' })).status, 200);
    assert.equal((await call(liu.token, '/api/cards/' + (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '普通工作' })).body.cardId + '/decide', 'POST', { result: '同意' })).status, 400, '非決策卡不能 decide');

    // ===== 第三階段：AI 建議 =====
    const sug = (tok, body) => call(tok, '/api/suggestions', 'POST', { requestId: rid(), ...body });
    assert.equal((await sug(liu.token, { kind: 'create', title: 'x', ownerId: pg.participantId, why: 'y' })).status, 400, '人類不用建議');
    assert.equal((await sug(qa.token, { kind: 'create', title: '給自己的', ownerId: qa.participantId, why: 'y' })).body.error.code, 'USE_POST', '替自己建卡要直接建');
    assert.equal((await sug(qa.token, { kind: 'create', title: '沒指派', why: 'y' })).body.error.code, 'USE_POST');
    assert.equal((await sug(qa.token, { kind: 'create', title: 'x', ownerId: pg.participantId })).status, 400, 'why 必填');
    const sMsg = (await call(liu.token, '/api/messages', 'POST', { requestId: rid(), text: '週五 demo 前請列出未完成項目' })).body;
    const sc = (await sug(qa.token, { kind: 'create', title: '週五 demo 未完成清單', ownerId: pg.participantId, next: '週四前彙整', why: '昱志要求週四前列出', basisMessageId: sMsg.messageId })).body;
    assert.equal(sc.state, 'pending'); assert.equal(sc.create.owner.participantId, pg.participantId); assert.equal(sc.from.participantId, qa.participantId);
    const mine = c1.cardId; // c1 由 pg 負責
    assert.equal((await sug(pg.token, { kind: 'status', cardId: mine, status: '待確認', why: 'y' })).body.error.code, 'USE_PATCH', '自己的卡直接 PATCH');
    const ss = (await sug(qa.token, { kind: 'status', cardId: mine, status: '待確認', waitForId: liuId, why: '修正完成，等你複驗' })).body;
    assert.equal(ss.kind, 'status'); assert.equal(ss.to, '待確認'); assert.equal(ss.card.cardId, mine);
    const ssDup = await sug(qa.token, { kind: 'status', cardId: mine, status: '待確認', waitForId: liuId, why: '重複提出' });
    assert.equal(ssDup.status, 200); assert.equal(ssDup.body.suggestionId, ss.suggestionId, '相同建議不重複建立');
    assert.equal((await sug(qa.token, { kind: 'status', cardId: mine, status: '進行中', why: 'y' })).body.error.code, 'NO_CHANGE', '已經是那個狀態');
    assert.equal((await sug(qa.token, { kind: 'status', cardId: dDefault.cardId, status: '已完成', why: 'y' })).body.error.code, 'USE_DECIDE');
    // 列表：人類看全部、AI 只看自己的；AI 不能採用或略過
    assert.equal((await call(liu.token, '/api/suggestions')).body.items.length, 2);
    assert.equal((await call(pg.token, '/api/suggestions')).body.items.length, 0, 'AI 只看到自己的建議');
    assert.equal((await call(qa.token, `/api/suggestions/${ss.suggestionId}/apply`, 'POST', {})).status, 403, 'AI 不能採用');
    assert.equal((await call(pg.token, `/api/suggestions/${ss.suggestionId}/skip`, 'POST')).status, 403);
    // 採用（建卡，可先改欄位）：卡片由建議者建立、負責人是被指派者、關聯依據訊息、紀錄註明採用
    const ap = await call(liu.token, `/api/suggestions/${sc.suggestionId}/apply`, 'POST', { title: '週五 demo 未完成清單（改）' });
    assert.equal(ap.status, 201); assert.equal(ap.body.title, '週五 demo 未完成清單（改）'); assert.equal(ap.body.status, '待處理');
    assert.equal(ap.body.createdBy.participantId, qa.participantId); assert.equal(ap.body.owner.participantId, pg.participantId);
    const apd = (await call(liu.token, `/api/cards/${ap.body.cardId}`)).body;
    assert.equal(apd.messageIds[0], sMsg.messageId); assert.equal(apd.messageIds.length, 2, "採用建議的通知也關聯到新卡");
    assert.ok(apd.log[0].text.includes('採用 QA助手 的建議建立卡片'), '紀錄註明採用誰的建議');
    assert.equal((await call(liu.token, `/api/suggestions/${sc.suggestionId}/apply`, 'POST', {})).body.error.code, 'NOT_PENDING', '不能重複採用');
    // 採用（改狀態）與略過
    const aps = (await call(liu.token, `/api/suggestions/${ss.suggestionId}/apply`, 'POST', {})).body;
    assert.equal(aps.status, '待確認'); assert.equal(aps.waitFor.participantId, liuId);
    assert.ok((await call(liu.token, `/api/cards/${mine}`)).body.log.some(l => l.text.startsWith('採用 QA助手 的建議：狀態')));
    const sk = (await sug(qa.token, { kind: 'create', title: '會被略過', ownerId: pg.participantId, why: 'y' })).body;
    assert.equal((await call(liu.token, `/api/suggestions/${sk.suggestionId}/skip`, 'POST')).body.state, 'skipped');
    assert.equal((await call(liu.token, '/api/suggestions')).body.items.length, 0, '處理完就不在待處理');
    assert.equal((await call(liu.token, '/api/suggestions?state=applied')).body.items.length, 2);

    // ===== 團隊狀態取自卡片 =====
    const team = (await call(liu.token, '/api/team-status')).body;
    const pgMem = team.members.find(m => m.participantId === pg.participantId);
    assert.equal(pgMem.status.source, 'card', 'PG 有負責的卡片，狀態取自卡片');
    assert.equal(pgMem.status.state, 'waiting', '最急的是待確認那張');
    assert.equal(pgMem.status.cardId, mine); assert.ok(pgMem.status.cardCount >= 2);
    const qaMem = team.members.find(m => m.participantId === qa.participantId);
    assert.ok(!qaMem.status || qaMem.status.source !== 'card', 'QA 沒負責卡片，不顯示卡片狀態');
    // 決策卡：等決策者的列入「等你決定」，帶 cardId 與決策者
    const dOpen = (await call(liu.token, '/api/cards', 'POST', { ...dreq, requestId: rid(), title: '團隊狀態用的決策' })).body;
    const team2 = (await call(liu.token, '/api/team-status')).body;
    const dd = team2.decisions.find(x => x.cardId === dOpen.cardId);
    assert.ok(dd, '決策卡列入等你決定'); assert.equal(dd.deciderId, liuId);
    await call(liu.token, `/api/cards/${dOpen.cardId}/decide`, 'POST', { result: '同意' });
    assert.ok(!(await call(liu.token, '/api/team-status')).body.decisions.some(x => x.cardId === dOpen.cardId), '決定後就移出');

    // C-115 卡片動作發通知：決定、變更負責人／等待對象、採用建議，會 @ 相關成員（走既有通知與門鈴）
    const pend = async tok => (await call(tok, '/api/notifications?status=pending&limit=100')).body.items.map(n => n.preview || '');
    // C-155：建卡時指定別人也通知（負責人、等誰、決策者）；指定自己不通知
    const cc = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '建卡就指派', ownerId: qa.participantId, waitForId: pg.participantId })).body;
    assert.ok((await pend(qa.token)).some(t => t.includes(cc.cardId) && t.includes('建立卡片，負責人 QA助手')), 'C-155：建卡指定負責人 → 負責人收到通知');
    assert.ok((await pend(pg.token)).some(t => t.includes(cc.cardId) && t.includes('等 PG助手')), 'C-155：建卡指定等誰 → 對方收到通知');
    const ccDec = (await call(pg.token, '/api/cards', 'POST', { requestId: rid(), type: '決策', title: 'AI 提決策', question: '要不要？' })).body;
    assert.ok((await pend(liu.token)).some(t => t.includes(ccDec.cardId) && t.includes('決定')), 'C-155：AI 建決策卡 → 決策者（所屬人類）收到通知');
    const ccSelf = (await call(qa.token, '/api/cards', 'POST', { requestId: rid(), title: '自己的卡', ownerId: qa.participantId })).body;
    assert.ok(!(await pend(qa.token)).some(t => t.includes(ccSelf.cardId)), 'C-155：指定自己不通知');
    const nd = (await call(pg.token, '/api/cards', 'POST', { requestId: rid(), type: '決策', title: '[平台] 通知測試決策', question: '要不要通知？' })).body;
    await call(liu.token, `/api/cards/${nd.cardId}/decide`, 'POST', { result: '要求補充', note: '請補充影響範圍' });
    assert.ok((await pend(pg.token)).some(t => t.startsWith('[通知] 【平台】' + nd.cardId) && t.includes('要求補充：請補充影響範圍')), '要求補充通知提案人，帶專案標記且標題去掉舊前綴');
    const nc = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '通知測試工作' })).body;
    await call(liu.token, `/api/cards/${nc.cardId}`, 'PATCH', { ownerId: qa.participantId });
    await call(liu.token, `/api/cards/${nc.cardId}`, 'PATCH', { ownerId: qa.participantId }); // 沒變更，不重複發
    const qn = (await pend(qa.token)).filter(t => t.includes(nc.cardId));
    assert.equal(qn.length, 1, '變更負責人通知新負責人，且只發一則');
    assert.ok(qn[0].startsWith(`[通知] 【${nc.project}】${nc.cardId} 通知測試工作：負責人改為`), 'C-146 A：專案標記取自卡片的專案欄位');
    const selfCard = (await call(qa.token, '/api/cards', 'POST', { requestId: rid(), title: 'QA 自己改自己' })).body;
    await call(qa.token, `/api/cards/${selfCard.cardId}`, "PATCH", { ownerId: qa.participantId, status: '進行中' });
    assert.ok(!(await pend(qa.token)).some(t => t.includes(selfCard.cardId)), 'AI 自己改自己的卡不發通知（避免互相喚醒）');
    // C-130：POST /api/messages 可帶 cardId，訊息一併關聯到該卡；找不到的卡回 404 且不發訊息
    const cm = (await call(liu.token, '/api/messages', 'POST', { requestId: rid(), text: '[回覆] ' + nc.cardId + '：先照原計畫', cardId: nc.cardId, recipientIds: [qa.participantId] })).body;
    assert.equal(cm.cardLinked, true, '訊息關聯到卡片');
    assert.ok((await call(liu.token, `/api/cards/${nc.cardId}`)).body.messageIds.includes(cm.messageId), '卡片的相關訊息含這則');
    const before = (await call(liu.token, '/api/messages?limit=5')).body.items.length;
    assert.equal((await call(liu.token, '/api/messages', 'POST', { requestId: rid(), text: 'x', cardId: 'C-99999' })).status, 404, '找不到卡片回 404');
    assert.equal((await call(liu.token, '/api/messages?limit=5')).body.items.length, before, '404 時沒有發出訊息');
    assert.equal((await call(liu.token, '/api/messages', 'POST', { requestId: rid(), text: 'x', cardId: 'abc' })).status, 404, 'cardId 格式錯誤');
    // C-134：人類回覆某則訊息＝處理了它，他在那則訊息上的待處理通知自動標為已讀；AI 不會被自動 ACK
    const ask = (await call(qa.token, '/api/messages', 'POST', { requestId: rid(), text: '[需確認] 自動已讀測試', recipientIds: [liuId] })).body;
    const nPend = async () => (await call(liu.token, '/api/notifications?status=pending&limit=100')).body.items.filter(n => n.messageId === ask.messageId).length;
    assert.equal(await nPend(), 1, '人類收到待處理通知');
    await call(liu.token, '/api/messages', 'POST', { requestId: rid(), text: '[回覆] 可以', replyToMessageId: ask.messageId, recipientIds: [qa.participantId] });
    assert.equal(await nPend(), 0, '人類回覆後該則通知自動已讀');
    const aiNotif = (await call(qa.token, '/api/notifications?status=pending&limit=100')).body.items.filter(n => n.messageId !== ask.messageId);
    assert.ok(aiNotif.some(n => (n.preview || '').startsWith('[回覆] 可以')), 'AI 收到的回覆通知仍是待處理（不替 AI 自動 ACK）');
    // ===== C-139：決策卡暫緩／恢復 =====
    const df = (await call(pg.token, '/api/cards', 'POST', { requestId: rid(), type: '決策', title: '暫緩測試', deciderId: liuId })).body;
    assert.equal((await call(percy.token, `/api/cards/${df.cardId}/defer`, 'POST', { reason: 'x' })).body.error.code, 'NOT_PARTY', '無關的人不能暫緩');
    assert.equal((await call(qa.token, `/api/cards/${df.cardId}/defer`, 'POST', { reason: 'x' })).body.error.code, 'NOT_PARTY', '無關的 AI 不能暫緩');
    const wk = (await call(pg.token, '/api/cards', 'POST', { requestId: rid(), title: '一般工作卡' })).body;
    assert.equal((await call(liu.token, `/api/cards/${wk.cardId}/defer`, 'POST', {})).status, 400, '非決策卡不能暫緩');
    const dfd = (await call(liu.token, `/api/cards/${df.cardId}/defer`, 'POST', { reason: '等銀行端確認' })).body;
    assert.equal(dfd.status, '受阻'); assert.ok(dfd.blocker.startsWith('暫緩（') && dfd.blocker.includes('等銀行端確認')); assert.equal(dfd.decision.deferred, true);
    assert.equal((await call(liu.token, `/api/cards/${df.cardId}/decide`, 'POST', { result: '同意' })).body.error.code, 'NOT_PENDING', '暫緩中不能決定');
    assert.equal((await call(liu.token, `/api/cards/${df.cardId}/defer`, 'POST', {})).body.error.code, 'NOT_PENDING', '不能重複暫緩');
    assert.ok((await pend(pg.token)).some(t => t.includes(df.cardId) && t.includes('暫緩（')), '暫緩通知提案人');
    assert.ok(!(await call(liu.token, '/api/team-status')).body.decisions.some(d => d.cardId === df.cardId), '暫緩後不在待決定清單');
    assert.equal((await call(percy.token, `/api/cards/${df.cardId}/resume`, 'POST')).body.error.code, 'NOT_PARTY');
    const rs = (await call(pg.token, `/api/cards/${df.cardId}/resume`, 'POST')).body;
    assert.equal(rs.status, '待確認'); assert.equal(rs.blocker, ''); assert.equal(rs.decision.deferred, false); assert.equal(rs.waitFor.participantId, liuId);
    assert.ok((await call(liu.token, '/api/team-status')).body.decisions.some(d => d.cardId === df.cardId), '恢復後回到待決定清單');
    assert.equal((await call(pg.token, `/api/cards/${df.cardId}/resume`, 'POST')).body.error.code, 'NOT_DEFERRED', '沒暫緩不能恢復');
    await call(liu.token, `/api/cards/${df.cardId}/decide`, 'POST', { result: '同意' });
    assert.equal((await call(liu.token, `/api/cards/${df.cardId}/defer`, 'POST', {})).body.error.code, 'DECIDED', '已決定不能暫緩');
    // ===== C-143：AI 軟刪除 =====
    const gone = await mk('待刪助手');
    const poAi = (await call(liu.token, '/api/my-ais', 'POST', { roleKey: 'PO', role: 'PO', name: '產品助手', duties: 'd', style: 's', autonomy: 'a', mustConfirm: 'm', handoff: 'h' })).body;
    const gcard = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '待刪助手的卡', ownerId: gone.participantId, status: '進行中' })).body;
    assert.equal(gcard.owner?.participantId, gone.participantId);
    const gmsg = (await call(gone.token, '/api/messages', 'POST', { requestId: rid(), text: '[進度] 我在做事' })).body;
    assert.equal((await call(gone.token, `/api/my-ais/${gone.participantId}/delete`, 'POST', { confirmName: '待刪助手' })).status, 403, 'AI 不能刪除');
    assert.equal((await call(percy.token, `/api/my-ais/${gone.participantId}/delete`, 'POST', { confirmName: gone.name })).status, 404, '別人不能刪');
    assert.equal((await call(liu.token, `/api/my-ais/${gone.participantId}/delete`, 'POST', { confirmName: '打錯' })).status, 400, '名稱不符');
    const del = (await call(liu.token, `/api/my-ais/${gone.participantId}/delete`, 'POST', { confirmName: gone.name })).body;
    assert.deepEqual(del.unassignedCards, [gcard.cardId]); assert.equal(del.notified, true);
    assert.equal((await call(gone.token, '/api/me')).status, 401, 'Token 立即失效');
    assert.ok(!(await call(liu.token, '/api/participants')).body.items.some(p => p.participantId === gone.participantId), '不在成員清單');
    assert.ok(!(await call(liu.token, '/api/my-ais')).body.items.some(p => p.participantId === gone.participantId), '不在我的 AI');
    assert.equal((await call(liu.token, `/api/my-ais/${gone.participantId}/enable`, 'POST')).status, 404, '不能再啟用');
    assert.equal((await call(liu.token, `/api/my-ais/${gone.participantId}/delete`, 'POST', { confirmName: gone.name })).status, 404, '重複刪除');
    const afterCard = (await call(liu.token, `/api/cards/${gcard.cardId}`)).body;
    assert.equal(afterCard.owner, null, '卡片變未指派'); assert.equal(afterCard.status, '待處理');
    const oldMsg = (await call(liu.token, `/api/messages/${gmsg.messageId}`)).body;
    assert.equal(oldMsg.author.deleted, true); assert.ok(oldMsg.author.name.endsWith('（已刪除）'), '舊訊息保留並標已刪除');
    assert.ok((await call(poAi.token, '/api/notifications?status=pending&limit=50')).body.items.some(n => (n.preview || '').includes('待刪助手') && n.preview.includes(gcard.cardId)), 'PO 收到哪些卡變未指派');
    // ===== C-144：可能過時（測試把門檻調成 0）=====
    const st1 = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '過時測試卡', status: '進行中' })).body;
    await new Promise(r2 => setTimeout(r2, 20));
    assert.equal((await call(liu.token, `/api/cards/${st1.cardId}`)).body.staleHint, undefined, '沒有關聯訊息不算過時');
    await call(pg.token, '/api/messages', 'POST', { requestId: rid(), text: `[通知] ${st1.cardId} 系統通知`, cardId: st1.cardId });
    assert.equal((await call(liu.token, `/api/cards/${st1.cardId}`)).body.staleHint, undefined, '[通知] 不算新動態');
    await call(pg.token, '/api/messages', 'POST', { requestId: rid(), text: `[進度] ${st1.cardId} 我做了很多事`, cardId: st1.cardId });
    const stl = (await call(liu.token, `/api/cards/${st1.cardId}`)).body;
    assert.ok(stl.staleHint?.latestMessageAt > stl.staleHint?.lastUpdatedAt, '有新進度訊息 → 可能過時');
    assert.ok((await call(liu.token, '/api/cards')).body.items.find(x => x.cardId === st1.cardId).staleHint, '列表也有 staleHint');
    const sinceList = (await call(liu.token, '/api/cards?since=' + encodeURIComponent(new Date(Date.now() + 60_000).toISOString()))).body.items;
    assert.ok(sinceList.some(x => x.cardId === st1.cardId && x.staleHint), '增量同步也帶回過時的卡');
    await call(liu.token, `/api/cards/${st1.cardId}`, 'PATCH', { next: '更新一下' });
    assert.equal((await call(liu.token, `/api/cards/${st1.cardId}`)).body.staleHint, undefined, '更新卡片後不再過時');
    await call(pg.token, '/api/messages', 'POST', { requestId: rid(), text: `[進度] ${st1.cardId} 再一則`, cardId: st1.cardId });
    await call(liu.token, `/api/cards/${st1.cardId}`, 'PATCH', { status: '待確認' });
    await call(liu.token, `/api/cards/${st1.cardId}`, 'PATCH', { status: '已完成' });
    assert.equal((await call(liu.token, `/api/cards/${st1.cardId}`)).body.staleHint, undefined, '已完成的卡不標過時');
    // ===== C-161 卡片瘦身：已完成＋已驗證滿 7 天自動封存 =====
    // 這段改用 Percy 的帳號，避免劉昱志的帳號撞到每分鐘請求上限
    await call(liu.token, `/api/participants/${percy.participant.participantId}/projects`, 'PUT', { projects: ['平台'] });
    const pc = percy;
    const { DatabaseSync } = await import('node:sqlite');
    const sqlDb = new DatabaseSync(path.join(dataDir, 'switch.db'));
    const ago = d => new Date(Date.now() - d * 86400_000).toISOString();
    const seqOf = id => Number(id.slice(2)) - 100; // 傳 legacyId（C-382：cardId 是專案卡號）
    const mkDone = async (title, verify) => {
      const c = (await call(pc.token, '/api/cards', 'POST', { requestId: rid(), title, ownerId: pg.participantId })).body;
      if (!c.cardId) throw new Error('建卡失敗：' + JSON.stringify(c));
      await call(pg.token, `/api/cards/${c.cardId}`, 'PATCH', { status: '已完成' });
      if (verify) await call(pc.token, `/api/cards/${c.cardId}/verify`, 'POST');
      return c;
    };
    const oldV = await mkDone('驗證滿 8 天', true), oldU = await mkDone('完成 8 天沒驗證', false), newV = await mkDone('驗證 6 天', true);
    sqlDb.prepare('UPDATE cards SET done_at = ?, verified_at = ? WHERE seq = ?').run(ago(9), ago(8), seqOf(oldV.legacyId));
    sqlDb.prepare('UPDATE cards SET done_at = ? WHERE seq = ?').run(ago(8), seqOf(oldU.legacyId));
    sqlDb.prepare('UPDATE cards SET done_at = ?, verified_at = ? WHERE seq = ?').run(ago(7), ago(6), seqOf(newV.legacyId));
    const list = (await call(pc.token, '/api/cards?limit=200&counts=1')).body; // 讀卡時順便封存（測試設 ARCHIVE_EVERY_MS=0）
    const st = id => list.items.find(c => c.cardId === id)?.status;
    assert.equal(st(oldV.cardId), undefined, '已驗證滿 7 天 → 不在預設清單（已封存）');
    assert.equal(st(oldU.cardId), '已完成', '未驗證永遠不自動封存');
    assert.equal(st(newV.cardId), '已完成', '驗證未滿 7 天不封存');
    assert.ok(list.counts.archived >= 1, 'counts=1 回已封存總數');
    const arch = (await call(pc.token, `/api/cards/${oldV.cardId}`)).body;
    assert.equal(arch.status, '已封存');
    assert.ok(arch.log.some(l => l.text === '系統自動封存（完成滿 7 天）' && l.by?.name === '系統' && l.via === '系統'), '紀錄寫系統自動封存');
    assert.ok(arch.done && arch.verified, '封存保留完成與驗證資訊（抽屜要顯示）');
    const archList = (await call(pc.token, '/api/cards?status=已封存&limit=1&offset=0')).body;
    assert.equal(archList.items.length, 1, '已封存分頁 limit');
    assert.ok((await call(pc.token, '/api/cards?include=archived&limit=200')).body.items.some(c => c.cardId === oldV.cardId), 'include=archived 拿得到');
    // 重新打開：清掉完成／驗證，再完成＋驗證重新計 7 天（不會馬上又被封存）
    const reo = (await call(pc.token, `/api/cards/${oldV.cardId}`, 'PATCH', { status: '待處理' })).body;
    assert.ok(reo.status === '待處理' && !reo.done && !reo.verified, '重新打開清掉完成與驗證');
    await call(pg.token, `/api/cards/${oldV.cardId}`, 'PATCH', { status: '已完成' });
    await call(pc.token, `/api/cards/${oldV.cardId}/verify`, 'POST');
    assert.equal((await call(pc.token, '/api/cards?limit=200')).body.items.find(c => c.cardId === oldV.cardId)?.status, '已完成', '重新完成＋驗證後重新計 7 天');
    const back = (await call(pc.token, `/api/cards/${oldV.cardId}`)).body;
    assert.ok(back.log.some(l => l.text === '重新打開'), '紀錄寫重新打開');
    sqlDb.close();
    // C-168：人類標「已完成」＝最終驗收，同時記為已驗證；AI 完成的卡照舊要別人驗
    const hc = (await call(pc.token, '/api/cards', 'POST', { requestId: rid(), title: '人類完成的卡', ownerId: percy.participant.participantId })).body;
    const hd = (await call(pc.token, `/api/cards/${hc.cardId}`, 'PATCH', { status: '已完成' })).body;
    assert.ok(hd.done && hd.verified && hd.verified.by?.participantId === percy.participant.participantId, 'C-168：人類完成 → 自動記為已驗證（驗證人＝本人）');
    assert.ok((await call(pc.token, `/api/cards/${hc.cardId}`)).body.log.some(l => l.text === '人類完成即驗收'), '紀錄寫「人類完成即驗收」');
    const ac = (await call(pc.token, '/api/cards', 'POST', { requestId: rid(), title: 'AI 完成的卡', ownerId: pg.participantId })).body;
    const ad = (await call(pg.token, `/api/cards/${ac.cardId}`, 'PATCH', { status: '已完成' })).body;
    assert.ok(ad.done && !ad.verified, 'AI 完成 → 仍待別人驗證');
    console.log('cards: all checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
