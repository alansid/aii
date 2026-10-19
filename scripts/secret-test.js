// C-301 重現測試：接入連結與 Token 不能貼進群組、卡片、私訊
// 修正前：昱志 10/19 13:48 把 codex-pg-銀行 的 /api/setup/ 一次性連結整段貼進群組，伺服器照收
// 用法：node scripts/secret-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-secret-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let n = 0;
const msg = (tok, text) => call(tok, '/api/messages', 'POST', { requestId: 's' + (++n), project: '平台', text });
const blocked = (r, label) => { assert.equal(r.status, 400, label + '：要擋'); assert.equal(r.body.error.code, 'SECRET_IN_TEXT', label); assert.match(r.body.error.message, /機密/, label); };

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: '程式開發', name: 'codex-pg', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiTok = db && (await db.get('SELECT token FROM participants WHERE id = ?', ai.participantId)).token;
  const link = (await call(liu.token, `/api/my-ais/${ai.participantId}/onboarding-link`, 'POST', {})).body.url;
  assert.match(link, /\/api\/setup\//);

  // 群組：一次性連結、AI Token、人類裝置 Token 都擋
  blocked(await msg(liu.token, `下載失敗\ncurl -s --create-dirs -o .aigile/setup.md "${link}"`), '群組貼一次性連結');
  blocked(await msg(liu.token, `AIGILE_TOKEN=${aiTok}`), '群組貼 AI Token');
  blocked(await msg(liu.token, `我的 ${liu.token} 給你`), '群組貼人類 Token');
  blocked(await msg(aiTok, `Authorization: Bearer ${aiTok}`), 'AI 自己貼 Token');

  // 卡片：建卡、改卡、交接說明
  blocked(await call(liu.token, '/api/cards', 'POST', { requestId: 'c1', project: '平台', title: '接入', reason: link }), '建卡含連結');
  const card = (await call(liu.token, '/api/cards', 'POST', { requestId: 'c2', project: '平台', title: '一般卡' })).body;
  assert.ok(card.cardId, '一般卡可建');
  blocked(await call(liu.token, `/api/cards/${card.cardId}`, 'PATCH', { next: `Token ${aiTok}`, version: card.version }), '改卡含 Token');

  // 私訊
  await call(liu.token, '/api/projects/平台/dm', 'PUT', { on: true });
  blocked(await call(liu.token, '/api/dm', 'POST', { requestId: 'd1', aiId: ai.participantId, text: link }), '私訊含連結');

  // 不誤擋：一般長字串、雜湊、已失效的舊 Token 形狀
  assert.equal((await msg(liu.token, 'SHA-256 6092634df689a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234567890 對過了')).status, 201, '雜湊不擋');
  assert.equal((await msg(liu.token, 'commit 94270ee，隨機字 AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefg')).status, 201, '不是成員 Token 的亂碼不擋');
  assert.equal((await msg(liu.token, '連結格式是 /api/setup/<id>.<secret>，不要貼')).status, 201, '講到 /api/setup/ 但沒有真連結不擋');

  // 短版接入：提醒 Codex 沙盒放行網路、連不到改用完整版
  const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(appJs, /network_access/, '短版接入提到 network_access');
  assert.match(appJs, /錯誤 7/, '短版接入提到 curl 錯誤 7');
  console.log('secret-test：全部通過');
} catch (e) {
  console.error('secret-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { db.close?.(); } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
