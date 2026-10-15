// AI 建議批次處理驗收測試（C-107）：批次採用／略過、AI 不能批次、部分失敗不中斷、通知合併、上限。
// 用法：npm run test:suggestions
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3994;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-sugg-'));
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
const rid = () => 'req_s' + (++n);

(async () => {
  await ready;
  try {
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'UX' })).body;
    const liuId = liu.participant.participantId;
    await call(liu.token, `/api/participants/${liuId}/projects`, 'PUT', { projects: ['平台'] });
    const r = ROLES.find(x => x.key === 'PG');
    const mk = name => call(liu.token, '/api/my-ais', 'POST', { roleKey: 'PG', role: r.role, name, duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff }).then(x => x.body);
    const pg = await mk('PG助手'), qa = await mk('QA助手');

    // 三張別人（人類）的卡，PG 各提一則「改進行中」；QA 提一則「替 PG 建卡」
    const cards = [];
    for (let i = 0; i < 3; i++) cards.push((await call(liu.token, '/api/cards', 'POST', { requestId: rid(), title: `批次測試卡 ${i}`, status: '待處理' })).body);
    const sg = [];
    for (const c of cards) sg.push((await call(pg.token, '/api/suggestions', 'POST', { requestId: rid(), kind: 'status', cardId: c.cardId, status: '進行中', why: '我開始做了' })).body.suggestionId);
    const creat = (await call(qa.token, '/api/suggestions', 'POST', { requestId: rid(), kind: 'create', title: '請 PG 補測試', ownerId: pg.participantId, why: '缺測試' })).body.suggestionId;
    assert.ok(sg.every(Boolean) && creat, '建議建立成功');

    const B = (tok, body) => call(tok, '/api/suggestions/batch', 'POST', body);
    // 權限與驗證
    assert.equal((await B(pg.token, { action: 'apply', ids: sg })).status, 403, 'AI 不能批次處理');
    assert.equal((await B(liu.token, { action: 'all', ids: sg })).status, 400, 'action 只能 apply／skip');
    assert.equal((await B(liu.token, { action: 'apply', ids: [] })).status, 400, 'ids 不能空（沒有「全部採用」）');
    assert.equal((await B(liu.token, { action: 'apply' })).status, 400, '沒給 ids 也不行');
    assert.equal((await B(liu.token, { action: 'apply', ids: Array.from({ length: 51 }, (_, i) => `S-${i + 1}`) })).status, 400, '一次最多 50 則');

    // 批次採用：含一則不存在的（部分失敗不中斷）
    const res = (await B(liu.token, { action: 'apply', ids: [...sg, creat, 'S-9999'] })).body;
    assert.equal(res.done, 4, '4 則成功');
    assert.equal(res.failed, 1, '1 則失敗（不存在）');
    assert.equal(res.results.find(x => x.id === 'S-9999').ok, false);
    for (const c of cards) {
      const d = (await call(liu.token, `/api/cards/${c.cardId}`)).body;
      assert.equal(d.status, '進行中', '卡片狀態已改');
      assert.ok(d.log.some(l => l.text.includes('採用 PG助手 的建議')), '卡片紀錄寫採用誰的建議');
    }
    // 再批次一次：已處理過的回 NOT_PENDING，不中斷
    const again = (await B(liu.token, { action: 'apply', ids: [sg[0]] })).body;
    assert.equal(again.results[0].error, 'NOT_PENDING', '已處理過的回 NOT_PENDING');

    // 通知合併：PG 只收到一則批次通知，列出三張卡與新建的那張
    const pending = (await call(pg.token, '/api/notifications?status=pending&limit=100')).body.items.map(x => x.preview || '');
    const batchMsgs = pending.filter(t => t.startsWith('[通知] 批次採用了 AI 建議'));
    assert.equal(batchMsgs.length, 1, '同一位收件人只收一則合併通知');
    assert.ok(cards.every(c => batchMsgs[0].includes(c.cardId)), '合併通知列出所有相關的卡');

    // 批次略過
    const more = [];
    for (const c of cards) more.push((await call(pg.token, '/api/suggestions', 'POST', { requestId: rid(), kind: 'status', cardId: c.cardId, status: '待確認', why: '做完了' })).body.suggestionId);
    const skipped = (await B(liu.token, { action: 'skip', ids: more })).body;
    assert.equal(skipped.done, 3, '批次略過 3 則');
    for (const c of cards) assert.equal((await call(liu.token, `/api/cards/${c.cardId}`)).body.status, '進行中', '略過不改卡片');
    assert.equal((await call(pg.token, '/api/suggestions?state=skipped')).body.items.length, 3, '建議狀態為已略過');

    console.log('suggestions: all checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
