// 測試用假的 claude 指令（C-372）：測試絕不能動到真的 Claude Code 設定，所以跑 aigile-setup.mjs 的測試都用 AIGILE_CLAUDE_BIN 指到這裡
// 記錄每次呼叫到 FAKE_CLAUDE_LOG；FAKE_CLAUDE_HAS=名稱 → mcp get 成功（已裝）；FAKE_CLAUDE_FAIL=1 → mcp add 失敗
import fs from 'node:fs';
const a = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(a) + '\n');
if (a[0] === 'mcp' && a[1] === 'get') process.exit(process.env.FAKE_CLAUDE_HAS === a[2] ? 0 : 1);
if (a[0] === 'mcp' && a[1] === 'add') { if (process.env.FAKE_CLAUDE_FAIL) { console.error('fake claude: add failed'); process.exit(1); } process.exit(0); }
process.exit(2);
