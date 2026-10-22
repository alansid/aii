// C-385（PLAT-238）畫面測試（真的瀏覽器）：搜尋框用注音打字，還在選字時不重畫；選完字才篩選；英文照舊每打一個字就篩
// 修正前：工作頁搜尋框每次 input 都重畫，輸入法被打斷，字沒選就送出，變成一串「ㄓㄓㄨㄥ」
// 用 Chrome 的 Input.imeSetComposition 模擬組字、Input.insertText 模擬選字。需要 Chrome 或 Edge；找不到就略過。用法：node scripts/c385-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('c385-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('c385');
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const ids = [];
  for (const [name, role] of [['王中明', 'UX'], ['Alice', 'QA']]) ids.push((await kit.call(null, '/api/join', 'POST', { name, role })).body.participant.participantId);
  await kit.call(liu.token, '/api/members/matrix', 'PUT', { changes: ids.map(id => ({ id, projects: ['平台'] })) });
  for (const [i, t] of ['中文搜尋卡', 'apple 卡', '第三張'].entries()) await kit.call(liu.token, '/api/cards', 'POST', { requestId: 'c' + i, project: '平台', title: t });
  const { js, login, cdp } = await kit.browser();
  const go = async url => { await js(`history.pushState(null, '', ${JSON.stringify(url)}); dispatchEvent(new PopStateEvent('popstate')); true`); await sleep(700); };

  // 對一個搜尋框：組字「ㄓ」→「ㄓㄨㄥ」期間框不能被換掉、清單不變；選「中」後才篩；回傳篩完的筆數
  const ime = async (sel, rows, label) => {
    await until(() => js(`!!document.querySelector(${JSON.stringify(sel)})`), 10000, label);
    const total = await js(`document.querySelectorAll(${JSON.stringify(rows)}).length`);
    await js(`(() => { const q = document.querySelector(${JSON.stringify(sel)}); q.value = ''; q.focus(); q.__keep = 1; return true; })()`);
    for (const t of ['ㄓ', 'ㄓㄨ', 'ㄓㄨㄥ']) { await cdp('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length }); await sleep(150); }
    assert.equal(await js(`document.querySelector(${JSON.stringify(sel)}).__keep`), 1, `${label}：組字中搜尋框不能被重畫`);
    assert.equal(await js(`document.activeElement === document.querySelector(${JSON.stringify(sel)})`), true, `${label}：組字中游標還在搜尋框`);
    assert.equal(await js(`document.querySelectorAll(${JSON.stringify(rows)}).length`), total, `${label}：組字中清單不變`);
    await cdp('Input.insertText', { text: '中' });
    await until(() => js(`document.querySelectorAll(${JSON.stringify(rows)}).length < ${total}`), 5000, `${label}：選完字才篩（原本 ${total} 筆）`);
    assert.equal(await js(`document.querySelector(${JSON.stringify(sel)}).value`), '中', `${label}：框裡是選好的字，不是注音`);
    return js(`document.querySelectorAll(${JSON.stringify(rows)}).length`);
  };

  await login(liu.token);
  // 1. 工作頁搜尋卡片
  await go('/p/platform/work');
  assert.equal(await ime('#card-q', '.crow:not(.arch), .ctile', '工作頁'), 1, '工作頁只剩「中文搜尋卡」');
  // 英文沒有組字：每打一個字就篩（不能變慢、不能等 compositionend）
  await js("(() => { const q = document.querySelector('#card-q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await sleep(300);
  await js("document.querySelector('#card-q').focus(); true");
  await cdp('Input.insertText', { text: 'e' });
  await until(() => js("document.querySelectorAll('.crow:not(.arch), .ctile').length === 1"), 3000, '英文即時篩選');
  assert.equal(await js("document.querySelector('#card-q').value"), 'e'); // 卡號 PLAT 也有 a，用 e 只會中 apple

  // 2. 成員與權限：左邊搜尋成員（pm-mq）、右邊共用篩選列（fb-q-perm）
  await go('/members');
  await until(() => js("!!document.querySelector('[data-pm-view]')"), 10000, '成員與權限');
  await js("document.querySelector('[data-pm-view=\"byMember\"]')?.click(); true");
  await ime('#pm-mq', '[data-pm-mem]', '成員與權限搜尋成員');
  await js("document.querySelector('[data-pm-view=\"byProject\"]')?.click(); true");
  await until(() => js("!!document.querySelector('[data-pm-proj]')"), 8000, '專案清單');
  await js("document.querySelector('[data-pm-proj=\"平台\"]').click(); true");
  await ime('#fb-q-perm', '.pm-table .c-name', '專案成員篩選');
  console.log('c385-test：全部通過');
} catch (e) {
  console.error('c385-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
