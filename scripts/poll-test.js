// C-319 驗收測試：poll.mjs 冷啟動（本機沒有 state.json，例如換了電腦）先從工作記憶還原游標
// 修正前：本機沒有游標就直接用 limit=1 跳到最新，雲端工作記憶裡還沒處理的訊息整批漏掉
// 用法：node scripts/poll-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-poll-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
// poll.mjs 是獨立程序，要真的連得到：開一個本機 HTTP 埠轉給 app
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const POLL = fileURLToPath(new URL('../public/poll.mjs', import.meta.url));
const poll = (cwd, token, ...args) => new Promise((resolve, reject) => execFile(process.execPath, [POLL, '--agent', 'PG', ...args], { cwd, env: { ...process.env, AIGILE_BASE: BASE, AIGILE_TOKEN_PG: token } }, (e, out) => e ? reject(e) : resolve(JSON.parse(out))));

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiToken = (await db.get('SELECT token FROM participants WHERE id = ?', ai.participantId)).token;
  const say = text => call(liu.token, '/api/messages', 'POST', { project: '平台', text, requestId: 'r' + Math.random() });

  // 舊電腦：處理到「第一則」為止，游標存進工作記憶
  await say('第一則');
  const cur = (await call(aiToken, '/api/messages?limit=1')).body.nextCursor;
  assert.equal((await call(aiToken, '/api/me/state', 'PUT', { messagesCursor: cur })).status, 200);
  await say('換電腦前沒處理的 A'); await say('換電腦前沒處理的 B');

  // 新電腦：沒有 .aigile/PG/state.json
  const fresh = fs.mkdtempSync(path.join(dataDir, 'pc2-'));
  let r = await poll(fresh, aiToken);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.newMessages.map(m => m.text), ['換電腦前沒處理的 A', '換電腦前沒處理的 B'], '從工作記憶的游標接著讀，不漏訊息');
  assert.equal(r.cursorFrom, 'cloud', '回報游標從工作記憶還原');
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, '.aigile', 'PG', 'state.json'), 'utf8')).messagesCursor, cur, '還原的游標寫回本機');

  // 本機已有游標：照本機的（不再讀工作記憶）
  r = await poll(fresh, aiToken);
  assert.equal(r.cursorFrom, 'local');
  assert.equal(r.newMessages.length, 2, '還沒 commit：同一批再給一次');

  // 本機、雲端都沒有：第一次接入，只建基準、不讀歷史
  await call(aiToken, '/api/me/state', 'PUT', {});
  const third = fs.mkdtempSync(path.join(dataDir, 'pc3-'));
  r = await poll(third, aiToken);
  assert.equal(r.cursorFrom, 'latest');
  assert.deepEqual(r.newMessages, [], '第一次接入不把歷史當新任務');
  console.log('poll-test：全部通過');
} catch (e) {
  console.error('poll-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  server.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
