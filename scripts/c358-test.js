// C-358 重現測試（R-4，昱志 v0.88.0）：在投信點「我的 AI」會跳回總覽，跟 AI 討論新角色就落到血汗勞工平台
// 修正後：在專案裡打開「我的 AI」留在那個專案（網址 /p/<專案>/my-ai），新角色用那個專案；在總覽打開照舊
// 不開瀏覽器：從 app.js 抽出 goTop、routePath、parseRoute、roleAiPj，用假的狀態跑
// 用法：node scripts/c358-test.js [要測的 app.js 路徑]
import fs from 'node:fs';
import assert from 'node:assert';

const js = fs.readFileSync(process.argv[2] || new URL('../public/app.js', import.meta.url), 'utf8');
const fnSrc = name => { // 抽出一個函式（function 或 const 箭頭）到它那一段結束
  const m = new RegExp(`\\n  (?:async )?function ${name}\\(|\\n  const ${name} = `).exec(js);
  assert.ok(m, '找不到 ' + name);
  let i = m.index + 1, depth = 0, started = false;
  for (let j = i; j < js.length; j++) {
    const c = js[j];
    if (c === '{' || c === '(') { depth++; started = true; } else if (c === '}' || c === ')') depth--;
    if (started && depth === 0 && (js[j + 1] === '\n' || js[j + 1] === ';')) return js.slice(i, j + 1) + ';';
  }
  throw new Error('抽不出 ' + name);
};
const has = name => new RegExp(`\\n  (?:async )?function ${name}\\(|\\n  const ${name} = `).test(js);

const calls = [];
const env = {
  state: { view: '投信', page: 'messages', projectList: [{ id: '平台', slug: 'platform' }, { id: '投信', slug: 'sitc' }], me: { projects: ['平台', '投信'] } },
  PROJECTS: ['平台', '投信'],
  closeSheet: () => {}, hasHub: () => true,
  showPage: p => { calls.push(['showPage', p]); env.state.page = p; },
  setProjectView: (v, p) => { calls.push(['setProjectView', v, p]); env.state.view = v; env.state.page = p; },
  TOP_PAGES: { myai: '/my-ai', perm: '/members' }, PAGE_SLUG: { messages: 'messages' }, PAGE_BY_NAME: {},
  location: { pathname: '/' }, canMakeRole: () => true,
};
const names = ['myProjects', 'projectView', ...(has('inProjectView') ? ['inProjectView'] : []), 'goTop', 'routePath', 'parseRoute', 'roleAiPj'];
const fns = new Function(...Object.keys(env), `${names.map(fnSrc).join('\n')}\nreturn { ${names.join(', ')} };`)(...Object.values(env));

try {
  // 在投信點「我的 AI」
  fns.goTop('myai');
  assert.equal(env.state.view, '投信', '留在投信：' + JSON.stringify(calls));
  assert.equal(env.state.page, 'myai');
  assert.equal(fns.routePath(), '/p/sitc/my-ai', '網址記得專案');
  assert.equal(fns.roleAiPj(), '投信', '跟 AI 討論新角色用投信');
  // 重新整理：/p/sitc/my-ai 回到投信的我的 AI
  env.location.pathname = '/p/sitc/my-ai';
  assert.deepEqual(fns.parseRoute(), { view: '投信', page: 'myai' }, '重新整理還在投信');
  // 在總覽點「我的 AI」：照舊（第一層頁面）
  env.state.view = 'hub'; env.state.page = 'hub'; calls.length = 0;
  fns.goTop('myai');
  assert.deepEqual(calls[0], ['setProjectView', 'hub', 'myai'], '總覽照舊');
  assert.equal(fns.routePath(), '/my-ai');
  // 成員與權限：照舊回總覽
  env.state.view = '投信'; calls.length = 0;
  fns.goTop('perm');
  assert.deepEqual(calls[0], ['setProjectView', 'hub', 'perm'], '成員與權限照舊');
  // 我的 AI 頁在專案裡只列這個專案的 AI，並可看全部
  assert.ok(js.includes("if (scope) items = items.filter(a => (a.projects || []).includes(scope)"), '只列這個專案的 AI');
  assert.ok(js.includes('id="ma-all">看全部 AI'), '可以看全部');
  console.log('c358-test：全部通過');
} catch (e) {
  console.error('c358-test 失敗：', e.message);
  process.exitCode = 1;
}
