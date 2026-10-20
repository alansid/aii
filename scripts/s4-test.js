// C-343 S4 驗收測試：門鈴簽章
// 修正前：門鈴頻道是公開的，拿到 Supabase anon key 的人可以送任何 AI 的門鈴，watcher 照單全收，
//         每個假門鈴都讓它打一次平台（被灌假門鈴就一直讀）
// 修正後：平台用收件 AI 自己的 Token 對 doorbell|id|at|n 簽 HMAC；watcher 驗不過、或同一個 n 重播就略過，不打平台
// 用法：node scripts/s4-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-s4-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const bells = []; // 門鈴打到假的 Supabase
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://sb.test/')) { bells.push(JSON.parse(opts.body).messages[0].payload); return new Response('{}'); }
  return realFetch(url, opts);
};
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', supabaseUrl: 'https://sb.test', supabaseKey: 'k' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// 把 watcher.mjs 的簽章檢查抽出來跑（跟 bell-test 一樣，測的是實際要發出去的檔）
const src = fs.readFileSync(new URL('../public/watcher.mjs', import.meta.url), 'utf8');
const start = src.indexOf('// ---------- C-343 S4'), end = src.indexOf('// ---------- Supabase Realtime', start);
const watcherSide = (ME, TOKEN) => {
  const logs = [];
  const fn = new Function('createHmac', 'timingSafeEqual', 'Buffer', 'ME', 'TOKEN', 'log', `${src.slice(start, end)}; return { bellOk, badBell };`);
  return { ...fn(crypto.createHmac, crypto.timingSafeEqual, Buffer, ME, TOKEN, (...a) => logs.push(a.join(' '))), logs };
};

try {
  assert.ok(start > 0 && end > start, '找得到 watcher 的簽章檢查');
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const mk = async name => { const a = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; return { id: a.participantId, tok: (await db.get('SELECT token FROM participants WHERE id = ?', a.participantId)).token }; };
  const a = await mk('甲助手'), b = await mk('乙助手');

  // 1) 平台：門鈴帶每位收件 AI 的簽章，簽章用的是收件人自己的 Token
  const m = (await call(liu.token, '/api/messages', 'POST', { project: '平台', requestId: 's4-1', text: '請兩位看一下 C-1', recipientIds: [a.id, b.id] })).body;
  assert.ok(m.messageId, '發文成功 ' + JSON.stringify(m).slice(0, 150));
  for (let i = 0; i < 50 && !bells.length; i++) await sleep(10);
  assert.equal(bells.length, 1, '一則訊息按一次門鈴');
  const bell = bells[0];
  assert.deepEqual([...bell.ids].sort(), [a.id, b.id].sort(), 'ids 照舊送（舊版 watcher 靠它）');
  assert.ok(typeof bell.at === 'string' && typeof bell.n === 'string' && bell.n.length >= 10, '有時間與每次不同的 n');
  const expect = (tok, id) => crypto.createHmac('sha256', tok).update(`doorbell|${id}|${bell.at}|${bell.n}`).digest('hex').slice(0, 32);
  assert.equal(bell.sigs[a.id], expect(a.tok, a.id), '甲的簽章用甲的 Token');
  assert.equal(bell.sigs[b.id], expect(b.tok, b.id), '乙的簽章用乙的 Token');
  assert.ok(!JSON.stringify(bell).includes(a.tok) && !JSON.stringify(bell).includes(b.tok), '門鈴裡沒有 Token');

  // 2) watcher：平台送的真門鈴驗得過；同一個門鈴重播就略過
  const wa = watcherSide(a.id, a.tok), wb = watcherSide(b.id, b.tok);
  assert.equal(wa.bellOk(bell), true, '甲驗過平台的門鈴');
  assert.equal(wb.bellOk(bell), true, '乙也驗得過（各自用自己的 Token）');
  assert.equal(wa.bellOk(bell), false, '同一個門鈴重播：略過');
  assert.equal(wa.bellOk(structuredClone(bell)), false, '複製一份重送：還是同一個 n，略過');

  // 3) watcher：假造的門鈴一律略過
  const fresh = () => ({ ids: [a.id], at: new Date().toISOString(), n: 'bell_' + crypto.randomBytes(6).toString('hex') });
  assert.equal(wa.bellOk(fresh()), false, '沒有簽章（拿 anon key 直接送）：略過');
  const f1 = fresh(); f1.sigs = { [a.id]: crypto.createHmac('sha256', 'not-my-token').update(`doorbell|${a.id}|${f1.at}|${f1.n}`).digest('hex').slice(0, 32) };
  assert.equal(wa.bellOk(f1), false, '用別的 Token 簽：略過');
  const f2 = fresh(); f2.sigs = { [a.id]: bell.sigs[a.id] };
  assert.equal(wa.bellOk(f2), false, '搬舊簽章到新的時間與 n：略過');
  const f3 = { ...bell, n: 'bell_other' };
  assert.equal(wa.bellOk(f3), false, '改 n 想繞過重播檢查：簽章對不上，略過');
  const f4 = fresh(); f4.sigs = { [a.id]: crypto.createHmac('sha256', b.tok).update(`doorbell|${a.id}|${f4.at}|${f4.n}`).digest('hex').slice(0, 32) };
  assert.equal(wa.bellOk(f4), false, '乙用自己的 Token 替甲簽（同群組的 AI 也假造不了別人的門鈴）：略過');
  assert.equal(wa.bellOk({ ids: [a.id], at: bell.at, n: bell.n, sigs: { [a.id]: 'x'.repeat(5) } }), false, '簽章長度不對不會丟例外');
  assert.equal(wa.bellOk(null), false, '空 payload 不會丟例外');

  // 4) 被灌假門鈴：日誌最多每 10 分鐘一行，不洗版
  for (let i = 0; i < 100; i++) wa.badBell();
  assert.equal(wa.logs.length, 1, '100 個假門鈴只記一行');
  assert.match(wa.logs[0], /簽章不符的門鈴/);

  // 5) 私訊的門鈴一樣有簽章
  assert.equal((await call(liu.token, '/api/projects/平台/dm', 'PUT', { on: true })).status, 200, '開私訊');
  bells.length = 0;
  const dm = await call(liu.token, '/api/dm', 'POST', { aiId: a.id, text: '私訊測試', requestId: 's4-dm' });
  assert.ok(dm.status < 300, '私訊成功 ' + JSON.stringify(dm.body).slice(0, 150));
  {
    for (let i = 0; i < 50 && !bells.length; i++) await sleep(10);
    assert.equal(bells.length, 1, '私訊按門鈴');
    assert.equal(watcherSide(a.id, a.tok).bellOk(bells[0]), true, '私訊門鈴驗得過');
  }

  // 6) 接入設定裡的雜湊、規格說明跟著更新
  const sha = crypto.createHash('sha256').update(fs.readFileSync(new URL('../public/watcher.mjs', import.meta.url))).digest('hex');
  assert.ok(fs.readFileSync(new URL('../src/core.js', import.meta.url), 'utf8').includes(`WATCHER_SHA256 = '${sha}'`), 'WATCHER_SHA256 等於 watcher.mjs 的雜湊');
  assert.match(fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8'), /watcher 驗不過就略過/, '規格寫到簽章');
  console.log('s4-test：全部通過');
} catch (e) {
  console.error('s4-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await sleep(50);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
