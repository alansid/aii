// C-380 畫面測試（真的瀏覽器）：管理員沒有專案角色時，名片顯示「管理員」，不露出舊的跨專案角色；一般成員照舊（搜尋成員、跨專案訊息用同一個函式）
// C-380 退回（PLAT-235，昱志 10/22）：管理員看得到、管得了所有專案，但在沒有角色的專案不算成員——
//   成員名單、人數、交接對象、團隊狀態、@ 選人都不列，@所有人不通知；名單上方一行灰字說明；有角色的專案照舊
//   修正前：新建的 testing 在「成員與權限」列出管理員（未設定、1 人）
// 伺服器端（第一次上線不幫管理員帶角色）在 roles-test.js。需要 Chrome 或 Edge；找不到就略過。用法：node scripts/c380-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('c380-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('c380');
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '劉昱志', role: 'Sponsor' })).body; // 第一位＝管理員
  const kang = (await kit.call(null, '/api/join', 'POST', { name: '康旭', role: 'BA' })).body;
  const liuId = liu.participant.participantId, kangId = kang.participant.participantId;
  const { js, login } = await kit.browser();
  const meLine = () => js("document.querySelector('#sheet-me .me-info .muted')?.textContent || ''");
  const go = async url => { await js(`history.pushState(null, '', ${JSON.stringify(url)}); dispatchEvent(new PopStateEvent('popstate')); true`); await sleep(700); };

  await login(liu.token);
  await until(async () => /管理員/.test(await meLine()), 8000, '管理員名片');
  assert.ok(!/Sponsor/.test(await meLine()), `管理員名片不顯示舊角色（${await meLine()}）`);
  // 管理員進專案：不跳「你在 平台 還沒設角色」
  await go('/p/platform/messages');
  await until(() => js("/平台/.test(document.querySelector('#crumbs')?.textContent || '')"), 8000, '進平台');
  assert.equal(await js("document.querySelector('#role-banner').hidden"), true, '管理員不提示設角色');

  // ---- PLAT-235：新建專案 testing，管理員沒角色 → 不算成員 ----
  const pj = (await kit.call(liu.token, '/api/projects', 'POST', { name: 'testing' })).body.id;
  await kit.call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: kangId, projects: ['平台', '銀行系統', pj] }] });
  await kit.call(liu.token, `/api/participants/${kangId}/project-roles`, 'PUT', { roles: { [pj]: 'BA' } });
  const wang = (await kit.call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body, wangId = wang.participant.participantId;
  await kit.call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: wangId, projects: [pj] }] });
  await kit.call(liu.token, `/api/participants/${wangId}/project-roles`, 'PUT', { roles: { [pj]: 'UX' } });
  await kit.call(liu.token, `/api/participants/${liuId}/project-roles`, 'PUT', { roles: { 平台: 'PO' } }); // 平台有角色＝照舊是成員
  const views = (await kit.call(liu.token, '/api/projects')).body.items;
  assert.equal(views.find(p => p.id === pj).memberCount, 2, 'testing 人數不算沒角色的管理員');
  assert.equal(views.find(p => p.id === '平台').memberCount, 2, '平台有角色，照算');
  const ids = async q => (await kit.call(kang.token, q)).body.members?.map(m => m.participantId) || (await kit.call(kang.token, q)).body.items.map(m => m.participantId);
  assert.ok(!(await ids(`/api/participants?project=${encodeURIComponent(pj)}`)).includes(liuId), '依專案查成員不列管理員');
  assert.ok(!(await ids(`/api/team-status?project=${encodeURIComponent(pj)}`)).includes(liuId), '團隊狀態不列管理員');
  assert.ok((await ids('/api/participants?project=' + encodeURIComponent('平台'))).includes(liuId), '有角色的專案照舊列');
  // @所有人：testing 不通知管理員；平台照常
  const before = (await kit.call(liu.token, '/api/notifications?status=pending')).body.items.length;
  await kit.call(kang.token, '/api/messages', 'POST', { requestId: 'all1', project: pj, audience: 'all', text: '[通知] testing 的大家' });
  assert.equal((await kit.call(liu.token, '/api/notifications?status=pending')).body.items.length, before, '@所有人不通知沒角色的管理員');
  await kit.call(kang.token, '/api/messages', 'POST', { requestId: 'all2', project: '平台', audience: 'all', text: '[通知] 平台的大家' });
  assert.equal((await kit.call(liu.token, '/api/notifications?status=pending')).body.items.length, before + 1, '有角色的專案 @所有人照常通知');

  // 網頁：成員與權限的 testing 不列管理員、上方一行灰字；人數 1
  await login(liu.token);
  await go('/members');
  await until(() => js(`!!document.querySelector('[data-pm-proj="${pj}"]')`), 10000, '成員與權限');
  await js(`document.querySelector('[data-pm-proj="${pj}"]').click(); true`);
  await until(() => js("/testing/.test(document.querySelector('.pm-dtitle')?.textContent || '')"), 8000, '選 testing');
  const names = await js("[...document.querySelectorAll('.pm-table .c-name')].map(td => td.textContent.trim())");
  assert.ok(!names.some(t => t.includes('劉昱志')) && names.some(t => t.includes('康旭')), 'testing 名單不列管理員：' + names.join('｜'));
  assert.match(await js("document.querySelector('.pm-dtitle').textContent"), /2 人/, '標題人數 2');
  assert.match(await js("document.querySelector('.pm-admin-note')?.textContent || ''"), /管理員 劉昱志 可以看所有專案/, '名單上方灰字說明');
  assert.match(await js(`document.querySelector('[data-pm-proj="${pj}"]').textContent`), /2/, '左邊清單人數 2');
  await js(`document.querySelector('[data-pm-proj="平台"]').click(); true`);
  await until(() => js("/平台/.test(document.querySelector('.pm-dtitle')?.textContent || '')"), 8000, '選平台');
  assert.ok(await js("[...document.querySelectorAll('.pm-table .c-name')].some(td => td.textContent.includes('劉昱志'))"), '平台有角色照舊列');
  assert.ok(!(await js("!!document.querySelector('.pm-admin-note')")), '有角色的專案沒有灰字');

  // 網頁：testing 的 @ 選人、交接對象不列管理員（用康旭登入）
  const c = (await kit.call(kang.token, '/api/cards', 'POST', { requestId: 'tc', project: pj, title: 'testing 的卡', ownerId: kangId })).body;
  await login(kang.token);
  await go(`/p/${encodeURIComponent((views.find(p => p.id === pj).slug) || pj)}/messages`);
  await until(() => js("/testing/.test(document.querySelector('#crumbs')?.textContent || '')"), 8000, '進 testing');
  await js("const t = document.querySelector('#composer-input') || document.querySelector('textarea'); t.focus(); t.value = '@'; t.dispatchEvent(new Event('input', { bubbles: true })); true");
  await sleep(500);
  const at = await js("[...document.querySelectorAll('#mention-list [role=option], .mention-list li, .mention-item')].map(x => x.textContent)");
  assert.ok(at.length && !at.some(t => t.includes('劉昱志')), '@ 選人不列管理員：' + at.join('｜'));
  await js(`document.querySelector('.cap[data-cap="${c.cardId}"]')?.click(); true`);
  await go(`/p/${encodeURIComponent((views.find(p => p.id === pj).slug) || pj)}/work`);
  await until(() => js(`!!document.querySelector('[data-card="${c.cardId}"]')`), 8000, '工作頁的卡');
  await js(`document.querySelector('[data-card="${c.cardId}"]').click(); true`);
  await until(() => js("!!document.querySelector('.drawer-titles')"), 8000, '卡片抽屜');
  await js("[...document.querySelectorAll('button')].find(b => /^交接/.test(b.textContent.trim()))?.click(); true");
  await until(() => js("!!document.querySelector('#handover-form')"), 8000, '交接表單');
  const opts = await js("[...document.querySelectorAll('#handover-form option, #handover-form [data-to]')].map(o => o.textContent)");
  assert.ok(opts.some(t => t.includes('王小明')) && !opts.some(t => t.includes('劉昱志')), '交接對象不列管理員：' + opts.join('｜'));

  await login(kang.token);
  await until(async () => /BA/.test(await meLine()), 8000, '一般成員名片');
  assert.ok(!/管理員/.test(await meLine()), '一般成員不顯示管理員');
  console.log('c380-test：全部通過');
} catch (e) {
  console.error('c380-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
