// C-380 畫面測試（真的瀏覽器）：管理員沒有專案角色時，名片顯示「管理員」，不露出舊的跨專案角色；一般成員照舊（搜尋成員、跨專案訊息用同一個函式）
// 伺服器端（第一次上線不幫管理員帶角色）在 roles-test.js。需要 Chrome 或 Edge；找不到就略過。用法：node scripts/c380-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('c380-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('c380');
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '劉昱志', role: 'Sponsor' })).body; // 第一位＝管理員
  const kang = (await kit.call(null, '/api/join', 'POST', { name: '康旭', role: 'BA' })).body;
  const { js, login } = await kit.browser();
  const meLine = () => js("document.querySelector('#sheet-me .me-info .muted')?.textContent || ''");

  await login(liu.token);
  await until(async () => /管理員/.test(await meLine()), 8000, '管理員名片');
  assert.ok(!/Sponsor/.test(await meLine()), `管理員名片不顯示舊角色（${await meLine()}）`);

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
