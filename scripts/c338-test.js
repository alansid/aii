// C-338 驗收測試（Fable 健檢 C4、C5、C12）
// 修正前：
//   C4 watcher、等待、接入檢查、opencode 腳本的 SHA-256 手寫在 src/core.js，改腳本忘了更新，AI 下載後核對失敗（測試事後才抓）
//   C5 23 個 cf:db:migrate-* 指令；50 多個測試沒有單一入口，容易漏跑
//   C12 規格與 README 寫「15 分鐘」標可能斷線／尚未回應，程式是 20 分鐘；README 寫邀請連結 15 分鐘，C-308 起預設 24 小時
// 用法：node scripts/c338-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { scriptHashes, HASHED_SCRIPTS } from './script-hashes.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-c338-'));
const node = (...args) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });

try {
  // C4：core.js 不再手寫雜湊；雜湊從 public/ 的實際檔案算
  assert.doesNotMatch(read('src/core.js'), /_SHA256 = '[0-9a-f]{64}'/, 'core.js 沒有手寫的 SHA-256');
  const h = scriptHashes();
  assert.deepEqual(Object.keys(h), HASHED_SCRIPTS, '四個腳本都有雜湊');
  for (const f of HASHED_SCRIPTS) assert.equal(h[f], crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'public', f))).digest('hex'), `${f} 雜湊等於檔案內容`);

  // C4：部署前 releases.mjs 產生 generated/script-hashes.json，worker.js 打包並傳給 createApp
  const g = node('scripts/releases.mjs');
  assert.equal(g.status, 0, 'releases.mjs 跑得起來：' + g.stderr);
  assert.deepEqual(JSON.parse(read('generated/script-hashes.json')), h, 'generated/script-hashes.json 跟檔案一致');
  const worker = read('worker.js');
  assert.match(worker, /import scriptHashes from '\.\/generated\/script-hashes\.json'/, 'worker.js 讀產生的雜湊');
  assert.match(worker, /^\s+scriptHashes,$/m, 'worker.js 傳給 createApp');
  assert.match(read('server.js'), /scriptHashes: scriptHashes\(\)/, '本機 server.js 現算');
  assert.match(JSON.parse(read('package.json')).scripts.deploy, /^node scripts\/releases\.mjs --deployed && /, 'npm run deploy 先跑 releases.mjs（才有最新雜湊）');

  // C4：API 回的就是傳進來的雜湊
  const db = openNodeDb(path.join(dataDir, 'switch.db'));
  const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: h, config: { openJoin: '1', rateLimitPerMin: '100000' } });
  const call = async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name: '甲助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiTok = (await db.get('SELECT token FROM participants WHERE id = ?', ai.participantId)).token;
  const wenv = (await call(aiTok, '/api/me/watcher-env')).body;
  assert.deepEqual(wenv.files, { 'watcher.mjs': h['watcher.mjs'], 'aigile-wait.mjs': h['aigile-wait.mjs'], 'aigile-opencode.mjs': h['aigile-opencode.mjs'], 'aigile-mcp.mjs': h['aigile-mcp.mjs'] }, 'watcher-env 的雜湊');

  // C5：migration 只剩一個指令；npm test 是單一入口
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.deepEqual(Object.keys(scripts).filter(k => k.startsWith('cf:db:migrate-')), [], '沒有 cf:db:migrate-* 了');
  assert.equal(scripts['cf:db:migrate'], 'node scripts/migrate.js', 'npm run cf:db:migrate -- <檔>');
  assert.equal(scripts.test, 'node scripts/run-all.js', 'npm test');
  assert.doesNotMatch(read('README.md'), /cf:db:migrate-/, 'README 不再提舊指令');
  const one = node('scripts/run-all.js', 'bell-test');
  assert.equal(one.status, 0, 'run-all 帶篩選只跑那個：' + one.stdout.slice(-300));
  assert.match(one.stdout, /✓ bell-test\.js/); assert.match(one.stdout, /1\/1 通過/);
  const none = node('scripts/run-all.js', 'no-such-test-xyz');
  assert.equal(none.status, 1, '篩不到測試算失敗（不會默默說全過）');

  // C12：文件數字跟程式一致
  const core = read('src/core.js'), spec = read('docs/ai-integration.md'), readme = read('README.md');
  const stale = Number(/STALE_MS = \(Number\(config\.staleMinutes\) \|\| (\d+)\)/.exec(core)[1]);
  const unanswered = Number(/UNANSWERED_MS = \(Number\(config\.unansweredMinutes\) \|\| (\d+)\)/.exec(core)[1]);
  assert.ok(spec.includes(`AI 超過 ${stale} 分鐘沒呼叫 API 標「可能斷線」`), `規格：可能斷線 ${stale} 分鐘`);
  assert.ok(spec.includes(`被指定超過 ${unanswered} 分鐘沒 ACK 標「尚未回應」`), `規格：尚未回應 ${unanswered} 分鐘`);
  assert.ok(readme.includes(`指派超過 ${unanswered} 分鐘未讀取`), `README：尚未回應 ${unanswered} 分鐘`);
  const inviteDefault = /INVITE_TTL_DEFAULT = '(\w+)'/.exec(read('src/login.js'))[1];
  assert.equal(inviteDefault, '24h'); assert.match(readme, /邀請連結（一次性；有效時間預設 24 小時/, 'README：邀請連結預設 24 小時');
  console.log('c338-test：全部通過');
} catch (e) {
  console.error('c338-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
