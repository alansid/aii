// C-374 畫面測試（真的瀏覽器）：手機上方列每頁同一組按鈕、同順序；375px 寬頭像不被擠出、不出現橫向捲動
// 修正前：總覽有「要你處理」、訊息有「收件匣＋私訊」、成員與權限都沒有；總覽與訊息頁太寬，頭像被切掉
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/c374-test.js（設 SHOT_DIR 會把各頁截圖存進去）
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('c374-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const SHOT = process.env.SHOT_DIR || '';
const kit = await startKit('c374');
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body; // 管理員
  // 有自己的 AI 在平台＝專案裡能私訊；再塞幾則待處理，讓徽章出現
  await kit.call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: '程式開發', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' });
  const { js, login, cdp } = await kit.browser();
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await login(liu.token);

  const KEY = `el => el.matches('.m-back') ? 'back' : el.matches('.mobile-title') ? 'title' : el.matches('[data-search-open]') ? 'search'
    : el.matches('.dm-top-btn') ? 'dm' : el.matches('#menu-btn') ? 'menu' : el.matches('.m-av') ? 'avatar' : (el.className || el.tagName)`;
  const look = () => js(`(() => {
    const key = ${KEY};
    const top = document.querySelector('.mobile-top');
    const vis = [...top.children].filter(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0);
    const av = top.querySelector('.m-av').getBoundingClientRect();
    return { keys: vis.map(key), avRight: Math.round(av.right), avLeft: Math.round(av.left), vw: innerWidth,
      sw: document.documentElement.scrollWidth, topSw: top.scrollWidth, topCw: top.clientWidth };
  })()`);
  const go = async (url, ready) => {
    await js(`history.pushState(null, '', ${JSON.stringify(url)}); dispatchEvent(new PopStateEvent('popstate')); true`);
    if (ready) await until(() => js(ready), 10000, url);
    await sleep(700);
  };
  const pages = [
    ['總覽', '/', null],
    ['訊息', '/p/platform/messages', null],
    ['收件匣', '/p/platform/inbox', null],
    ['工作', '/p/platform/work', null],
    ['成員與權限', '/members', null],
    ['我的 AI', '/my-ai', null],
  ];
  const seen = [];
  for (const [name, url, ready] of pages) {
    await go(url, ready);
    const r = await look();
    seen.push([name, r.keys.filter(k => k !== 'back').join(',')]);
    assert.ok(r.avLeft >= 0 && r.avRight <= r.vw, `${name}：頭像要整個在畫面裡（${r.avLeft}～${r.avRight}／${r.vw}）`);
    assert.ok(r.sw <= r.vw, `${name}：不能橫向捲動（內容寬 ${r.sw}／${r.vw}）`);
    assert.ok(r.topSw <= r.topCw, `${name}：上方列不能超出（${r.topSw}／${r.topCw}）`);
    if (SHOT) {
      const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 375, height: 300, scale: 1 } });
      fs.mkdirSync(SHOT, { recursive: true });
      fs.writeFileSync(path.join(SHOT, `c374-mobile-${pages.findIndex(p => p[1] === url)}.png`), Buffer.from(shot.result.data, 'base64'));
    }
  }
  const want = 'title,search,dm,menu,avatar';
  for (const [name, keys] of seen) assert.equal(keys, want, `${name}：上方列要是同一組同順序（${keys}）`);

  // 不在專案時私訊淡色，點了說明；專案裡可以開
  await go('/');
  assert.equal(await js("document.querySelector('.dm-top-btn').classList.contains('off')"), true, '總覽的私訊淡色');
  await js("document.querySelector('.dm-top-btn').click(); true");
  await until(() => js("/先進入一個專案/.test(document.querySelector('#toast')?.textContent || '')"), 5000, '總覽點私訊有說明');
  await go('/p/platform/messages');
  assert.equal(await js("document.querySelector('.dm-top-btn').classList.contains('off')"), false, '專案裡私訊可用');

  // 要你處理、收件匣、回報都在選單裡
  await js("document.querySelector('#menu-btn').click(); true");
  await until(() => js("!document.querySelector('#sheet').hidden"), 5000, '選單');
  const sheet = await js(`[...document.querySelectorAll('#sheet .sheet-panel > button')].filter(b => !b.hidden).map(b => b.textContent.trim().replace(/\\s+/g, ' '))`);
  assert.ok(sheet.some(t => t.startsWith('要你處理')), '選單有要你處理：' + sheet.join('｜'));
  assert.ok(sheet.some(t => t.startsWith('收件匣')), '選單有收件匣');
  assert.ok(sheet.some(t => t.includes('回報')), '選單有回報');
  console.log('c374-test：全部通過');
} catch (e) {
  console.error('c374-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
