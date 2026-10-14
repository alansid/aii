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
    assert.equal((await call(liu.token, '/api/cards', 'POST', { requestId: rid(), type: '決策', title: 'x' })).status, 400, '決策卡第二階段才開放');

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

    console.log('cards: all checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
