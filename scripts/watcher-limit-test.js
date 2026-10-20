// C-327 B 驗收測試：watcher 叫醒上限（每小時／每天次數、單次執行時間）
// 修正前：watcher 有新通知就叫醒，沒有次數上限；喚醒指令跑多久都不管（行內一次叫醒跑 7～8 分鐘、整天用量爆掉）
// 用法：node scripts/watcher-limit-test.js
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
const WATCHER = fileURLToPath(new URL('../public/watcher.mjs', import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-wlimit-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const procs = [];
function startWatcher(cwd, ai, tok, extra) {
  const p = spawn(process.execPath, [WATCHER], { cwd, env: { ...process.env, AIGILE_BASE: BASE, AIGILE_TOKEN: tok, AIGILE_ME: ai, SUPABASE_URL: '', SUPABASE_KEY: '', HEARTBEAT_MIN: '0.01', BELL_FILE: path.join(cwd, 'bell.json'), ...extra } });
  let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  const w = { p, log: () => out, stop: async () => { p.kill(); await new Promise(r => p.exitCode !== null ? r() : p.on('exit', r)); } };
  procs.push(w); return w;
}
const until = async (fn, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(100); } throw new Error('等不到：' + label); };

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const mk = async name => { const a = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; return { id: a.participantId, tok: (await db.get('SELECT token FROM participants WHERE id = ?', a.participantId)).token }; };
  const notify = (ai, i) => call(liu.token, '/api/messages', 'POST', { project: '平台', requestId: `n-${ai.id}-${i}`, recipientIds: [ai.id], text: `[通知] 第 ${i} 則` });
  // 告訴所屬人類：私訊（專案有開）或群組 [通知]（沒開時退回）；這裡的專案沒開私訊，走群組
  const dmsTo = async ai => [...await db.all('SELECT text FROM dms WHERE from_id = ? ORDER BY seq', ai.id), ...await db.all('SELECT text FROM messages WHERE author_id = ? ORDER BY seq', ai.id)].map(r => r.text);

  // 1) 預設每小時上限 3（昱志 10/20 從 4 改 3）：來 4 則新通知，第 4 次被擋，只叫醒 3 次，其他的等時段過了才補；私訊所屬人類一次
  const a = await mk('上限助手'), wa = fs.mkdtempSync(path.join(dataDir, 'a-'));
  const wakeLog = path.join(wa, 'wakes.txt');
  const wakes = () => { try { return fs.readFileSync(wakeLog, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  const cmd = `"${process.execPath}" -e "require('fs').appendFileSync('wakes.txt','w\\n')"`;
  let w = startWatcher(wa, a.id, a.tok, { WAKE_CMD: cmd });
  for (let i = 1; i <= 4; i++) {
    await notify(a, i);
    await sleep(2000); // 巡檢每 0.6 秒一次：跨過幾次，讓這則一定被看到
  }
  assert.equal(wakes(), 3, `只叫醒 3 次（實際 ${wakes()} 次）：\n` + w.log().slice(-600));
  assert.match(w.log(), /叫醒已達每小時上限 3 次/, '日誌寫原因');
  try { await until(async () => (await dmsTo(a)).length >= 1, 5000, '私訊'); } catch (e) { console.log(w.log().split('\n').filter(l => !/保底巡檢/.test(l)).join('\n').slice(-1500)); throw e; }
  await sleep(1500);
  const dm = await dmsTo(a);
  assert.equal(dm.length, 1, '同一段上限只私訊一次');
  assert.match(dm[0], /已達每小時上限（3 次）.*自動恢復/);
  const bell = JSON.parse(fs.readFileSync(path.join(wa, 'bell.json'), 'utf8'));
  assert.equal(bell.wakes.length, 3, '叫醒時間記在門鈴檔');

  // 2) 重開 watcher 不歸零：還在上限內就不叫醒
  await w.stop();
  w = startWatcher(wa, a.id, a.tok, { WAKE_CMD: cmd });
  await notify(a, 5);
  await until(() => /上限/.test(w.log()), 8000, '重開後仍在上限');
  assert.equal(wakes(), 3, '重開後沒有多叫醒');
  await w.stop();

  // 2b) 預設每天上限 15：24 小時內已叫醒 15 次（都超過 1 小時前），第 16 次被擋
  const c = await mk('每天上限助手'), wc = fs.mkdtempSync(path.join(dataDir, 'c-'));
  const ago = Date.now() - 2 * 3_600_000;
  fs.writeFileSync(path.join(wc, 'bell.json'), JSON.stringify({ v: 1, seq: 15, wakes: Array.from({ length: 15 }, (_, i) => ago - i * 60_000) }));
  await notify(c, 1);
  w = startWatcher(wc, c.id, c.tok, { WAKE_CMD: cmd });
  await until(() => /叫醒已達每天上限 15 次/.test(w.log()), 8000, '每天上限');
  assert.ok(!fs.existsSync(path.join(wc, 'wakes.txt')), '第 16 次沒叫醒');
  await w.stop();

  // 3) 單次執行上限：喚醒指令卡住就停掉它，並私訊
  const b = await mk('卡住助手'), wb = fs.mkdtempSync(path.join(dataDir, 'b-'));
  await notify(b, 1);
  const hang = `"${process.execPath}" -e "setTimeout(()=>{},120000)"`;
  w = startWatcher(wb, b.id, b.tok, { WAKE_CMD: hang, WAKE_TIMEOUT_MIN: '0.03' }); // 約 1.8 秒
  const t0 = Date.now();
  await until(() => /喚醒指令結束/.test(w.log()), 15000, '卡住的喚醒被停掉');
  assert.ok(Date.now() - t0 < 12000, '沒有等到喚醒指令自己結束');
  assert.match(w.log(), /喚醒指令跑超過 [\d.]+ 分鐘，停掉它/);
  await until(async () => (await dmsTo(b)).some(t => /跑超過/.test(t)), 5000, '超時私訊');

  // 4) 預設值：每小時 3、每天 15、單次 10 分鐘；規格寫明
  const src = fs.readFileSync(WATCHER, 'utf8');
  // C-341：會跑模型的接法（這裡的 WAKE_CMD 是 node）維持 3／15；Claude Code（echo）12／60 見 c341-test
  assert.match(src, /num\(env\.WAKE_MAX_PER_HOUR, BELL_ONLY \? 12 : 3\)/); assert.match(src, /num\(env\.WAKE_MAX_PER_DAY, BELL_ONLY \? 60 : 15\)/); assert.match(src, /num\(env\.WAKE_TIMEOUT_MIN, 10\)/);
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.match(spec, /每小時最多叫醒 3 次、每天 15 次、單次最多 10 分鐘/, '規格寫明上限');
  console.log('watcher-limit-test：全部通過');
} catch (e) {
  console.error('watcher-limit-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  for (const w of procs) try { w.p.kill(); } catch {}
  server.close();
  await sleep(300);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
