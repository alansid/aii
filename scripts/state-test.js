// AI 工作記憶驗收測試（C-108）：寫入驗證、16KB、非法欄位、行內檢查、相同內容不重寫、依專案可見。
// 用法：npm run test:state
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3993;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-state-'));
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TEAM_CACHE_MS: '0' }, stdio: 'pipe',
});
const ready = new Promise((res, rej) => {
  server.stdout.on('data', d => { if (String(d).includes('已啟動')) res(); });
  server.on('exit', c => rej(new Error('server exited ' + c)));
});
const call = async (token, p, method = 'GET', body, raw) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

(async () => {
  await ready;
  try {
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'UX' })).body;
    const percy = (await call(null, '/api/join', 'POST', { name: 'Percy', role: 'PO' })).body;
    const liuId = liu.participant.participantId, percyId = percy.participant.participantId;
    const r = ROLES.find(x => x.key === 'PG');
    const mk = (name, environment) => call(liu.token, '/api/my-ais', 'POST', { projects: ['平台', '銀行系統'], roleKey: 'PG', role: r.role, name, duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff, environment }).then(x => x.body);
    const plat = await mk('平台PG', '行外'), bank = await mk('銀行PG', '行內');
    await call(liu.token, `/api/participants/${plat.participantId}/projects`, 'PUT', { projects: ['平台'] });
    await call(liu.token, `/api/participants/${bank.participantId}/projects`, 'PUT', { projects: ['銀行系統'] });
    await call(liu.token, `/api/participants/${liuId}/projects`, 'PUT', { projects: ['平台'] }); // 劉昱志只看平台
    await call(liu.token, `/api/participants/${percy.participant.participantId}/projects`, 'PUT', { projects: ['平台', '銀行系統'] }); // percy 兩邊都屬於（之後加入的人類預設沒有專案，由管理員劉昱志設定）

    const sha = '0123456789abcdef0123456789abcdef01234567';
    const good = { currentTask: { title: '做 C-108', stage: '實作', sha, cardId: 'C-108' }, backlog: [{ title: 'C-107 批次', trigger: '昱志同意' }], wakeMode: 'watcher' };
    const put = (tok, body, raw) => call(tok, '/api/me/state', 'PUT', body, raw);

    // 權限與格式
    assert.equal((await put(liu.token, good)).status, 403, '人類不能寫');
    assert.equal((await call(liu.token, '/api/me/state')).status, 403, '人類沒有自己的工作記憶');
    assert.equal((await put(plat.token, null, '{壞掉')).status, 400, '非法 JSON');
    assert.equal((await put(plat.token, { x: 1 })).status, 400, '未知欄位');
    assert.equal((await put(plat.token, { currentTask: { title: 'a', foo: 1 } })).status, 400, 'currentTask 未知欄位');
    assert.equal((await put(plat.token, { currentTask: { title: 'a', sha: 'abc' } })).status, 400, 'sha 要完整 40 碼');
    assert.equal((await put(plat.token, { currentTask: { title: 'a', cardId: 'X1' } })).status, 400, 'cardId 格式');
    assert.equal((await put(plat.token, { wakeMode: 'x' })).status, 400, 'wakeMode 只能三種');
    assert.equal((await put(plat.token, { backlog: Array.from({ length: 21 }, (_, i) => ({ title: 't' + i })) })).status, 400, 'backlog 最多 20');
    assert.equal((await put(plat.token, { currentTask: { title: 'x'.repeat(101) } })).status, 400, 'title 上限');
    assert.equal((await put(plat.token, null, JSON.stringify({ currentTask: { title: 'a' }, pad: 'x'.repeat(17000) }))).status, 400, '超過 16KB');

    // 寫入、讀回、相同內容不重寫
    const w1 = (await put(plat.token, good)).body;
    assert.equal(w1.unchanged, false, '第一次寫入');
    const rd = (await call(plat.token, '/api/me/state')).body;
    assert.equal(rd.state.currentTask.title, '做 C-108', 'AI 讀回自己的狀態');
    assert.equal(rd.state.backlog.length, 1);
    const w2 = (await put(plat.token, good)).body;
    assert.equal(w2.unchanged, true, '內容相同不重寫');
    assert.equal(w2.updatedAt, w1.updatedAt, '更新時間不變');
    const changed = (await put(plat.token, { ...good, currentTask: { ...good.currentTask, stage: '測試' } })).body;
    assert.equal(changed.unchanged, false, '內容改變才寫');

    // 行內 AI：只准標題與 SHA
    assert.equal((await put(bank.token, { currentTask: { title: '改 C:\src\Foo.java' } })).body.error.code, 'INTERNAL_CONTENT', '行內不能寫路徑');
    assert.equal((await put(bank.token, { backlog: [{ title: 'SELECT * FROM users' }] })).status, 400, '行內不能寫 SQL');
    assert.equal((await put(bank.token, { currentTask: { title: '核對統編檢核', stage: '驗收', sha } })).status, 200, '行內寫標題與 SHA 可以');

    // 依專案可見
    assert.equal((await call(liu.token, `/api/participants/${plat.participantId}/state`)).body.state.currentTask.stage, '測試', '同專案看得到');
    assert.equal((await call(liu.token, `/api/participants/${bank.participantId}/state`)).status, 403, '不同專案看不到');
    assert.equal((await call(percy.token, `/api/participants/${bank.participantId}/state`)).status, 200, '兩邊成員看得到');
    assert.equal((await call(bank.token, `/api/participants/${plat.participantId}/state`)).status, 403, '銀行系統 AI 看不到平台 AI');
    const tsLiu = (await call(liu.token, '/api/team-status')).body.members;
    assert.ok(tsLiu.find(m => m.participantId === plat.participantId).aiState, 'team-status 帶同專案 AI 的工作記憶');
    assert.ok(!tsLiu.some(m => m.participantId === bank.participantId), 'C-188：team-status 不列別專案的成員');
    const tsPercy = (await call(percy.token, '/api/team-status')).body.members;
    assert.ok(tsPercy.find(m => m.participantId === bank.participantId).aiState?.currentTask, '兩邊成員看得到全部');
    assert.equal(percyId.length > 0, true);

    console.log('state: all checks passed');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
