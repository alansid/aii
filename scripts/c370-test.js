// C-370 重現測試：aigile-setup.mjs 印的 MCP 名稱固定叫 aigile，同台第二個 AI 會撞名或用到別人的身分
// 修正後：名稱 aigile-<代號小寫>（Claude Code、Codex 都是），並提醒在自己的工作資料夾執行、只掛自己的；規格 3.18 同步
// 用法：node scripts/c370-test.js
import fs from 'node:fs';
import assert from 'node:assert';

const setup = fs.readFileSync(new URL('../public/aigile-setup.mjs', import.meta.url), 'utf8');
const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
try {
  assert.ok(!/claude mcp add aigile -- /.test(setup), 'Claude Code 名稱不能固定叫 aigile');
  assert.ok(!/\[mcp_servers\.aigile\]/.test(setup), 'Codex 名稱不能固定叫 aigile');
  assert.match(setup, /const mcpName = `aigile-\$\{AGENT\.toLowerCase\(\)\}`/, '名稱帶代號小寫');
  assert.match(setup, /addArgs = \['mcp', 'add', mcpName/, 'Claude Code 用帶代號的名稱（C-372 起由腳本直接裝）');
  assert.match(setup, /\[mcp_servers\.\$\{mcpName\}\]/, 'Codex 用帶代號的名稱');
  assert.match(setup, /同資料夾多個 AI 可並存/, 'C-372：同資料夾多個 AI 可並存');
  assert.match(setup, /同台/, '提醒同台多個 AI 各用自己的名稱');
  const s318 = spec.slice(spec.indexOf('### 3.18 MCP'));
  assert.match(s318, /aigile-<代號小寫>/, '規格 3.18 寫名稱');
  assert.match(s318, /同資料夾多個 AI 可並存/, 'C-372：規格 3.18 寫可並存');
  console.log('c370-test：全部通過');
} catch (e) {
  console.error('c370-test 失敗：', e.message);
  process.exitCode = 1;
}
