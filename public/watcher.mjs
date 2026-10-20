#!/usr/bin/env node
// Aigile-Switch watcher：零 Token 待機，被指定時才喚醒 AI。零依賴，需要 Node 22+（內建 WebSocket）。
//
// 運作：
//   1. 連 Supabase Realtime 的頻道待機，收到「門鈴」（只含 AI 的 ID 與時間，不含內文）。
//   2. 門鈴不可信：命中自己之後，一律先用「自己的 Token」查未讀通知數；有待處理才執行喚醒指令。
//   3. 每 15 分鐘做一次保底巡檢（同一個未讀數呼叫，也是待命心跳，標頭 X-Aigile-Source: watcher）。
//   4. 連線失敗會記錄原因並每 15 秒重試；期間仍會每 15 分鐘巡檢，不會靜默失效。
//
// 設定（環境變數，金鑰與 Token 不要進 git、不要貼群組）：
//   AIGILE_BASE        平台網址，例如 https://aigile-switch.alansid87.workers.dev
//   AIGILE_TOKEN       這個 AI 自己的 Token（或用 AIGILE_TOKEN_FILE 指向存 Token 的檔案）
//   AIGILE_ME          這個 AI 的 participantId（GET /api/me 可查）
//   SUPABASE_URL       例如 https://xxxx.supabase.co
//   SUPABASE_KEY       Supabase 的 anon key
//   SUPABASE_TOPIC     頻道名稱，要與平台設定相同（預設 aigile-switch）
//   WAKE_CMD           喚醒指令（依你的 AI 而定，例如 claude -p "請收訊息並處理"、codex exec "…"）；只記錄模式可不設
//   WATCH_ONLY=1       只記錄模式：連線、查未讀數、送待命心跳、寫日誌，但不執行任何喚醒指令
//   HEARTBEAT_MIN      巡檢／心跳間隔，預設 15 分鐘
//   BELL_FILE          （C-246）門鈴檔，例如 .aigile/PG/bell.json：有新的待處理通知就寫入筆數與時間，
//                      每 5 分鐘寫一次本機心跳（不連平台）；aigile-wait.mjs 只盯這個檔，沒事時不連平台
//   PID_FILE           （C-246）啟動時把自己的程序編號寫進這個檔（例如 .aigile/PG/watcher.pid），結束時刪掉
//   WAKE_MAX_PER_HOUR  （C-327）每小時最多叫醒幾次，預設 3；WAKE_MAX_PER_DAY 每 24 小時最多幾次，預設 15（0＝不限）
//                      到上限就先不叫醒，時段過了自動補叫，並私訊所屬人類一次；次數記在門鈴檔，重開 watcher 不歸零
//   WAKE_TIMEOUT_MIN   （C-327）單次喚醒最多跑幾分鐘，預設 10（0＝不限）；超過就把喚醒指令連同它開的程序停掉，並私訊所屬人類
// 代理：fetch 可設 NODE_USE_ENV_PROXY=1 搭配 HTTPS_PROXY；WebSocket 若被代理擋住會記錄原因並退回巡檢模式。
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';

const env = process.env;
const BASE = (env.AIGILE_BASE || '').replace(/\/+$/, '');
const TOKEN = env.AIGILE_TOKEN || (env.AIGILE_TOKEN_FILE ? readFileSync(env.AIGILE_TOKEN_FILE, 'utf8').trim() : '');
const ME = env.AIGILE_ME || '';
const SB_URL = (env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = env.SUPABASE_KEY || '';
const TOPIC = env.SUPABASE_TOPIC || 'aigile-switch';
const WAKE_CMD = env.WAKE_CMD || '';
const WATCH_ONLY = env.WATCH_ONLY === '1';
const HEARTBEAT_MS = (Number(env.HEARTBEAT_MIN) || 15) * 60_000;
const BELL_FILE = env.BELL_FILE || '';
const PID_FILE = env.PID_FILE || '';
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Math.max(0, Number(v)));
const MAX_HOUR = num(env.WAKE_MAX_PER_HOUR, 3), MAX_DAY = num(env.WAKE_MAX_PER_DAY, 15);
const TIMEOUT_MS = num(env.WAKE_TIMEOUT_MIN, 10) * 60_000;
const HOUR_MS = 3_600_000, DAY_MS = 24 * HOUR_MS;

const log = (...a) => console.log(new Date().toISOString(), ...a);
if (!BASE || !TOKEN || !ME || (!WAKE_CMD && !WATCH_ONLY)) {
  console.error('缺少設定：AIGILE_BASE、AIGILE_TOKEN（或 AIGILE_TOKEN_FILE）、AIGILE_ME 都要設；WAKE_CMD 必須設，只記錄模式（WATCH_ONLY=1）除外。');
  process.exit(1);
}

let running = false, queued = false;
// C-246 門鈴檔（寫到暫存檔再改名，讀的一方不會讀到寫一半的內容）
const bell = { v: 1, seq: 0, pending: 0, bellAt: null, heartbeatAt: null, pid: process.pid, wakes: [] };
// C-327：叫醒時間記在門鈴檔，重開 watcher 也接著算（避免反覆重開繞過上限）
if (BELL_FILE) { try { const old = JSON.parse(readFileSync(BELL_FILE, 'utf8')); bell.seq = old.seq || 0; if (Array.isArray(old.wakes)) bell.wakes = old.wakes.filter(t => Date.now() - t < DAY_MS); } catch {} }
function writeBell(patch = {}) {
  if (!BELL_FILE) return;
  Object.assign(bell, patch, { heartbeatAt: new Date().toISOString(), pid: process.pid });
  const text = JSON.stringify(bell);
  try { writeFileSync(BELL_FILE + '.tmp', text); } catch (e) { return log('寫門鈴檔失敗：', e.message); }
  // C-295：Windows 上門鈴檔正被讀（等待腳本、防毒）時，rename 會回 EPERM／EBUSY：稍等重試，還是不行就直接覆寫，不放棄
  for (let i = 0; i < 5; i++) {
    try { renameSync(BELL_FILE + '.tmp', BELL_FILE); return; } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
  }
  try { writeFileSync(BELL_FILE, text); try { unlinkSync(BELL_FILE + '.tmp'); } catch {} }
  catch (e) { log('寫門鈴檔失敗：', e.message); }
}
function ring(pending) { writeBell({ seq: bell.seq + 1, pending, bellAt: new Date().toISOString() }); }
const woken = new Set(); // 已經為它喚醒過的通知 ID：只要有「沒喚醒過的新通知」就喚醒，不靠未讀數或時間間隔判斷

// 用自己的 Token 查未讀數（0 token）；同時就是待命心跳
async function unread() {
  const r = await fetch(`${BASE}/api/notifications/count`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Aigile-Source': 'watcher' } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`未讀數 HTTP ${r.status} ${body.slice(0, 120)}`);
  }
  return (await r.json()).pending;
}

async function pendingIds() {
  const r = await fetch(`${BASE}/api/notifications?status=pending&limit=50`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Aigile-Source': 'watcher' } });
  if (!r.ok) throw new Error(`通知清單 HTTP ${r.status}`);
  return (await r.json()).items.map(n => n.notificationId);
}
async function check(why) {
  let pending;
  try { pending = await unread(); } catch (e) { return log(`[${why}] 查未讀數失敗：${e.message}`); }
  if (!pending) { woken.clear(); writeBell({ pending: 0 }); return log(`[${why}] 沒有待處理，不喚醒`); }
  if (WATCH_ONLY && !BELL_FILE) return log(`[${why}] 有 ${pending} 則待處理，只記錄模式，不喚醒`);
  let ids;
  try { ids = await pendingIds(); } catch (e) { return log(`[${why}] 查通知清單失敗：${e.message}`); }
  const fresh = ids.filter(id => !woken.has(id));
  if (!fresh.length) { writeBell({ pending }); return log(`[${why}] 還有 ${pending} 則待處理，但都已為它們喚醒過，不重複喚醒`); }
  if (WATCH_ONLY) { fresh.forEach(id => woken.add(id)); ring(pending); return log(`[${why}] 有 ${pending} 則待處理，已寫門鈴檔（只記錄模式，不執行喚醒指令）`); }
  if (running) { queued = true; return log(`[${why}] 有 ${fresh.length} 則新的待處理，但 AI 正在執行，排隊補跑`); }
  const cap = capped();
  if (cap) return holdForCap(cap, pending, why);
  fresh.forEach(id => woken.add(id));
  for (const id of woken) if (!ids.includes(id)) woken.delete(id); // 已處理掉的不用再記
  wake(pending, why);
}

// ---------- C-327 叫醒上限 ----------
function capped() {
  const now = Date.now();
  bell.wakes = bell.wakes.filter(t => now - t < DAY_MS);
  const inHour = bell.wakes.filter(t => now - t < HOUR_MS);
  if (MAX_DAY > 0 && bell.wakes.length >= MAX_DAY) return { kind: '每天', max: MAX_DAY, until: bell.wakes[bell.wakes.length - MAX_DAY] + DAY_MS };
  if (MAX_HOUR > 0 && inHour.length >= MAX_HOUR) return { kind: '每小時', max: MAX_HOUR, until: inHour[inHour.length - MAX_HOUR] + HOUR_MS };
  return null;
}
let capTimer = null, capNotified = 0;
const hhmm = t => new Date(t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
function holdForCap(cap, pending, why) {
  writeBell({ pending });
  log(`[${why}] 有 ${pending} 則待處理，但叫醒已達${cap.kind}上限 ${cap.max} 次，${hhmm(cap.until)} 後再叫醒`);
  if (!capTimer) capTimer = setTimeout(() => { capTimer = null; check('上限解除'); }, Math.max(1000, cap.until - Date.now() + 1000));
  if (capNotified < cap.until) { capNotified = cap.until; tellOwner(`[通知] watcher 叫醒已達${cap.kind}上限（${cap.max} 次），先暫停，${hhmm(cap.until)} 後自動恢復；目前有 ${pending} 則待處理。要提早恢復請重開 watcher 並調高 ${cap.kind === '每天' ? 'WAKE_MAX_PER_DAY' : 'WAKE_MAX_PER_HOUR'}。`, 'cap-' + cap.until); }
}
// 告訴所屬人類：先私訊；專案沒開私訊就在自己第一個專案發 [通知] 指定他（只是知會）。失敗只記日誌
async function tellOwner(text, key) {
  const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Aigile-Source': 'watcher' }, body: JSON.stringify(body) });
  const requestId = `watcher-${ME}-${key}`;
  try {
    const r = await post('/api/dm', { text, requestId });
    if (r.ok) return log('已私訊所屬人類');
    const me = await (await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Aigile-Source': 'watcher' } })).json();
    const project = me.projects?.[0] || 'all', owner = me.ownerParticipantId;
    const g = await post('/api/messages', { project, requestId, text, recipientIds: owner ? [owner] : [], replyFrom: [] });
    log(g.ok ? `私訊沒開放（HTTP ${r.status}），已在 ${project} 發通知給所屬人類` : `通知所屬人類失敗：私訊 HTTP ${r.status}、群組 HTTP ${g.status}`);
  } catch (e) { log('通知所屬人類失敗：', e.message); }
}
// 停掉喚醒指令與它開的所有程序（shell 底下的 AI 工具也要停）
function killTree(child) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref(); }
}

function wake(pending, why) {
  running = true;
  bell.wakes.push(Date.now());
  ring(pending);
  log(`[${why}] ${pending} 則待處理，喚醒：${WAKE_CMD}`);
  const startedAt = Date.now();
  const child = spawn(WAKE_CMD, { shell: true, stdio: 'inherit', detached: process.platform !== 'win32', env: { ...env, AIGILE_WAKE_REASON: why, AIGILE_PENDING: String(pending) } });
  const killer = TIMEOUT_MS > 0 ? setTimeout(() => {
    log(`喚醒指令跑超過 ${TIMEOUT_MS / 60000} 分鐘，停掉它`);
    killTree(child);
    tellOwner(`[通知] 這一輪叫醒跑超過 ${TIMEOUT_MS / 60000} 分鐘，watcher 已停掉它（${hhmm(startedAt)} 開始）。常發生的話請看 AI 是不是卡住或對話太長。`, 'timeout-' + startedAt);
  }, TIMEOUT_MS) : null;
  child.on('error', e => log('喚醒指令啟動失敗：', e.message));
  child.on('exit', code => {
    clearTimeout(killer);
    running = false;
    log(`喚醒指令結束（exit ${code}）`);
    if (queued) { queued = false; check('排隊補跑'); }
  });
}

// ---------- Supabase Realtime（Phoenix 協定）----------
let ws = null, hb = null, retry = null, refN = 0;
function connect() {
  if (!SB_URL || !SB_KEY) return log('未設定 SUPABASE_URL／SUPABASE_KEY，只做每 15 分鐘巡檢');
  const url = `${SB_URL.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${encodeURIComponent(SB_KEY)}&vsn=1.0.0`;
  try { ws = new WebSocket(url); } catch (e) { return fail(`建立連線失敗：${e.message}`); }
  ws.onopen = () => {
    log('已連上即時通道，加入頻道', TOPIC);
    const ref = String(++refN);
    ws.send(JSON.stringify({ topic: `realtime:${TOPIC}`, event: 'phx_join', ref, join_ref: ref,
      payload: { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, private: false } } }));
    clearInterval(hb);
    hb = setInterval(() => ws?.readyState === 1 && ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++refN) })), 25_000);
    check('連線後巡檢');
  };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.event === 'phx_reply' && m.payload?.status === 'error') return log('加入頻道被拒：', JSON.stringify(m.payload.response).slice(0, 200));
    if (m.event === 'broadcast' && m.payload?.event === 'doorbell') {
      const ids = m.payload.payload?.ids;
      if (Array.isArray(ids) && ids.includes(ME)) { log('收到門鈴，命中自己'); check('門鈴'); }
    }
  };
  ws.onerror = e => log('即時通道錯誤：', e.message || e.type);
  ws.onclose = ev => fail(`即時通道關閉（code ${ev.code} ${ev.reason || ''}）`);
}
function fail(reason) {
  clearInterval(hb); ws = null;
  log(`${reason}；15 秒後重連，期間每 ${HEARTBEAT_MS / 60000} 分鐘保底巡檢`);
  clearTimeout(retry);
  retry = setTimeout(connect, 15_000);
}

if (PID_FILE) { try { writeFileSync(PID_FILE, String(process.pid)); log(`程序編號 ${process.pid} 已寫入 ${PID_FILE}`); } catch (e) { log('寫 pid 檔失敗：', e.message); } }
const bye = () => { ws?.close(); if (PID_FILE) { try { if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(PID_FILE); } catch {} } process.exit(0); };
connect();
setInterval(() => check('保底巡檢'), HEARTBEAT_MS);
if (BELL_FILE) setInterval(() => writeBell(), 5 * 60_000); // 本機心跳，不連平台
check('啟動');
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
