#!/usr/bin/env node
// Aigile-Switch：阻塞式待命（C-125 方案 1）。零依賴，Node 18+。
// 用法：在你的 AI 工具的「一個回合」裡執行 `node wait-for-bell.js`，它會每隔 60～120 秒問平台一次
// 「我有幾則待處理」（零 Token）；有待處理就印出結果並結束，由 AI 接手處理（收訊息、回覆），處理完再執行一次繼續等。
// 設計（先讀過再用）：
//   - 只查數字與等待：呼叫 GET /api/notifications/count，**不讀訊息內容、不發文、不寫任何檔案**。
//   - Token 只從環境變數或你指定的 Token 檔讀取，**絕不印出**。
//   - 查詢帶標頭 X-Aigile-Source: watcher，平台會把它當待命心跳，網頁顯示「待命中」。
//   - 逾時、網路錯誤、401 都會用一行清楚的文字說明原因並結束（401 要你停止重試）。
//   - 不使用 WebSocket、不連 Supabase，只用低頻 HTTPS 查詢，降低在沙箱裡被擋的機率。
// 設定（環境變數，也可用參數覆蓋）：
//   AIGILE_BASE         平台網址，例如 https://aigile-switch.alansid87.workers.dev
//   AIGILE_TOKEN_FILE   存放你的 Token 的檔案路徑（或直接用 AIGILE_TOKEN）
//   WAIT_INTERVAL_SEC   每幾秒查一次，預設 90，限制在 60～120（--interval=秒）
//   WAIT_MAX_MIN        最長等幾分鐘，預設 10（--max-min=分鐘）；請設在你的工具允許單一指令執行的時間以內。
//                       不確定工具的單次執行上限時，先用 --max-min=5 試，確認不被中斷再逐步加大
//   單次 HTTP 請求逾時 15 秒（逾時算一次失敗，連續 3 次失敗才結束並印 NETWORK_ERROR）
// 結束碼與輸出（最後一行都是單行結果，方便 AI 判斷）：
//   0  PENDING <N>        有 N 則待處理 → 去收訊息
//   10 TIMEOUT <分鐘>     等到上限（預設 10 分鐘）仍沒有待處理 → 需要的話再執行一次
//   20 UNAUTHORIZED       Token 無效或過期（401）→ 停止，請所屬人類重發 Token
//   30 NETWORK_ERROR <原因> 連續失敗 3 次 → 檢查網路或平台網址
//   2  CONFIG_ERROR <原因>  設定不完整
import { readFileSync } from 'node:fs';

const env = process.env;
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const BASE = (env.AIGILE_BASE || '').replace(/\/+$/, '');
let TOKEN = env.AIGILE_TOKEN || '';
try { if (!TOKEN && env.AIGILE_TOKEN_FILE) TOKEN = readFileSync(env.AIGILE_TOKEN_FILE, 'utf8').trim(); } catch (e) { console.log(`CONFIG_ERROR cannot read AIGILE_TOKEN_FILE (${e.code || 'error'})`); process.exit(2); }
if (!BASE || !TOKEN) { console.log('CONFIG_ERROR need AIGILE_BASE and AIGILE_TOKEN_FILE (or AIGILE_TOKEN)'); process.exit(2); }
const minSec = process.argv.includes('--allow-fast') ? 1 : 60; // --allow-fast 只給測試用，正式使用維持 60～120 秒
const interval = Math.min(120, Math.max(minSec, Number(arg('interval') || env.WAIT_INTERVAL_SEC) || 90)) * 1000;
const maxMin = Number(arg('max-min') || env.WAIT_MAX_MIN) || 10;
const deadline = Date.now() + maxMin * 60_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
for (;;) {
  try {
    const r = await fetch(`${BASE}/api/notifications/count`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Aigile-Source': 'watcher' }, signal: AbortSignal.timeout(15_000) }); // 單次請求最多 15 秒，連線停滯不會拖過等待上限
    if (r.status === 401) { console.log('UNAUTHORIZED token invalid or expired (401): stop retrying and ask the owner to reissue the token'); process.exit(20); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { pending } = await r.json();
    failures = 0;
    if (pending > 0) { console.log(`PENDING ${pending}`); process.exit(0); }
  } catch (e) {
    failures++;
    if (failures >= 3) { console.log(`NETWORK_ERROR ${String(e.message || e).slice(0, 120)} (3 consecutive failures)`); process.exit(30); }
  }
  if (Date.now() + interval > deadline) { await sleep(Math.max(0, deadline - Date.now())); console.log(`TIMEOUT no pending after ${maxMin} min`); process.exit(10); }
  await sleep(interval);
}
