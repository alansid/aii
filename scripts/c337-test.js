// C-337 驗收測試（Fable 健檢）：門鈴掛對請求、邀請撞名可重試、watcher 喚醒啟動失敗不卡住、舊腳本不再公開
// 修正前：
//   B6 worker 用模組變數記「目前的請求」，並行時門鈴掛到別的（可能已結束的）請求上 → 這次發文的請求沒等門鈴
//   B8 邀請先標已用、再建人；中間名稱被搶走 → 500，邀請燒掉
//   B10 喚醒指令啟動失敗（沒有 exit 事件）後 running 一直是 true，之後每次門鈴都只「排隊補跑」
//   C1／C2 public/wait-for-bell.js、public/wake-qa.mjs 仍公開可下載
// 用法：node scripts/c337-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-c337-'));
const raw = openNodeDb(path.join(dataDir, 'switch.db'));
let raceName = null; // B8：設了就在建人前一刻讓別人先用掉這個名稱
const db = { ...raw, run: async (sql, ...a) => {
  if (raceName && /^INSERT INTO participants/.test(sql.trim())) {
    const n = raceName; raceName = null;
    await raw.run('INSERT INTO participants (id, kind, name, code, token, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', 'p_racer', 'human', n, 'RACE', 'tok_racer', new Date().toISOString(), new Date().toISOString());
  }
  return raw.run(sql, ...a);
} };
// 門鈴打到假的 Supabase：記下來，故意慢一點（模擬網路）
const bells = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://sb.test/')) { await sleep(150); bells.push(JSON.parse(opts.body).messages[0].payload); return new Response('{}'); }
  return realFetch(url, opts);
};
const app = createApp({ db, storage: dbStorage(raw), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', authFailLimit: '1000', supabaseUrl: 'https://sb.test', supabaseKey: 'k' } });
const wctx = () => { const waits = []; return { waits, waitUntil: p => waits.push(p) }; };
const call = async (token, p, method = 'GET', body, w = null) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost', w);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let server, watcher;

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiTok = (await raw.get('SELECT token FROM participants WHERE id = ?', ai.participantId)).token;

  // B6：發文的請求自己等門鈴送完；同時進行的別的請求先結束也沒關係
  const wPost = wctx(), wOther = wctx();
  const [post] = await Promise.all([
    call(liu.token, '/api/messages', 'POST', { project: '平台', requestId: 'b6', recipientIds: [ai.participantId], text: '請看' }, wPost),
    call(liu.token, '/api/me', 'GET', null, wOther),
  ]);
  assert.equal(post.status, 201);
  assert.ok(wPost.waits.length >= 1, '發文的請求用自己的 waitUntil 等門鈴（修正前沒有）');
  await Promise.all(wPost.waits);
  assert.ok(bells.some(b => b.ids.includes(ai.participantId)), '門鈴送到');
  assert.ok(fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8').includes('app(env)(request, url.origin, ctx)'), 'worker 把這次請求的 ctx 傳進去');
  assert.ok(!/currentCtx/.test(fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8')), '不再用模組變數記目前的請求');

  // B8：檢查名稱之後、建人之前名稱被搶走 → 409，邀請還能用，換名稱重試成功
  const invRes = (await call(liu.token, '/api/invites', 'POST', { name: '王小明', projects: ['平台'] })).body;
  const inv = invRes.invite;
  const itok = invRes.url.split('/invite/')[1];
  raceName = '搶名字';
  let r = await call(null, '/api/auth/invite', 'POST', { token: itok, name: '搶名字' });
  assert.equal(r.status, 409, '撞名回 409（修正前 500）：' + JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'NAME_TAKEN');
  assert.equal((await raw.get('SELECT used_at FROM invites WHERE id = ?', inv.inviteId || inv.id)).used_at, null, '邀請還回去');
  r = await call(null, '/api/auth/invite', 'POST', { token: itok, name: '王小明' });
  assert.ok(r.status < 300, '換名稱重試成功：' + JSON.stringify(r.body).slice(0, 200));

  // B10：喚醒指令啟動失敗後，下一則通知還會再試（Windows：把 ComSpec 指到不存在的檔，讓 shell 啟動失敗）
  if (process.platform === 'win32') {
    server = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const base = `http://${req.headers.host}`;
      const out = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
      res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer()));
    });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    const wd = fs.mkdtempSync(path.join(dataDir, 'w-'));
    const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^comspec$/i.test(k))); // 原本的 COMSPEC 拿掉，才換得掉
    watcher = spawn(process.execPath, [fileURLToPath(new URL('../public/watcher.mjs', import.meta.url))], { cwd: wd, env: { ...baseEnv, ComSpec: 'C:\\no-such-dir\\cmd.exe', AIGILE_BASE: `http://127.0.0.1:${server.address().port}`, AIGILE_TOKEN: aiTok, AIGILE_ME: ai.participantId, WAKE_CMD: 'echo hi', HEARTBEAT_MIN: '0.01', SUPABASE_URL: '', SUPABASE_KEY: '' } });
    let wlog = ''; watcher.stdout.on('data', d => { wlog += d; });
    for (let i = 0; i < 60 && (wlog.match(/喚醒指令啟動失敗/g) || []).length < 1; i++) await sleep(100);
    await call(liu.token, '/api/messages', 'POST', { project: '平台', requestId: 'b10', recipientIds: [ai.participantId], text: '第二則' });
    for (let i = 0; i < 60 && (wlog.match(/喚醒指令啟動失敗/g) || []).length < 2; i++) await sleep(100);
    assert.ok((wlog.match(/喚醒指令啟動失敗/g) || []).length >= 2, '失敗後新通知還會再叫醒：\n' + wlog.split('\n').filter(l => !/保底巡檢/.test(l)).join('\n').slice(-800));
    assert.ok(!/排隊補跑/.test(wlog), '不會卡在「AI 正在執行，排隊補跑」');
  } else console.log('（不是 Windows：略過 B10 的 shell 啟動失敗測試）');

  // C1／C2：舊腳本不再公開；設定頁文字不再提 wait-for-bell
  const pub = f => new URL('../public/' + f, import.meta.url);
  assert.ok(!fs.existsSync(pub('wait-for-bell.js')), 'wait-for-bell.js 刪掉');
  assert.ok(!fs.existsSync(pub('wake-qa.mjs')) && fs.existsSync(new URL('./experimental/wake-qa.mjs', import.meta.url)), 'wake-qa.mjs 移出 public');
  assert.ok(!fs.readFileSync(pub('app.js'), 'utf8').includes('wait-for-bell'), '設定頁不再提 wait-for-bell');
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.ok(!spec.includes("node -e \"const fs=require('fs')"), 'C3：規格不再放一行式下載，改請人跑檢查腳本');
  console.log('c337-test：全部通過');
} catch (e) {
  console.error('c337-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  watcher?.kill(); server?.close();
  await sleep(200);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
