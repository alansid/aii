// C-298 驗收測試：風格記在帳號、頂欄搜尋訊息（看得到的範圍跟訊息列表一樣）
// 用法：node scripts/search-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-search-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let n = 0;
const msg = (tok, project, text) => call(tok, '/api/messages', 'POST', { requestId: 'm' + (++n), project, text });
const q = s => encodeURIComponent(s);

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const huang = (await call(null, '/api/join', 'POST', { name: '黃紹軒', role: 'PG', environment: '行內' })).body;
  const H = huang.participant.participantId;
  await call(liu.token, `/api/participants/${H}/projects`, 'PUT', { projects: ['銀行系統'] });

  // 風格：預設 a；改 c 之後 /api/me 帶回；亂填擋下；AI 不能設
  assert.deepEqual((await call(liu.token, '/api/me')).body.prefs, { style: 'a' }, '預設清爽');
  assert.equal((await call(liu.token, '/api/me/prefs', 'PUT', { style: 'z' })).status, 400);
  assert.deepEqual((await call(liu.token, '/api/me/prefs', 'PUT', { style: 'c' })).body.prefs, { style: 'c' });
  assert.equal((await call(liu.token, '/api/me')).body.prefs.style, 'c', '記在帳號');
  assert.equal((await call(huang.token, '/api/me')).body.prefs.style, 'a', '別人不受影響');
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: '程式開發', name: '小助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiTok = (await db.get('SELECT token FROM participants WHERE id = ?', ai.participantId)).token;
  assert.equal((await call(aiTok, '/api/me/prefs', 'PUT', { style: 'b' })).status, 403, 'AI 沒有網頁風格');

  // 搜尋訊息
  await msg(liu.token, '平台', '平台的藍莓計畫今天開工');
  await msg(liu.token, '銀行系統', '銀行系統的藍莓報表');
  await msg(huang.token, '銀行系統', '行內藍莓測試 100%_完成');
  assert.equal((await call(liu.token, `/api/search/messages?q=${q('藍')}`)).status, 400, '至少 2 個字');
  let r = await call(liu.token, `/api/search/messages?q=${q('藍莓')}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 3, '管理員三則都找得到');
  assert.equal(r.body.items[0].text, '行內藍莓測試 100%_完成', '新的在前');
  // % 和 _ 當一般字，不是萬用字元
  assert.equal((await call(liu.token, `/api/search/messages?q=${q('0%_完')}`)).body.items.length, 1, '% _ 照字面找');
  assert.equal((await call(liu.token, `/api/search/messages?q=${q('藍_')}`)).body.items.length, 0, '_ 不是萬用字元');
  // 搜尋結果一定是訊息列表看得到的（每個人各自比對）
  for (const [who, tok] of [['劉', liu.token], ['黃', huang.token]]) {
    const list = (await call(tok, '/api/messages?limit=100')).body.items;
    const seen = new Set(list.map(m => m.messageId));
    const hits = (await call(tok, `/api/search/messages?q=${q('藍莓')}`)).body.items;
    assert.ok(hits.every(m => seen.has(m.messageId)), `${who}：搜尋不能多出看不到的訊息`);
    assert.equal(hits.length, list.filter(m => m.text.includes('藍莓')).length, `${who}：看得到的都找得到`);
  }
  // 專案篩選
  assert.ok((await call(liu.token, `/api/search/messages?q=${q('藍莓')}&project=${q('平台')}`)).body.items.every(m => m.project === '平台'), '可限定專案');

  // C-312：讀取上限。每類最多 20 筆；至少 2 字；每人每分鐘最多 10 次（人類、AI 都算；網頁一次 Enter 走 /api/search 算 1 次）
  const chen = (await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  await call(liu.token, `/api/participants/${chen.participant.participantId}/projects`, 'PUT', { projects: ['平台'] });
  for (let i = 1; i <= 25; i++) await call(liu.token, '/api/cards', 'POST', { requestId: 'k' + i, project: '平台', title: `草莓任務 ${i}` });
  for (let i = 1; i <= 25; i++) await msg(liu.token, '平台', `草莓訊息 ${i}`);
  // 網頁合併搜尋：卡片＋訊息各最多 20 筆，算 1 次
  r = await call(chen.token, `/api/search?q=${q('草莓')}`);
  assert.equal(r.status, 200); assert.ok(r.body.cards.length <= 20 && r.body.cards.length > 0, `卡片最多 20 筆（${r.body.cards.length}）`);
  assert.ok(r.body.messages.length <= 20 && r.body.messages.length > 0, `訊息最多 20 筆（${r.body.messages.length}）`);
  assert.ok((await call(chen.token, `/api/cards?q=${q('草莓')}&limit=100`)).body.items.length <= 20, '直接查卡片也最多 20 筆');
  assert.equal((await call(chen.token, `/api/cards?q=${q('草')}`)).status, 400, '卡片搜尋至少 2 字');
  assert.equal((await call(chen.token, `/api/search?q=${q('草')}`)).status, 400, '合併搜尋至少 2 字');
  for (let i = 3; i <= 10; i++) assert.equal((await call(chen.token, `/api/search?q=${q('草莓')}`)).status, 200, `第 ${i} 次還可以（前面已用 2 次；不到 2 字的不算）`);
  r = await call(chen.token, `/api/search?q=${q('草莓')}`);
  assert.equal(r.status, 429, '第 11 次擋下'); assert.equal(r.body.error.code, 'SEARCH_LIMIT');
  assert.match(r.body.error.message, /每人每分鐘最多 10 次，請 \d+ 秒後再試/);
  assert.equal((await call(chen.token, `/api/cards?q=${q('草莓')}`)).status, 429, '直接查卡片也擋');
  assert.equal((await call(liu.token, `/api/search?q=${q('草莓')}`)).status, 200, '別人不受影響');
  assert.equal((await call(chen.token, '/api/cards?limit=5')).status, 200, '一般卡片列表（沒有關鍵字）不受影響');

  // UX 退回的重現：AI 的 Token 直接打 /api/search/messages，1 分鐘內第 11 次要 429；
  // 而且雲端有好幾份程式：兩份 app 共用同一個資料庫輪流接，也要算在一起
  const uxAi = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'UX', role: 'UX', name: '體驗助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const uxTok = (await db.get('SELECT token FROM participants WHERE id = ?', uxAi.participantId)).token;
  const app2 = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
  const via = async (which, path) => { const rr = await which(new Request('http://localhost' + path, { headers: { Authorization: `Bearer ${uxTok}` } }), 'http://localhost'); return { status: rr.status, body: await rr.json().catch(() => ({})) }; };
  for (let i = 1; i <= 10; i++) assert.equal((await via(i % 2 ? app : app2, `/api/search/messages?q=${q('草莓')}`)).status, 200, `AI 第 ${i} 次可以`);
  r = await via(app2, `/api/search/messages?q=${q('草莓')}`);
  assert.equal(r.status, 429, 'AI 第 11 次擋下（修正前兩份程式各算各的、又是 20 次才擋）');
  assert.equal(r.body.error.code, 'SEARCH_LIMIT');
  console.log('search-test：全部通過');
} catch (e) {
  console.error('search-test 失敗：', e.message, (e.stack.split('\n').find(l => l.includes('search-test.js')) || '').trim());
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
