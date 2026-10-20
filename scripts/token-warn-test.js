// C-321 驗收測試：團隊狀態「Token 快到期」改成到期前 24 小時（可用設定覆寫）
// 修正前：門檻寫死 2 小時，剩 23 小時（甚至 4.5 小時）都顯示沒事，常在半夜過期沒人看到
// 用法：node scripts/token-warn-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-tokenwarn-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const mk = extra => createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0', ...extra } });
const call = async (app, token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const H = 3_600_000;

try {
  const app = mk({});
  const liu = (await call(app, null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const ai = async (name, left) => {
    const a = (await call(app, liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    await db.run('UPDATE participants SET token_expires_at = ? WHERE id = ?', Date.now() + left, a.participantId);
    return a.participantId;
  };
  const a23 = await ai('剩23小時', 23 * H), a25 = await ai('剩25小時', 25 * H), a4 = await ai('剩4小時半', 4.5 * H), gone = await ai('已過期', -H);
  const st = async (appX, id) => (await call(appX, liu.token, '/api/team-status')).body.members.find(m => m.participantId === id);

  let m = await st(app, a23);
  assert.equal(m.tokenExpiringSoon, true, '剩 23 小時 → 快到期');
  assert.equal((await st(app, a4)).tokenExpiringSoon, true, '剩 4.5 小時 → 快到期（UX 10/20 回報的情況）');
  m = await st(app, a25);
  assert.equal(m.tokenExpiringSoon, false, '剩 25 小時 → 還不用提醒');
  m = await st(app, gone);
  assert.deepEqual([m.tokenExpired, m.tokenExpiringSoon], [true, false], '已過期照舊是「已過期」（紅），不算快到期');

  // 設定覆寫：TOKEN_WARN_HOURS=2 時，剩 23 小時不提醒
  const two = mk({ tokenWarnHours: '2' });
  assert.equal((await st(two, a23)).tokenExpiringSoon, false, '設定成 2 小時 → 23 小時不提醒');
  assert.equal((await call(app, liu.token, '/api/team-status')).body.tokenWarnHours, 24, '回傳目前門檻（網頁說明用）');

  // 兩種部署都接得到設定；規格寫明門檻
  for (const f of ['../server.js', '../worker.js']) assert.match(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), /tokenWarnHours: (process\.)?env\.TOKEN_WARN_HOURS/, f + ' 接 TOKEN_WARN_HOURS');
  assert.match(fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8'), /到期前 24 小時[^\n]{0,20}Token 快到期/, '規格寫明 24 小時');
  console.log('token-warn-test：全部通過');
} catch (e) {
  console.error('token-warn-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
