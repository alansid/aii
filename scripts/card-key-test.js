// C-310 驗收測試：卡號改「專案代號＋專案內連號」（PLAT-12），C-xxx 永久保留
// 修正前：全站共用 C-xxx，同專案內會跳號（昱志 10/19 第 2655 則：1A 專案代號＋專案內連號；2A 舊卡依建立順序補號）
// 用法：node scripts/card-key-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-cardkey-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let n = 0;
const card = (tok, project, title) => call(tok, '/api/cards', 'POST', { requestId: 'c' + (++n), project, title }).then(r => r.body);

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const chen = (await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  await call(liu.token, `/api/participants/${chen.participant.participantId}/projects`, 'PUT', { projects: ['平台', '銀行系統'] });

  // 專案代號：預設取網址英文名
  const pl = (await call(liu.token, '/api/projects')).body.items;
  assert.equal(pl.find(p => p.id === '平台').code, 'PLAT');
  assert.equal(pl.find(p => p.id === '銀行系統').code, 'BANK');

  // 兩個專案交錯建卡：各自從 1 連續編（C 號是全站的，會跳）
  const a = await card(liu.token, '平台', '平台一'), b = await card(liu.token, '銀行系統', '銀行一');
  const c = await card(liu.token, '平台', '平台二'), d = await card(liu.token, '銀行系統', '銀行二');
  assert.deepEqual([a.key, b.key, c.key, d.key], ['PLAT-1', 'BANK-1', 'PLAT-2', 'BANK-2'], '專案內連號');
  assert.match(c.cardId, /^C-\d+$/, 'cardId 照舊是 C-xxx');

  // 兩種編號都收：查、改
  let r = await call(chen.token, '/api/cards/PLAT-2');
  assert.equal(r.status, 200); assert.equal(r.body.cardId, c.cardId, 'PLAT-2 就是那張');
  assert.equal((await call(chen.token, '/api/cards/plat-2')).body.cardId, c.cardId, '小寫也收');
  r = await call(chen.token, '/api/cards/PLAT-2', 'PATCH', { next: '用代號號改', version: r.body.version });
  assert.equal(r.status, 200); assert.equal(r.body.next, '用代號號改');
  assert.equal((await call(chen.token, `/api/cards/${c.cardId}`)).body.next, '用代號號改', 'C-xxx 照舊');
  assert.equal((await call(chen.token, '/api/cards/PLAT-99')).status, 404, '不存在的號 404');

  // 搜尋：打代號號或 C 號都找得到
  assert.ok((await call(chen.token, '/api/cards?q=BANK-2')).body.items.some(x => x.cardId === d.cardId), '搜 BANK-2');
  assert.ok((await call(chen.token, `/api/cards?q=${a.cardId}`)).body.items.some(x => x.cardId === a.cardId), '搜 C 號');

  // 換專案：在新專案拿新號
  r = await call(liu.token, `/api/cards/${a.cardId}`, 'PATCH', { project: '銀行系統', version: a.version });
  assert.equal(r.body.key, 'BANK-3', '移到銀行系統拿新號');
  assert.equal((await card(liu.token, '平台', '平台三')).key, 'PLAT-3', '原專案照樣往下編（不補洞）');

  // 改專案代號：只有管理員；格式、重複擋下；改了用新代號，C 號照舊
  assert.equal((await call(chen.token, '/api/projects/平台/code', 'PUT', { code: 'PF' })).status, 403);
  assert.equal((await call(liu.token, '/api/projects/平台/code', 'PUT', { code: 'P1' })).status, 400, '只能英文字母');
  assert.equal((await call(liu.token, '/api/projects/平台/code', 'PUT', { code: 'BANK' })).status, 409, '不能跟別的專案重複');
  r = await call(liu.token, '/api/projects/平台/code', 'PUT', { code: 'pf' });
  assert.equal(r.status, 200); assert.equal(r.body.items.find(p => p.id === '平台').code, 'PF');
  assert.equal((await call(chen.token, `/api/cards/${c.cardId}`)).body.key, 'PF-2', '改代號後顯示新代號');
  assert.equal((await call(chen.token, '/api/cards/PF-2')).body.cardId, c.cardId);
  assert.equal((await call(chen.token, '/api/cards/PLAT-2')).status, 404, '舊代號不再對應');
  // 新專案建立時可以帶代號
  r = await call(liu.token, '/api/projects', 'POST', { name: '外食減脂助手', code: 'diet' });
  assert.equal(r.status, 201); assert.equal(r.body.items.find(p => p.id === r.body.id).code, 'DIET');

  // migration 0022：舊格式的表（沒有 proj_no）依建立順序補號
  const old = new DatabaseSync(':memory:');
  old.exec("CREATE TABLE cards (seq INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, title TEXT, project TEXT, created_at TEXT)");
  const ins = old.prepare('INSERT INTO cards (uid, title, project, created_at) VALUES (?,?,?,?)');
  [['平台', '2026-10-01'], ['銀行系統', '2026-10-02'], ['平台', '2026-10-03'], ['平台', '2026-10-03'], ['銀行系統', '2026-10-05']].forEach(([pj, at], i) => ins.run('u' + i, 't' + i, pj, at));
  for (const stmt of fs.readFileSync(new URL('../migrations/0022_card_proj_no.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '').split(';').map(x => x.trim()).filter(Boolean)) old.exec(stmt);
  assert.deepEqual(old.prepare('SELECT project, proj_no FROM cards ORDER BY seq').all().map(x => `${x.project}-${x.proj_no}`), ['平台-1', '銀行系統-1', '平台-2', '平台-3', '銀行系統-2'], '舊卡依建立順序補號（同時間依 seq）');
  assert.throws(() => old.exec("UPDATE cards SET proj_no = 1 WHERE seq = 3"), /UNIQUE/, '同專案不能重號');
  old.close();

  // C-319：同時建卡 20 張＋同時把 10 張卡移進同一專案，號碼不重複、也不失敗
  // 修正前：換專案先查最大號、隔一步才寫回，兩張同時移進來會拿到同一號，撞唯一索引回 500
  const movers = [];
  for (let i = 0; i < 10; i++) movers.push(await card(liu.token, '銀行系統', '待移' + i));
  const burst = await Promise.all([
    ...Array.from({ length: 20 }, (_, i) => call(liu.token, '/api/cards', 'POST', { requestId: 'burst' + i, project: '平台', title: '同時建' + i })),
    ...movers.map(m => call(liu.token, `/api/cards/${m.cardId}`, 'PATCH', { project: '平台', version: m.version })),
  ]);
  assert.deepEqual(burst.filter(x => x.status >= 300).map(x => `${x.status} ${x.body.error?.code}`), [], '同時建卡／移卡都成功');
  const platKeys = burst.map(x => x.body.key);
  assert.equal(new Set(platKeys).size, 30, '30 張號碼都不同：' + platKeys.join(','));
  assert.ok(platKeys.every(k => /^[A-Z]+-\d+$/.test(k)), '每張都有代號號');
  const dup = await db.get("SELECT project, proj_no, COUNT(*) AS n FROM cards WHERE proj_no IS NOT NULL GROUP BY project, proj_no HAVING n > 1");
  assert.ok(!dup, '資料庫沒有重號');

  // 網頁：顯示代號號、內文兩種寫法都轉成卡片
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /C-\\d\{3,\}\|\[A-Z\]\{2,5\}-\\d\+/, '訊息內文兩種卡號都認');
  assert.match(js, /\$\{esc\(c\.key \|\| c\.cardId\)\}/, '卡片顯示代號號');
  console.log('card-key-test：全部通過');
} catch (e) {
  console.error('card-key-test 失敗：', e.message, (e.stack.split('\n').find(l => l.includes('card-key-test.js')) || '').trim());
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
