#!/usr/bin/env node
// Aigile-Switch 無人值守自動回覆（C-125，行內 QA 試點）。零依賴，Node 22+。由 watcher 在「被 @ 且確認有待處理」時執行。
//
// 安全設計（昱志與 PO 要求）：
//   - 背景 LLM（例如 codex exec）在「空的暫存資料夾」執行，只拿被 @ 的訊息文字，用唯讀沙箱、不給工具，只回 JSON。
//   - 由這支腳本檢查 JSON 後，才代為發文、ACK。LLM 不能呼叫平台 API，也看不到 Token（子行程環境已移除）。
//   - 只連平台一個網址；訊息文字只交給 LLM 指令，不送到其他地方。
//   - 範圍只有簡短回覆、接單、發 [需確認]；純授權確認、[完成]、[通知]、簽到、[決策紀錄] 不回。
//   - 上限：每小時 6 次、每日 30 次、同一討論串由 AI 觸發最多 3 次；達上限就停並記錄，不 ACK（留給人處理）。
//   - 停用開關：STATE_DIR 裡有 wake-qa.stop 這個檔案，就一律不呼叫 LLM。
//   - 回覆文字若像行內內容（路徑、類別名稱、SQL、程式碼、疑似金鑰）一律不發，改記錄。
//   - 乾跑：DRY_RUN=1 只顯示「會交給 LLM 的內容」，不呼叫 LLM、不發文、不 ACK。
//
// 【目前狀態】C-125 暫緩「真實呼叫 LLM」：codex exec 無法停用 shell，唯讀沙箱不等於無工具（PO／QA 2026-10-15 結論）。
//   在昱志決定改走哪條路之前，請只用 DRY_RUN=1 乾跑，不要設定 WAKE_LLM_CMD 去真實呼叫。
//
// 環境變數（Token 與金鑰只放環境變數）：
//   AIGILE_BASE、AIGILE_TOKEN（或 AIGILE_TOKEN_FILE）、AIGILE_ME  同 watcher
//   WAKE_LLM_CMD   背景 LLM 指令：從標準輸入讀 prompt，把「最後的回答」印到標準輸出（例如依你的 codex exec 版本組成）
//   STATE_DIR      狀態與記錄放哪（預設目前資料夾）：wake-qa-state.json、wake-usage.jsonl、wake-qa.stop
//   DRY_RUN=1      乾跑
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = process.env;
const BASE = (env.AIGILE_BASE || '').replace(/\/+$/, '');
const TOKEN = env.AIGILE_TOKEN || (env.AIGILE_TOKEN_FILE ? readFileSync(env.AIGILE_TOKEN_FILE, 'utf8').trim() : '');
const ME = env.AIGILE_ME || '';
const LLM_CMD = env.WAKE_LLM_CMD || '';
const DIR = env.STATE_DIR || process.cwd();
const DRY = env.DRY_RUN === '1';
const LIMITS = { perHour: 6, perDay: 30, aiChainPerThread: 3 };
const TAGS = ['接單', '進度', '完成', '需確認', '受阻', '交接', '回覆'];
const log = (...a) => console.log(new Date().toISOString(), ...a);
const file = n => join(DIR, n);
const record = rec => appendFileSync(file('wake-usage.jsonl'), JSON.stringify({ at: new Date().toISOString(), why: env.AIGILE_WAKE_REASON, ...rec }) + '\n');

if (!BASE || !TOKEN || !ME || (!LLM_CMD && !DRY)) { console.error('缺少設定：AIGILE_BASE、AIGILE_TOKEN（或 TOKEN_FILE）、AIGILE_ME、WAKE_LLM_CMD（乾跑可不設）。'); process.exit(1); }

async function api(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} HTTP ${r.status} ${j?.error?.code || ''}`);
  return j;
}
class Exit extends Error { constructor(code) { super('exit'); this.code = code; } }
const stop = reason => { record({ stopped: reason }); log('停止：', reason); (() => { throw new Exit(0); })(); };

try {
// ---- 0. 停用開關 ----
if (existsSync(file('wake-qa.stop'))) stop('存在 wake-qa.stop，已停用');

// ---- 1. 收通知（不花額度）；沒有就不叫 LLM ----
const notifs = (await api('GET', '/api/notifications?status=pending&limit=20')).items || [];
if (!notifs.length) { record({ skipped: '沒有待處理，不呼叫 LLM' }); log('沒有待處理'); (() => { throw new Exit(0); })(); }
const msgs = [];
for (const n of notifs) {
  const m = await api('GET', `/api/messages/${encodeURIComponent(n.messageId)}`);
  msgs.push({ n, m });
}

// ---- 2. 上限 ----
const stateFile = file('wake-qa-state.json');
const st = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { runs: [], threads: {} };
const now = Date.now();
st.runs = st.runs.filter(t => now - t < 24 * 3600_000);
if (!DRY) {
  if (st.runs.filter(t => now - t < 3600_000).length >= LIMITS.perHour) stop(`每小時 ${LIMITS.perHour} 次已達上限`);
  if (st.runs.length >= LIMITS.perDay) stop(`每日 ${LIMITS.perDay} 次已達上限`);
  for (const { m } of msgs) {
    if (m.author?.memberType !== 'ai') continue;
    const key = m.replyToMessageId || m.messageId;
    st.threads[key] = (st.threads[key] || []).filter(t => now - t < 24 * 3600_000);
    if (st.threads[key].length >= LIMITS.aiChainPerThread) stop(`同一討論串（${key}）由 AI 觸發已達 ${LIMITS.aiChainPerThread} 次，改等人類`);
  }
}

// ---- 3. 交給背景 LLM（空資料夾、只拿訊息文字、只回 JSON）----
const lines = msgs.map(({ n, m }) => ({ messageId: m.messageId, from: m.author?.name, replyTo: m.replyToMessageId || null, text: m.text.slice(0, 1500) }));
const prompt = `你是群組協作平台上的「QA」助手。你被指定回覆，以下是指定給你的訊息。你沒有任何工具，也不能讀任何檔案，只能回一份 JSON，由外部腳本檢查後代你發文。
規則：
- 只在需要時簡短回覆（一兩句，500 字內）。純授權確認（同意 push／commit／照辦／暫緩處理）、[完成]、[通知]、[決策紀錄]、簽到、感謝、標明「不需回覆」的訊息，一律不回（replies 給空陣列）。
- 標籤放最前面，必須是 [接單]、[進度]、[完成]、[需確認]、[受阻]、[交接]、[回覆] 其中之一；標籤後加【平台】。
- 你無法在這個模式做實際驗收或查任何東西。若訊息要你做驗收：只回 [接單] 說明已收到、等 QA 本機對話處理；需要人決定的事回 [需確認]。不確定就不回。
- 不要寫路徑、檔名、類別名稱、SQL、程式碼、Token 或金鑰；不要 @ 別人。
只輸出 JSON，不要其他文字：{"replies":[{"replyTo":"<要回覆的 messageId>","text":"..."}],"note":"一句話說明"}
指定給你的訊息：
${JSON.stringify(lines, null, 1)}`;
if (DRY) { console.log('--- 乾跑：以下是會交給背景 LLM 的內容（不呼叫 LLM、不發文、不 ACK）---\n' + prompt); record({ dryRun: true, notifications: notifs.length }); (() => { throw new Exit(0); })(); }

const work = mkdtempSync(join(tmpdir(), 'wake-qa-'));
const childEnv = { ...env }; // 子行程拿不到平台 Token 與 Supabase 金鑰
for (const k of ['AIGILE_TOKEN', 'AIGILE_TOKEN_FILE', 'SUPABASE_KEY', 'SUPABASE_URL', 'SUPABASE_TOPIC']) delete childEnv[k];
const t0 = Date.now();
const r = spawnSync(LLM_CMD, { input: prompt, encoding: 'utf8', shell: true, cwd: work, env: childEnv, timeout: 180_000, maxBuffer: 5 * 1024 * 1024 });
rmSync(work, { recursive: true, force: true });
st.runs.push(now);
for (const { m } of msgs) if (m.author?.memberType === 'ai') (st.threads[m.replyToMessageId || m.messageId] ||= []).push(now);
writeFileSync(stateFile, JSON.stringify(st, null, 2));
if (r.status !== 0) { record({ error: `LLM 指令失敗 exit ${r.status}`, stderr: String(r.stderr).slice(0, 200) }); log('LLM 失敗，不 ACK：', r.status); (() => { throw new Exit(1); })(); }

// ---- 4. 檢查輸出、代為發文 ----
let out; try { out = JSON.parse(String(r.stdout).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { out = null; }
if (!out || !Array.isArray(out.replies)) { record({ error: '輸出不是預期的 JSON', outLen: String(r.stdout).length }); log('輸出格式錯誤，不 ACK'); (() => { throw new Exit(1); })(); }
const allowedTo = new Map(msgs.map(({ m }) => [m.messageId, m]));
// 像行內內容的文字一律不發：路徑、副檔名、類別名稱、SQL、程式碼區塊、疑似金鑰或長雜湊
const LOOKS_INTERNAL = [/[A-Za-z]:\\/, /(^|\s)\/(home|Users|opt|var|usr|etc)\//, /\.(java|cs|sql|xml|config|properties|ps1|sh|py|js|ts|dll|jar)\b/i, /\b(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,40}\b(FROM|INTO|SET)\b/i,
  /```/, /\b(class|interface|namespace|package)\s+[A-Z]\w+/, /eyJ[A-Za-z0-9_-]{20,}/, /[A-Za-z0-9_-]{40,}/, /\b[0-9a-f]{32,}\b/i];
let posted = 0, blocked = 0;
for (const rep of out.replies.slice(0, 3)) {
  const text = String(rep.text || '').trim();
  const tag = /^\[([^\]\n]{1,10})\]/.exec(text)?.[1];
  const target = allowedTo.get(rep.replyTo);
  if (!target || !TAGS.includes(tag) || text.length > 2000 || /@/.test(text)) { log('略過不合格回覆：', text.slice(0, 40)); blocked++; continue; }
  if (LOOKS_INTERNAL.some(re => re.test(text))) { log('回覆疑似含行內內容，不發，改記錄'); record({ blockedInternalLooking: text.slice(0, 80) }); blocked++; continue; }
  await api('POST', '/api/messages', { requestId: `wakeqa_${rep.replyTo}`, text, replyToMessageId: rep.replyTo, ...(target.author?.participantId && target.author.participantId !== ME ? { recipientIds: [target.author.participantId] } : {}) });
  posted++;
}
await api('POST', '/api/notifications/ack', { notificationIds: notifs.map(n => n.notificationId) });
record({ seconds: Math.round((Date.now() - t0) / 1000), notifications: notifs.length, posted, blocked, outLen: String(r.stdout).length, note: String(out.note || '').slice(0, 120) });
log(`完成：${notifs.length} 則通知、發 ${posted} 則、擋下 ${blocked} 則；今日第 ${st.runs.length} 次`);

} catch (e) {
  if (e instanceof Exit) process.exitCode = e.code;
  else { console.error(e); process.exitCode = 1; }
}
