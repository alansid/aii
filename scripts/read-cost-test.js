// C-316 驗收測試：D1 讀取優化
// ④ 成員表改成「有寫入才整張重讀」：雲端好幾份程式共用版本記號；沒寫入時只讀版本 1 列＋最近有活動的人
// ⑤ 個人待處理通知：索引順著讀、讀到 LIMIT 就停（不再整批讀出來排序）
// ① 團隊狀態：網頁 5 分鐘才輪詢一次、伺服器快取 180 秒
// 用法：node scripts/read-cost-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-readcost-'));
const raw = openNodeDb(path.join(dataDir, 'switch.db'));
// 數「整張成員表」被讀了幾次
let fullReads = 0;
const db = { ...raw, all: (sql, ...a) => { if (/^SELECT \* FROM participants$/.test(sql.trim())) fullReads++; return raw.all(sql, ...a); } };
const mk = () => createApp({ db, storage: dbStorage(raw), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', peopleCheckMs: '50' } });
const A = mk(), B = mk(); // 兩份程式共用同一個資料庫
const call = (app, token, p, method = 'GET', body) => app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost')
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
  const liu = (await call(A, null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const chen = (await call(A, null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  const C = chen.participant.participantId;
  // 暖身：新資料庫第一次載入會寫一次跨專案名單（一次性），先讓兩份程式都過了這一步
  for (let i = 0; i < 3; i++) { await call(B, liu.token, '/api/projects'); await call(A, liu.token, '/api/projects'); await call(B, liu.token, '/api/participants'); await call(A, liu.token, '/api/participants'); await sleep(70); }

  // 沒有寫入：過了檢查間隔也不整張重讀（修正前每 30 秒整張讀）
  fullReads = 0;
  for (let i = 0; i < 6; i++) { await sleep(70); await call(B, liu.token, '/api/participants'); await call(A, chen.token, '/api/participants'); }
  assert.equal(fullReads, 0, `沒寫入不整張重讀（讀了 ${fullReads} 次）`);

  // A 改了成員資料 → B 下一次檢查就看到（靠版本記號，不靠到期）
  await call(A, liu.token, `/api/participants/${C}/projects`, 'PUT', { projects: ['銀行系統'] });
  await sleep(70);
  const seen = (await call(B, liu.token, '/api/participants')).body.items.find(p => p.participantId === C);
  assert.deepEqual(seen.projects, ['銀行系統'], '另一份程式也看到新的所屬專案');
  assert.ok(fullReads >= 1 && fullReads <= 3, `有寫入才重讀（${fullReads} 次）`);

  // 在線狀態照樣更新：陳在 A 有動作，B 看得到他在線
  await raw.run('UPDATE participants SET last_seen_at = 0 WHERE id = ?', C); // 先當作很久沒來
  await call(A, liu.token, `/api/participants/${C}/projects`, 'PUT', { projects: ['平台'] }); await sleep(70);
  await call(B, liu.token, '/api/participants'); await call(A, liu.token, '/api/participants'); // 兩邊都因這次寫入重讀一次
  fullReads = 0;
  await call(A, chen.token, '/api/me'); // 陳上線（寫 last_seen_at）
  await sleep(70);
  const on = (await call(B, liu.token, '/api/participants')).body.items.find(p => p.participantId === C);
  assert.equal(on.isOnline, true, '在線狀態跟得上（只補最近有活動的人）');
  assert.equal(fullReads, 0, '補在線狀態不用整張重讀');

  // ⑤ 個人待處理通知：查詢計畫不用另外排序（讀到 LIMIT 就停）
  const plan = (await raw.all("EXPLAIN QUERY PLAN SELECT n.* FROM notifications n WHERE n.recipient_id = 'x' AND n.status = 'pending' ORDER BY n.created_at DESC, n.rowid DESC LIMIT 50")).map(r => r.detail).join(' | ');
  assert.match(plan, /idx_notif_recipient/, '用個人通知索引：' + plan);
  assert.ok(!/TEMP B-TREE/.test(plan), '不用暫存排序：' + plan);
  const src = fs.readFileSync(new URL('../src/core.js', import.meta.url), 'utf8');
  assert.ok(src.includes("'n.created_at DESC, n.rowid DESC'"), '程式用 rowid 當第二排序鍵');
  // 索引：在線狀態用
  assert.ok((await raw.all("SELECT name FROM sqlite_master WHERE name = 'idx_participants_seen'")).length, '有 participants(last_seen_at) 索引');

  // C-320：團隊狀態的待處理數不再把通知連同訊息整批讀（每則 2 列 → 1 列）；訊息的專案與時間記在記憶體只補讀新的；
  // 待處理數有自己的快取，改卡等寫入讓團隊狀態重算時不跟著重讀通知
  // 修正前：每次都 JOIN 訊息，改一張卡團隊狀態就整批重讀
  const log = [];
  const spy = { ...raw, all: (sql, ...a) => { const rows = raw.all(sql, ...a); const s = sql.replace(/\s+/g, ' ').trim(); if (/notifications|FROM messages WHERE id IN|card_msgs/.test(s)) Promise.resolve(rows).then(r => log.push({ s, n: r.length })); return rows; } };
  const T = createApp({ db: spy, storage: dbStorage(raw), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '1000' } });
  const say = i => call(T, liu.token, '/api/messages', 'POST', { project: '平台', requestId: 'pend' + i, recipientIds: [C], text: '[通知] 給陳的第 ' + i + ' 則' });
  const team = async () => { log.length = 0; const r = await call(T, liu.token, '/api/team-status'); await sleep(5); return r.body.members.find(m => m.participantId === C); };
  const notifQ = () => log.filter(x => /FROM notifications/.test(x.s) && /status = 'pending'/.test(x.s) && !/recipient_id = \?/.test(x.s));
  const msgQ = () => log.filter(x => /FROM messages WHERE id IN/.test(x.s));
  for (let i = 1; i <= 5; i++) await say(i);
  await sleep(1100);
  let mb = await team();
  assert.equal(mb.pendingCount, 5, '待處理數照算');
  assert.ok(!log.some(x => /notifications n LEFT JOIN messages/.test(x.s)), '不再 JOIN 訊息');
  assert.deepEqual(notifQ().map(x => x.n), [5], '通知表讀 1 次、5 則');
  assert.deepEqual(msgQ().map(x => x.n), [5], '第一次補讀 5 則訊息的專案與時間');
  await sleep(1100);
  mb = await team();
  assert.equal(mb.pendingCount, 5);
  assert.deepEqual(msgQ(), [], '訊息已記住：快取到期重算也不再讀訊息');
  await say(6); await sleep(1100);
  mb = await team();
  assert.equal(mb.pendingCount, 6, '新通知算進去');
  assert.deepEqual(msgQ().map(x => x.n), [1], '只補讀新的那 1 則訊息');
  await call(T, liu.token, '/api/cards', 'POST', { requestId: 'pendcard', project: '平台', title: '改卡讓團隊狀態重算' });
  mb = await team();
  assert.deepEqual(notifQ(), [], '改卡後團隊狀態重算，待處理數用自己的快取，不重讀通知');
  assert.equal(mb.pendingCount, 6);

  // C-322：卡片「可能過時」檢查：找舊卡只讀未結案的（狀態索引）；關聯訊息讀過就記住，之後只補讀新加的關聯
  // 修正前：每次重算都把舊卡的全部關聯訊息整批重讀
  const S = createApp({ db: spy, storage: dbStorage(raw), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', cardStaleHours: String(1 / 3600) } }); // 門檻 1 秒、快取約 17 毫秒
  const mkCard = async t => (await call(S, liu.token, '/api/cards', 'POST', { requestId: 'st' + t, project: '平台', title: t })).body;
  const ca = await mkCard('甲'), cb = await mkCard('乙'), cdone = await mkCard('已完成的');
  await call(S, liu.token, `/api/cards/${cdone.cardId}`, 'PATCH', { status: '已完成', version: cdone.version });
  const link = (cid, i) => call(S, liu.token, '/api/messages', 'POST', { project: '平台', requestId: 'sl' + cid + i, cardId: cid, text: '討論 ' + cid + ' 第 ' + i + ' 則' });
  await sleep(1200);
  for (let i = 0; i < 3; i++) await link(ca.cardId, i);
  const hints = async () => { await sleep(30); log.length = 0; const r = await call(S, liu.token, '/api/cards?status=open'); await sleep(5); return new Set(r.body.items.filter(c => c.staleHint).map(c => c.cardId)); };
  const fullQ = () => log.filter(x => /card_seq IN \(SELECT value FROM json_each/.test(x.s));
  let h = await hints();
  assert.ok(h.has(ca.cardId) && !h.has(cb.cardId), '甲有新討論 → 可能過時；乙沒有');
  const oldPlan = (await raw.all("EXPLAIN QUERY PLAN SELECT seq, updated_at FROM cards WHERE status IN (SELECT value FROM json_each('[\"待處理\"]')) AND updated_at < '9'")).map(r => r.detail).join(' | ');
  assert.match(oldPlan, /idx_cards_status/, '找舊卡用狀態索引：' + oldPlan);
  assert.ok(fs.readFileSync(new URL('../src/cards.js', import.meta.url), 'utf8').includes("'SELECT seq, updated_at FROM cards WHERE status IN (SELECT value FROM json_each(?)) AND updated_at < ?'"), '程式用這條找舊卡');
  h = await hints();
  assert.ok(h.has(ca.cardId), '標示照舊');
  assert.deepEqual(fullQ(), [], '關聯訊息讀過就記住，不再整批重讀');
  await link(cb.cardId, 0);
  h = await hints();
  assert.ok(h.has(cb.cardId), '乙的新關聯補讀到 → 乙也可能過時');
  assert.deepEqual(fullQ(), [], '只補讀新加的關聯');
  assert.ok(!h.has(cdone.cardId), '已完成的卡不算');

  // ① 團隊狀態：網頁 5 分鐘輪詢、伺服器快取 180 秒
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /Date\.now\(\) - lastTeamPoll > 300_000/, '網頁團隊狀態 5 分鐘輪詢一次');
  assert.match(src, /TEAM_CACHE_MS_DEFAULT = 180_000/, '伺服器快取 180 秒');
  console.log('read-cost-test：全部通過');
} catch (e) {
  console.error('read-cost-test 失敗：', e.message, (e.stack.split('\n').find(l => l.includes('read-cost-test.js')) || '').trim());
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
