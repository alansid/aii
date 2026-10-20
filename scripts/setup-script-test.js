// C-327 C1／C-328 驗收測試：接入檢查腳本 aigile-setup.mjs、等待指令不再 CONFIG_ERROR、舊 watcher.env 補門鈴設定
// 修正前：接入要 AI 自己一步步下載、核對、寫設定（行內一個接入跑到 587 回合）；
//   setup.md 的等待指令沒帶 --env-file，照抄就 CONFIG_ERROR；舊 watcher.env 缺 BELL_FILE、PID_FILE，重接也沒人補
// 用法：node scripts/setup-script-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const pub = f => fileURLToPath(new URL('../public/' + f, import.meta.url));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-setup-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', supabaseUrl: 'https://sb.example', supabaseKey: 'anon-key' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
// 腳本是獨立程序：開本機埠，靜態檔（watcher.mjs 等）直接回 public 裡的檔
const server = http.createServer(async (req, res) => {
  const f = /^\/(watcher|aigile-wait|aigile-setup)\.mjs$/.exec(req.url);
  if (f) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(pub(f[0].slice(1)))); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const run = (cwd, file, args, env = {}) => new Promise(resolve => execFile(process.execPath, [file, ...args], { cwd, env: { ...process.env, AIGILE_BASE: '', AIGILE_TOKEN: '', ...env } }, (e, out) => resolve({ code: e ? e.code : 0, out })));
const setup = (cwd, extra = []) => run(cwd, pub('aigile-setup.mjs'), ['--agent', 'PG', '--base', BASE, ...extra]);
const work = () => fs.mkdtempSync(path.join(dataDir, 'w-'));
const envOf = d => Object.fromEntries(fs.readFileSync(path.join(d, '.aigile/PG/watcher.env'), 'utf8').trim().split('\n').map(l => [l.split('=')[0], l.split('=').slice(1).join('=')]));

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const tok = (await db.get('SELECT token FROM participants WHERE id = ?', ai.participantId)).token;
  const putToken = d => { fs.mkdirSync(path.join(d, '.aigile/PG'), { recursive: true }); fs.writeFileSync(path.join(d, '.aigile/PG/.token'), tok); };

  // 端點：只給 AI；內容就是標準 watcher.env 與兩個檔的雜湊
  assert.equal((await call(liu.token, '/api/me/watcher-env')).status, 403, '人類拿不到');
  const cfg = (await call(tok, '/api/me/watcher-env')).body;
  assert.deepEqual(cfg.files, { 'watcher.mjs': sha(pub('watcher.mjs')), 'aigile-wait.mjs': sha(pub('aigile-wait.mjs')) }, '雜湊跟 public 的檔一致');
  assert.match(cfg.env, /BELL_FILE=\.aigile\/PG\/bell\.json/);
  assert.ok(!cfg.env.includes(tok), 'watcher.env 不放 Token（用 AIGILE_TOKEN_FILE）');

  // 1) 第一次：一個指令做完，檔案、設定、.gitignore 都好了
  const a = work(); putToken(a); fs.mkdirSync(path.join(a, '.git'));
  let r = await setup(a);
  assert.equal(r.code, 0, r.out);
  assert.equal(sha(path.join(a, '.aigile/watcher/watcher.mjs')), cfg.files['watcher.mjs'], '下載並核對 watcher');
  assert.equal(sha(path.join(a, '.aigile/watcher/aigile-wait.mjs')), cfg.files['aigile-wait.mjs']);
  let env = envOf(a);
  assert.equal(env.BELL_FILE, '.aigile/PG/bell.json'); assert.equal(env.AIGILE_BASE, BASE);
  assert.match(fs.readFileSync(path.join(a, '.gitignore'), 'utf8'), /^\.aigile\/$/m, '補 .gitignore');
  assert.match(r.out, /等待腳本：node --env-file=\.aigile\/PG\/watcher\.env \.aigile\/watcher\/aigile-wait\.mjs --agent PG/, '印出的等待指令帶 --env-file');
  assert.ok(!r.out.includes(tok), '輸出不含 Token');
  assert.ok(r.out.trim().split('\n').length <= 20, '輸出短（不灌爆 AI 的對話）：' + r.out.trim().split('\n').length + ' 行');
  r = await setup(a);
  assert.match(r.out, /watcher\.mjs 已是最新/); assert.match(r.out, /watcher\.env 完整/, '再跑一次不動東西');

  // 2) C-328：舊 watcher.env（C-246 以前）缺 BELL_FILE、PID_FILE；自己改過的 WAKE_CMD 要保留；watcher 在跑就提醒重開
  const b = work(); putToken(b);
  fs.writeFileSync(path.join(b, '.aigile/PG/watcher.env'), `AIGILE_BASE=${BASE}\nAIGILE_ME=${ai.participantId}\nAIGILE_TOKEN_FILE=.aigile/PG/.token\nWAKE_CMD=.aigile\\PG\\wake.cmd\n`);
  fs.writeFileSync(path.join(b, '.aigile/PG/watcher.pid'), String(process.pid)); // 一個活著的程序
  fs.mkdirSync(path.join(b, '.aigile/watcher'), { recursive: true }); fs.writeFileSync(path.join(b, '.aigile/watcher/watcher.mjs'), '// 舊版');
  r = await setup(b);
  assert.equal(r.code, 0, r.out);
  env = envOf(b);
  assert.equal(env.BELL_FILE, '.aigile/PG/bell.json', '補上門鈴檔'); assert.equal(env.PID_FILE, '.aigile/PG/watcher.pid', '補上 pid 檔');
  assert.equal(env.WAKE_CMD, '.aigile\\PG\\wake.cmd', '保留自己的 WAKE_CMD');
  assert.match(r.out, /補上 .*BELL_FILE/); assert.match(r.out, /watcher\.mjs 已更新/, '舊版 watcher 換新');
  assert.match(r.out, new RegExp(`watcher（程序 ${process.pid}）用的是舊檔或舊設定：先停掉它`), '提醒重開 watcher');

  // 3) Token 失效：停在 Token 那步，最後一行說怎麼辦
  const c = work(); fs.mkdirSync(path.join(c, '.aigile/PG'), { recursive: true }); fs.writeFileSync(path.join(c, '.aigile/PG/.token'), 'tok_bad');
  r = await setup(c);
  assert.equal(r.code, 1); assert.match(r.out.trim().split('\n').pop(), /^卡在：Token。怎麼辦：.*重發 Token/);
  assert.ok(!fs.existsSync(path.join(c, '.aigile/watcher')), '失敗就不往下做');

  // 3b) C-329 UX 回報：Token 放在規則教的 AIGILE_TOKEN_<代號> 也讀得到（修正前只讀 AIGILE_TOKEN，說找不到 Token）
  const d = work();
  r = await run(d, pub('aigile-setup.mjs'), ['--agent', 'PG', '--base', BASE], { AIGILE_TOKEN_PG: tok });
  assert.equal(r.code, 0, '讀 AIGILE_TOKEN_PG：' + r.out.trim().split('\n').pop());

  // 4) C-328：等待腳本沒帶 --env-file（舊 setup.md 的寫法）也找得到平台，不再 CONFIG_ERROR
  r = await run(a, path.join(a, '.aigile/watcher/aigile-wait.mjs'), ['--agent', 'PG', '--max-min=0.02']);
  assert.ok(!/CONFIG_ERROR/.test(r.out), '讀同代號 watcher.env：' + r.out.trim());
  assert.match(r.out.trim().split('\n').pop(), /^(TIMEOUT|PENDING \d+)$/);

  // 5) 接入設定：跑檢查腳本（附雜湊）、等待指令帶 --env-file、省用量與換新對話寫進去
  const ob = (await call(liu.token, `/api/my-ais/${ai.participantId}/onboarding`)).body.text;
  assert.ok(ob.includes(`aigile-setup.mjs（SHA-256 ${sha(pub('aigile-setup.mjs'))}`), '接入設定附檢查腳本的雜湊（要跟檔案一致）');
  assert.match(ob, /node --env-file=\.aigile\/PG\/watcher\.env \.aigile\/watcher\/aigile-wait\.mjs --agent PG/, '等待指令帶 --env-file');
  assert.ok(!/^node \.aigile\/watcher\/aigile-wait\.mjs/m.test(ob) && !/等待：node \.aigile/.test(ob), '沒有不帶 --env-file 的等待指令');
  assert.ok(!ob.includes('SUPABASE_KEY='), 'watcher.env 內容不再整段貼在接入設定（改由腳本寫）');
  assert.match(ob, /不整份重讀/); assert.match(ob, /最後 20 行/); assert.match(ob, /超過 40 回合/); assert.match(ob, /接好就換新對話/);
  console.log('setup-script-test：全部通過');
} catch (e) {
  console.error('setup-script-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  server.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
