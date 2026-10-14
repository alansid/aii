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
    assert.deepEqual(detail.messageIds, [msg.messageId]);
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

    console.log('cards: all checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
