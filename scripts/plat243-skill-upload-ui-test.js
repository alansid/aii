// PLAT-243 上傳技能彈窗改版：三步、檔案卡片＋檢查標籤、角色膠囊＋會裝到幾隻、底部固定一列、手機全螢幕
// 用法：node scripts/plat243-skill-upload-ui-test.js（找不到 Chrome／Edge 就略過）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('plat243-skill-upload-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('p243');
// 不壓縮的 zip
function zip(entries) {
  const parts = [], central = []; let off = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text), nm = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    parts.push(h, nm, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p243ui-'));
const zf = (name, entries) => { const f = path.join(tmp, name); fs.writeFileSync(f, zip(entries)); return f; };
const good = zf('good.zip', [['SKILL.md', '---\nname: pg-new\ndescription: 新技能\n---\n規則\n'], ['templates.md', '範本\n']]);
const bad = zf('bad.zip', [['SKILL.md', '---\nname: pg-bad\n---\nAKIAABCDEFGHIJKLMNOP\n']]);
const withScript = zf('script.zip', [['SKILL.md', '---\nname: pg-run\ndescription: 有腳本\n---\n規則\n'], ['scripts/run.sh', 'echo hi\n']]);
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body; // 管理員
  const mk = (name, roleKey, projects = ['平台']) => kit.call(liu.token, '/api/my-ais', 'POST', { projects, roleKey, role: roleKey, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' });
  await mk('PG一號', 'PG'); await mk('PG二號', 'PG'); await mk('UX一號', 'UX'); await mk('銀行PG', 'PG', ['銀行系統']);

  const { js: js0, login, cdp } = await kit.browser(375, 800);
  const js = e => js0(e).catch(x => { throw new Error(x.message + ' ← ' + e.slice(0, 80)); });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true }); // 視窗最小寬度可能大於 375，直接模擬手機
  const open = async () => {
    await until(() => js("!!document.querySelector('[data-skup], #ma-skills')"), 10000, '技能入口');
    if (!(await js("!!document.querySelector('[data-skup]')"))) await js("document.querySelector('#ma-skills').click(); true");
    await until(() => js("!!document.querySelector('[data-skup]')"), 10000, '技能庫');
    await js("document.querySelector('[data-skup]').click(); true");
    await until(() => js("!!document.querySelector('.modal.sk-up #sk-zip')"), 8000, '上傳彈窗');
  };
  const pick = async f => {
    const { root } = (await cdp('DOM.getDocument')).result;
    const { nodeId } = (await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '#sk-zip' })).result;
    await cdp('DOM.setFileInputFiles', { nodeId, files: [f] });
    await until(() => js("!!document.querySelector('.sk-up-card')"), 8000, '檔案卡片');
  };
  const txt = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.textContent || '').trim()`);
  const send = () => js("document.querySelector('[data-sksend]')");
  const sendState = () => js("(() => { const b = document.querySelector('[data-sksend]'); return b.textContent.trim() + (b.disabled ? '／停用' : ''); })()");

  await login(liu.token, '/my-ai');
  await until(() => js("!!document.querySelector('#ma-skills')"), 10000, '我的 AI 頁');
  await open();

  // 1. 標題下只留一句；檔案規則在檔案區下方
  assert.equal(await txt('.modal-sub'), '上架後，這個專案勾選角色的 AI 會收到。');
  assert.deepEqual(await js("[...document.querySelectorAll('.sk-up-step')].map(e => e.firstChild.textContent.trim())"), ['1. 上傳到', '2. 檔案', '3. 給哪些角色的 AI'], '三步');
  assert.match(await txt('.sk-up-sec .field-hint'), /SKILL\.md；1 MB 內、只收文字檔/);
  // 沒選檔案：上架鈕停用、左邊提示
  assert.equal(await sendState(), '上架／停用');
  assert.equal(await txt('#sk-up-note'), '先選檔案');

  // 5. 手機 375px：全螢幕、底部那列在畫面最下面、沒有橫向捲動
  await until(() => js("Math.round(document.querySelector('.modal.sk-up').getBoundingClientRect().top) === 0"), 3000, '滑出動畫結束');
  assert.equal(await js("(() => { const r = document.querySelector('.modal.sk-up').getBoundingClientRect(); return Math.round(r.top) === 0 && Math.round(r.height) === innerHeight && Math.round(r.width) === innerWidth; })()"), true, '全螢幕');
  assert.equal(await js("Math.round(document.querySelector('.sk-up-foot').getBoundingClientRect().bottom) === innerHeight"), true, '底部固定');
  assert.equal(await js('innerWidth'), 375, '手機寬度');
  assert.equal(await js("document.documentElement.scrollWidth <= innerWidth + 1"), true, '沒有橫向捲動');

  // 3. 角色膠囊：都不選＝平台全部 3 隻；選 PG＝2；再選 UX＝3；取消 UX＝2；換專案到銀行系統＝1
  assert.equal(await txt('#sk-up-n'), '會裝到 3 隻 AI。');
  const role = r => js(`document.querySelector('[data-skrole="${r}"]').click(); true`);
  await role('PG');
  assert.equal(await js("document.querySelector('[data-skrole=\"PG\"]').getAttribute('aria-pressed')"), 'true', '選中');
  assert.equal(await txt('#sk-up-n'), '會裝到 2 隻 AI。');
  await role('UX'); assert.equal(await txt('#sk-up-n'), '會裝到 3 隻 AI。');
  await role('UX'); assert.equal(await txt('#sk-up-n'), '會裝到 2 隻 AI。');
  assert.equal(await js("document.querySelectorAll('.sk-up-role').length > 4 && new Set([...document.querySelectorAll('.sk-up-role')].map(b => Math.round(b.getBoundingClientRect().top))).size > 1"), true, '膠囊會換行');
  await js("{ const s = document.querySelector('#sk-pj'); s.value = '銀行系統'; s.dispatchEvent(new Event('change', { bubbles: true })); } true");
  assert.equal(await txt('#sk-up-n'), '會裝到 1 隻 AI。', '換專案即時更新');
  await js("{ const s = document.querySelector('#sk-pj'); s.value = '平台'; s.dispatchEvent(new Event('change', { bubbles: true })); } true");

  // 2. 檢查沒過：紅色標籤寫原因、上架鈕停用
  await pick(bad);
  assert.match(await txt('.sk-up-name'), /pg-bad/);
  const tags = () => js("[...document.querySelectorAll('.sk-up-tag')].map(t => t.className.split(' ')[1] + ':' + t.textContent.trim())");
  let t = await tags();
  assert.ok(t.includes('bad:✗ SKILL.md 沒寫 description') && t.some(x => /^bad:✗ SKILL\.md 裡有像金鑰的內容/.test(x)), JSON.stringify(t));
  assert.equal(await js("getComputedStyle(document.querySelector('.sk-up-tag.bad')).backgroundColor"), 'rgb(254, 226, 226)', '紅色');
  assert.equal(await sendState(), '上架／停用');
  assert.equal(await txt('#sk-up-note'), '檢查沒過，改好再重新選');
  // 重新選 → 回到選檔
  await js("document.querySelector('[data-skrepick]').click(); true");
  assert.equal(await js("!!document.querySelector('#sk-zip') && !document.querySelector('.sk-up-card')"), true, '重新選');

  // 2. 檢查都過：卡片（名稱、讀自 SKILL.md · 檔數 · 大小、重新選）、綠色標籤
  await pick(good);
  assert.equal(await txt('.sk-up-name'), 'pg-new');
  assert.match(await txt('.sk-up-meta'), /^讀自 SKILL\.md · 2 個檔 · 1 KB$/);
  assert.equal(await txt('[data-skrepick]'), '重新選');
  t = await tags();
  assert.deepEqual(t, ['ok:✓ 有 SKILL.md', 'ok:✓ 純文字，沒有腳本', 'ok:✓ 沒看到 Token／金鑰']);
  assert.equal(await js("getComputedStyle(document.querySelector('.sk-up-tag.ok')).backgroundColor"), 'rgb(220, 252, 231)', '綠色');
  // 4. 底部：純文字說明、上架可按
  assert.equal(await txt('#sk-up-note'), '純文字，按下就上架');
  assert.equal(await sendState(), '上架');
  assert.equal(await js("Math.round(document.querySelector('.sk-up-foot').getBoundingClientRect().bottom) === innerHeight"), true, '選了檔案底部還是固定');

  // 4. 失敗：錯誤顯示在底部那列上方，按鈕回來
  await js(`window.__f = window.fetch; window.fetch = (u, o) => /\\/skills$/.test(String(u)) && o?.method === 'POST' ? Promise.resolve(new Response(JSON.stringify({ error: { code: 'X', message: '測試用的失敗' } }), { status: 400, headers: { 'Content-Type': 'application/json' } })) : window.__f(u, o); true`);
  await js("document.querySelector('[data-sksend]').click(); true");
  await until(async () => (await txt('#sk-err')) === '測試用的失敗', 5000, '錯誤訊息');
  assert.equal(await js("(() => { const e = document.querySelector('#sk-err').getBoundingClientRect(), b = document.querySelector('.sk-up-bar').getBoundingClientRect(); return e.bottom <= b.top + 1 && !!document.querySelector('#sk-err').closest('.sk-up-foot'); })()"), true, '錯誤在底部上方');
  assert.equal(await sendState(), '上架');

  // 4. 上傳中：「上架中…」停用；成功後換成上架完成畫面、底部那列拿掉
  await js(`window.__go = null; window.fetch = (u, o) => /\\/skills$/.test(String(u)) && o?.method === 'POST' ? new Promise(r => { window.__go = () => r(window.__f(u, o)); }) : window.__f(u, o); true`);
  await js("document.querySelector('[data-sksend]').click(); true");
  await until(() => js('!!window.__go'), 5000, '送出');
  assert.equal(await sendState(), '上架中…／停用');
  assert.equal(await txt('#sk-err'), '', '再送一次先清掉錯誤');
  await js('window.__go(); true');
  await until(async () => (await txt('.sk-ok')).includes('pg-new'), 10000, '上架完成');
  assert.equal(await js("!document.querySelector('.sk-up-foot')"), true, '完成畫面沒有底部那列');
  const up = (await kit.call(liu.token, '/api/skills')).body.items.find(x => x.name === 'pg-new');
  assert.deepEqual(up.roles, ['PG'], '選的角色有送出');
  await js("window.fetch = window.__f; document.querySelector('[data-sk-fin]').click(); true");

  // 管理員選含腳本：可以直接上架
  await open();
  await pick(withScript);
  assert.match((await tags())[1], /^warn:含腳本 1 個：scripts\/run\.sh$/);
  assert.equal(await txt('#sk-up-note'), '含腳本，你能直接上架；每台電腦還要 AI 主人允許才裝');
  assert.equal(await sendState(), '上架');
  await js("document.querySelector('[data-skcancel]').click(); true");

  // 一般成員選含腳本：要管理員核准、按鈕「送出核准」
  const wang = (await kit.call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body;
  await kit.call(liu.token, `/api/participants/${wang.participant.participantId}/projects`, 'PUT', { projects: ['平台'] });
  await login(wang.token, '/my-ai');
  await until(() => js("!!document.querySelector('#ma-skills')"), 10000, '王小明的我的 AI 頁');
  await open();
  await pick(withScript);
  assert.equal(await txt('#sk-up-note'), '含腳本，要管理員核准');
  assert.equal(await sendState(), '送出核准');
  console.log('plat243-skill-upload-ui-test：全部通過');
} catch (e) {
  console.error('plat243-skill-upload-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
