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
    assert.match(c1.cardId, /^C-\d+$/);
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
    // 交接：負責人把卡交給指定成員，附說明；接手者回待處理並收到群組 @ 通知
    const rel = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '[平台] 接力測試', ownerId: pg.participantId, status: '進行中' })).body;
    const H = (tok, id, body) => call(tok, `/api/cards/${id}/handover`, 'POST', body);
    assert.equal((await H(qa.token, rel.cardId, { toId: qa.participantId, note: 'x' })).body.error.code, 'NOT_CARD_OWNER', '非負責 AI 不能交接');
    assert.equal((await H(pg.token, rel.cardId, { toId: qa.participantId })).status, 400, '交接說明必填');
    assert.equal((await H(pg.token, rel.cardId, { toId: pg.participantId, note: 'x' })).body.error.code, 'SAME_OWNER', '不能交給自己');
    assert.equal((await H(pg.token, rel.cardId, { toId: qa.participantId, note: 'x'.repeat(301) })).status, 400, '交接說明上限');
    const ho = (await H(pg.token, rel.cardId, { toId: qa.participantId, note: 'API 已完成，請接畫面' })).body;
    assert.equal(ho.owner.participantId, qa.participantId, '負責人換成接手者');
    assert.equal(ho.status, '待處理', '交接後回待處理');
    const hmsg = (await call(liu.token, `/api/messages/${ho.handoverMessageId}`)).body;
    assert.ok(hmsg.text.startsWith('[交接] 【平台】' + rel.cardId + ' 接力測試 → @QA助手：API 已完成'), '自動發 [交接] 群組訊息，專案標記取自標題前綴');
    assert.ok(hmsg.recipients.some(r => r.participantId === qa.participantId), '@ 接手者');
    const relDetail = (await call(liu.token, `/api/cards/${rel.cardId}`)).body;
    assert.ok(relDetail.log.some(l => l.text.startsWith('交接 PG助手 → QA助手：')), '紀錄留下交接歷程');
    assert.ok(relDetail.messageIds.includes(ho.handoverMessageId), '交接訊息關聯到卡片');
    assert.equal((await H(pg.token, rel.cardId, { toId: qa.participantId, note: '再交' })).body.error.code, 'NOT_CARD_OWNER', '交出後不能再交');
    const toHuman = (await H(qa.token, rel.cardId, { toId: liuId, note: '請你看' })).body;
    assert.equal(toHuman.owner.participantId, liuId, 'AI 可以交給人類');
    const noPrefix = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '無前綴接力', ownerId: pg.participantId })).body;
    const np = (await H(pg.token, noPrefix.cardId, { toId: liuId, note: 'ok' })).body;
    assert.ok((await call(liu.token, `/api/messages/${np.handoverMessageId}`)).body.text.startsWith('[交接] ' + noPrefix.cardId + ' 無前綴接力'), '沒前綴就不加專案標記');
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
    assert.equal((await call(percy.token, `/api/cards/${c1.cardId}/verify`, 'POST')).body.error.code, 'ALREADY_VERIFIED');
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
    assert.equal((await call(liu.token, `/api/cards?since=${encodeURIComponent(since)}`)).body.items.length, 0, '沒有變動就沒有資料');
    await call(liu.token, `/api/cards/${own.cardId}`, 'PATCH', { title: 'PG 自己的工作（改）' });
    const delta = (await call(liu.token, `/api/cards?since=${encodeURIComponent(since)}`)).body.items;
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
    const nd = (await call(pg.token, '/api/cards', 'POST', { requestId: rid(), type: '決策', title: '[平台] 通知測試決策', question: '要不要通知？' })).body;
    await call(liu.token, `/api/cards/${nd.cardId}/decide`, 'POST', { result: '要求補充', note: '請補充影響範圍' });
    assert.ok((await pend(pg.token)).some(t => t.startsWith('[通知] 【平台】' + nd.cardId) && t.includes('要求補充：請補充影響範圍')), '要求補充通知提案人，專案標記取自標題前綴');
    const nc = (await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: '通知測試工作' })).body;
    await call(liu.token, `/api/cards/${nc.cardId}`, 'PATCH', { ownerId: qa.participantId });
    await call(liu.token, `/api/cards/${nc.cardId}`, 'PATCH', { ownerId: qa.participantId }); // 沒變更，不重複發
    const qn = (await pend(qa.token)).filter(t => t.includes(nc.cardId));
    assert.equal(qn.length, 1, '變更負責人通知新負責人，且只發一則');
    assert.ok(qn[0].startsWith('[通知] ' + nc.cardId + ' 通知測試工作：負責人改為'), '沒前綴就不加專案標記');
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
    console.log('cards: all checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
