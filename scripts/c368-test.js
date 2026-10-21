// C-368 測試（W-2）：AI 一多就難找。成員與權限、@ 選人、我的 AI 用同一套搜尋＋篩選
// 不開瀏覽器：從 app.js 抽出比對、標黃、篩選、@ 候選與選單畫法，用假的成員跑
// 用法：node scripts/c368-test.js [要測的 app.js 路徑]
import fs from 'node:fs';
import assert from 'node:assert';

const js = fs.readFileSync(process.argv[2] || new URL('../public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const fnSrc = name => {
  const m = new RegExp(`\\n  (?:async )?function ${name}\\(|\\n  const ${name} = `).exec(js);
  assert.ok(m, '找不到 ' + name);
  let i = m.index + 1, depth = 0, started = false;
  for (let j = i; j < js.length; j++) {
    const c = js[j];
    if (c === '{' || c === '(' || c === '[') { depth++; started = true; } else if (c === '}' || c === ')' || c === ']') depth--;
    if (started && depth === 0 && (js[j + 1] === '\n' || js[j + 1] === ';')) return js.slice(i, j + 1) + ';';
  }
  throw new Error('抽不出 ' + name);
};

const P = (id, name, kind, extra = {}) => ({ participantId: id, name, memberType: kind, status: 'active', projects: ['平台'], isOnline: false, ...extra });
const people = [
  P('me', '劉昱志', 'human', { shortCode: 'TWE6', projectRoles: { 平台: 'PO' } }),
  P('h2', '陳詠翰', 'human', { shortCode: 'CH01', projectRoles: { 平台: 'UX' } }),
  P('a1', '昱志血汗勞工的程式開發助手', 'ai', { shortCode: 'RVVW', role: '程式開發', roleKey: 'PG' }),
  P('a2', '兩隻血汗勞工', 'ai', { shortCode: 'BM3C', role: '程式開發', roleKey: 'PG' }),
  P('a3', '平台QA', 'ai', { shortCode: 'QRV2', role: '品質', roleKey: 'QA' }),
  P('a4', 'codex-pg-銀行', 'ai', { shortCode: '2URQ', role: '程式開發', roleKey: 'PG', projects: ['銀行'] }),
];
const mem = new Map();
const env = {
  state: { participants: new Map(people.map(p => [p.participantId, p])) },
  PROJECTS: ['平台', '銀行'],
  store: { get: k => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) },
  esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  RECENT_AT: 'aigile-recent-at',
  ALL: { participantId: '__all', name: '所有人', memberType: 'all', role: '通知所有成員' },
  meId: () => 'me', myProjects: () => ['平台'], projName: x => x, projectView: () => '平台', roOf: () => false,
  sendTarget: () => '平台',
};
const names = ['roleIn', 'findQ', 'findHit', 'markQ', 'NO_FIND', 'findPrefs', 'saveFindPrefs', 'findPass', 'mentionScope', 'inScope', 'recentAt', 'noteRecentAt', 'mentionCandidates', 'mentionItemsHtml'];
const fns = new Function(...Object.keys(env), `${names.map(fnSrc).join('\n')}\nreturn { ${names.join(', ')} };`)(...Object.values(env));
const ids = list => list.map(p => p.participantId);

try {
  // 1. 比對：名字、代號、角色名稱、角色代碼，不分大小寫
  const hit = q => ids(people.filter(p => fns.findHit(p, fns.findQ(q), '平台')));
  assert.deepEqual(hit('rvvw'), ['a1'], '代號（小寫也行）');
  assert.deepEqual(hit('PG'), ['a1', 'a2', 'a4'], '角色代碼 PG＋名字裡的 pg');
  assert.deepEqual(hit('品質'), ['a3'], '角色名稱');
  assert.deepEqual(hit('ux'), ['h2'], '人類在這個專案的角色');
  assert.deepEqual(hit(''), ids(people), '沒打字全部');
  // 2. 符合的字標黃（安全跳脫）
  assert.equal(fns.markQ('codex-pg-銀行', 'pg'), 'codex-<mark>pg</mark>-銀行');
  assert.equal(fns.markQ('RVVW', 'rv'), '<mark>RV</mark>VW');
  assert.equal(fns.markQ('<b>', ''), '&lt;b&gt;');
  // 3. 篩選：人類／AI、角色、專案；條件記在這台裝置
  const f = { kind: 'ai', role: '程式開發', proj: '' };
  assert.deepEqual(ids(people.filter(p => fns.findPass(p, f, '平台'))), ['a1', 'a2', 'a4']);
  assert.deepEqual(ids(people.filter(p => fns.findPass(p, { ...f, proj: '銀行' }, '平台'))), ['a4']);
  fns.saveFindPrefs('perm', f);
  assert.deepEqual(fns.findPrefs('perm'), f, '篩選條件記住');
  assert.ok(!/"q"/.test(mem.get('aigile-find:perm')), '搜尋字不記');
  // 4. @ 選人：打 @rv → 代號也算；分 AI／人類，AI 在前；只列本專案
  let c = fns.mentionCandidates('rv');
  assert.deepEqual(ids(c), ['a1', 'a3'], '@rv 找到 RVVW、QRV2，不列銀行的');
  assert.ok(c.every(p => p._grp === 'AI'));
  const html = fns.mentionItemsHtml(c, 0, '平台');
  assert.ok(html.includes('AI · 符合 2') && html.includes('#<mark>RV</mark>VW'), '分組標題與標黃');
  assert.ok(html.includes('↑↓ 選、Enter 選定、Esc 關'), '鍵盤提示');
  // 沒打字：最近 @ 過的在前（最多 5 位），再來人類、AI
  fns.noteRecentAt(people[3]);
  c = fns.mentionCandidates('');
  assert.equal(c[0].participantId, '__all');
  assert.equal(c[1].participantId, 'a2', '最近 @ 過的在最前');
  assert.equal(c[1]._grp, '最近 @ 過');
  assert.deepEqual(c.slice(2).map(p => p._grp), ['人類', 'AI', 'AI'], '再來人類、AI');
  for (const p of people) fns.noteRecentAt(p);
  assert.ok(fns.mentionCandidates('').filter(p => p._grp === '最近 @ 過').length <= 5, '最近最多 5 位');
  // 5. 三處都用同一套篩選列；我的 AI 6 個以上才出現；不加讀取
  assert.ok(/findBarHtml\('perm'/.test(js), '成員與權限有篩選列');
  assert.ok(/findBarHtml\('myai'/.test(js) && /items\.length >= 6/.test(js), '我的 AI 6 個以上才有篩選列');
  assert.ok(/顯示 \$\{shown\}／\$\{total\}/.test(js), '顯示 x／y');
  assert.ok(js.includes('清除篩選'), '沒結果給清除篩選');
  assert.ok(/max-width: 699px\)[\s\S]*\.fb-more \{ display: inline-flex/.test(css), '手機篩選收進「篩選 ▾」');
  console.log('c368-test：全部通過');
} catch (e) {
  console.error('c368-test 失敗：', e.message);
  process.exitCode = 1;
}
