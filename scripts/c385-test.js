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

  // 3. PLAT-238 退回（昱志 10/23）：我的 AI 搜尋框（8 個 AI 才出現篩選列）
  for (const n of ['中文助手', '測試一', '測試二', 'PG甲', 'PG乙', 'QA丙', 'UX丁', 'BA戊']) await kit.call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name: n, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' });
  await go('/my-ai');
  assert.equal(await ime('#fb-q-myai', '.ma-row', '我的 AI'), 1, '我的 AI 只剩「中文助手」');
  assert.equal(await js("document.querySelector('#fb-q-myai').__keep"), 1, '篩選後搜尋框還是同一個（不換掉，輸入法不會被打斷）');
  // Windows 有的輸入法組字中送的 input 沒標 isComposing（修正前就是這樣被篩成 0 筆、留下注音）
  await js("(() => { const q = document.querySelector('#fb-q-myai'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await until(() => js("document.querySelectorAll('.ma-row').length === 8"), 5000, '清空後 8 個');
  const quirk = async (text, composing) => js(`(() => { const q = document.querySelector('#fb-q-myai'); q.focus(); q.value = ${JSON.stringify(text)};
    q.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: ${JSON.stringify(composing ? 'insertCompositionText' : 'insertText')}, isComposing: false })); return true; })()`);
  await js("document.querySelector('#fb-q-myai').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })); true");
  for (const t of ['ㄘ', 'ㄘㄜ', 'ㄘㄜˋ', '測ㄕ', '測ㄕˋ']) { await quirk(t, true); await sleep(80); }
  assert.equal(await js("document.querySelectorAll('.ma-row').length"), 8, '沒標 isComposing 的組字 input 也不篩');
  assert.equal(await js("document.querySelector('#fb-q-myai').__keep"), 1, '組字中搜尋框沒被換掉');
  await js("(() => { const q = document.querySelector('#fb-q-myai'); q.value = '測試'; q.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '測試' })); return true; })()");
  await until(() => js("document.querySelectorAll('.ma-row').length === 2"), 5000, '選完字才篩（測試一、測試二）');
  assert.equal(await js("document.querySelector('#fb-q-myai').value"), '測試');
  // 搜尋框留著不換，「清除篩選」還是要清掉框裡的字
  await js("(() => { const q = document.querySelector('#fb-q-myai'); q.value = 'zzz'; q.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await until(() => js("!!document.querySelector('[data-fb-clear=\"myai\"]')"), 5000, '沒有符合的');
  await js("document.querySelector('[data-fb-clear=\"myai\"]').click(); true");
  await until(() => js("document.querySelectorAll('.ma-row').length === 8"), 5000, '清除後 8 個');
  assert.equal(await js("document.querySelector('#fb-q-myai').value"), '', '框裡的字清掉');
  console.log('c385-test：全部通過');
} catch (e) {
  console.error('c385-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
