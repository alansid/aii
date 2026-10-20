#!/usr/bin/env node
// Aigile-Switch 等待腳本（C-246）：AI 處理完手上的事就執行它，有事才結束，讓 AI 被叫醒。零依賴，Node 18+，Windows／Mac／Linux。
//
// 運作：
//   1. 啟動時用自己的 Token 查一次待處理數（抓處理期間進來的通知）；有就立刻結束。
//   2. 之後只盯本機門鈴檔 .aigile/<代號>/bell.json（watcher 寫的）：fs.watch＋每 30 秒看一次。
//      沒事時不連平台、不讀資料庫。
//   3. watcher 不在（watcher.pid 的程序不在，或門鈴檔超過 30 分鐘沒心跳）：印一次 WARN，
//      改成每 10 分鐘問一次待處理數（備援）；watcher 回來就恢復只盯門鈴檔。
//   4. 不讀訊息內容、不發文、不寫任何檔案；Token 不會印出。
//
// 用法：node aigile-wait.mjs --agent PG [--max-min=110]
//   需要 AIGILE_BASE（沒設就讀 .aigile/<代號>/watcher.env），以及 AIGILE_TOKEN 或 AIGILE_TOKEN_FILE（預設 .aigile/<代號>/.token）。
//   Claude Code：用背景指令執行、逾時設最長，結束時會通知你；處理完再執行一次。不要用 Monitor、不要 sleep 迴圈。
//   Codex 等只能在回合內執行的工具：前景執行，--max-min 設在工具的時間上限內。
//
// 輸出最後一行（與結束碼）：
//   PENDING <n>      0   有 n 則待處理：收訊息、處理、回覆，做完再執行一次
//   RECOVERED        0   備援模式下平台從錯誤恢復：跑一輪確認，再執行一次
//   TIMEOUT          10  時間到、沒有事：直接再執行一次
//   UNAUTHORIZED     20  Token 無效或過期：停止，告訴所屬人類
//   NETWORK_ERROR    30  備援模式連續 3 次連不上：停止，告訴所屬人類
//   CONFIG_ERROR     40  設定缺少：停止，告訴所屬人類
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  return args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1];
};
const AGENT = String(opt('agent', process.env.AIGILE_AGENT || 'default'));
const DIR = path.resolve(opt('dir', path.join('.aigile', AGENT)));
const MAX_MS = Math.max(0.01, Number(opt('max-min', 110))) * 60_000;
const POLL_MS = Math.max(1, Number(opt('poll-sec', 600))) * 1000;     // 備援：每 10 分鐘
const LOOK_MS = Math.max(1, Number(opt('look-sec', 30))) * 1000;      // 門鈴檔：每 30 秒看一次
const ALIVE_MS = Math.max(1, Number(opt('alive-sec', 60))) * 1000;    // watcher 在不在：每分鐘看一次
const STALE_MS = Math.max(1, Number(opt('stale-min', 30))) * 60_000;  // 門鈴檔心跳超過 30 分鐘＝watcher 不在
const BELL = path.join(DIR, 'bell.json');
const PIDF = path.join(DIR, 'watcher.pid');
// 沒帶 --env-file 也找得到平台：讀同代號的 watcher.env（C-328）
let envBase = '';
try { envBase = /^AIGILE_BASE=(.*)$/m.exec(fs.readFileSync(path.join(DIR, 'watcher.env'), 'utf8'))?.[1].trim() || ''; } catch {}
const BASE = (process.env.AIGILE_BASE || envBase).replace(/\/+$/, '');
const tokenFile = process.env.AIGILE_TOKEN_FILE || path.join(DIR, '.token');
let TOKEN = '';
try { TOKEN = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {} // 檔案為準，舊的 AIGILE_TOKEN 環境變數不能蓋掉它
TOKEN = TOKEN || process.env.AIGILE_TOKEN || '';

const finish = (line, code) => { console.log(line); process.exit(code); };
const note = line => console.log(`${new Date().toISOString()} ${line}`);
if (!BASE || !TOKEN) finish('CONFIG_ERROR', 40);

class Unauthorized extends Error {}
async function count() {
  const r = await fetch(`${BASE}/api/notifications/count?wake=1`, { // C-341：只算要叫醒的，知會類不算
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Aigile-Source': 'wait' }, signal: AbortSignal.timeout(15_000),
  });
  if (r.status === 401) throw new Unauthorized();
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return j.wake ?? j.pending; // 舊平台沒有 wake 就照舊看 pending
}
const readBell = () => { try { return JSON.parse(fs.readFileSync(BELL, 'utf8')); } catch { return null; } };
const pidAlive = () => {
  let pid;
  try { pid = Number(fs.readFileSync(PIDF, 'utf8').trim()); } catch { return false; }
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const watcherAlive = () => {
  const b = readBell();
  return pidAlive() && !!b?.heartbeatAt && Date.now() - Date.parse(b.heartbeatAt) < STALE_MS;
};

// 1. 啟動時查一次（門鈴編號先記下，查詢期間響的門鈴才不會漏掉）
let seq = readBell()?.seq ?? 0;
try {
  const n = await count();
  if (n > 0) finish(`PENDING ${n}`, 0);
} catch (e) {
  if (e instanceof Unauthorized) finish('UNAUTHORIZED', 20);
  note(`WARN 啟動時查待處理數失敗（${e.message}），先等門鈴`);
}

// 2. 只盯門鈴檔
const onBell = () => {
  const b = readBell();
  if (b && b.seq > seq && b.pending > 0) finish(`PENDING ${b.pending}`, 0);
  if (b && b.seq > seq) seq = b.seq;
};
try { fs.watch(DIR, (_, name) => { if (!name || String(name).startsWith('bell.json')) onBell(); }); } catch {}
setInterval(onBell, LOOK_MS);

// 3. watcher 不在：備援每 10 分鐘問一次
let fallback = null, fails = 0, hadError = false;
async function poll() {
  try {
    const n = await count();
    if (n > 0) finish(`PENDING ${n}`, 0);
    if (hadError) finish('RECOVERED', 0);
    fails = 0;
  } catch (e) {
    if (e instanceof Unauthorized) finish('UNAUTHORIZED', 20);
    fails++; hadError = true;
    note(`WARN 備援查詢失敗（${e.message}），第 ${fails} 次`);
    if (fails >= 3) finish('NETWORK_ERROR', 30);
  }
}
function checkWatcher() {
  const alive = watcherAlive();
  if (!alive && !fallback) {
    note(`WARN watcher 不在（${PIDF} 的程序不在，或門鈴檔超過 ${STALE_MS / 60000} 分鐘沒心跳），改成每 ${POLL_MS / 60000} 分鐘問一次待處理數`);
    fallback = setInterval(poll, POLL_MS);
  } else if (alive && fallback) {
    note('watcher 回來了，恢復只盯門鈴檔');
    clearInterval(fallback); fallback = null; fails = 0; hadError = false;
    seq = readBell()?.seq ?? seq;
  }
}
checkWatcher();
setInterval(checkWatcher, ALIVE_MS);

// 4. 時間到
setTimeout(() => finish('TIMEOUT', 10), MAX_MS);
