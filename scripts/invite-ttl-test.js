// C-308 重現測試：邀請連結有效時間可選（15 分鐘／1 小時／24 小時預設／7 天），照舊只能用一次
// 修正前：一律 15 分鐘，對方隔天才看信就過期（昱志 10/19 第 2628 則）
// 用法：node scripts/invite-ttl-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-invttl-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0', authFailLimit: '1000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const H = 3_600_000;
const left = iv => Date.parse(iv.expiresAt) - Date.now();
const tokenOf = url => url.split('/invite/')[1];

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const mk = async (name, ttl) => call(liu.token, '/api/invites', 'POST', { name, projects: ['平台'], ...(ttl ? { ttl } : {}) });

  // 預設 24 小時；四種都能選；亂填擋下
  let r = await mk('甲');
  assert.equal(r.status, 201);
  assert.ok(left(r.body.invite) > 23.9 * H && left(r.body.invite) <= 24 * H, '預設 24 小時（修正前 15 分鐘）');
  assert.equal(r.body.invite.ttl, '24h');
  for (const [ttl, ms] of [['15m', 0.25 * H], ['1h', H], ['7d', 168 * H]]) {
    const x = (await mk('乙' + ttl, ttl)).body.invite;
    assert.ok(left(x) > ms - 60_000 && left(x) <= ms, `${ttl} 有效時間正確`);
    assert.equal(x.ttl, ttl);
  }
  assert.equal((await mk('丙', '30d')).status, 400, '只能選這四種');

  // 重新產生：沒帶就沿用原本的有效時間；帶了就換
  const week = (await call(liu.token, '/api/invites')).body.items.find(i => i.name === '乙7d');
  r = await call(liu.token, `/api/invites/${week.id}/regenerate`, 'POST');
  assert.equal(r.body.invite.ttl, '7d', '重發沿用 7 天');
  r = await call(liu.token, `/api/invites/${week.id}/regenerate`, 'POST', { ttl: '1h' });
  assert.equal(r.body.invite.ttl, '1h', '重發可以改成 1 小時');

  // 只能用一次；清單看得到誰用掉
  const a = await mk('丁', '7d');
  assert.equal((await call(null, '/api/auth/invite/peek', 'POST', { token: tokenOf(a.body.url) })).body.valid, true);
  assert.equal((await call(null, '/api/auth/invite', 'POST', { token: tokenOf(a.body.url), name: '丁' })).status < 300, true, '第一次用得了');
  assert.ok((await call(null, '/api/auth/invite', 'POST', { token: tokenOf(a.body.url), name: '丁2' })).status >= 400, '第二次不行');
  const used = (await call(liu.token, '/api/invites')).body.items.find(i => i.name === '丁');
  assert.equal(used.status, '已使用'); assert.equal(used.usedByName, '丁', '看得到誰用掉');

  // 作廢、過期 → 打開時無效（畫面請對方找管理員重發）
  const b = await mk('戊', '7d');
  await call(liu.token, `/api/invites/${b.body.invite.id}/cancel`, 'POST');
  let peek = (await call(null, '/api/auth/invite/peek', 'POST', { token: tokenOf(b.body.url) })).body;
  assert.equal(peek.valid, false, '作廢後失效'); assert.equal(peek.adminName, '劉昱志', '畫面寫得出找誰重發');
  const c = await mk('己', '1h');
  await db.run('UPDATE invites SET expires_at = ? WHERE id = ?', Date.now() - 1, c.body.invite.id);
  assert.equal((await call(null, '/api/auth/invite/peek', 'POST', { token: tokenOf(c.body.url) })).body.valid, false, '過期失效');

  // 重設登入也能選；預設 24 小時
  const dId = (await call(liu.token, '/api/participants')).body.items.find(p => p.name === '丁').participantId;
  r = await call(liu.token, `/api/participants/${dId}/reset-login`, 'POST', { ttl: '15m' });
  assert.equal(r.body.invite.ttl, '15m', '重設登入可選');
  r = await call(liu.token, `/api/participants/${dId}/reset-login`, 'POST');
  assert.equal(r.body.invite.ttl, '24h', '重設登入預設 24 小時');

  // 網頁：選項、7 天提示、作廢字樣、失效頁寫清楚
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /\['15m', '15 分鐘'\], \['1h', '1 小時'\], \['24h', '24 小時'\], \['7d', '7 天'\]/, '四個選項');
  assert.match(js, /時間越長、外流風險越大，用完或不需要就作廢/, '7 天提示');
  assert.match(js, /已過期或已作廢[^<]*請找/, '失效頁請對方找管理員重發');
  console.log('invite-ttl-test：全部通過');
} catch (e) {
  console.error('invite-ttl-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
