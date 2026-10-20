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
  const f = /^\/(watcher|aigile-wait|aigile-setup|aigile-opencode)\.mjs$/.exec(req.url);
  if (f) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(pub(f[0].slice(1)))); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const run = (cwd, file, args, env = {}) => new Promise(resolve => execFile(process.execPath, [file, ...args], { cwd, env: { ...process.env, AIGILE_BASE: '', AIGILE_TOKEN: '', ...env } }, (e, out) => resolve({ code: e ? e.code : 0, out })));
let AG = 'PG'; // 平台給的代號（角色_短代碼），拿到 Token 後換成真的
const setup = (cwd, extra = []) => run(cwd, pub('aigile-setup.mjs'), ['--agent', AG, '--base', BASE, ...extra]);
const work = () => fs.mkdtempSync(path.join(dataDir, 'w-'));
const envOf = d => Object.fromEntries(fs.readFileSync(path.join(d, `.aigile/${AG}/watcher.env`), 'utf8').trim().split('\n').map(l => [l.split('=')[0], l.split('=').slice(1).join('=')]));

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const tok = (await db.get('SELECT token FROM participants WHERE id = ?', ai.participantId)).token;
  AG = (await call(tok, '/api/me/watcher-env')).body.agent;
  const putToken = d => { fs.mkdirSync(path.join(d, `.aigile/${AG}`), { recursive: true }); fs.writeFileSync(path.join(d, `.aigile/${AG}/.token`), tok); };

  // 10/20：代號＝角色_短代碼，同一個人兩個 PG 不會共用 .aigile/PG/（修正前都叫 PG，Token 互相蓋掉）
  const ai2 = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name: '第二個程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const tok2 = (await db.get('SELECT token FROM participants WHERE id = ?', ai2.participantId)).token;
  const AG2 = (await call(tok2, '/api/me/watcher-env')).body.agent;
  assert.match(AG, /^PG_[A-Z0-9]{4}$/, '代號是角色_短代碼：' + AG);
  assert.notEqual(AG, AG2, '兩個 PG 代號不同');
  const link2 = (await call(liu.token, `/api/my-ais/${ai2.participantId}/onboarding-link`, 'POST', {})).body;
  assert.equal(link2.agent, AG2, '短版接入的資料夾也用新代號');
  const ob2 = (await call(liu.token, `/api/my-ais/${ai2.participantId}/onboarding`)).body.text;
  assert.ok(ob2.includes(`代號（--agent）：${AG2}（平台給的，不會跟別的 AI 重複`) && !/撞了改用/.test(ob2), '接入設定寫平台給的代號，不再叫 AI 自己改');

  // 端點：只給 AI；內容就是標準 watcher.env 與兩個檔的雜湊
  assert.equal((await call(liu.token, '/api/me/watcher-env')).status, 403, '人類拿不到');
  const cfg = (await call(tok, '/api/me/watcher-env')).body;
  assert.deepEqual(cfg.files, { 'watcher.mjs': sha(pub('watcher.mjs')), 'aigile-wait.mjs': sha(pub('aigile-wait.mjs')), 'aigile-opencode.mjs': sha(pub('aigile-opencode.mjs')) }, '雜湊跟 public 的檔一致');
  assert.ok(cfg.env.includes(`BELL_FILE=.aigile/${AG}/bell.json`));
  assert.ok(!cfg.env.includes(tok), 'watcher.env 不放 Token（用 AIGILE_TOKEN_FILE）');

  // 1) 第一次：一個指令做完，檔案、設定、.gitignore 都好了
  const a = work(); putToken(a); fs.mkdirSync(path.join(a, '.git'));
  let r = await setup(a);
  assert.equal(r.code, 0, r.out);
  assert.equal(sha(path.join(a, '.aigile/watcher/watcher.mjs')), cfg.files['watcher.mjs'], '下載並核對 watcher');
  assert.equal(sha(path.join(a, '.aigile/watcher/aigile-wait.mjs')), cfg.files['aigile-wait.mjs']);
  assert.equal(sha(path.join(a, '.aigile/watcher/aigile-opencode.mjs')), cfg.files['aigile-opencode.mjs'], 'C-331 opencode 喚醒腳本一起下載核對');
  let env = envOf(a);
  assert.equal(env.BELL_FILE, `.aigile/${AG}/bell.json`); assert.equal(env.AIGILE_BASE, BASE);
  assert.match(fs.readFileSync(path.join(a, '.gitignore'), 'utf8'), /^\.aigile\/$/m, '補 .gitignore');
  assert.ok(r.out.includes(`等待腳本：node --env-file=.aigile/${AG}/watcher.env .aigile/watcher/aigile-wait.mjs --agent ${AG}`), '印出的等待指令帶 --env-file');
  // 代號打錯（例如照舊寫 PG）：停下來說正確代號，不寫到別人的資料夾
  const wrong = work(); fs.mkdirSync(path.join(wrong, '.aigile/PG'), { recursive: true }); fs.writeFileSync(path.join(wrong, '.aigile/PG/.token'), tok);
  r = await run(wrong, pub('aigile-setup.mjs'), ['--agent', 'PG', '--base', BASE]);
  assert.equal(r.code, 1); assert.ok(r.out.includes(`你的代號是 ${AG}，不是 PG`), '代號錯就停：' + r.out.trim().split('\n').pop());
  assert.ok(!fs.existsSync(path.join(wrong, '.aigile/watcher')), '代號錯不往下做');
  assert.ok(!r.out.includes(tok), '輸出不含 Token');
  assert.ok(r.out.trim().split('\n').length <= 20, '輸出短（不灌爆 AI 的對話）：' + r.out.trim().split('\n').length + ' 行');
  r = await setup(a);
  assert.match(r.out, /watcher\.mjs 已是最新/); assert.match(r.out, /watcher\.env 完整/, '再跑一次不動東西');

  // 2) C-328：舊 watcher.env（C-246 以前）缺 BELL_FILE、PID_FILE；自己改過的 WAKE_CMD 要保留；watcher 在跑就提醒重開
  const b = work(); putToken(b);
  fs.writeFileSync(path.join(b, `.aigile/${AG}/watcher.env`), `AIGILE_BASE=${BASE}\nAIGILE_ME=${ai.participantId}\nAIGILE_TOKEN_FILE=.aigile/${AG}/.token\nWAKE_CMD=.aigile\\${AG}\\wake.cmd\n`);
  fs.writeFileSync(path.join(b, `.aigile/${AG}/watcher.pid`), String(process.pid)); // 一個活著的程序
  fs.mkdirSync(path.join(b, '.aigile/watcher'), { recursive: true }); fs.writeFileSync(path.join(b, '.aigile/watcher/watcher.mjs'), '// 舊版');
  r = await setup(b);
  assert.equal(r.code, 0, r.out);
  env = envOf(b);
  assert.equal(env.BELL_FILE, `.aigile/${AG}/bell.json`, '補上門鈴檔'); assert.equal(env.PID_FILE, `.aigile/${AG}/watcher.pid`, '補上 pid 檔');
  assert.equal(env.WAKE_CMD, `.aigile\\${AG}\\wake.cmd`, '保留自己的 WAKE_CMD');
  assert.match(r.out, /補上 .*BELL_FILE/); assert.match(r.out, /watcher\.mjs 已更新/, '舊版 watcher 換新');
  assert.match(r.out, new RegExp(`watcher（程序 ${process.pid}）用的是舊檔或舊設定：先停掉它`), '提醒重開 watcher');

  // 3) Token 失效：停在 Token 那步，最後一行說怎麼辦
  const c = work(); fs.mkdirSync(path.join(c, `.aigile/${AG}`), { recursive: true }); fs.writeFileSync(path.join(c, `.aigile/${AG}/.token`), 'tok_bad');
  r = await setup(c);
  assert.equal(r.code, 1); assert.match(r.out.trim().split('\n').pop(), /^卡在：Token。怎麼辦：.*重發 Token/);
  assert.ok(!fs.existsSync(path.join(c, '.aigile/watcher')), '失敗就不往下做');

  // 3a) C-344：連不上平台（例如 Codex 沙盒沒開網路）→ 最後一行直接寫怎麼開，不用開完全權限
  //     修正前只說「公司網路多半要代理」，Codex 使用者不知道要改哪裡
  const nc = work(); putToken(nc);
  r = await run(nc, pub('aigile-setup.mjs'), ['--agent', AG, '--base', 'http://127.0.0.1:9'], { CODEX_SANDBOX_NETWORK_DISABLED: '1' });
  let last = r.out.trim().split('\n').pop();
  assert.equal(r.code, 1);
  assert.match(r.out, /你在 Codex 沙盒裡，網路沒開/, 'Codex 沙盒認得出來');
  assert.ok(last.includes('[sandbox_workspace_write] network_access = true') && last.includes("-c 'sandbox_workspace_write.network_access=true'") && last.includes('不用開完全權限'), 'Codex：最後一行寫設定檔與啟動參數兩種開法：' + last);
  r = await run(nc, pub('aigile-setup.mjs'), ['--agent', AG, '--base', 'http://127.0.0.1:9']);
  last = r.out.trim().split('\n').pop();
  assert.ok(last.includes('HTTPS_PROXY') && last.includes('如果你是 Codex') && last.includes('network_access = true'), '看不出是不是 Codex：代理與 Codex 兩種都說：' + last);
  const spec344 = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.ok(spec344.includes('**Codex 要先開網路**') && spec344.includes("codex --sandbox workspace-write -c 'sandbox_workspace_write.network_access=true'") && spec344.includes('**不用開完全權限**'), '規格 3.12 有 Codex 開網路段');
  assert.ok((await call(liu.token, `/api/my-ais/${ai.participantId}/onboarding`)).body.text.includes('要先請 劉昱志 開網路，不用完全權限'), '接入設定第四節提醒 Codex 先開網路');
  assert.ok(fs.readFileSync(pub('app.js'), 'utf8').includes("[sandbox_workspace_write] network_access = true（或啟動時加 --sandbox workspace-write -c 'sandbox_workspace_write.network_access=true'），不用開完全權限"), '網頁短版接入寫明確設定');

  // 3b) C-329 UX 回報：Token 放在規則教的 AIGILE_TOKEN_<代號> 也讀得到（修正前只讀 AIGILE_TOKEN，說找不到 Token）
  const d = work();
  r = await run(d, pub('aigile-setup.mjs'), ['--agent', AG, '--base', BASE], { [`AIGILE_TOKEN_${AG}`]: tok });
  assert.equal(r.code, 0, '讀 AIGILE_TOKEN_<代號>：' + r.out.trim().split('\n').pop());

  // 3c) 10/20 行內 codex-pg-銀行：Token 檔已換新，但環境裡還留著舊的 AIGILE_TOKEN → 一直 401
  //     修正前：檢查腳本、watcher、等待腳本都是環境變數優先，換了檔案也沒用；401 也不說平台回了什麼
  const e = work(); putToken(e);
  r = await run(e, pub('aigile-setup.mjs'), ['--agent', AG, '--base', BASE], { AIGILE_TOKEN: 'tok_stale_old' });
  assert.equal(r.code, 0, '檔案優先：' + r.out.trim().split('\n').pop());
  assert.ok(r.out.includes(`Token 來源：${path.join('.aigile', AG)}/.token`), r.out);
  assert.match(r.out, /! 環境變數 AIGILE_TOKEN（開頭 tok_…）跟 \.token 不一樣，已用 \.token/, '提醒清掉舊的環境變數');
  r = await setup(c);
  assert.match(r.out, /平台不認得這組 Token（401 INVALID_TOKEN：.*用的是開頭 tok_…）/, '401 說出平台回的原因與用的是哪一組');
  r = await run(e, path.join(a, '.aigile/watcher/aigile-wait.mjs'), ['--agent', AG, '--max-min=0.02'], { AIGILE_BASE: BASE, AIGILE_TOKEN: 'tok_stale_old' });
  assert.ok(!/UNAUTHORIZED/.test(r.out), '等待腳本以 .token 為準：' + r.out.trim());
  const wp = execFile(process.execPath, [path.join(a, '.aigile/watcher/watcher.mjs')], { cwd: e, env: { ...process.env, AIGILE_BASE: BASE, AIGILE_ME: ai.participantId, AIGILE_TOKEN: 'tok_stale_old', AIGILE_TOKEN_FILE: `.aigile/${AG}/.token`, WATCH_ONLY: '1', SUPABASE_URL: '', SUPABASE_KEY: '' } });
  let wlog = ''; wp.stdout.on('data', x => { wlog += x; });
  for (let i = 0; i < 50 && !/\[啟動\]/.test(wlog); i++) await new Promise(res => setTimeout(res, 100));
  wp.kill();
  assert.match(wlog, /\[啟動\]/); assert.ok(!/401/.test(wlog), 'watcher 以 AIGILE_TOKEN_FILE 為準：' + wlog.trim());

  // 4) C-328：等待腳本沒帶 --env-file（舊 setup.md 的寫法）也找得到平台，不再 CONFIG_ERROR
  r = await run(a, path.join(a, '.aigile/watcher/aigile-wait.mjs'), ['--agent', AG, '--max-min=0.02']);
  assert.ok(!/CONFIG_ERROR/.test(r.out), '讀同代號 watcher.env：' + r.out.trim());
  assert.match(r.out.trim().split('\n').pop(), /^(TIMEOUT|PENDING \d+)$/);

  // 5) 接入設定：跑檢查腳本（附雜湊）、等待指令帶 --env-file、省用量與換新對話寫進去
  const ob = (await call(liu.token, `/api/my-ais/${ai.participantId}/onboarding`)).body.text;
  assert.ok(ob.includes(`aigile-setup.mjs（SHA-256 ${sha(pub('aigile-setup.mjs'))}`), '接入設定附檢查腳本的雜湊（要跟檔案一致）');
  assert.ok(ob.includes(`node --env-file=.aigile/${AG}/watcher.env .aigile/watcher/aigile-wait.mjs --agent ${AG}`), '等待指令帶 --env-file');
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
