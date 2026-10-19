// C-313 驗收測試（真的瀏覽器）：總覽側欄「總覽」不放數字，只有「要你處理」顯示全部件數；各專案列是自己的件數
// 修正前：「總覽」和「要你處理」都顯示同一個數字（昱志 10/19：兩個 1 重複）
// 需要本機有 Chrome 或 Edge；找不到就略過。用法：node scripts/hub-count-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('hub-count-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('hubcount');
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const L = liu.participant.participantId;
  const ai = (await kit.call(liu.token, '/api/my-ais', 'POST', { projects: ['平台', '銀行系統'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const tok = kit.aiToken(ai.participantId);
  // 平台 2 張、銀行系統 1 張等他驗收
  for (const [i, pj] of [[1, '平台'], [2, '平台'], [3, '銀行系統']]) {
    const c = (await kit.call(tok, '/api/cards', 'POST', { requestId: 'v' + i, project: pj, title: `等驗收 ${i}`, ownerId: ai.participantId, status: '進行中' })).body;
    assert.equal((await kit.call(tok, `/api/cards/${c.cardId}`, 'PATCH', { status: '待確認', waitForId: L, version: c.version })).status, 200);
  }
  const { js, login, cdp } = await kit.browser();
  await login(liu.token);
  await until(() => js("!!document.querySelector('.hub-side [data-hub-todo-open] .hs-n')"), 15000, '要你處理的數字');
  await sleep(500);
  const r = await js(`(() => {
    const n = sel => document.querySelector(sel)?.querySelector('.hs-n')?.textContent ?? null;
    return { hub: n('.hub-side [data-proj="hub"]'), todo: n('.hub-side [data-hub-todo-open]'), plat: n('.hub-side [data-proj="平台"]'), bank: n('.hub-side [data-proj="銀行系統"]') };
  })()`);
  assert.equal(r.hub, null, '「總覽」不放數字（修正前和要你處理重複）');
  assert.equal(r.todo, '3', '「要你處理」是全部件數');
  assert.equal(r.plat, '2', '平台列是自己的件數');
  assert.equal(r.bank, '1', '銀行系統列是自己的件數');

  // C-314：總覽右側「要你處理」清單跟數字同一個來源（修正前只列決策與建議，等你驗收、要你回覆都漏掉，顯示「目前沒有」）
  await kit.call(tok, '/api/messages', 'POST', { requestId: 'ask1', project: '平台', text: '這個要你回答一下', recipientIds: [L] });
  await js("location.reload(); true");
  await until(() => js("document.querySelector('.hub-side [data-hub-todo-open] .hs-n')?.textContent === '4'"), 15000, '要你處理變 4');
  await sleep(500);
  const panel = await js(`(() => ({ rows: document.querySelectorAll('.hub-todo .ht-row').length, empty: !!document.querySelector('.hub-todo .ht-empty'),
    head: document.querySelector('.hub-todo .ht-head .ps-count')?.textContent || null, kinds: [...document.querySelectorAll('.hub-todo .ht-tag')].map(t => t.textContent) }))()`);
  assert.equal(panel.empty, false, '右側不能寫「目前沒有」');
  assert.equal(panel.rows, 4, `右側列出 4 件（實際 ${panel.rows}）`);
  assert.equal(panel.head, '4', '右側標題數字跟側欄一樣');
  assert.deepEqual(panel.kinds.sort(), ['回覆', '驗收', '驗收', '驗收'].sort(), '三張等你驗收＋一則要你回覆');
  // 點一項 → 進那個專案的收件匣、捲到那一列
  await js("[...document.querySelectorAll('.hub-todo .ht-row')].find(b => b.querySelector('.ht-tag').textContent === '驗收' && b.dataset.hubProj === '平台').click(); true");
  await until(() => js("!!document.querySelector('#page-work [data-ver-row].focus-item')"), 8000, '收件匣那一列被標出來');

  // 手機：選單裡的「總覽」也不放數字
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await js("location.href = '/'; true");
  await until(() => js("document.body.classList.contains('at-hub')"), 15000, '回到總覽');
  await sleep(600);
  await js("document.querySelector('#menu-btn').click(); true");
  await until(() => js("!!document.querySelector('#sheet:not([hidden]) .ph-card.is-hub')"), 5000, '手機選單');
  assert.equal(await js("document.querySelector('#sheet .ph-card.is-hub .ps-count')?.textContent || null"), null, '手機選單的總覽不放數字');
  console.log('hub-count-test：全部通過');
} catch (e) {
  console.error('hub-count-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
