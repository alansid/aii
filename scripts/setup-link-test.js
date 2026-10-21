// C-309 重現測試：短版接入每個 AI 存自己的 .aigile/<代號>/setup.md，不再共用檔名
// 修正前：一律存 .aigile/setup.md；投信同資料夾的 PG 讀到 BA 留下的舊檔（含 BA 的 Token），身分錯（昱志 10/19 15:28）
// 用法：node scripts/setup-link-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-setup-link-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
const raw = (p, method = 'GET', token, body) => app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
const call = async (token, p, method = 'GET', body) => { const r = await raw(p, method, token, body); return { status: r.status, body: await r.json().catch(() => ({})) }; };

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const mk = (roleKey, name) => call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey, role: roleKey, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }).then(r => r.body);
  const ba = await mk('BA', '投信需求分析'), pg = await mk('PG', '投信程式開發');

  // 各自的資料夾
  const lba = (await call(liu.token, `/api/my-ais/${ba.participantId}/onboarding-link`, 'POST', {})).body;
  const lpg = (await call(liu.token, `/api/my-ais/${pg.participantId}/onboarding-link`, 'POST', {})).body;
  // 10/20 起代號＝角色_短代碼（同一個人兩個 PG 不會共用 .aigile/PG/）
  assert.match(lba.agent, /^BA_[A-Z0-9]{4}$/, 'BA 存 .aigile/BA_xxxx/（修正前沒有，網頁只好用共用檔名）');
  assert.match(lpg.agent, /^PG_[A-Z0-9]{4}$/, 'PG 存 .aigile/PG_xxxx/');

  // 下載下來的設定：開頭有身分核對、接完刪 setup.md
  const text = async url => (await raw(url.replace('http://localhost', ''))).text();
  const tBa = await text(lba.url), tPg = await text(lpg.url);
  assert.match(tBa.slice(0, 400), /這份設定是給「投信需求分析」/, 'BA 的設定開頭寫明是給 BA');
  assert.match(tPg.slice(0, 400), /這份設定是給「投信程式開發」/, 'PG 的設定開頭寫明是給 PG');
  assert.match(tPg, /名字不是這個，就是讀到別的 AI 的檔：停下來/, '身分不符就停');
  assert.ok(tPg.includes(`.aigile/${lpg.agent}/setup.md 含 Token，存好 .token 後就刪掉`), '接完刪掉 setup.md');
  // 連結只能讀一次（照舊）
  assert.equal((await raw(lpg.url.replace('http://localhost', ''))).status, 410, '連結只能讀一次');

  // 網頁短版文字：存到自己的資料夾、一定要下載覆蓋、核對身分、接完刪掉
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  // C-352：短版文字搬到 shortOnboardingText（按鈕呼叫它）
  assert.match(js.slice(js.indexOf("b.dataset.act === 'short'"), js.indexOf("b.dataset.act === 'token'")), /shortOnboardingText\(ai, r\)/);
  const i0 = js.indexOf('function shortOnboardingText'), short = js.slice(i0, js.indexOf('\n  }\n', i0));
  assert.ok(!short.includes('.aigile/setup.md'), '不再用共用的 .aigile/setup.md');
  assert.match(short, /const dir = `\.aigile\/\$\{r\.agent \|\| 'AI'\}`/, '用伺服器給的代號資料夾');
  assert.match(short, /一定要執行，會覆蓋舊檔；「只能下載一次」說的是這個連結/, '寫清楚一定要下載、會覆蓋');
  assert.match(short, /開頭寫的身分必須是「\$\{ai\.name\}」，不是就停下來/, '核對身分');
  assert.match(short, /然後刪掉 \$\{dir\}\/setup\.md/, '接完刪掉');
  console.log('setup-link-test：全部通過');
} catch (e) {
  console.error('setup-link-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
