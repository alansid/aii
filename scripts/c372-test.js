// C-372 重現測試：接入檢查只印 MCP 指令，AI 讀成「不能跟別人同資料夾並存」而停下；昱志以為腳本會自己裝
// 修正後：--tool claude 時腳本直接 claude mcp add aigile-<代號小寫>（已裝跳過、失敗印指令且不中斷）；Codex 照舊印設定
// 用假的 claude（scripts/fake-claude.mjs）記錄呼叫，絕不動真的 Claude Code 設定
// 用法：node scripts/c372-test.js
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
import { scriptHashes } from './script-hashes.mjs';

const pub = f => fileURLToPath(new URL('../public/' + f, import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-c372-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '10000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const server = http.createServer(async (req, res) => {
  const f = /^\/(watcher|aigile-wait|aigile-setup|aigile-opencode|aigile-mcp)\.mjs$/.exec(req.url);
  if (f) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(pub(f[0].slice(1)))); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const tok = (await db.get('SELECT token FROM participants WHERE id = ?', ai.participantId)).token;
  const AG = (await call(tok, '/api/me/watcher-env')).body.agent, NAME = 'aigile-' + AG.toLowerCase();
  const wd = fs.mkdtempSync(path.join(dataDir, 'w-'));
  fs.mkdirSync(path.join(wd, '.aigile', AG), { recursive: true });
  fs.writeFileSync(path.join(wd, '.aigile', AG, '.token'), tok);
  const log = path.join(dataDir, 'claude.log');
  const setup = (tool, env = {}) => { fs.rmSync(log, { force: true }); return new Promise(ok => execFile(process.execPath, [pub('aigile-setup.mjs'), '--agent', AG, '--base', BASE, '--tool', tool],
    { cwd: wd, env: { ...process.env, AIGILE_BASE: '', AIGILE_TOKEN: '', CLAUDECODE: '', AIGILE_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_HAS: '', FAKE_CLAUDE_FAIL: '', ...env } },
    (e, out) => ok({ code: e ? e.code : 0, out, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [] }))); };
  const mcp = path.resolve(wd, '.aigile', 'watcher', 'aigile-mcp.mjs').replace(/\\/g, '/');

  // 1. Claude Code、還沒裝 → 腳本直接裝（名稱帶代號、絕對路徑、這個資料夾）
  let r = await setup('claude');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls, [['mcp', 'get', NAME], ['mcp', 'add', NAME, '--', 'node', mcp, '--agent', AG]], '先查再裝：' + JSON.stringify(r.calls));
  assert.match(r.out, new RegExp(`✓ MCP：已幫 Claude Code 裝好 ${NAME}`));
  assert.match(r.out, /同資料夾多個 AI 可並存/, '文字改成可並存');
  assert.ok(!/只掛自己的/.test(r.out), '不再寫容易誤讀的「只掛自己的」');
  // 2. 已裝 → 跳過、印已裝
  r = await setup('claude', { FAKE_CLAUDE_HAS: NAME });
  assert.deepEqual(r.calls, [['mcp', 'get', NAME]], '已裝就不再 add');
  assert.match(r.out, /✓ MCP：Claude Code 已裝 .*（不重裝）/);
  // 3. 裝失敗 → 印指令讓 AI 手動裝，不中斷（照樣跑完、結束碼 0）
  r = await setup('claude', { FAKE_CLAUDE_FAIL: '1' });
  assert.equal(r.code, 0, '不中斷');
  assert.match(r.out, new RegExp(`! MCP 沒裝成（fake claude: add failed）：請自己在這個資料夾執行 claude mcp add ${NAME} -- node`));
  assert.match(r.out, /完成：/, '其他檢查照樣做完');
  // 4. Codex：不呼叫 claude，照舊印設定（全機共用，不由腳本改）
  r = await setup('codex');
  assert.deepEqual(r.calls, [], 'Codex 不碰 claude');
  assert.match(r.out, new RegExp(`\\[mcp_servers\\.${NAME}\\]`));
  console.log('c372-test：全部通過');
} catch (e) {
  console.error('c372-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  server.close();
  db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
