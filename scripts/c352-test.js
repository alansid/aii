// C-352 退回（UX 10/21）重現測試：我的 AI
// 1. 最下面一列按 ⋯，選單被框裁掉 → 改浮層，下面放不下就往上開
// 2. 沒頭像的 AI 方塊放整個角色名（擠兩行）→ 放角色代碼或名字第一個字
// 3. 手機第二行開頭多一個「·」（角色、環境都空時）
// 不開瀏覽器：把 app.js 裡我的 AI 那段抽出來，用假的 DOM 跑
// 用法：node scripts/c352-test.js [要測的 app.js 路徑]
import fs from 'node:fs';
import assert from 'node:assert';

const js = fs.readFileSync(process.argv[2] || new URL('../public/app.js', import.meta.url), 'utf8');
const a = js.indexOf('  // C-352 我的 AI（UX 稿 v75）'), b = js.indexOf('  async function openMyAi(');
const src = js.slice(a, b);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const avatar = p => `<span class="avatar">${esc(p.avatar || p.role)}</span>`;
const env = { esc, avatar, tokenLevel: () => '', fmtTime: x => x, mmdd: () => '10/28', state: { projMeta: { crossRoleIds: [] } }, PROJECTS: ['平台'],
  projTag: p => `<span class="ptag">${p}</span>`, CONVO_OPTS: [['', '依所在環境（建議）']], CONVO_HINT: { '': '', auto: '', keep: '' }, grantsBlock: () => '', innerHeight: 700, innerWidth: 1200 };
const fn = new Function(...Object.keys(env), `${src}; return { myAiRowHtml: typeof myAiRowHtml === 'function' ? myAiRowHtml : null, maPlaceMenu: typeof maPlaceMenu === 'function' ? maPlaceMenu : null };`);
const { myAiRowHtml, maPlaceMenu } = fn(...Object.values(env));

try {
  assert.ok(myAiRowHtml, '找得到 myAiRowHtml');
  const ai = (o = {}) => ({ participantId: 'p1', name: '平台QA', status: 'active', role: '', roleKey: 'custom', environment: '', projects: [], expiresAt: '2026-10-28T00:00:00Z', ...o });
  // 2. 頭像：角色代碼（英文 2～4 字）或名字第一個字，不放整個角色名
  assert.match(myAiRowHtml(ai({ roleKey: 'qa', role: '品質保證' })), /<span class="avatar">QA<\/span>/, '有角色代碼放代碼');
  assert.match(myAiRowHtml(ai({ roleKey: 'custom', role: '程式／開發' })), /<span class="avatar">平<\/span>/, '自訂角色放名字第一個字');
  assert.match(myAiRowHtml(ai({ avatar: '🤖', roleKey: 'PG' })), /<span class="avatar">🤖<\/span>/, '有自己的頭像就用自己的');
  // 3. 角色、環境都空：第二行不以「·」開頭
  const meta = /<div class="ma-meta">([\s\S]*?)<\/div>/.exec(myAiRowHtml(ai({ projects: ['平台'] })))[1];
  assert.ok(!/^\s*(<span[^>]*>)?\s*·/.test(meta), '第二行開頭沒有「·」：' + meta);
  // 1. 選單用浮層：最下面一列（按鈕在視窗底部）往上開；上面一列往下開
  assert.ok(maPlaceMenu, '有放選單位置的函式');
  const place = btnTop => {
    const m = { offsetHeight: 260, style: {} };
    const btn = { getBoundingClientRect: () => ({ top: btnTop, bottom: btnTop + 34, right: 1100 }) };
    m.parentElement = { querySelector: () => btn };
    maPlaceMenu({ querySelector: () => m });
    return m.style;
  };
  let st = place(640);
  assert.equal(st.position, 'fixed', '浮層，不被框裁掉');
  assert.equal(st.top, `${640 - 260 - 4}px`, '底部那列往上開');
  st = place(100);
  assert.equal(st.top, `${100 + 34 + 4}px`, '上面那列往下開');
  assert.equal(st.right, '100px', '貼著按鈕右邊');
  console.log('c352-test：全部通過');
} catch (e) {
  console.error('c352-test 失敗：', e.message);
  process.exitCode = 1;
}
