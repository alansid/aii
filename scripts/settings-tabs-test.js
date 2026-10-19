// C-305 驗收測試（真的瀏覽器）：個人設定分四頁
// 外觀／個人資料／我的專案／帳號與登入；電腦左邊、手機上方可滑；彈窗高度固定；記住上次分頁；
// 有沒存的修改換頁先問；上下鍵切換、讀螢幕唸「分頁 N／4」
// 需要本機有 Chrome 或 Edge；找不到就略過。用法：node scripts/settings-tabs-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('settings-tabs-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('settings');
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  await kit.call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: '程式開發', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' });
  const { js, login, key, cdp } = await kit.browser();
  await login(liu.token);

  const open = async () => {
    await js("document.querySelector('.topbar .av-btn').click(); true");
    await until(() => js("!!document.querySelector('#av-menu [data-av=\"settings\"]')"), 5000, '頭像選單');
    await js("document.querySelector('#av-menu [data-av=\"settings\"]').click(); true");
    await until(() => js("!!document.querySelector('.modal.set-modal [role=tab]')"), 5000, '個人設定');
    await sleep(150);
  };
  const close = () => js("document.querySelector('.modal.set-modal .modal-x').click(); true");
  const st = () => js(`(() => {
    const tabs = [...document.querySelectorAll('.set-modal [role=tab]')];
    const vis = [...document.querySelectorAll('.set-modal .set-pane')].filter(p => !p.hidden);
    return { n: tabs.length, labels: tabs.map(t => t.getAttribute('aria-label')), sel: tabs.filter(t => t.getAttribute('aria-selected') === 'true').map(t => t.dataset.setTab),
      focus: document.activeElement?.dataset?.setTab || null, vis: vis.map(p => p.id), h: Math.round(document.querySelector('.set-modal .modal-body').getBoundingClientRect().height),
      dir: getComputedStyle(document.querySelector('.set-tabs')).flexDirection, confirm: !!document.querySelector('.confirm-root .overlay') };
  })()`);

  await js("localStorage.removeItem('aigile-switch-set-tab'); true");
  await open();
  let s = await st();
  assert.equal(s.n, 4, '四個分頁');
  assert.deepEqual(s.labels, ['外觀，分頁 1／4', '個人資料，分頁 2／4', '我的專案，分頁 3／4', '帳號與登入，分頁 4／4'], '讀螢幕唸分頁 N／4');
  assert.deepEqual(s.sel, ['look'], '第一次開在外觀'); assert.deepEqual(s.vis, ['sp-look'], '只顯示一頁');
  assert.equal(s.focus, 'look', '焦點在目前分頁');
  assert.equal(s.dir, 'column', '電腦：分頁在左邊直排');
  // 每頁放對東西
  const has = (pane, sels) => js(`${JSON.stringify(sels)}.every(q => document.querySelector('#${pane} ' + q))`);
  assert.ok(await has('sp-look', ['[data-theme-opt]', '[data-style-opt]', '#set-mine']), '外觀：外觀、風格、只顯示與我相關');
  assert.ok(await has('sp-me', ['[data-change-avatar]', '[data-set-av="ask"]', '[data-set-av="revert"]']), '個人資料：頭像三顆按鈕');
  assert.ok(await has('sp-proj', ['.proj-rows', '#my-roles [data-myrole]', '#my-roles-save']), '我的專案：所屬專案、我的角色');
  assert.ok(await has('sp-acct', ['#pwd-set', '[data-set-open="devices"]', '[data-set-open="api"]', '#set-leave']), '帳號與登入：帳號密碼、裝置、API、離開群組');
  assert.ok(await js("(() => { const p = document.querySelector('#sp-acct'); const k = [...p.children]; return k[k.length - 1].classList.contains('danger-zone'); })()"), '離開群組在最下面');

  // 鍵盤：下、上、End、Home；高度固定
  const h0 = s.h;
  await key('ArrowDown'); s = await st();
  assert.deepEqual(s.sel, ['me'], '↓ 到個人資料'); assert.equal(s.focus, 'me', '焦點跟著移'); assert.deepEqual(s.vis, ['sp-me']);
  await key('ArrowUp'); assert.deepEqual((await st()).sel, ['look'], '↑ 回外觀');
  await key('End'); s = await st(); assert.deepEqual(s.sel, ['acct'], 'End 到最後一頁');
  assert.equal(s.h, h0, `彈窗高度固定（${h0} vs ${s.h}）`);
  await key('ArrowDown'); assert.deepEqual((await st()).sel, ['look'], '最後一頁再 ↓ 回到第一頁');
  await key('ArrowUp'); assert.deepEqual((await st()).sel, ['acct']);

  // 記住上次分頁
  await close(); await open();
  assert.deepEqual((await st()).sel, ['acct'], '再開時停在上次的分頁');

  // 有沒存的修改（角色）換頁先問
  await js("document.querySelector('#st-proj').click(); true"); await sleep(100);
  const changed = await js(`(() => { const sel = document.querySelector('#my-roles [data-myrole]'); const o = [...sel.options].find(o => o.value && !o.value.startsWith('__') && o.value !== sel.value); sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return o.value; })()`);
  assert.ok(changed, '改了角色');
  await sleep(100);
  await js("document.querySelector('#st-look').click(); true");
  await until(() => js("!!document.querySelector('.confirm-root [data-close]')"), 5000, '換頁前詢問');
  assert.match(await js("document.querySelector('.confirm-root').textContent"), /要先儲存嗎/);
  await js("document.querySelector('.confirm-root [data-close]').click(); true"); await sleep(150);
  s = await st(); assert.deepEqual(s.sel, ['proj'], '選「留下來儲存」就留在原頁'); assert.equal(s.confirm, false);
  await js("document.querySelector('#st-look').click(); true");
  await until(() => js("!!document.querySelector('.confirm-root [data-ok]')"), 5000, '再問一次');
  await js("document.querySelector('.confirm-root [data-ok]').click(); true"); await sleep(150);
  assert.deepEqual((await st()).sel, ['look'], '選「不儲存，換頁」就換頁');
  assert.notEqual(await js("document.querySelector('#my-roles [data-myrole]').value"), changed, '沒存的角色修改丟掉');
  // 沒改東西換頁不問
  await js("document.querySelector('#st-proj').click(); true"); await sleep(100);
  await js("document.querySelector('#st-acct').click(); true"); await sleep(200);
  s = await st(); assert.equal(s.confirm, false, '沒改不問'); assert.deepEqual(s.sel, ['acct']);
  // 帳號密碼填了一半也算
  await until(() => js("!document.querySelector('#pwd-set-form').hidden"), 5000, '帳號密碼表單');
  await js("const f = document.querySelector('#pwd-set-form'); f.newPassword.value = 'abc12345'; true");
  await js("document.querySelector('#st-me').click(); true");
  await until(() => js("!!document.querySelector('.confirm-root [data-ok]')"), 5000, '密碼沒存也要問');
  await js("document.querySelector('.confirm-root [data-ok]').click(); true"); await sleep(150);
  assert.equal(await js("document.querySelector('#pwd-set-form').newPassword.value"), '', '丟掉沒存的密碼');

  // 手機：分頁在上方、可左右滑；左右鍵也能切
  await close();
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  await js("document.querySelector('.m-av').click(); true");
  await until(() => js("!!document.querySelector('#av-menu [data-av=\"settings\"]')"), 5000, '手機頭像選單');
  await js("document.querySelector('#av-menu [data-av=\"settings\"]').click(); true");
  await until(() => js("!!document.querySelector('.modal.set-modal [role=tab]')"), 5000, '手機個人設定');
  await sleep(150);
  s = await st();
  assert.equal(s.dir, 'row', '手機：分頁在上方橫排');
  assert.ok(await js("(() => { const t = document.querySelector('.set-tabs'); return getComputedStyle(t).overflowX === 'auto'; })()"), '手機：分頁列可左右滑');
  assert.ok(await js("document.querySelector('.set-modal').getBoundingClientRect().width <= 390"), '手機：彈窗不超出畫面');
  assert.deepEqual(s.sel, ['me'], '手機也記得上次分頁（剛才停在個人資料）');
  await key('ArrowRight'); assert.deepEqual((await st()).sel, ['proj'], '→ 切下一頁');
  console.log('settings-tabs-test：全部通過');
} catch (e) {
  console.error('settings-tabs-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
