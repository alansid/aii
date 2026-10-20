// C-341 驗收測試（C-340 昱志選 A＋B）：叫醒上限依接法分、知會類通知不叫醒
// 修正前：
//   A 不分接法一律每小時 3 次，Claude Code（只寫門鈴）工作中半小時就被擋，PG2 卡 7 則待處理一小時
//   B 只是知會（[接單]／[完成]、標了不用回）也按門鈴、watcher 巡檢也叫醒，一半的叫醒是白跑
// 用法：node scripts/c341-test.js
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-c341-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const bells = []; // 門鈴打到假的 Supabase
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://sb.test/')) { bells.push(...JSON.parse(opts.body).messages[0].payload.ids); return new Response('{}'); }
  return realFetch(url, opts);
};
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', supabaseUrl: 'https://sb.test', supabaseKey: 'k' } });
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
let seq = 0;

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const mk = async name => { const a = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; return { id: a.participantId, tok: (await db.get('SELECT token FROM participants WHERE id = ?', a.participantId)).token }; };
  const a = await mk('甲助手'), b = await mk('乙助手');
  const send = (tok, body) => call(tok, '/api/messages', 'POST', { project: '平台', requestId: 'm' + (++seq), ...body });
  const wakeOf = async (ai, mid) => (await call(ai.tok, '/api/notifications?status=pending&limit=50')).body.items.find(n => n.messageId === mid)?.wake;

  // B：哪些叫醒、哪些只是知會（按門鈴與清單的 wake 一致）
  const cases = [
    ['標了不用回（replyFrom: []）', { text: '[通知] 同步一下', recipientIds: [a.id], replyFrom: [] }, false],
    ['[完成] 告知', { text: '[完成] C-1 做好了', recipientIds: [a.id] }, false],
    ['[接單] 告知', { text: '[接單] 收到', recipientIds: [a.id] }, false],
    ['指派（一般 @）', { text: '請做 C-2', recipientIds: [a.id] }, true],
    ['[需確認] 指定要他回', { text: '[需確認] A 還是 B？\n選項：\nA. 甲\nB. 乙', recipientIds: [a.id], replyFrom: [a.id] }, true],
    ['[完成] 但指定要他回', { text: '[完成] 做好了，請你驗收', recipientIds: [a.id], replyFrom: [a.id] }, true],
  ];
  for (const [label, body, want] of cases) {
    bells.length = 0;
    const m = (await send(b.tok, body)).body;
    assert.ok(m.messageId, label + '：發文成功 ' + JSON.stringify(m).slice(0, 150));
    await sleep(20);
    assert.equal(bells.includes(a.id), want, `${label}：${want ? '要' : '不'}按門鈴`);
    assert.equal(await wakeOf(a, m.messageId), want, `${label}：清單 wake=${want}`);
  }
  // 回覆他的訊息：一般回覆照 C-277 預設要他回（叫醒）；只是 [接單]／[完成] 回覆＝知會
  const mine = (await send(a.tok, { text: '我的交接', recipientIds: [b.id] })).body;
  const ack = (await send(b.tok, { text: '[接單] 收到，開工', replyToMessageId: mine.messageId })).body;
  assert.equal(await wakeOf(a, ack.messageId), false, '回覆我的 [接單]：知會（修正前預設要回覆、會叫醒）');
  const q = (await send(b.tok, { text: '這個要怎麼做？', replyToMessageId: mine.messageId })).body;
  assert.equal(await wakeOf(a, q.messageId), true, '一般回覆（問問題）：照樣叫醒');
  // 私訊一律叫醒
  await call(liu.token, '/api/dm', 'POST', { aiId: a.id, text: '私訊', requestId: 'dm1' }).catch(() => {});

  // B：watcher 巡檢也不為知會叫醒；真的要處理的來了才叫醒，知會留在清單一起看
  const c = await mk('丙助手'), wc = fs.mkdtempSync(path.join(dataDir, 'c-'));
  const cmd = `"${process.execPath}" -e "require('fs').appendFileSync('wakes.txt','w\\n')"`;
  const wakes = () => { try { return fs.readFileSync(path.join(wc, 'wakes.txt'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  let w = startWatcher(wc, c.id, c.tok, { WAKE_CMD: cmd });
  await send(b.tok, { text: '[完成] 告訴你一聲', recipientIds: [c.id] });
  await send(b.tok, { text: '[通知] 同步', recipientIds: [c.id], replyFrom: [] });
  await sleep(2000);
  assert.equal(wakes(), 0, '只有知會：巡檢不叫醒（修正前會叫醒）：\n' + w.log().split('\n').filter(l => !/保底巡檢\] 還有/.test(l)).join('\n').slice(-400));
  assert.match(w.log(), /2 則只是知會/, '日誌寫出是知會');
  await send(b.tok, { text: '請處理 C-9', recipientIds: [c.id] });
  for (let i = 0; i < 40 && wakes() < 1; i++) await sleep(100);
  assert.equal(wakes(), 1, '要處理的來了才叫醒');
  assert.equal((await call(c.tok, '/api/notifications?status=pending')).body.items.length, 3, '知會留在清單，叫醒時一起看');
  await w.stop();

  // B（UX 退回）：等待腳本啟動時與沒有 watcher 時看的未讀數，也不能算知會類——否則留著的知會讓它一啟動就醒、空轉
  const e = await mk('戊助手'), we = fs.mkdtempSync(path.join(dataDir, 'e-'));
  await send(b.tok, { text: '[完成] 告訴你', recipientIds: [e.id] });
  await send(b.tok, { text: '[通知] 同步', recipientIds: [e.id], replyFrom: [] });
  const cnt = (await call(e.tok, '/api/notifications/count?wake=1')).body;
  assert.deepEqual(cnt, { pending: 2, wake: 0 }, 'count?wake=1：2 則待處理、0 則要叫醒');
  assert.deepEqual((await call(e.tok, '/api/notifications/count')).body, { pending: 2 }, '不帶參數照舊');
  const runWait = env2 => new Promise(ok => { const p = spawn(process.execPath, [fileURLToPath(new URL('../public/aigile-wait.mjs', import.meta.url)), '--agent', 'E', '--max-min=0.03'], { cwd: we, env: { ...process.env, AIGILE_BASE: BASE, AIGILE_TOKEN: e.tok, AIGILE_TOKEN_FILE: path.join(we, 'none'), ...env2 } }); let o = ''; p.stdout.on('data', d => { o += d; }); p.on('exit', code => ok({ code, last: o.trim().split('\n').pop() })); });
  let wr = await runWait();
  assert.equal(wr.last, 'TIMEOUT', '只剩知會類：等待腳本不醒（修正前一啟動就 PENDING 2）：' + wr.last);
  await send(b.tok, { text: '請處理 C-10', recipientIds: [e.id] });
  wr = await runWait();
  assert.equal(wr.last.startsWith('PENDING'), true, '有要處理的就醒：' + wr.last);

  // A：Claude Code 接法（WAKE_CMD 是 echo）預設每小時 12 次；opencode 等維持 3 次（watcher-limit-test 測）
  const d = await mk('丁助手'), wd = fs.mkdtempSync(path.join(dataDir, 'd-'));
  const now = Date.now();
  fs.writeFileSync(path.join(wd, 'bell.json'), JSON.stringify({ v: 1, seq: 11, wakes: Array.from({ length: 11 }, (_, i) => now - (i + 1) * 60_000) })); // 一小時內已叫醒 11 次
  w = startWatcher(wd, d.id, d.tok, { WAKE_CMD: 'echo WAKE' });
  await send(b.tok, { text: '請做 1', recipientIds: [d.id] });
  for (let i = 0; i < 40 && !/喚醒：echo WAKE/.test(w.log()); i++) await sleep(100);
  assert.match(w.log(), /喚醒：echo WAKE/, '第 12 次照樣叫醒（修正前第 4 次就擋）');
  await sleep(300);
  await send(b.tok, { text: '請做 2', recipientIds: [d.id] });
  for (let i = 0; i < 40 && !/上限/.test(w.log()); i++) await sleep(100);
  assert.match(w.log(), /叫醒已達每小時上限 12 次/, '第 13 次才擋');
  await w.stop();
  const src = fs.readFileSync(WATCHER, 'utf8');
  assert.match(src, /num\(env\.WAKE_MAX_PER_HOUR, BELL_ONLY \? 12 : 3\)/); assert.match(src, /num\(env\.WAKE_MAX_PER_DAY, BELL_ONLY \? 60 : 15\)/);
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.match(spec, /Claude Code（`WAKE_CMD` 是 echo，只寫門鈴）每小時 12 次、每天 60 次/); assert.match(spec, /`wake`（[^\n]{0,80}`false`＝知會類/); assert.match(spec, /count\?wake=1/);
  console.log('c341-test：全部通過');
} catch (e) {
  console.error('c341-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  for (const w of procs) try { w.p.kill(); } catch {}
  server.close();
  await sleep(200);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
