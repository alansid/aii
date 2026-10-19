// C-281 驗收測試：回報問題＋許願池
// 用法：node scripts/feedback-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-fb-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
const BASE = 'http://localhost';
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), BASE);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const img = async (token, p, bytes) => { const r = await app(new Request(BASE + p, { method: 'POST', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${token}` }, body: bytes }), BASE); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const png = n => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(n).fill(1)]);

try {
  // 版本號：網頁顯示的版本要跟 package.json 一樣
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.ok(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').includes(`const APP_VERSION = '${pkg}'`), `app.js 的 APP_VERSION 要等於 ${pkg}`);

  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body; // 管理員（平台＋銀行）
  const huang = (await call(null, '/api/join', 'POST', { name: '黃紹軒', role: 'PO' })).body; // 只在銀行系統（不在平台）
  const H = huang.participant.participantId;
  await call(liu.token, `/api/participants/${H}/projects`, 'PUT', { projects: ['銀行系統'] });
  const po = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PO', role: '產品負責', name: 'claude-PO', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;

  // 不在平台的人也能回報；PO 被叫醒；回報的人自己看不到回報清單
  let r = await call(huang.token, '/api/reports', 'POST', { title: '手機按送出沒反應', detail: '按了沒動靜', project: '銀行系統', context: { page: '銀行系統 › 訊息', version: '0.72.0', device: 'iPhone Safari', errorCode: 'NETWORK', junk: 'x' } });
  assert.equal(r.status, 201); assert.equal(r.body.reportId, 'R-1');
  const n = (await call(po.token, '/api/notifications?status=pending')).body.items.find(x => /\[回報\] R-1/.test(x.preview));
  assert.ok(n && n.ask === true, 'PO 收到回報通知（叫醒）');
  assert.equal((await call(huang.token, '/api/reports')).status, 403, '問題回報只有平台團隊看得到');
  assert.equal((await call(po.token, '/api/reports', 'POST', { title: 'x' })).status, 403, 'AI 先不能用 API 回報');
  assert.equal((await call(huang.token, '/api/reports', 'POST', { title: '' })).status, 400, '標題必填');

  // 截圖：回報的人、1 MB、最多 3 張
  assert.equal((await img(liu.token, '/api/reports/R-1/shots', png(10))).status, 404, '只有回報的人能傳截圖');
  r = await img(huang.token, '/api/reports/R-1/shots', png(10));
  assert.equal(r.status, 201); const shot = r.body.id;
  assert.equal((await img(huang.token, '/api/reports/R-1/shots', png(1024 * 1024 + 1))).status, 400, '超過 1 MB 擋');
  assert.equal((await img(huang.token, '/api/reports/R-1/shots', new Uint8Array([1, 2, 3]))).status, 400, '不是圖片擋');
  await img(huang.token, '/api/reports/R-1/shots', png(5)); await img(huang.token, '/api/reports/R-1/shots', png(6));
  assert.equal((await img(huang.token, '/api/reports/R-1/shots', png(7))).status, 400, '最多 3 張');

  // 平台團隊看清單、整理
  r = await call(liu.token, '/api/reports');
  assert.equal(r.body.open, 1);
  const rep1 = r.body.items[0];
  assert.equal(rep1.reporter.name, '黃紹軒'); assert.equal(rep1.reporterProject.name, '銀行系統');
  assert.deepEqual(Object.keys(rep1.context).sort(), ['device', 'errorCode', 'page', 'version'], '只留認得的自動資料');
  assert.equal(rep1.shots.length, 3);
  const sr = await app(new Request(`${BASE}/api/reports/R-1/shots/${shot}`, { headers: { Authorization: `Bearer ${liu.token}` } }), BASE);
  assert.equal(sr.status, 200); assert.equal(sr.headers.get('content-type'), 'image/png');
  assert.equal((await call(liu.token, '/api/reports/R-1', 'PATCH', { severity: '超級' })).status, 400);
  r = await call(liu.token, '/api/reports/R-1', 'PATCH', { severity: '嚴重' });
  assert.equal(r.body.severity, '嚴重');
  // 轉工作卡：卡完成時回報顯示已修好
  const card = (await call(liu.token, '/api/cards', 'POST', { requestId: 'c1', project: '平台', title: '修 R-1' })).body;
  r = await call(liu.token, '/api/reports/R-1', 'PATCH', { cardId: card.cardId });
  assert.equal(r.body.status, '已轉工作卡'); assert.equal(r.body.cardId, card.cardId);
  await call(liu.token, `/api/cards/${card.cardId}`, 'PATCH', { status: '已完成', version: card.version });
  assert.equal((await call(liu.token, '/api/reports/R-1')).body.status, '已修好', '工作卡完成＝已修好');
  // 合併、先不處理
  const r2 = (await call(huang.token, '/api/reports', 'POST', { title: '送出沒反應（同一件）' })).body;
  r = await call(liu.token, `/api/reports/${r2.reportId}`, 'PATCH', { mergedInto: 'R-1' });
  assert.equal(r.body.status, '已合併'); assert.equal(r.body.mergedInto, 'R-1');
  assert.equal((await call(liu.token, `/api/reports/${r2.reportId}`, 'PATCH', { mergedInto: r2.reportId })).status, 400, '不能合併到自己');
  r = await call(liu.token, `/api/reports/${r2.reportId}`, 'PATCH', { status: '先不處理', note: '重複' });
  assert.equal(r.body.status, '先不處理');

  // 許願池：所有人看得到、+1 不重複、專案名只給同專案的人
  let w = await call(huang.token, '/api/wishes', 'POST', { title: '卡片到期前提醒我', why: '常忘記', project: '銀行系統' });
  assert.equal(w.status, 201); assert.equal(w.body.votes, 1); assert.equal(w.body.voted, true, '許願的人自動 +1');
  const W1 = w.body.wishId;
  r = await call(po.token, '/api/wishes');
  assert.equal(r.body.items[0].project, null, '不在銀行系統的人看不到許願人的專案');
  assert.equal((await call(huang.token, '/api/wishes')).body.items[0].project.name, '銀行系統');
  assert.equal((await call(liu.token, `/api/wishes/${W1}/vote`, 'POST')).body.votes, 2);
  assert.equal((await call(liu.token, `/api/wishes/${W1}/vote`, 'POST')).body.votes, 2, '重複 +1 不算');
  assert.equal((await call(liu.token, `/api/wishes/${W1}/vote`, 'DELETE')).body.votes, 1, '取消 +1');
  await call(liu.token, `/api/wishes/${W1}/vote`, 'POST');
  // 狀態：只有平台團隊能改；排入要帶卡；卡完成＝已上線；先不做要原因
  assert.equal((await call(huang.token, `/api/wishes/${W1}`, 'PATCH', { status: '評估中' })).status, 403);
  assert.equal((await call(liu.token, `/api/wishes/${W1}`, 'PATCH', { status: '排入' })).status, 400, '排入要帶 cardId');
  assert.equal((await call(liu.token, `/api/wishes/${W1}`, 'PATCH', { status: '先不做' })).status, 400, '先不做要寫原因');
  const card2 = (await call(liu.token, '/api/cards', 'POST', { requestId: 'c2', project: '平台', title: '到期提醒' })).body;
  r = await call(liu.token, `/api/wishes/${W1}`, 'PATCH', { status: '排入', cardId: card2.cardId });
  assert.equal(r.body.status, '排入'); assert.equal(r.body.cardId, card2.cardId);
  await call(liu.token, `/api/cards/${card2.cardId}`, 'PATCH', { status: '已完成', version: card2.version });
  assert.equal((await call(huang.token, '/api/wishes')).body.items.find(x => x.wishId === W1).status, '已上線', '工作卡完成＝已上線');
  assert.equal((await call(huang.token, '/api/wishes')).body.canEdit, false);

  // 每天彙整：9 點後一天一次，叫醒 PO；當天第二次不發
  // 每人每天 20 則（回報＋許願）：已經 2 則回報＋1 個願望
  for (let i = 0; i < 17; i++) await call(huang.token, '/api/wishes', 'POST', { title: `願望 ${i}` });
  assert.equal((await call(huang.token, '/api/wishes', 'POST', { title: '第 21 則' })).status, 429, '每天最多 20 則');
  assert.equal((await call(huang.token, '/api/reports', 'POST', { title: '第 21 則' })).status, 429);

  // 每天彙整：台北 9 點後一天一次，叫醒 PO；當天第二次、隔天 9 點前都不發（用固定的未來日期）
  const at10 = Date.parse('2030-01-02T02:00:00Z'); // 台北 10:00
  await db.run("DELETE FROM app_settings WHERE key = 'wish_digest'");
  await db.run('UPDATE wishes SET created_at = ?', '2030-01-01T12:00:00.000Z');
  assert.equal(await app.wishDigest(at10), 18, '彙整 18 個新願望');
  assert.ok((await call(po.token, '/api/notifications?status=pending&limit=50')).body.items.some(x => /許願彙整/.test(x.preview)), 'PO 收到彙整');
  assert.equal(await app.wishDigest(at10 + 3600_000), 0, '同一天不重發');
  assert.equal(await app.wishDigest(Date.parse('2030-01-02T23:00:00Z')), 0, '隔天 7 點還沒到 9 點不發');

  // 截圖 30 天後排程清掉
  await db.run('UPDATE report_shots SET created_at = ?', Date.now() - 31 * 86400_000);
  assert.equal((await app.runScheduled()).shotsCleaned, 3, '30 天的截圖刪掉');
  assert.equal((await call(liu.token, '/api/reports/R-1')).body.shots.length, 0);
  console.log('feedback-test：全部通過');
} catch (e) {
  console.error('feedback-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
