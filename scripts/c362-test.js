// C-362 重現測試（R-5，昱志 v0.88.0）：從「成員與權限」或總覽開「我的 AI」→ 新增／編輯 AI →「＋ 跟 AI 討論新角色」，一律落到平台
// 修正後：看表單勾的所屬專案；在專案裡用那個專案（C-358）；能建的只有一個就用它；兩個以上不默默選，回 null 讓人選
// 不開瀏覽器：從 app.js 抽出 roleAiPjs、roleAiPj，用假的狀態跑
// 用法：node scripts/c362-test.js [要測的 app.js 路徑]
import fs from 'node:fs';
import assert from 'node:assert';

const js = fs.readFileSync(process.argv[2] || new URL('../public/app.js', import.meta.url), 'utf8');
const fnSrc = name => {
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

const env = { state: { view: 'hub', me: { projects: ['平台', '投信'] } }, PROJECTS: ['平台', '投信'], lead: ['平台', '投信'] };
env.canMakeRole = pj => env.lead.includes(pj);
const names = ['myProjects', 'projectView', ...(has('roleAiPjs') ? ['roleAiPjs'] : []), 'roleAiPj'];
const fns = new Function(...Object.keys(env), `${names.map(fnSrc).join('\n')}\nreturn { ${names.join(', ')} };`)(...Object.values(env));

try {
  // 1. 總覽／成員與權限（不在專案裡），兩個專案都能建、表單還沒勾 → 不能默默變平台
  assert.notEqual(fns.roleAiPj([]), '平台', '總覽打開不該默默用平台');
  assert.equal(fns.roleAiPj([]), null, '兩個以上要讓人選');
  // 2. 表單勾了投信（例如編輯投信的 AI）→ 投信
  assert.equal(fns.roleAiPj(['投信']), '投信', '照表單勾的所屬專案');
  // 3. 投信成員（只在投信能建角色）從總覽打開 → 投信
  env.lead.splice(0, env.lead.length, '投信');
  assert.equal(fns.roleAiPj([]), '投信', '只有一個能建就用它');
  assert.equal(fns.roleAiPj(['平台']), '投信', '勾的專案不能建角色時，退回能建的那個');
  // 4. C-358 不受影響：在投信裡打開 → 投信
  env.lead.splice(0, env.lead.length, '平台', '投信');
  env.state.view = '投信';
  assert.equal(fns.roleAiPj([]), '投信', 'C-358 在專案裡用那個專案');
  assert.equal(fns.roleAiPj(['平台', '投信']), '投信', 'C-358 在專案裡、兩個都勾還是用這個專案');
  // 5. 表單：沒決定時跳出選專案，不再 if (pj) 就略過
  assert.ok(js.includes('pickRoleAiPj('), '要有選專案的視窗');
  assert.ok(js.includes('新角色要建在哪個專案？'), '畫面寫明建在哪個專案');
  console.log('c362-test：全部通過');
} catch (e) {
  console.error('c362-test 失敗：', e.message);
  process.exitCode = 1;
}
