// C-346 網頁端：技能 zip 解析、外層資料夾去掉、逐行差異、入口按鈕（不開瀏覽器，把 app.js 裡的函式抽出來跑）
// 用法：node scripts/skills-ui-test.js
import fs from 'node:fs';
import zlib from 'node:zlib';
import assert from 'node:assert';

const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const grab = name => { const i = js.indexOf(name); assert.ok(i >= 0, '找不到 ' + name); return i; };
// 從「const SK_ST」到「const skFileHtml」之間是純函式（不碰 DOM）
const src = js.slice(grab('  const SK_ST = '), grab('  const skFileHtml = '));
const { skReadZip, skStrip, skDiff } = new Function(`${src}; return { skReadZip, skStrip, skDiff };`)();

// 做一個 zip：一個不壓縮、一個 deflate，另外夾 Mac 的 __MACOSX 與 .DS_Store
function zip(entries) {
  const parts = [], central = []; let off = 0;
  for (const [name, text, deflate] of entries) {
    const raw = Buffer.from(text), data = deflate ? zlib.deflateRawSync(raw) : raw, nm = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(deflate ? 8 : 0, 8); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nm.length, 26);
    parts.push(h, nm, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(deflate ? 8 : 0, 10); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, nm);
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return new Blob([Buffer.concat([...parts, cd, e])]);
}

try {
  const z = zip([['my-skill/SKILL.md', '---\nname: my-skill\ndescription: 測試\n---\n內容', false], ['my-skill/scripts/run.sh', 'echo 中文\n'.repeat(50), true], ['__MACOSX/._x', 'junk', false], ['my-skill/.DS_Store', 'junk', false]]);
  const files = await skReadZip(z);
  assert.deepEqual(files.map(f => f.path).sort(), ['my-skill/SKILL.md', 'my-skill/scripts/run.sh'], '略過 __MACOSX、.DS_Store');
  assert.equal(files.find(f => f.path.endsWith('run.sh')).text, 'echo 中文\n'.repeat(50), 'deflate 解得開、中文正常');
  assert.deepEqual(skStrip(files).map(f => f.path).sort(), ['SKILL.md', 'scripts/run.sh'], '外面多一層資料夾就去掉');
  assert.deepEqual(skStrip([{ path: 'SKILL.md', text: '' }, { path: 'a/b.md', text: '' }]).map(f => f.path), ['SKILL.md', 'a/b.md'], '最上層已有 SKILL.md 就不動');
  await assert.rejects(skReadZip(zip([['SKILL.md', 'x', false], ['logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0xc3]), false]])), /logo\.png 不是文字檔/, 'zip 裡有二進位檔會擋');
  const bin = new Blob([Buffer.concat([Buffer.from([0xff, 0xfe, 0x00])])]);
  await assert.rejects(skReadZip(bin), /不是 zip/, '不是 zip 會說');
  const d = skDiff('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(d, [[' ', 'a'], ['-', 'b'], ['+', 'B'], [' ', 'c'], ['+', 'd']], '逐行差異');
  // 入口：我的 AI 卡片「技能」、成員與權限的「技能」分頁（leader 也有）
  assert.ok(js.includes('data-act="skills"') && js.includes("openAiSkills(ai); // C-346"), '我的 AI 卡片有「技能」');
  assert.ok(js.includes("[['members', '成員'], ['roles', '角色'], ['skills', '技能']]"), 'leader 有技能分頁');
  assert.ok(js.includes('看過全文與差異，核准上架'), '核准按鈕寫明要看全文與差異');
  console.log('skills-ui-test：全部通過');
} catch (e) {
  console.error('skills-ui-test 失敗：', e.message);
  process.exitCode = 1;
}
