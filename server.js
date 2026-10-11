// Aigile-Switch 復刻版：人類與 AI 助手共用的協作群組。
// 零相依：Node 內建 http + node:sqlite。啟動：node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const ROOM_CODE = process.env.ROOM_CODE || ''; // 設定後，人類加入群組需輸入此代碼
const ACTIVE_WINDOW_MS = 30_000;
const RATE_LIMIT_PER_MIN = 120;
const MAX_TEXT = 8000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'switch.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- human | ai
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL UNIQUE,       -- 顯示用短代碼，如 TG57
  owner_id TEXT,                   -- AI 所屬的人類
  duties TEXT NOT NULL DEFAULT '', -- AI 主要職責
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active', -- active | disabled
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  author_id TEXT NOT NULL,
  text TEXT NOT NULL,
  reply_to TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (author_id, request_id)
);
CREATE TABLE IF NOT EXISTS message_recipients (
  message_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  PRIMARY KEY (message_id, participant_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reasons TEXT NOT NULL,           -- JSON 陣列：mention | reply
  status TEXT NOT NULL DEFAULT 'pending', -- pending | acked
  created_at TEXT NOT NULL,
  acked_at TEXT,
  UNIQUE (recipient_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_notif_recipient ON notifications (recipient_id, status, created_at);
`);

// ---------- 工具 ----------
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const randId = (prefix, n = 16) => {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (const b of bytes) s += B62[b % 62];
  return `${prefix}_${s}`;
};
const newToken = () => crypto.randomBytes(32).toString('base64url');
const nowIso = () => new Date().toISOString();

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (const b of crypto.randomBytes(4)) c += chars[b % chars.length];
    if (!db.prepare('SELECT 1 FROM participants WHERE code = ?').get(c)) return c;
  }
}

const encodeCursor = seq => Buffer.from(JSON.stringify({ s: seq })).toString('base64url');
function decodeCursor(c) {
  if (!c) return 0;
  try {
    const s = JSON.parse(Buffer.from(c, 'base64url').toString()).s;
    return Number.isInteger(s) && s >= 0 ? s : null;
  } catch { return null; }
}

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status; this.code = code; this.extra = extra;
  }
}

// ---------- 序列化 ----------
const getParticipant = id => db.prepare('SELECT * FROM participants WHERE id = ?').get(id);

function publicParticipant(p, { now = Date.now() } = {}) {
  const owner = p.owner_id ? getParticipant(p.owner_id) : null;
  return {
    participantId: p.id, kind: p.kind, name: p.name, role: p.role, code: p.code,
    ownerId: p.owner_id || null, ownerName: owner ? owner.name : null,
    duties: p.kind === 'ai' ? p.duties : undefined,
    status: p.status,
    active: p.status === 'active' && now - p.last_seen_at < ACTIVE_WINDOW_MS,
    lastSeenAt: p.last_seen_at ? new Date(p.last_seen_at).toISOString() : null,
  };
}

function serializeMessage(m) {
  const author = getParticipant(m.author_id);
  const recipients = db.prepare(`
    SELECT p.id, p.name FROM message_recipients r JOIN participants p ON p.id = r.participant_id
    WHERE r.message_id = ? ORDER BY p.name`).all(m.id);
  return {
    messageId: m.id,
    sequence: m.seq,
    author: {
      participantId: author.id, name: author.name, role: author.role, code: author.code, kind: author.kind,
      ownerName: author.owner_id ? getParticipant(author.owner_id)?.name ?? null : null,
    },
    text: m.text,
    recipients: recipients.map(r => ({ participantId: r.id, name: r.name })),
    replyToMessageId: m.reply_to,
    requestId: m.request_id,
    createdAt: m.created_at,
  };
}

function serializeNotification(n) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(n.message_id);
  const sender = getParticipant(m.author_id);
  return {
    notificationId: n.id,
    reasons: JSON.parse(n.reasons),
    status: n.status,
    messageId: n.message_id,
    replyToMessageId: m.reply_to,
    sender: { participantId: sender.id, name: sender.name, role: sender.role },
    preview: m.text.length > 120 ? m.text.slice(0, 120) + '…' : m.text,
    createdAt: n.created_at,
    ackedAt: n.acked_at,
  };
}

// ---------- 即時推播（網頁用 SSE） ----------
const sseClients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) c.res.write(payload);
}
setInterval(() => { for (const c of sseClients) c.res.write(': ping\n\n'); }, 25_000).unref();

// ---------- 驗證與限流 ----------
const rate = new Map(); // participantId -> { windowStart, count }
function authenticate(req, url) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : url.searchParams.get('token');
  if (!token) throw new ApiError(401, 'MISSING_TOKEN', '缺少 Authorization: Bearer <token>');
  const p = db.prepare('SELECT * FROM participants WHERE token = ?').get(token);
  if (!p) throw new ApiError(401, 'INVALID_TOKEN', 'Token 無效或已被重發');
  if (p.status !== 'active') throw new ApiError(401, 'TOKEN_EXPIRED', '此身分已停用');
  if (p.owner_id) {
    const owner = getParticipant(p.owner_id);
    if (!owner || owner.status !== 'active') throw new ApiError(401, 'TOKEN_EXPIRED', '所屬人類已離開');
  }
  const now = Date.now();
  const r = rate.get(p.id) || { windowStart: now, count: 0 };
  if (now - r.windowStart >= 60_000) { r.windowStart = now; r.count = 0; }
  r.count++;
  rate.set(p.id, r);
  if (r.count > RATE_LIMIT_PER_MIN) {
    const retry = Math.ceil((r.windowStart + 60_000 - now) / 1000);
    throw new ApiError(429, 'RATE_LIMITED', '請求過於頻繁', { retryAfter: retry });
  }
  const wasActive = now - p.last_seen_at < ACTIVE_WINDOW_MS;
  db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?').run(now, p.id);
  p.last_seen_at = now;
  if (!wasActive) broadcast('presence', publicParticipant(p));
  return p;
}
const requireHuman = me => {
  if (me.kind !== 'human') throw new ApiError(403, 'HUMAN_ONLY', '此操作僅限人類成員');
};

// ---------- 業務邏輯 ----------
function createMessage(me, body) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw new ApiError(400, 'TEXT_REQUIRED', 'text 不可為空');
  if (text.length > MAX_TEXT) throw new ApiError(400, 'TEXT_TOO_LONG', `text 上限 ${MAX_TEXT} 字`);
  const requestId = body.requestId ? String(body.requestId).slice(0, 200) : null;

  if (requestId) {
    const dup = db.prepare('SELECT * FROM messages WHERE author_id = ? AND request_id = ?').get(me.id, requestId);
    if (dup) return { message: serializeMessage(dup), duplicate: true };
  }

  let replyTo = null;
  if (body.replyToMessageId) {
    replyTo = db.prepare('SELECT * FROM messages WHERE id = ?').get(String(body.replyToMessageId));
    if (!replyTo) throw new ApiError(400, 'REPLY_TARGET_NOT_FOUND', 'replyToMessageId 不存在');
  }

  // 收件人 = 明確指定的 recipientIds ∪ 內文中的 @名字
  const recipientIds = new Set();
  for (const id of Array.isArray(body.recipientIds) ? body.recipientIds : []) {
    const p = getParticipant(String(id));
    if (!p) throw new ApiError(400, 'RECIPIENT_NOT_FOUND', `找不到成員 ${id}`);
    recipientIds.add(p.id);
  }
  const everyone = db.prepare("SELECT id, name FROM participants WHERE status = 'active'").all()
    .sort((a, b) => b.name.length - a.name.length);
  let scan = text;
  for (const p of everyone) {
    const tag = '@' + p.name;
    if (scan.includes(tag)) { recipientIds.add(p.id); scan = scan.split(tag).join(' '); }
  }
  recipientIds.delete(me.id);

  const id = randId('m');
  const createdAt = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO messages (id, author_id, text, reply_to, request_id, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, me.id, text, replyTo?.id ?? null, requestId, createdAt);
    const addR = db.prepare('INSERT INTO message_recipients (message_id, participant_id) VALUES (?,?)');
    for (const rid of recipientIds) addR.run(id, rid);

    const reasons = new Map();
    for (const rid of recipientIds) reasons.set(rid, ['mention']);
    if (replyTo && replyTo.author_id !== me.id) {
      reasons.set(replyTo.author_id, [...(reasons.get(replyTo.author_id) || []), 'reply']);
    }
    const addN = db.prepare('INSERT INTO notifications (id, recipient_id, message_id, reasons, created_at) VALUES (?,?,?,?,?)');
    for (const [rid, rs] of reasons) addN.run(randId('n'), rid, id, JSON.stringify(rs), createdAt);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
  broadcast('message', message);
  return { message, duplicate: false };
}

function listMessages(url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const tail = url.searchParams.get('tail');
  let rows;
  let hasMore;
  if (tail) {
    // 網頁用：取最新 N 筆
    const n = Math.min(Math.max(Number(tail) || 100, 1), 500);
    rows = db.prepare('SELECT * FROM messages ORDER BY seq DESC LIMIT ?').all(n).reverse();
    hasMore = false;
  } else {
    const after = decodeCursor(url.searchParams.get('after'));
    if (after === null) throw new ApiError(400, 'INVALID_CURSOR', 'after 游標格式錯誤');
    rows = db.prepare('SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?').all(after, limit + 1);
    hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
  }
  const last = rows.length ? rows[rows.length - 1].seq : decodeCursor(url.searchParams.get('after')) || 0;
  return { items: rows.map(serializeMessage), nextCursor: encodeCursor(last), hasMore };
}

function listNotifications(me, url) {
  const status = url.searchParams.get('status') || 'pending';
  if (!['pending', 'acked', 'all'].includes(status)) throw new ApiError(400, 'INVALID_STATUS', 'status 需為 pending | acked | all');
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const where = status === 'all' ? '' : 'AND status = ?';
  const args = status === 'all' ? [me.id, limit + 1] : [me.id, status, limit + 1];
  let rows = db.prepare(`SELECT * FROM notifications WHERE recipient_id = ? ${where} ORDER BY created_at, id LIMIT ?`).all(...args);
  const hasMore = rows.length > limit;
  if (hasMore) rows = rows.slice(0, limit);
  return { items: rows.map(serializeNotification), hasMore };
}

function ackNotifications(me, ids) {
  const acked = [];
  const stmt = db.prepare("UPDATE notifications SET status = 'acked', acked_at = ? WHERE id = ? AND recipient_id = ? AND status = 'pending'");
  for (const id of ids) {
    const n = db.prepare('SELECT * FROM notifications WHERE id = ? AND recipient_id = ?').get(String(id), me.id);
    if (!n) throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', `找不到通知 ${id}`);
    stmt.run(nowIso(), n.id, me.id);
    acked.push(n.id);
  }
  return { acked };
}

function validateName(name) {
  name = typeof name === 'string' ? name.trim() : '';
  if (!name || name.length > 40) throw new ApiError(400, 'INVALID_NAME', '名稱需為 1～40 字');
  if (/[\s@]/.test(name)) throw new ApiError(400, 'INVALID_NAME', '名稱不可包含空白或 @');
  return name;
}
function assertNameFree(name, exceptId = null) {
  const p = db.prepare('SELECT id FROM participants WHERE name = ?').get(name);
  if (p && p.id !== exceptId) throw new ApiError(409, 'NAME_TAKEN', '此名稱已被使用');
}

function joinHuman(body) {
  if (ROOM_CODE && body.roomCode !== ROOM_CODE) throw new ApiError(403, 'INVALID_ROOM_CODE', '群組代碼錯誤');
  const name = validateName(body.name);
  assertNameFree(name);
  const role = String(body.role || '').trim().slice(0, 20);
  const p = {
    id: randId('p'), kind: 'human', name, role, code: newCode(), token: newToken(), ts: nowIso(),
  };
  db.prepare(`INSERT INTO participants (id, kind, name, role, code, token, created_at, updated_at, last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(p.id, 'human', name, role, p.code, p.token, p.ts, p.ts, Date.now());
  const created = getParticipant(p.id);
  broadcast('participants', { changed: p.id });
  return { token: p.token, participant: publicParticipant(created) };
}

function myAi(me, id) {
  const ai = getParticipant(id);
  if (!ai || ai.kind !== 'ai' || ai.owner_id !== me.id) throw new ApiError(404, 'AI_NOT_FOUND', '找不到此 AI 助手');
  return ai;
}
function aiView(ai) {
  return { ...publicParticipant(ai), token: ai.token, version: ai.version, updatedAt: ai.updated_at };
}

function createAi(me, body) {
  const name = validateName(body.name);
  assertNameFree(name);
  const ts = nowIso();
  const id = randId('p');
  db.prepare(`INSERT INTO participants (id, kind, name, role, code, owner_id, duties, token, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, 'ai', name, String(body.role || '').trim().slice(0, 20), newCode(), me.id,
    String(body.duties || '').trim().slice(0, 1000), newToken(), ts, ts);
  broadcast('participants', { changed: id });
  return aiView(getParticipant(id));
}

function updateAi(me, id, body) {
  const ai = myAi(me, id);
  const name = body.name !== undefined ? validateName(body.name) : ai.name;
  assertNameFree(name, ai.id);
  const role = body.role !== undefined ? String(body.role).trim().slice(0, 20) : ai.role;
  const duties = body.duties !== undefined ? String(body.duties).trim().slice(0, 1000) : ai.duties;
  db.prepare('UPDATE participants SET name = ?, role = ?, duties = ?, version = version + 1, updated_at = ? WHERE id = ?')
    .run(name, role, duties, nowIso(), ai.id);
  broadcast('participants', { changed: ai.id });
  return aiView(getParticipant(ai.id));
}

function setAiStatus(me, id, status) {
  const ai = myAi(me, id);
  db.prepare('UPDATE participants SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), ai.id);
  broadcast('participants', { changed: ai.id });
  return aiView(getParticipant(ai.id));
}

function reissueToken(me, id) {
  const ai = myAi(me, id);
  db.prepare('UPDATE participants SET token = ?, version = version + 1, updated_at = ? WHERE id = ?')
    .run(newToken(), nowIso(), ai.id);
  return aiView(getParticipant(ai.id));
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

function onboardingText(req, ai) {
  const owner = getParticipant(ai.owner_id);
  const base = baseUrl(req);
  return [
    `你是「${ai.name}」，是 ${owner.name} 在 Aigile-Switch 協作群組中的 AI 助手（角色：${ai.role || '未指定'}）。`,
    ai.duties ? `主要職責：${ai.duties}` : '',
    '',
    '## 接入資訊（機密，勿外流、勿寫入 git）',
    `- BASE_URL: ${base}`,
    `- TOKEN: ${ai.token}`,
    `- 你的 participantId: ${ai.id}`,
    `- 你所屬的人類：${owner.name}（participantId: ${owner.id}）`,
    '',
    '## 開始前',
    `1. 先閱讀接入規格：${base}/docs/ai-guide.md`,
    '2. 呼叫 GET /api/me 確認身分，再發一則報到訊息（requestId 使用 "req_checkin_<你的 participantId>"）。',
    '3. 依規格輪詢新訊息與通知；被 @提及或被回覆時，先回【接單】，完成後回【完成】並 ack 通知。',
    `4. 任何 git commit / push / merge / 部署，以及超出職責的事，都先在本機對話取得 ${owner.name} 的同意。`,
  ].filter(l => l !== null).join('\n');
}

// ---------- 路由 ----------
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) throw new ApiError(413, 'BODY_TOO_LARGE', '請求內容過大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'INVALID_JSON', 'JSON 格式錯誤'); }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/health', () => ({ ok: true, roomCodeRequired: !!ROOM_CODE }));
route('POST', '/api/join', async ({ req }) => joinHuman(await readJson(req)));

route('GET', '/api/me', ({ me }) => ({ ...publicParticipant(me), duties: me.duties }));
route('GET', '/api/participants', ({ url }) => {
  const now = Date.now();
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const items = db.prepare("SELECT * FROM participants WHERE status = 'active' ORDER BY kind DESC, created_at").all()
    .map(p => publicParticipant(p, { now }))
    .filter(p => !q || [p.name, p.role, p.code].some(v => v.toLowerCase().includes(q)));
  return { items, total: items.length, active: items.filter(p => p.active).length };
});

route('GET', '/api/messages', ({ url }) => listMessages(url));
route('GET', '/api/messages/:id', ({ params }) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(params.id);
  if (!m) throw new ApiError(404, 'MESSAGE_NOT_FOUND', '找不到訊息');
  return serializeMessage(m);
});
route('POST', '/api/messages', async ({ req, me, res }) => {
  const r = createMessage(me, await readJson(req));
  return { __status: r.duplicate ? 200 : 201, ...r.message, duplicate: r.duplicate };
});

route('GET', '/api/notifications', ({ me, url }) => listNotifications(me, url));
route('POST', '/api/notifications/:id/ack', ({ me, params }) => ackNotifications(me, [params.id]));
route('POST', '/api/notifications/ack', async ({ me, req }) => {
  const body = await readJson(req);
  if (!Array.isArray(body.notificationIds)) throw new ApiError(400, 'IDS_REQUIRED', '需提供 notificationIds 陣列');
  return ackNotifications(me, body.notificationIds);
});

route('GET', '/api/my-ais', ({ me }) => {
  requireHuman(me);
  return { items: db.prepare("SELECT * FROM participants WHERE owner_id = ? AND kind = 'ai' ORDER BY created_at").all(me.id).map(aiView) };
});
route('POST', '/api/my-ais', async ({ me, req }) => { requireHuman(me); return { __status: 201, ...createAi(me, await readJson(req)) }; });
route('PATCH', '/api/my-ais/:id', async ({ me, req, params }) => { requireHuman(me); return updateAi(me, params.id, await readJson(req)); });
route('POST', '/api/my-ais/:id/reissue', ({ me, params }) => { requireHuman(me); return reissueToken(me, params.id); });
route('POST', '/api/my-ais/:id/disable', ({ me, params }) => { requireHuman(me); return setAiStatus(me, params.id, 'disabled'); });
route('POST', '/api/my-ais/:id/enable', ({ me, params }) => { requireHuman(me); return setAiStatus(me, params.id, 'active'); });
route('GET', '/api/my-ais/:id/onboarding', ({ me, params, req }) => {
  requireHuman(me);
  return { text: onboardingText(req, myAi(me, params.id)) };
});
route('POST', '/api/leave', ({ me }) => {
  requireHuman(me);
  // 登出只清除本機；這裡提供「離開群組」：停用自己與名下 AI
  db.prepare("UPDATE participants SET status = 'disabled', updated_at = ? WHERE id = ? OR owner_id = ?").run(nowIso(), me.id, me.id);
  broadcast('participants', { changed: me.id });
  return { ok: true };
});

const PUBLIC_ROUTES = new Set(['/api/health', '/api/join']);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, url) {
  if (url.pathname === '/docs/ai-guide.md') {
    const md = fs.readFileSync(path.join(__dirname, 'docs', 'ai-guide.md'), 'utf8').replaceAll('{{BASE_URL}}', baseUrl(req));
    res.writeHead(200, { 'Content-Type': MIME['.md'] });
    return res.end(md);
  }
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
  try {
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const me = authenticate(req, url);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      const client = { res, id: me.id };
      sseClients.add(client);
      // 網頁開著就算在線
      const beat = setInterval(() => {
        try { db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?').run(Date.now(), me.id); } catch {}
      }, 10_000);
      req.on('close', () => { sseClients.delete(client); clearInterval(beat); });
      return;
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const me = PUBLIC_ROUTES.has(url.pathname) ? null : authenticate(req, url);
      const out = await r.handler({ req, res, url, params, me });
      const status = out.__status || 200;
      delete out.__status;
      return send(res, status, out);
    }
    throw new ApiError(404, 'NOT_FOUND', '找不到此 API');
  } catch (e) {
    if (!(e instanceof ApiError)) {
      console.error(e);
      e = new ApiError(500, 'INTERNAL', '伺服器錯誤');
    }
    const headers = e.extra.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : {};
    send(res, e.status, { error: { code: e.code, message: e.message } }, headers);
  }
});

// 定期推播在線人數變化（活躍 30 秒視窗會自然過期）
setInterval(() => broadcast('presence-tick', {}), 15_000).unref();

server.listen(PORT, () => {
  console.log(`Aigile-Switch 已啟動：http://localhost:${PORT}`);
  if (ROOM_CODE) console.log('已啟用群組代碼 (ROOM_CODE)');
});
