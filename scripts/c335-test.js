// C-335 驗收測試（Fable 健檢 S1、S2、S3、S5、S9）：登入憑證收緊
//   S1 不收網址 ?token=；S2 讀登入碼留安全通知；S3 配對碼猜錯 5 次全部作廢（記在 DB，多份程式共用）
//   S5 公開端點不回管理員姓名；S9 回報、許願擋 Token
// 用法：node scripts/c335-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-c335-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
// 記憶體限流放寬，才測得到 DB 那一層；A、B 兩份程式共用同一個資料庫
const mk = () => createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', authFailLimit: '1000' } });
const A = mk(), B = mk();
const call = async (token, p, method = 'GET', body, app = A) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const wrongOf = code => (code === '000000' ? '000001' : '000000');

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const L = liu.participant.participantId;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiTok = (await db.get('SELECT token FROM participants WHERE id = ?', ai.participantId)).token;
  const code = (await db.get('SELECT token FROM participants WHERE id = ?', L)).token;
  const dev = (await call(null, '/api/auth/code', 'POST', { code })).body.token;
  assert.match(dev, /^dv_/, '用登入碼登入拿到裝置');

  // S1：Token 只收 Authorization 標頭
  assert.equal((await call(null, `/api/me?token=${encodeURIComponent(aiTok)}`)).status, 401, 'S1：網址帶 ?token= 不算登入');
  assert.equal((await call(aiTok, '/api/me')).status, 200, 'S1：標頭照常可用');

  // S5：公開端點不回管理員姓名
  const h = (await call(null, '/api/health')).body;
  assert.equal(h.adminName, undefined, 'S5：health 不回管理員姓名');
  assert.equal(h.setup, false);
  const peek = (await call(null, '/api/auth/invite/peek', 'POST', { token: 'no-such-invite' })).body;
  assert.deepEqual(peek, { valid: false }, 'S5：失效邀請不回管理員姓名');

  // S2：讀登入碼留安全通知（同一台 24 小時只記一次）
  assert.equal((await call(dev, '/api/me/login-code')).body.code, code);
  const notes = async () => (await call(dev, '/api/me/notices')).body.items.filter(n => n.kind === 'login_code_read');
  const n1 = await notes();
  assert.equal(n1.length, 1, 'S2：讀登入碼後本人收到安全通知');
  assert.ok(n1[0].detail, 'S2：通知寫是哪台裝置');
  await call(dev, '/api/me/login-code');
  assert.equal((await notes()).length, 1, 'S2：同一台重複讀不重複通知');
  const dev2 = (await call(null, '/api/auth/code', 'POST', { code }, B)).body.token;
  await call(dev2, '/api/me/login-code', 'GET', undefined, B);
  assert.equal((await notes()).length, 2, 'S2：換一台裝置讀再記一筆');

  // S3：配對碼猜錯 5 次（跨程式累計）→ 還沒用的配對碼全部作廢
  const pa = (await call(dev, '/api/devices/pair-code', 'POST')).body.code;
  assert.match(pa, /^\d{6}$/);
  for (let i = 0; i < 2; i++) assert.equal((await call(null, '/api/auth/pair', 'POST', { code: wrongOf(pa) }, A)).status, 400);
  for (let i = 0; i < 2; i++) assert.equal((await call(null, '/api/auth/pair', 'POST', { code: wrongOf(pa) }, B)).status, 400);
  const ok4 = await call(null, '/api/auth/pair', 'POST', { code: pa }, B);
  assert.equal(ok4.status, 200, 'S3：錯 4 次還能用：' + JSON.stringify(ok4.body));
  assert.equal((await db.get("SELECT count FROM login_fails WHERE username = '#pair'")).count, 4, 'S3：失敗次數記在 DB（兩份程式加總）');

  const pb = (await call(dev, '/api/devices/pair-code', 'POST')).body.code;
  for (let i = 0; i < 5; i++) await call(null, '/api/auth/pair', 'POST', { code: wrongOf(pb) }, i % 2 ? A : B);
  assert.equal((await call(null, '/api/auth/pair', 'POST', { code: pb })).status, 400, 'S3：全站錯滿 5 次，配對碼作廢');
  const pc = (await call(dev, '/api/devices/pair-code', 'POST')).body.code;
  assert.equal((await call(null, '/api/auth/pair', 'POST', { code: pc })).status, 200, 'S3：重新產生的配對碼可以用');
  assert.ok(!(await db.get("SELECT 1 AS x FROM login_fails WHERE username = '#pair' AND count >= 5")), 'S3：作廢後計數歸零');

  // S9：回報、許願擋 Token
  const rep = await call(dev, '/api/reports', 'POST', { title: '登入怪怪的', detail: `我的 AI Token 是 ${aiTok}` });
  assert.equal(rep.body.error?.code, 'SECRET_IN_TEXT', 'S9：回報說明含 Token 擋下');
  const wish = await call(dev, '/api/wishes', 'POST', { title: `希望 ${aiTok} 可以`, why: 'x' });
  assert.equal(wish.body.error?.code, 'SECRET_IN_TEXT', 'S9：許願含 Token 擋下');
  assert.equal((await call(dev, '/api/wishes', 'POST', { title: '一般的願望', why: '方便' })).status, 201, 'S9：一般許願照常');

  console.log('c335: all checks passed');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
