// C-336 驗收測試（Fable 健檢 R3、R5、R7、R9）：D1 讀取／寫入量
//   R3 app_settings 前綴查詢改鍵範圍（走主鍵）、卡片計數改 status IN（走 idx_cards_status）→ 量測 /api/projects 讀取列數
//   R5 人類在線時間：前景 60 秒、背景分頁 5 分鐘才寫一次
// 量測方式：照報告的規模塞資料（app_settings 300 列、cards 600 張），看查詢計畫；
//   SCAN（全表）＝讀整張表，SEARCH（走索引）＝讀符合的列。D1 的 rows_read 也是這樣算。
// 用法：node scripts/c336-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-c336-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body, headers = {}) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const plan = async sql => (await db.all('EXPLAIN QUERY PLAN ' + sql)).map(r => r.detail).join(' | ');
const count = async (sql, ...a) => (await db.get(sql, ...a)).n;

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const L = liu.participant.participantId;
  await call(liu.token, `/api/participants/${L}/projects`, 'PUT', { projects: ['平台', '銀行系統'] });

  // ---- 塞資料：app_settings 300 列（大多是會一直長的 sq:、rprop:、prefs:、grants:、olink:）----
  const prefixes = ['sq', 'rprop', 'prefs', 'grants', 'olink'];
  for (let i = 0; i < 300; i++) await db.run('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', `${prefixes[i % 5]}:x${i}`, '{}');
  for (const pj of ['平台', '銀行系統']) {
    await db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', `repo:${pj}`, JSON.stringify({ url: 'https://github.com/a/b', branch: 'main' }));
    await db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', `dm:${pj}`, JSON.stringify({ on: true, by: L, at: '2026-10-20T00:00:00Z' }));
  }
  // ---- cards 600 張：100 張未結案、500 張已完成／已封存 ----
  const tpl = (await call(liu.token, '/api/cards', 'POST', { requestId: 'tpl', title: '樣板', project: '平台' })).body;
  assert.ok(tpl.cardId, JSON.stringify(tpl));
  const cols = (await db.all('PRAGMA table_info(cards)')).map(c => c.name).filter(c => !['seq', 'uid', 'status', 'request_id', 'proj_no', 'project'].includes(c));
  for (let i = 0; i < 599; i++) {
    const st = i < 99 ? ['待處理', '進行中', '受阻'][i % 3] : i % 2 ? '已完成' : '已封存';
    await db.run(`INSERT INTO cards (uid, status, request_id, project, ${cols.join(',')}) SELECT ?, ?, ?, ?, ${cols.join(',')} FROM cards WHERE seq = ?`,
      'card_seed' + i, st, 'seed' + i, i % 2 ? '平台' : '銀行系統', Number(tpl.cardId.slice(2)) - 100);
  }
  const settingsRows = await count('SELECT COUNT(*) AS n FROM app_settings');
  const cardRows = await count('SELECT COUNT(*) AS n FROM cards');
  assert.ok(settingsRows >= 300 && cardRows === 600, `資料規模：app_settings ${settingsRows}、cards ${cardRows}`);

  // ---- R3：/api/projects 的查詢都要走索引 ----
  const OPEN = "('待整理','待處理','進行中','待確認','受阻')";
  const queries = [
    ['pcode:+slug:', "SELECT key, value FROM app_settings WHERE (key >= 'pcode:' AND key < 'pcode;') OR (key >= 'slug:' AND key < 'slug;')", "SELECT key, value FROM app_settings WHERE key LIKE 'pcode:%' OR key LIKE 'slug:%'"],
    ['repo:', "SELECT key, value FROM app_settings WHERE (key >= 'repo:' AND key < 'repo;')", "SELECT key, value FROM app_settings WHERE key LIKE 'repo:%'"],
    ['dm:', "SELECT key, value FROM app_settings WHERE (key >= 'dm:' AND key < 'dm;')", "SELECT key, value FROM app_settings WHERE key LIKE 'dm:%'"],
    ['roles:', "SELECT key, value FROM app_settings WHERE (key >= 'roles:' AND key < 'roles;')", "SELECT key, value FROM app_settings WHERE key LIKE 'roles:%'"],
    ['slug:', "SELECT key, value FROM app_settings WHERE (key >= 'slug:' AND key < 'slug;')", "SELECT key, value FROM app_settings WHERE key LIKE 'slug:%'"],
    ['cards 計數', `SELECT project, COUNT(*) AS n FROM cards WHERE status IN ${OPEN} GROUP BY project`, "SELECT project, COUNT(*) AS n FROM cards WHERE status NOT IN ('已完成','已封存') GROUP BY project"],
  ];
  let before = 0, after = 0;
  for (const [name, now, old] of queries) {
    const pNew = await plan(now), pOld = await plan(old);
    assert.ok(!/SCAN (app_settings|cards)\b/.test(pNew), `${name} 新查詢不能全表掃描：${pNew}`);
    assert.ok(/SCAN (app_settings|cards)\b/.test(pOld), `${name} 舊查詢是全表掃描（量測基準）：${pOld}`);
    const table = name === 'cards 計數' ? cardRows : settingsRows;
    const matched = name === 'cards 計數' ? await count(`SELECT COUNT(*) AS n FROM cards WHERE status IN ${OPEN}`) : (await db.all(now)).length;
    // 舊查詢的結果要跟新的一樣
    assert.deepEqual(JSON.stringify(await db.all(old)), JSON.stringify(await db.all(now)), `${name} 新舊結果一致`);
    before += table; after += matched;
    console.log(`  ${name.padEnd(12)} 舊：全表 ${table} 列 → 新：${matched} 列（${pNew}）`);
  }
  const cut = Math.round((1 - after / before) * 100);
  console.log(`  /api/projects 估計讀取：${before} 列 → ${after} 列，降 ${cut}%`);
  assert.ok(cut >= 80, `R3：讀取列數要降 80% 以上（實際 ${cut}%）`);
  const pv = await call(liu.token, '/api/projects');
  assert.equal(pv.status, 200);
  assert.equal(pv.body.items.find(p => p.id === '平台').repo?.url, 'https://github.com/a/b', '畫面行為不變：程式庫照讀得到');
  assert.equal(pv.body.items.find(p => p.id === '平台').dm?.on, true, '畫面行為不變：私訊設定照讀得到');
  assert.equal(pv.body.items.reduce((n, p) => n + p.openCards, 0), 100, '畫面行為不變：未結案卡片數');
  // 卡片列表（R9）：預設不含已封存、status=open 只含未結案
  const lst = (await call(liu.token, '/api/cards?limit=200&counts=1')).body.items;
  assert.ok(lst.every(c => c.status !== '已封存'), '預設列表不含已封存');
  assert.ok((await call(liu.token, '/api/cards?status=open&limit=200')).body.items.every(c => !['已完成', '已封存'].includes(c.status)), 'status=open 只含未結案');
  assert.ok(!/SCAN cards\b/.test(await plan(`SELECT seq FROM cards WHERE status IN ${OPEN}`)), 'R9：未結案條件走狀態索引');

  // ---- R5：人類在線時間寫入間隔 ----
  const seenAt = async () => (await db.get('SELECT last_seen_at FROM participants WHERE id = ?', L)).last_seen_at;
  const setSeen = (ago, dev = null) => Promise.all([db.run('UPDATE participants SET last_seen_at = ? WHERE id = ?', Date.now() - ago, L)]);
  await setSeen(30_000); let t0 = await seenAt();
  await call(liu.token, '/api/me');
  assert.equal(await seenAt(), t0, 'R5：前景 30 秒內不寫（原本 20 秒就寫）');
  await setSeen(61_000); t0 = await seenAt();
  await call(liu.token, '/api/me');
  assert.ok(await seenAt() > t0, 'R5：前景超過 60 秒才寫');
  await setSeen(120_000); t0 = await seenAt();
  await call(liu.token, '/api/me', 'GET', undefined, { 'X-Aigile-Bg': '1' });
  assert.equal(await seenAt(), t0, 'R5：背景分頁 2 分鐘不寫');
  await setSeen(301_000); t0 = await seenAt();
  await call(liu.token, '/api/me', 'GET', undefined, { 'X-Aigile-Bg': '1' });
  assert.ok(await seenAt() > t0, 'R5：背景分頁超過 5 分鐘才寫');
  await setSeen(80_000);
  assert.equal((await call(liu.token, '/api/participants')).body.items.find(p => p.participantId === L).isOnline, true, 'R5：80 秒前活動仍算在線（門檻 90 秒）');

  console.log('c336: all checks passed');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
