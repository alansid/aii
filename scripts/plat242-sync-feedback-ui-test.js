// PLAT-242 畫面測試（真的瀏覽器，手機寬 375px）：技能同步按下去要有回饋
// 昱志 10/24：按「全部同步（3 隻）」三隻都離線，按鈕跟頂部都沒變，像沒按到；其中一隻 Token 過期也沒說
// 1. 按下去按鈕立刻「叫醒中…」停用，送完頂部寫「已通知 N 隻：…」
// 2. 都通知過（含離線）→ 按鈕「已通知 N 隻（等上線）」停用；離線的不算「要同步」（我的 AI 頁上方那條也不算）
// 3. Token 過期：該列「Token 已過期，重發後才會同步」＋重發入口；不算進「已通知」
// UX 補充：離線那列寫通知時間「離線 · 已通知 14:59，上線後自動裝」；上方那條不直接消失，灰色寫「N 隻已通知，等上線」，全部裝好才消失
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/plat242-sync-feedback-ui-test.js
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('plat242-sync-feedback-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('p242');
const SETUP_SHA = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(new URL('../public/aigile-setup.mjs', import.meta.url)))).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const mk = async name => { const a = (await kit.call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; assert.ok(a.participantId, JSON.stringify(a)); return { id: a.participantId, tok: kit.aiToken(a.participantId) }; };
  // PG三號的 Token 過期（先建、先改；後面再建 AI 時平台會重讀成員表）
  const pg3 = await mk('PG三號');
  kit.sql('UPDATE participants SET token_expires_at = ? WHERE id = ?', Date.now() - 60_000, pg3.id);
  const pg1 = await mk('PG一號'), pg2 = await mk('PG二號');
  await fetch(kit.BASE + '/api/notifications/count', { headers: { Authorization: 'Bearer ' + pg1.tok, 'X-Aigile-Source': 'watcher' } }); // PG 一號待命中；二號離線
  const up = await kit.call(liu.token, '/api/projects/%E5%B9%B3%E5%8F%B0/skills', 'POST', { files: [{ path: 'SKILL.md', text: '---\nname: pg-rules\ndescription: PG 規則\n---\n規則\n' }], roles: ['PG'] });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const view = (await kit.call(liu.token, '/api/skill-sync')).body.items;
  assert.equal(view.find(a => a.aiId === pg3.id).tokenExpired, true, 'API 標出 Token 過期');
  assert.equal(view.find(a => a.aiId === pg1.id).tokenExpired, false);

  const { js, login } = await kit.browser(375, 800);
  await login(liu.token, '/my-ai');
  // 上方那條：Token 過期的不算「要同步」
  await until(() => js("(document.querySelector('#ma-sync')?.textContent || '').includes('2 隻 AI 有技能要同步')"), 10000, '同步提示只算 2 隻');
  // 讓「全部同步」的送出慢一點，才看得到「叫醒中…」
  await js(`(() => { const of = window.fetch; window.fetch = (u, o) => String(u).includes('/api/skill-sync') && o && o.method === 'POST' ? new Promise(r => setTimeout(r, 1500)).then(() => of(u, o)) : of(u, o); return true; })()`);
  await js("document.querySelector('[data-sy-banner]').click(); true");
  // 1. 按下去立刻「叫醒中…」停用
  await until(() => js("(() => { const b = document.querySelector('.sy-top [data-sy-all]'); return !!b && b.disabled && b.textContent.includes('叫醒中'); })()"), 3000, '叫醒中…');
  // 送完頂部寫結果
  const top = () => js("document.querySelector('.sy-sum')?.textContent || ''");
  await until(async () => (await top()).includes('已通知 2 隻：1 隻叫醒中、1 隻離線（上線後自動補）'), 8000, '頂部寫結果');
  // 2. 都通知過 → 按鈕「已通知 2 隻（等上線）」停用，不再寫「要同步」
  assert.equal(await js("(() => { const b = document.querySelector('[data-sy-wait]'); return !!b && b.disabled && b.textContent; })()"), '已通知 2 隻（等上線）');
  assert.equal(await js("!!document.querySelector('[data-sy-all]')"), false, '沒有「全部同步」');
  assert.equal((await top()).includes('要同步'), false, '離線的不算要同步：' + await top());
  // 3. Token 過期的：該列寫明＋重發入口；頂部另外寫、不算進已通知
  const row = id => js(`document.querySelector('[data-sy="${id}"] .sy-st')?.textContent.trim() || ''`);
  assert.match(await row(pg3.id), /^Token 已過期，重發後才會同步/);
  assert.equal(await js(`!!document.querySelector('[data-sy-reissue="${pg3.id}"]')`), true, '有重發入口');
  assert.match(await top(), /1 隻 Token 已過期/);
  assert.match(await row(pg2.id), /^離線 · 已通知 \d{2}:\d{2}，上線後自動裝$/, '離線那列寫通知時間：' + await row(pg2.id));
  // AI 開始跑 → 頂部跟著變，按鈕仍是已通知
  await kit.call(pg1.tok, '/api/me/skills/sync-status', 'POST', { state: 'running', tool: 'claude' });
  await until(async () => (await top()).includes('已通知 2 隻：1 隻同步中、1 隻離線（上線後自動補）'), 10000, '同步中');
  assert.equal(await js("document.querySelector('[data-sy-wait]')?.textContent"), '已通知 2 隻（等上線）');
  // 手機 375px：沒有橫向捲動、按鈕沒被擠出畫面
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth + 1'), true, '沒有橫向捲動');
  assert.equal(await js("(() => { const r = document.querySelector('[data-sy-wait]').getBoundingClientRect(); return r.right <= innerWidth && r.left >= 0; })()"), true, '按鈕在畫面內');
  assert.equal(await js(`(() => { const r = document.querySelector('[data-sy-reissue="${pg3.id}"]').getBoundingClientRect(); return r.right <= innerWidth && r.width > 0; })()`), true, '重發入口在畫面內');

  // 關掉清單：上方那條不再寫「要同步」，改「2 隻已通知，等上線」＋Token 過期（有看清單）
  await js("document.querySelector('#modal-root [data-close]')?.click(); true");
  const bar = () => js("document.querySelector('#ma-sync')?.textContent || ''");
  await until(async () => (await bar()).includes('2 隻已通知，等上線') && (await bar()).includes('1 隻 AI 的 Token 已過期'), 10000, '上方寫已通知、Token 過期：' + await bar());
  assert.equal((await bar()).includes('要同步'), false);
  // 只剩等上線（Token 過期那隻先停用）→ 灰色、沒有按鈕；全部裝好才消失
  await kit.call(liu.token, `/api/my-ais/${pg3.id}/disable`, 'POST');
  await js("location.reload(); true");
  await until(() => js("(document.querySelector('#ma-sync .sy-banner.wait')?.textContent || '').includes('2 隻已通知，等上線')"), 10000, '灰色已通知');
  assert.equal(await js("!!document.querySelector('#ma-sync button')"), false, '等上線沒有按鈕');
  const sk = (await kit.call(pg1.tok, '/api/me/skills')).body.items.map(x => x.skillId);
  for (const a of [pg1, pg2]) await kit.call(a.tok, '/api/me/skills/installed', 'POST', { skillIds: sk, places: Object.fromEntries(sk.map(x => [x, 'own'])), tool: 'claude', setupSha: SETUP_SHA });
  await js("location.reload(); true");
  await until(() => js("!!document.querySelector('#ai-new')"), 10000, '我的 AI 頁');
  await sleep(1500);
  assert.equal(await bar(), '', '全部裝好才消失：' + await bar());
  await kit.call(liu.token, `/api/my-ais/${pg3.id}/enable`, 'POST');
  await js("location.reload(); true");
  await until(async () => (await bar()).includes('1 隻 AI 的 Token 已過期'), 10000, '重新啟用後又提醒 Token 過期');

  // 重發入口：確認後重發，Token 不再過期
  await js("document.querySelector('[data-sy-banner]').click(); true");
  await until(() => js(`!!document.querySelector('[data-sy-reissue="${pg3.id}"]')`), 8000, '清單');
  await js(`document.querySelector('[data-sy-reissue="${pg3.id}"]').click(); true`);
  await until(() => js("!!document.querySelector('.confirm-root [data-ok]')"), 5000, '確認重發');
  await js("document.querySelector('.confirm-root [data-ok]').click(); true");
  await until(async () => (await kit.call(liu.token, '/api/skill-sync')).body.items.find(a => a.aiId === pg3.id).tokenExpired === false, 8000, '重發後 Token 有效');
  await sleep(300);
  console.log('plat242-sync-feedback-ui-test：全部通過');
} catch (e) {
  console.error('plat242-sync-feedback-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
