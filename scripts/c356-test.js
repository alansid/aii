// C-356 重現測試：Codex 沒開網路時，連規格都下載不到 → 開網路的說明與症狀要寫在「複製短版接入」貼上的文字裡
// 修正前：只寫「curl 錯誤 7」，沒寫 127.0.0.1:9／連線被拒，也沒叫 AI 別說成代理問題（昱志 10/21 09:31 實測 AI 回「請確認行內代理」）
// 用法：node scripts/c356-test.js [要測的 app.js 路徑]
import fs from 'node:fs';
import assert from 'node:assert';

const js = fs.readFileSync(process.argv[2] || new URL('../public/app.js', import.meta.url), 'utf8');
const i0 = js.indexOf('  function shortOnboardingText'), i1 = js.indexOf('\n  }\n', i0) + 4;
const state = { me: { name: '劉昱志' } };
const shortOnboardingText = new Function('state', `${js.slice(i0, i1)}; return shortOnboardingText;`)(state);
const text = shortOnboardingText({ name: 'codex-pg', role: 'PG' }, { agent: 'PG_ABCD', url: 'https://x/api/setup/abc' });

try {
  assert.match(text, /sandbox_mode = "workspace-write"/, '貼上的文字就有 sandbox 設定');
  assert.match(text, /network_access = true/, '貼上的文字就有 network_access');
  assert.ok(text.indexOf('network_access') < text.indexOf('curl -s'), '開網路寫在下載之前（先確認再下載）');
  for (const k of ['127.0.0.1:9', 'curl 錯誤 7', '連線被拒']) assert.ok(text.includes(k), '寫出症狀：' + k);
  assert.match(text, /不是代理/, '叫 AI 別說成代理問題');
  assert.match(text, /開 network_access 後重開 Codex/, '告訴主人的那句話寫好');
  assert.ok(!/貼到群組。$/.test(text) || text.includes('不要貼到群組'), '其他規則還在');
  console.log('c356-test：全部通過');
} catch (e) {
  console.error('c356-test 失敗：', e.message);
  process.exitCode = 1;
}
