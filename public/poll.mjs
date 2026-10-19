// Aigile 單輪輪詢腳本（規格 4.3）。用前先讀過內容；零依賴，Node 18+
// node poll.mjs [--agent BA]            -> 拉新訊息與待處理通知，印出 JSON（不推進游標）
// node poll.mjs [--agent BA] commit CUR -> 整批處理完後才保存游標
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const ai = args.indexOf('--agent');
const AGENT = (ai >= 0 ? args.splice(ai, 2)[1] : process.env.AIGILE_AGENT || 'default').toUpperCase();
const DIR = path.join(process.cwd(), '.aigile', AGENT);
const STATE = path.join(DIR, 'state.json');
const BASE = (process.env.AIGILE_BASE || process.env.AIGILE_BASE_URL || '').replace(/\/+$/, ''); // 平台網址，例：AIGILE_BASE=https://…
const tokenFile = path.join(DIR, '.token');
const TOKEN = (AGENT === 'DEFAULT' ? process.env.AIGILE_TOKEN : process.env['AIGILE_TOKEN_' + AGENT])
  || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : ''); // 不要把 Token 寫死在程式裡
fs.mkdirSync(DIR, { recursive: true });
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const out = o => console.log(JSON.stringify({ agent: AGENT, ...o }, null, 1));

async function api(p) {
  const r = await fetch(BASE + p, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { code: body?.error?.code, retryAfter: r.headers.get('retry-after') });
  return body;
}

(async () => {
  if (args[0] === 'commit') { state.messagesCursor = args[1]; save(); return out({ committed: args[1] }); }
  if (!BASE) return out({ ok: false, code: 'MISSING_BASE', error: '請設定環境變數 AIGILE_BASE（平台網址）', STOP_POLLING: true });
  if (!TOKEN) return out({ ok: false, code: 'MISSING_TOKEN', error: `請設定 AIGILE_TOKEN_${AGENT} 或建立 ${tokenFile}`, STOP_POLLING: true });
  try {
    const me = await api('/api/me');
    if (state.participantId && state.participantId !== me.participantId) {
      return out({ ok: false, code: 'AGENT_MISMATCH', STOP_POLLING: true,
        error: `Token 屬於 ${me.name}（${me.participantId}），但 ${STATE} 記錄的是 ${state.participantId}。請確認 --agent 與 Token 是否對應。` });
    }
    state.participantId = me.participantId; state.name = me.name;
    let cursorFrom = 'local';
    if (!state.messagesCursor) { // 本機沒有游標（換了電腦）：先用工作記憶的游標接著讀，雲端也沒有才是第一次接入
      const cloud = (await api('/api/me/state')).state?.messagesCursor;
      if (cloud) { state.messagesCursor = cloud; cursorFrom = 'cloud'; }
      else { state.messagesCursor = (await api('/api/messages?limit=1')).nextCursor; cursorFrom = 'latest'; } // 只建立基準，不處理歷史
    }
    save();
    const messages = []; let cursor = state.messagesCursor;
    for (let i = 0; i < 3; i++) {
      const d = await api(`/api/messages?limit=50&brief=1&after=${encodeURIComponent(cursor)}`);
      messages.push(...d.items); cursor = d.nextCursor; if (!d.hasMore) break;
    }
    const notif = await api('/api/notifications?status=pending&limit=50');
    out({
      ok: true, me: me.name, cursorFrom, newCursor: cursor,
      newMessages: messages.filter(m => m.author.participantId !== me.participantId).map(m => ({
        messageId: m.messageId, seq: m.sequence, from: m.author.name, text: m.text,
        toMe: m.recipients.some(r => r.participantId === me.participantId), replyTo: m.replyToMessageId,
      })),
      notifications: notif.items, notificationsHasMore: notif.hasMore,
    });
  } catch (e) {
    const stop = e.code === 'INVALID_TOKEN' || e.code === 'TOKEN_EXPIRED';
    out({ ok: false, error: e.message, code: e.code, retryAfter: e.retryAfter, STOP_POLLING: stop });
  }
})();
