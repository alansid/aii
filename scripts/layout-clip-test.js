// C-306 重現測試（真的瀏覽器）：左側欄不能被切掉（整頁被橫向捲走）
// 修正前：只要有東西比畫面寬，或有元素被捲到看得見，整頁就往左捲，側欄左邊（logo、「我的專案」）被切掉
//（昱志 10/19 14:41 POC 站「我的 AI」截圖：側欄只剩 242px，左邊 22px 被切）
// 也檢查「我的 AI」頁先畫出外框再載入（專案與 AI 清單同時抓）
// 需要本機有 Chrome 或 Edge；找不到就略過。用法：node scripts/layout-clip-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('layout-clip-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('layout');
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const { js, login, cdp } = await kit.browser();
  await login(liu.token);

  // 把畫面撐寬，再用各種方式往右捲；側欄要留在原地
  const shove = () => js(`(async () => {
    document.querySelectorAll('.zz-wide').forEach(e => e.remove());
    const w = document.createElement('div'); w.className = 'zz-wide'; w.style.cssText = 'flex:none;width:2600px;height:4px;background:red';
    (document.querySelector('.topbar') || document.querySelector('.mobile-top')).append(w);
    w.scrollIntoView({ inline: 'end', block: 'nearest' });
    document.documentElement.scrollLeft = 80; document.body.scrollLeft = 80; window.scrollTo(80, 0);
    const app = document.querySelector('.app'); if (app) app.scrollLeft = 80;
    const sb = document.querySelector('.sidebar'); if (sb) sb.scrollLeft = 80;
    await new Promise(r => setTimeout(r, 400));
    const box = el => el && el.offsetParent !== null ? Math.round(el.getBoundingClientRect().left) : null;
    const out = { sidebar: box(document.querySelector('.sidebar')), head: box(document.querySelector('.sidebar .side-head, .sidebar .proj-switch')), mtop: box(document.querySelector('.mobile-top')),
      sx: window.scrollX, app: app?.scrollLeft || 0, sbs: document.querySelector('.sidebar')?.scrollLeft || 0 };
    w.remove();
    return out;
  })()`);
  const desk = async where => {
    const r = await shove();
    assert.equal(r.sidebar, 0, `${where}：側欄要貼齊左邊（被捲走 ${-r.sidebar}px）`);
    assert.ok(r.head >= 0, `${where}：側欄內容不能被切（${r.head}）`);
    assert.equal(r.sx + r.app + r.sbs, 0, `${where}：整頁、外框、側欄都不能橫向捲動（${r.sx}/${r.app}/${r.sbs}）`);
  };

  await desk('總覽');
  await kit.call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: '程式開發', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' });
  // 我的 AI：先有外框（載入中），再出現清單
  await js("document.querySelector('.topbar .av-btn').click(); true");
  await until(() => js("!!document.querySelector('#av-menu [data-av=\"myai\"]')"), 5000, '頭像選單');
  await js("document.querySelector('#av-menu [data-av=\"myai\"]').click(); true");
  await until(() => js("!!document.querySelector('#myai-pane #ai-list')"), 5000, '我的 AI 外框');
  await until(() => js("/程式助手/.test(document.querySelector('#ai-list').textContent)"), 10000, '我的 AI 清單');
  await desk('我的 AI');
  await js("history.pushState(null, '', '/p/platform/messages'); dispatchEvent(new PopStateEvent('popstate')); true");
  await sleep(800);
  await desk('專案內');

  // 手機：頂部列不能被往左推
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  const m = await shove();
  assert.equal(m.mtop, 0, `手機：頂部列要貼齊左邊（${m.mtop}）`);
  assert.equal(m.sx + m.app, 0, `手機：整頁不能橫向捲動（${m.sx}/${m.app}）`);
  console.log('layout-clip-test：全部通過');
} catch (e) {
  console.error('layout-clip-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
