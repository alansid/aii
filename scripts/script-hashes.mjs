// C-338 C4：AI 下載的腳本雜湊自動產生，不再手寫在 src/core.js。
// 接入設定與 GET /api/me/watcher-env 附這些雜湊，讓 AI 下載後核對。
//   部署：scripts/releases.mjs（npm run deploy 會先跑）寫進 generated/script-hashes.json，worker.js 打包進去
//   本機 server.js 與測試：直接呼叫 scriptHashes() 從 public/ 算，永遠是最新
// 用法：node scripts/script-hashes.mjs   印出目前的雜湊
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const HASHED_SCRIPTS = ['watcher.mjs', 'aigile-wait.mjs', 'aigile-setup.mjs', 'aigile-opencode.mjs', 'aigile-mcp.mjs']; // aigile-mcp：C-355 MCP 轉接
const pub = new URL('../public/', import.meta.url);

export function scriptHashes() {
  return Object.fromEntries(HASHED_SCRIPTS.map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(new URL(f, pub))).digest('hex')]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) console.log(JSON.stringify(scriptHashes(), null, 2));
