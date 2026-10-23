// PLAT-240 畫面測試（真的瀏覽器，手機寬 375px）：我的 AI 上方「N 隻 AI 有技能要同步［全部同步］」→ 含腳本的一次允許 → 進度清單每隻一列；
// 新版通知的連結 ?sync=1 直接開同步清單；上傳成功畫面有「你有 N 隻 AI 會用到［全部同步］」
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/plat240-skill-sync-ui-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('plat240-skill-sync-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const SETUP_SHA = crypto.createHash('sha256').update(fs.readFileSync(fileURLToPath(new URL('../public/aigile-setup.mjs', import.meta.url)))).digest('hex');
const kit = await startKit('p240');
const skill = (name, extra = []) => [{ path: 'SKILL.md', text: `---\nname: ${name}\ndescription: ${name} 的說明\n---\n規則\n` }, ...extra];
// 不壓縮的 zip（上傳彈窗用）
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p240ui-'));
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const mk = async name => { const a = (await kit.call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; return { id: a.participantId, tok: kit.aiToken(a.participantId) }; };
  const pg1 = await mk('PG一號'), pg2 = await mk('PG二號');
  await fetch(kit.BASE + '/api/notifications/count', { headers: { Authorization: 'Bearer ' + pg1.tok, 'X-Aigile-Source': 'watcher' } }); // PG 一號待命中
  for (const [name, extra] of [['pg-rules', []], ['pg-tools', [{ path: 'scripts/run.sh', text: 'echo hi\n' }]]]) {
    const r = await kit.call(liu.token, '/api/projects/%E5%B9%B3%E5%8F%B0/skills', 'POST', { files: skill(name, extra), roles: ['PG'] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const { js, login, cdp } = await kit.browser(375, 800);
  await login(liu.token, '/my-ai');
  await until(() => js("!!document.querySelector('#ai-new')"), 10000, '我的 AI 頁');

  // 1. 列表上方一條「2 隻 AI 有技能要同步［全部同步］」
  await until(() => js("(document.querySelector('#ma-sync')?.textContent || '').includes('2 隻 AI 有技能要同步')"), 10000, '同步提示');
  await js("document.querySelector('[data-sy-banner]').click(); true");
  // 2. 含腳本的一次允許：列出會裝到哪幾隻，預設全勾
  await until(() => js("document.querySelectorAll('[data-sy-pair]').length === 2"), 8000, '允許清單');
  assert.equal(await js("[...document.querySelectorAll('[data-sy-pair]')].every(c => c.checked)"), true, '預設全勾');
  assert.match(await js("document.querySelector('.sy-allow').textContent"), /pg-tools 第 1 版（腳本 1 個）→ PG一號[\s\S]*→ PG二號/);
  await js("document.querySelector('[data-sy-go]').click(); true");
  // 3. 進度清單每隻一列：待命的＝等叫醒、沒心跳的＝離線
  await until(() => js("document.querySelectorAll('.sy-row').length === 2"), 8000, '進度清單');
  const st = () => js("Object.fromEntries([...document.querySelectorAll('.sy-row')].map(r => [r.querySelector('b').textContent, r.querySelector('.sy-st').textContent.trim()]))");
  let s = await st();
  assert.equal(s['PG一號'], '等叫醒'); assert.match(s['PG二號'], /^離線/);
  // 手機 375px：一列一行、狀態字在右邊、沒有橫向捲動
  assert.equal(await js("document.documentElement.scrollWidth <= innerWidth + 1"), true, '沒有橫向捲動');
  assert.equal(await js("(() => { const r = document.querySelector('.sy-row'), m = r.querySelector('.sy-main').getBoundingClientRect(), t = r.querySelector('.sy-st').getBoundingClientRect(); return t.left >= m.right - 1 && Math.abs(t.top - m.top) < 30; })()"), true, '狀態字在同一列右邊');
  // 4. AI 回報裝好 → 清單自己更新成 ✓ 已裝好（網頁每幾秒讀一次）
  const sk = (await kit.call(pg1.tok, '/api/me/skills')).body.items;
  assert.equal(sk.length, 2, '允許後兩個都會裝');
  await kit.call(pg1.tok, '/api/me/skills/sync-status', 'POST', { state: 'running', tool: 'claude', setupSha: SETUP_SHA });
  await until(async () => (await st())['PG一號'] === '同步中…', 10000, '同步中');
  await kit.call(pg1.tok, '/api/me/skills/installed', 'POST', { skillIds: sk.map(x => x.skillId), places: Object.fromEntries(sk.map(x => [x.skillId, 'own'])), tool: 'claude', setupSha: SETUP_SHA });
  await until(async () => (await st())['PG一號'] === '✓ 已裝好', 10000, '已裝好');
  assert.equal(await js("[...document.querySelectorAll('.sy-row')][0].querySelectorAll('.sk-mk.ok').length"), 2, '每個技能 ✓ 最新');
  await kit.call(pg2.tok, '/api/me/skills/sync-status', 'POST', { state: 'failed', lastLine: '技能：pg-tools 的雜湊跟平台給的不一樣' });
  await until(async () => /^✗ 失敗/.test((await st())['PG二號'] || ''), 10000, '失敗');
  assert.match(await js("document.querySelectorAll('.sy-row')[1].textContent"), /雜湊跟平台給的不一樣[\s\S]*再叫一次|再叫一次/, '失敗顯示最後一行與再叫一次');
  await js("document.querySelector('[data-close]')?.click(); true");

  // 5. 新版通知的連結 ?sync=1：直接開同步清單，網址收乾淨
  await login(liu.token, '/my-ai?sync=1');
  await until(() => js("[...document.querySelectorAll('.modal h2, .modal-title, .modal header')].some(h => h.textContent.includes('技能同步'))"), 10000, '同步清單');
  assert.equal(await js('location.search'), '', '網址拿掉 ?sync=1');
  await js("document.querySelector('#modal-root [data-close]')?.click(); true");

  // 6. 上傳成功畫面：你有 N 隻 AI 會用到［全部同步］
  const zf = path.join(tmp, 'pg-new.zip');
  fs.writeFileSync(zf, zip([['SKILL.md', '---\nname: pg-new\ndescription: 新技能\n---\n規則\n']]));
  await js("document.querySelector('#ma-skills').click(); true");
  await until(() => js("!!document.querySelector('[data-skup]')"), 10000, '技能庫');
  await js("document.querySelector('[data-skup]').click(); true");
  await until(() => js("!!document.querySelector('#sk-zip')"), 8000, '上傳彈窗');
  const { root } = (await cdp('DOM.getDocument')).result;
  const { nodeId } = (await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '#sk-zip' })).result;
  await cdp('DOM.setFileInputFiles', { nodeId, files: [zf] });
  await until(() => js("!document.querySelector('[data-sksend]')?.disabled"), 8000, '可以送出');
  await js("document.querySelector('[data-skup]') && document.querySelector('[data-sksend]').click(); true");
  await until(() => js("(document.querySelector('.sk-ok')?.textContent || '').includes('pg-new')"), 10000, '上傳成功畫面');
  await until(() => js("(document.querySelector('#sk-up-sync')?.textContent || '').includes('你有 2 隻 AI 會用到')"), 10000, '會用到幾隻');
  await js("document.querySelector('[data-sk-upsync]').click(); true");
  await until(() => js("document.querySelectorAll('.sy-row').length === 2"), 8000, '上傳後的進度清單');
  console.log('plat240-skill-sync-ui-test：全部通過');
} catch (e) {
  console.error('plat240-skill-sync-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
