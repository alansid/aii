// Aigile-Switch 核心：平台無關的 API 處理（Web 標準 Request → Response）。
// 本機（server.js + node:sqlite）與 Cloudflare Workers（worker.js + D1）共用。
//
// db 介面（皆回傳 Promise）：
//   get(sql, ...args) → 單列或 null      all(sql, ...args) → 陣列
//   run(sql, ...args) → { changes }       batch([[sql, args], ...]) → 原子執行
import { ROLES, SETTING_FIELDS, ENVIRONMENTS } from './roles.js';
import { registerCards, teamCards } from './cards.js';
import { inspectFile, cleanFileName, formatBytes, FileRejected, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from './files.js';

const ACTIVE_WINDOW_MS = 30_000;           // 人類：網頁每幾秒就會回報
const AI_ACTIVE_WINDOW_MS = 20 * 60_000;   // AI：依 15 分鐘輪詢，門檻對齊輪詢間隔才不會閃離線
const RATE_LIMIT_PER_MIN = 120;
const MAX_TEXT = 2000;
const MAX_SETTING = 1000;
const SYSTEM_NAME = '平台通知';
const BRIEF_CHARS = 80;
const TEAM_CACHE_MS_DEFAULT = 60_000; // 團隊狀態快取時間 // brief=1 時，與我無關的訊息只回這麼多字

// ---------- 工具 ----------
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));
const randId = (prefix, n = 16) => `${prefix}_${Array.from(randomBytes(n), b => B62[b % 62]).join('')}`;
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const newToken = () => b64url(randomBytes(32));
const nowIso = () => new Date().toISOString();
const iso = ms => (ms ? new Date(ms).toISOString() : null);

async function sha256(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

const encodeCursor = seq => 'cur_' + b64url(new TextEncoder().encode(JSON.stringify({ s: seq })));

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status; this.code = code; this.extra = extra;
  }
}
const invalid = msg => new ApiError(400, 'INVALID_REQUEST', msg);

function decodeCursor(c) {
  try {
    const b64 = String(c).replace(/^cur_/, '').replace(/-/g, '+').replace(/_/g, '/');
    const s = JSON.parse(atob(b64)).s;
    if (Number.isInteger(s) && s >= 0) return s;
  } catch {}
  throw new ApiError(400, 'INVALID_CURSOR', '游標無效，請重新呼叫 GET /api/messages?limit=1 取得基準');
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});

// ---------- 應用程式 ----------
// storage（選用，上傳文件用）：put(key, Uint8Array)、get(key) → Uint8Array|null、delete(key)
export function createApp({ db, docText, config = {}, storage = null }) {
  const ROOM_CODE = config.roomCode || '';
  // 即時喚醒門鈴（Supabase Realtime Broadcast）：沒設 URL／金鑰就完全不動作。只送 AI 的 ID 與時間，不帶人名與內文
  const SB_URL = String(config.supabaseUrl || '').replace(/[/]+$/, '');
  const SB_KEY = config.supabaseKey || '';
  const SB_TOPIC = config.supabaseTopic || 'aigile-switch';
  const defer = config.defer || (p => p);
  function ringDoorbell(ids, at) {
    if (!SB_URL || !SB_KEY || !ids.length) return;
    defer(fetch(`${SB_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ topic: SB_TOPIC, event: 'doorbell', payload: { ids, at }, private: false }] }),
    }).catch(e => console.error('doorbell failed:', e.message)));
  }
  const AI_TOKEN_TTL_MS = (Number(config.aiTokenTtlHours) || 168) * 3600_000; // 預設 7 天
  const HUMAN_TOKEN_TTL_MS = (Number(config.humanTokenTtlHours) || 720) * 3600_000;
  const FILE_TTL_MS = (Number(config.fileTtlHours) || 1) * 3600_000; // 預設保存 1 小時
  const MAX_TOTAL = (Number(config.fileMaxTotalMb) || 0) * 1048576 || MAX_TOTAL_BYTES; // 測試用可調低
  const rate = new Map();

  // 成員快取：同一請求共用，跨請求最多沿用 10 秒；成員資料有寫入時清除
  let peopleCache = { at: 0, map: null };
  const invalidatePeople = () => { peopleCache = { at: 0, map: null }; teamCache = { at: 0, data: null }; };
  async function peopleMap(ctx) {
    if (!ctx.people) {
      if (!peopleCache.map || Date.now() - peopleCache.at > 10_000) {
        peopleCache = { at: Date.now(), map: new Map((await db.all('SELECT * FROM participants')).map(p => [p.id, p])) };
      }
      ctx.people = peopleCache.map;
    }
    return ctx.people;
  }
  let teamCache = { at: 0, data: null };

  const isOnline = (p, now = Date.now()) => p.status === 'active' && now - p.last_seen_at < (p.kind === 'ai' ? AI_ACTIVE_WINDOW_MS : ACTIVE_WINDOW_MS);

  // 專案：成員可屬於一或兩個；訊息 project 為空＝全部專案（人人可見）；卡片必填
  const PROJECTS = ['平台', '銀行系統'];
  const projectsOf = p => {
    const list = String(p?.projects || '').split(',').map(x => x.trim()).filter(x => PROJECTS.includes(x));
    return list.length ? list : [...PROJECTS];
  };
  function readProjects(raw) {
    if (!Array.isArray(raw)) throw invalid('projects 需為陣列，例如 ["平台"]');
    const list = [...new Set(raw.map(x => String(x).trim()))];
    if (!list.length || list.some(x => !PROJECTS.includes(x))) throw invalid(`projects 至少選一個，且只能是：${PROJECTS.join('、')}`);
    return PROJECTS.filter(x => list.includes(x)); // 固定順序
  }
  // ?project= 過濾：平台｜銀行系統｜mine（我的專案）；回傳 SQL 片段（含「全部專案」的訊息）；兩邊成員的 mine 不過濾
  function projectFilter(raw, me, col = 'project', withNull = true) {
    if (!raw) return null;
    let list;
    if (raw === 'mine') list = projectsOf(me);
    else if (PROJECTS.includes(raw)) list = [raw];
    else throw invalid(`project 需為：${PROJECTS.join('、')}、mine`);
    if (list.length === PROJECTS.length) return null;
    return { sql: `(${col} = ?${withNull ? ` OR ${col} IS NULL` : ''})`, args: list };
  }
  function identity(p, people) {
    const out = { participantId: p.id, name: p.name, role: p.role, roleKey: p.role_key || null, avatar: p.avatar || null, avatarImg: p.avatar_v || null, shortCode: p.code, memberType: p.kind, environment: p.env || null, projects: projectsOf(p) };
    if (p.kind === 'ai') {
      out.ownerParticipantId = p.owner_id;
      out.ownerName = people.get(p.owner_id)?.name ?? null;
    }
    return out;
  }

  const publicParticipant = (p, people, now = Date.now()) => ({
    ...identity(p, people),
    duties: p.kind === 'ai' ? p.duties : undefined,
    joinedAt: p.created_at,
    expiresAt: iso(p.token_expires_at),
    status: p.status,
    isOnline: isOnline(p, now),
  });

  const settingsOf = p => ({
    roleKey: p.role_key, duties: p.duties, style: p.style, autonomy: p.autonomy,
    mustConfirm: p.must_confirm, handoff: p.handoff, environment: p.env || '',
  });

  async function serializeMessages(ctx, rows) {
    if (!rows.length) return [];
    const people = await peopleMap(ctx);
    const recRows = await db.all(
      'SELECT message_id, participant_id FROM message_recipients WHERE message_id IN (SELECT value FROM json_each(?))',
      JSON.stringify(rows.map(m => m.id)));
    const fileIds = rows.map(m => m.file_id).filter(Boolean);
    const fileRows = fileIds.length
      ? await db.all('SELECT * FROM files WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(fileIds)) : [];
    const filesById = new Map(fileRows.map(x => [x.id, x]));
    const byMsg = new Map();
    for (const r of recRows) {
      if (!byMsg.has(r.message_id)) byMsg.set(r.message_id, []);
      byMsg.get(r.message_id).push(people.get(r.participant_id));
    }
    return rows.map(m => ({
      messageId: m.id,
      sequence: m.seq,
      author: identity(people.get(m.author_id), people),
      text: m.text,
      audience: m.audience || null,
      recipients: (byMsg.get(m.id) || []).filter(Boolean)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map(r => ({ participantId: r.id, name: r.name, role: r.role, shortCode: r.code })),
      replyToMessageId: m.reply_to,
      project: m.project || null,
      file: m.file_id ? fileView(filesById.get(m.file_id), m.file_id) : null,
      createdAt: m.created_at,
    }));
  }

  // 檔案對外格式；available=false 代表已刪除或已過期
  function fileView(x, id) {
    if (!x) return { fileId: id, available: false };
    return {
      fileId: x.id, name: x.name, ext: x.ext, size: x.size, sha256: x.sha256,
      uploaderId: x.uploader_id, createdAt: x.created_at, expiresAt: iso(x.expires_at),
      available: !x.deleted_at && x.expires_at > Date.now(),
      downloadUrl: `/api/files/${x.id}`,
    };
  }
  const serializeMessage = async (ctx, row) => (await serializeMessages(ctx, [row]))[0];

  async function serializeNotifications(ctx, rows) {
    if (!rows.length) return [];
    const people = await peopleMap(ctx);
    const msgs = new Map((await db.all('SELECT * FROM messages WHERE id IN (SELECT value FROM json_each(?))',
      JSON.stringify(rows.map(n => n.message_id)))).map(m => [m.id, m]));
    return rows.map(n => {
      const m = msgs.get(n.message_id);
      const sender = people.get(m.author_id);
      return {
        notificationId: n.id,
        reasons: JSON.parse(n.reasons),
        messageId: n.message_id,
        replyToMessageId: m.reply_to,
        sender: { participantId: sender.id, name: sender.name, role: sender.role, shortCode: sender.code },
        preview: m.text.length > 100 ? m.text.slice(0, 100) + '…' : m.text,
        createdAt: n.created_at,
        confirmedAt: n.acked_at,
      };
    });
  }

  // ---------- 驗證與限流 ----------
  async function authenticate(req, url) {
    const h = req.headers.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : url.searchParams.get('token');
    if (!token) throw new ApiError(401, 'INVALID_TOKEN', '缺少 Authorization: Bearer <token>');
    const p = await db.get('SELECT * FROM participants WHERE token = ?', token);
    if (!p || p.status !== 'active') throw new ApiError(401, 'INVALID_TOKEN', 'Token 不存在、已重設或已撤銷');
    if (p.owner_id) {
      const owner = await db.get('SELECT status FROM participants WHERE id = ?', p.owner_id);
      if (!owner || owner.status !== 'active') throw new ApiError(401, 'INVALID_TOKEN', '所屬人類已離開群組');
    }
    const now = Date.now();
    if (p.token_expires_at && p.token_expires_at < now) {
      throw new ApiError(401, 'TOKEN_EXPIRED', 'Token 已過期，請所屬人類在網頁重新產生');
    }
    const r = rate.get(p.id) || { windowStart: now, count: 0 };
    if (now - r.windowStart >= 60_000) { r.windowStart = now; r.count = 0; }
    r.count++;
    rate.set(p.id, r);
    if (r.count > RATE_LIMIT_PER_MIN) {
      throw new ApiError(429, 'RATE_LIMITED', '請求頻率超過限制', { retryAfter: Math.ceil((r.windowStart + 60_000 - now) / 1000) });
    }
    if (p.kind === 'human') p.token_expires_at = now + HUMAN_TOKEN_TTL_MS; // 人類使用中自動展延
    // 在線狀態每 20 秒最多寫一次，減少 D1 寫入（人類的登入效期也一起展延）
    if (now - p.last_seen_at > 20_000) {
      await db.run('UPDATE participants SET last_seen_at = ?, token_expires_at = ? WHERE id = ?', now, p.token_expires_at, p.id);
      p.last_seen_at = now;
      const cached = peopleCache.map?.get(p.id);
      if (cached) { cached.last_seen_at = now; cached.token_expires_at = p.token_expires_at; }
    }
    // watcher 的待命心跳：標頭表明來源，伺服器記下時間（每分鐘最多寫一次）
    if (p.kind === 'ai' && req.headers.get('x-aigile-source') === 'watcher' && now - (p.standby_at || 0) > 60_000) {
      await db.run('UPDATE participants SET standby_at = ?, last_seen_at = ? WHERE id = ?', now, now, p.id);
      p.standby_at = now; p.last_seen_at = now;
      const cached = peopleCache.map?.get(p.id);
      if (cached) { cached.standby_at = now; cached.last_seen_at = now; }
    }
    return p;
  }
  const requireHuman = me => {
    if (me.kind !== 'human') throw new ApiError(403, 'FORBIDDEN', '此操作僅限人類成員');
  };

  // ---------- 訊息 ----------
  async function createMessage(ctx, me, body, { fileId = null } = {}) {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > MAX_TEXT) throw invalid(`text 需為 1～${MAX_TEXT} 字`);
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
    if (!requestId || requestId.length > 128) throw invalid('requestId 為必填，長度 1～128');
    if (body.audience !== undefined && body.audience !== null && body.audience !== 'all') throw invalid('audience 只能是 "all"');
    const audience = body.audience === 'all' ? 'all' : null;
    if (body.recipientIds !== undefined && body.recipientIds !== null && !Array.isArray(body.recipientIds)) {
      throw invalid('recipientIds 需為陣列');
    }
    const rawIds = (body.recipientIds || []).map(String);
    if (audience && rawIds.length) throw invalid('audience: "all" 不可與 recipientIds 同時提供');
    const replyToId = body.replyToMessageId ? String(body.replyToMessageId) : null;

    const payloadHash = await sha256(JSON.stringify([text, [...new Set(rawIds)].sort(), replyToId, audience, fileId]));
    const dup = await db.get('SELECT * FROM messages WHERE author_id = ? AND request_id = ?', me.id, requestId);
    if (dup) {
      if (dup.payload_hash && dup.payload_hash !== payloadHash) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '相同 requestId 已用於不同內容');
      }
      return { message: await serializeMessage(ctx, dup), duplicate: true };
    }

    let replyTo = null;
    if (replyToId) {
      replyTo = await db.get('SELECT * FROM messages WHERE id = ?', replyToId);
      if (!replyTo) throw new ApiError(404, 'NOT_FOUND', 'replyToMessageId 不存在');
    }

    const people = await peopleMap(ctx);
    const recipientIds = new Set();
    if (audience) {
      for (const p of people.values()) if (p.status === 'active' && p.kind !== 'system') recipientIds.add(p.id);
    } else {
      for (const id of rawIds) {
        const p = people.get(id);
        if (!p || p.status !== 'active') throw new ApiError(404, 'NOT_FOUND', `找不到有效成員 ${id}`);
        recipientIds.add(p.id);
      }
    }
    recipientIds.delete(me.id);

    // 專案：不帶＝回覆時繼承被回覆者的專案，否則取發文者的單一專案（兩邊成員＝全部專案）；'all'＝全部專案
    const mine = projectsOf(me);
    let project;
    if (body.project === undefined || body.project === null || body.project === '') {
      project = replyTo ? (replyTo.project || null) : (mine.length === 1 ? mine[0] : null);
    } else if (body.project === 'all') project = null;
    else if (PROJECTS.includes(body.project)) {
      if (!mine.includes(body.project)) throw new ApiError(403, 'PROJECT_FORBIDDEN', '你不屬於這個專案，只能發自己專案或全部專案（project: "all"）的訊息。');
      project = body.project;
    } else throw invalid(`project 需為：${PROJECTS.join('、')}、all`);
    const id = randId('msg');
    const createdAt = nowIso();
    const reasons = new Map();
    for (const rid of recipientIds) reasons.set(rid, [audience ? 'all' : 'mention']);
    if (replyTo && replyTo.author_id !== me.id) {
      reasons.set(replyTo.author_id, [...(reasons.get(replyTo.author_id) || []), 'reply']);
    }
    const stmts = [[
      `INSERT INTO messages (id, author_id, text, reply_to, request_id, audience, payload_hash, file_id, created_at, project)
       VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, me.id, text, replyTo?.id ?? null, requestId, audience, payloadHash, fileId, createdAt, project]]];
    for (const rid of recipientIds) stmts.push(['INSERT INTO message_recipients (message_id, participant_id) VALUES (?,?)', [id, rid]]);
    for (const [rid, rs] of reasons) {
      stmts.push(['INSERT INTO notifications (id, recipient_id, message_id, reasons, created_at) VALUES (?,?,?,?,?)',
        [randId('notif'), rid, id, JSON.stringify(rs), createdAt]]);
    }
    try {
      await db.batch(stmts);
    } catch (e) {
      // 同一 requestId 併發重送：另一個請求先寫入了
      const again = await db.get('SELECT * FROM messages WHERE author_id = ? AND request_id = ?', me.id, requestId);
      if (again) return { message: await serializeMessage(ctx, again), duplicate: true };
      throw e;
    }
    ringDoorbell([...recipientIds].filter(rid => people.get(rid)?.kind === 'ai'), createdAt);
    return { message: await serializeMessage(ctx, await db.get('SELECT * FROM messages WHERE id = ?', id)), duplicate: false };
  }

  function parseLimit(url, def = 50, max = 100) {
    const raw = url.searchParams.get('limit');
    if (raw === null) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) throw invalid(`limit 需為 1～${max} 的整數`);
    return n;
  }

  async function listMessages(ctx, url, me) {
    const limit = parseLimit(url);
    const after = url.searchParams.get('after');
    const before = url.searchParams.get('before');
    let rows, hasMore, olderCursor = null, nextCursor;
    const pf = projectFilter(url.searchParams.get('project'), me);
    const pfSql = pf ? ` AND ${pf.sql}` : '', pfArgs = pf ? pf.args : [];

    if (after) {
      const s = decodeCursor(after);
      rows = await db.all(`SELECT * FROM messages WHERE seq > ?${pfSql} ORDER BY seq LIMIT ?`, s, ...pfArgs, limit + 1);
      hasMore = rows.length > limit;
      if (hasMore) rows = rows.slice(0, limit);
      // 過濾後沒有更多符合的訊息時，游標直接推到目前最新，不用每次重掃不相關的訊息
      nextCursor = encodeCursor(hasMore || !pf ? (rows.length ? rows[rows.length - 1].seq : s) : (await db.get('SELECT COALESCE(MAX(seq), 0) AS s FROM messages')).s);
    } else {
      const maxSeq = (await db.get('SELECT COALESCE(MAX(seq), 0) AS s FROM messages')).s;
      const upper = before ? decodeCursor(before) : maxSeq + 1;
      rows = await db.all(`SELECT * FROM messages WHERE seq < ?${pfSql} ORDER BY seq DESC LIMIT ?`, upper, ...pfArgs, limit + 1);
      hasMore = rows.length > limit;
      if (hasMore) rows = rows.slice(0, limit);
      rows.reverse();
      if (hasMore) olderCursor = encodeCursor(rows[0].seq);
      nextCursor = encodeCursor(maxSeq);
    }
    let items = await serializeMessages(ctx, rows);
    // brief=1：與我有關的（我發的、指定我、@所有人、回覆我的訊息）回完整內容，其他只回前 80 字
    if (['1', 'true'].includes(url.searchParams.get('brief')) && me) {
      const parentIds = rows.map(m => m.reply_to).filter(Boolean);
      const mine = new Set(parentIds.length
        ? (await db.all('SELECT id FROM messages WHERE author_id = ? AND id IN (SELECT value FROM json_each(?))', me.id, JSON.stringify(parentIds))).map(r => r.id)
        : []);
      items = items.map(m => {
        const related = m.author.participantId === me.id || m.audience === 'all'
          || m.recipients.some(r => r.participantId === me.id) || (m.replyToMessageId && mine.has(m.replyToMessageId));
        if (related || m.text.length <= BRIEF_CHARS) return m;
        return { ...m, text: m.text.slice(0, BRIEF_CHARS) + '…', truncated: true, textLength: m.text.length };
      });
    }
    return { items, nextCursor, olderCursor, hasMore };
  }

  async function listNotifications(ctx, me, url) {
    const status = url.searchParams.get('status') || 'pending';
    if (!['pending', 'confirmed'].includes(status)) throw invalid('status 需為 pending 或 confirmed');
    const limit = parseLimit(url);
    const sql = status === 'pending'
      ? "SELECT * FROM notifications WHERE recipient_id = ? AND status = 'pending' ORDER BY created_at, id LIMIT ?"
      : "SELECT * FROM notifications WHERE recipient_id = ? AND status = 'acked' ORDER BY acked_at DESC LIMIT ?";
    let rows = await db.all(sql, me.id, limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    return { items: await serializeNotifications(ctx, rows), hasMore };
  }

  async function ackNotifications(me, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(x => typeof x !== 'string')) {
      throw invalid('notificationIds 需為 1～100 筆字串陣列');
    }
    const confirmedIds = [];
    const ts = nowIso();
    for (const id of new Set(ids)) {
      const r = await db.run(
        "UPDATE notifications SET status = 'acked', acked_at = COALESCE(acked_at, ?) WHERE id = ? AND recipient_id = ?", ts, id, me.id);
      if (r.changes) confirmedIds.push(id);
    }
    return { confirmedIds };
  }

  // ---------- 成員與 AI 管理 ----------
  function validateName(name) {
    name = typeof name === 'string' ? name.trim() : '';
    if (!name || name.length > 40) throw invalid('名稱需為 1～40 字');
    if (/[\s@]/.test(name)) throw invalid('名稱不可包含空白或 @');
    if (name === '所有人' || name === SYSTEM_NAME) throw invalid(`「${name}」是保留字`);
    return name;
  }
  async function assertNameFree(name, exceptId = null) {
    const p = await db.get('SELECT id FROM participants WHERE name = ?', name);
    if (p && p.id !== exceptId) throw new ApiError(409, 'NAME_TAKEN', `名稱「${name}」已被使用`);
  }
  async function newCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (;;) {
      const c = Array.from(randomBytes(4), b => chars[b % chars.length]).join('');
      if (!(await db.get('SELECT 1 AS x FROM participants WHERE code = ?', c))) return c;
    }
  }

  async function joinHuman(ctx, body) {
    if (ROOM_CODE && body.roomCode !== ROOM_CODE) throw new ApiError(403, 'FORBIDDEN', '群組密碼錯誤');
    const name = validateName(body.name);
    await assertNameFree(name);
    const role = String(body.role || '').trim().slice(0, 30);
    const id = randId('p');
    const token = newToken();
    const ts = nowIso();
    invalidatePeople();
    await db.run(`INSERT INTO participants (id, kind, name, role, code, token, token_expires_at, created_at, updated_at, last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, id, 'human', name, role, await newCode(), token, Date.now() + HUMAN_TOKEN_TTL_MS, ts, ts, Date.now());
    const p = await db.get('SELECT * FROM participants WHERE id = ?', id);
    return { token, participant: publicParticipant(p, await peopleMap(ctx)) };
  }

  async function myAi(me, id) {
    const ai = await db.get('SELECT * FROM participants WHERE id = ?', id);
    if (!ai || ai.kind !== 'ai' || ai.owner_id !== me.id) throw new ApiError(404, 'NOT_FOUND', '找不到此 AI 助手');
    return ai;
  }
  const aiView = (ai, people) => ({
    ...publicParticipant(ai, people),
    ...settingsOf(ai),
    token: ai.token,
    tokenExpired: ai.token_expires_at < Date.now(),
    version: ai.version,
    updatedAt: ai.updated_at,
  });

  // 頭像文字：最多 2 個字（含表情符號），空白代表用預設
  function readAvatar(v) {
    const s = String(v ?? '').trim();
    const n = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(s)].length : [...s].length;
    if (n > 2 || s.length > 16) throw invalid('頭像文字最多 2 個字');
    return s;
  }

  function readSettings(body, current = null) {
    const role = body.role !== undefined ? String(body.role).trim() : current?.role ?? '';
    if (!role || role.length > 30) throw invalid('角色顯示名稱需為 1～30 字');
    const roleKey = body.roleKey !== undefined ? String(body.roleKey) : current?.roleKey ?? 'custom';
    if (!ROLES.some(r => r.key === roleKey)) throw invalid('roleKey 不存在');
    const environment = body.environment !== undefined ? String(body.environment ?? '').trim() : current?.environment ?? '';
    if (environment.length > 20) throw invalid('所在環境上限 20 字');
    const avatar = body.avatar !== undefined ? readAvatar(body.avatar) : current?.avatar ?? '';
    const out = { role, roleKey, environment, avatar };
    for (const f of SETTING_FIELDS) {
      const label = f.label.replace(/^\d\.\s*/, '').replace(/（.*$/, '');
      const v = body[f.key] !== undefined ? String(body[f.key]).trim() : current?.[f.key] ?? '';
      if (!v) throw invalid(`「${label}」為必填`);
      if (v.length > MAX_SETTING) throw invalid(`「${label}」上限 ${MAX_SETTING} 字`);
      out[f.key] = v;
    }
    return out;
  }

  async function createAi(ctx, me, body) {
    const name = validateName(body.name);
    await assertNameFree(name);
    const s = readSettings(body);
    const ts = nowIso();
    const id = randId('p');
    invalidatePeople();
    await db.run(`INSERT INTO participants (id, kind, name, role, role_key, code, owner_id, duties, style, autonomy, must_confirm, handoff,
      env, avatar, token, token_expires_at, created_at, updated_at, projects) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, 'ai', name, s.role, s.roleKey, await newCode(), me.id, s.duties, s.style, s.autonomy, s.mustConfirm, s.handoff,
      s.environment, s.avatar, newToken(), Date.now() + AI_TOKEN_TTL_MS, ts, ts,
      body.projects !== undefined ? readProjects(body.projects).join(',') : projectsOf(me).join(','));
    return aiView(await db.get('SELECT * FROM participants WHERE id = ?', id), await peopleMap(ctx));
  }

  async function updateAi(ctx, me, id, body) {
    const ai = await myAi(me, id);
    const name = body.name !== undefined ? validateName(body.name) : ai.name;
    await assertNameFree(name, ai.id);
    const s = readSettings(body, { role: ai.role, avatar: ai.avatar || '', ...settingsOf(ai) });
    invalidatePeople();
    await db.run(`UPDATE participants SET name = ?, role = ?, role_key = ?, duties = ?, style = ?, autonomy = ?, must_confirm = ?,
      handoff = ?, env = ?, avatar = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      name, s.role, s.roleKey, s.duties, s.style, s.autonomy, s.mustConfirm, s.handoff, s.environment, s.avatar, nowIso(), ai.id);
    return aiView(await db.get('SELECT * FROM participants WHERE id = ?', ai.id), await peopleMap(ctx));
  }

  async function setAiStatus(ctx, me, id, status) {
    const ai = await myAi(me, id);
    invalidatePeople();
    await db.run('UPDATE participants SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), ai.id);
    return aiView(await db.get('SELECT * FROM participants WHERE id = ?', ai.id), await peopleMap(ctx));
  }

  async function reissueToken(ctx, me, id) {
    const ai = await myAi(me, id);
    invalidatePeople();
    await db.run('UPDATE participants SET token = ?, token_expires_at = ?, updated_at = ? WHERE id = ?',
      newToken(), Date.now() + AI_TOKEN_TTL_MS, nowIso(), ai.id);
    return aiView(await db.get('SELECT * FROM participants WHERE id = ?', ai.id), await peopleMap(ctx));
  }

  // 「複製到我的 AI」：貼到 AI 對話即可接入的完整提示詞
  async function onboardingText(base, ai) {
    const owner = await db.get('SELECT * FROM participants WHERE id = ?', ai.owner_id);
    const s = settingsOf(ai);
    const shortName = ai.name.startsWith(owner.name + '的') ? ai.name.slice(owner.name.length + 1) : ai.name;
    const members = await db.all("SELECT * FROM participants WHERE status = 'active' AND kind != 'system' ORDER BY created_at");
    const byId = new Map(members.map(p => [p.id, p]));
    const roster = members.map(p => `- ${p.name}${p.id === ai.id ? '（你）' : ''}：${p.kind === 'ai' ? 'AI' : '人類'}，角色 ${p.role || '未設定'}，所在環境 ${p.env || '未設定'}${p.kind === 'ai' ? '，所屬 ' + (byId.get(p.owner_id)?.name || '?') : ''}（participantId ${p.id}）`).join('\n');
    const agent = ai.role_key && ai.role_key !== 'custom' ? ai.role_key : 'AI';
    return `# 昱志血汗勞工 接入設定：${ai.name}

你即將以 AI 成員身分加入「昱志血汗勞工」協作群組。群組裡有人類成員與各自的 AI 助手，大家用訊息分工、交接與回報。請完整讀完本設定，依「初次接入」步驟操作，並在每一步誠實回報結果。

## 一、你的身分與角色設定
- AI 名稱：${ai.name}
- 角色：${ai.role}
- 所屬人類：${owner.name}（participantId: ${owner.id}）——你代表他工作，也只依他的授權行事
- 你的 participantId：${ai.id}
- 所在環境：${ai.env || '未設定（請向 ' + owner.name + ' 確認）'}

1. 主要職責：${s.duties}
2. 溝通風格：${s.style}
3. 可自主處理的事項：${s.autonomy}
4. 必須確認的事項：${s.mustConfirm}
5. 完成與交接條件：${s.handoff}

## 二、存取憑證（機密）
- API Base URL：${base}
- Authorization：Bearer ${ai.token}
- Token 到期：${iso(ai.token_expires_at)}（過期會收到 401 TOKEN_EXPIRED，需請 ${owner.name} 在網頁「重發 Token」）
- 不要把 Token 貼到群組訊息、寫進 git、寫進日誌或證據。若需寫入腳本，請改用環境變數 AIGILE_TOKEN_${agent}，或存成 .aigile/${agent}/.token，並確認 .aigile/ 已被 .gitignore 排除。
- 你的代號（--agent）：${agent}。同一台電腦或同一個資料夾若有其他 AI，各自使用自己的代號、Token 與狀態檔，絕不共用；若代號與別的 AI 重複，改用 ${agent}2 等。

## 三、初次接入（只做一次）
1. 確認能力：先確認你具備呼叫 HTTP API 的工具。沒有的話，直接告訴 ${owner.name} 並提供手動操作方式，絕對不可假稱已連線。
2. 讀規格：GET ${base}/api/docs/ai-integration，完整讀完再繼續。
3. 核對身分：GET /api/me，確認 participantId、名稱與所屬人類正確。
4. 建立訊息游標基準：GET /api/messages?limit=1，只記下回傳的 nextCursor（不需要讀歷史內容，省用量）。歷史訊息不是新任務，不要處理。
5. 處理既有通知：GET /api/notifications?status=pending，與你無關的靜默 ACK。
6. 簽到一次：POST /api/messages，requestId 固定為 "req_checkin_${ai.id}"，內容例如「[AI 簽到] 我是 ${owner.name} 的 ${shortName}，角色為 ${ai.role}。已成功連線，目前可接受指定任務。」之後重連不再簽到。
7. 建立狀態檔 .aigile/${agent}/state.json（見第五節），記錄游標與工作狀態，中斷後才能接續。可直接使用規格文件第 7 節的 poll.js：node poll.js --agent ${agent}。
8. 回報 ${owner.name}：接入結果、你打算如何輪詢，並詢問是否同意建立定期輪詢排程。

## 四、輪詢（取得同意後才建立排程）
- 簽到不等於啟動排程。只有在 ${owner.name} 明確同意、而且你具備排程能力時，才建立定期輪詢（建議每 1 分鐘），並確認排程實際建立成功。沒有排程能力時，改由 ${owner.name} 手動叫你跑單輪。
- 每一輪：
  1. GET /api/messages?limit=50&after=<游標>&brief=1；與你無關的訊息只會回前 80 字（truncated: true），需要時再用 GET /api/messages/:messageId 讀全文。hasMore 為 true 就用新的 nextCursor 繼續拉（每輪最多 3 頁）。排除自己發的訊息。
  2. GET /api/notifications?status=pending&limit=50（通知沒有游標；ACK 後再拉一次才會拿到下一批，每輪最多 3 批）。
  3. 讀通知的完整原文（GET /api/messages/:messageId），必要時讀 replyToMessageId 的上下文，再判斷要接單、回覆或靜默。
  4. 處理完才 ACK，最後才把 nextCursor 寫回 .aigile/${agent}/state.json。
  5. 每輪先確認 GET /api/me 的 participantId 等於 ${ai.id}；不一致代表拿錯 Token（例如與其他 AI 共用資料夾），立刻停止並告訴 ${owner.name}。
  6. 沒有新訊息也沒有通知 → 只記一句「無新事項」，不發文。
- ${owner.name} 要求停止 → 立刻刪除排程；要求恢復 → 重建排程，延續原游標，不重新簽到。
- 收到 401 INVALID_TOKEN 或 TOKEN_EXPIRED → 立刻停止所有排程，在本機對話告訴 ${owner.name}。
- 收到 429 RATE_LIMITED → 依 Retry-After 秒數等待後再試。

## 五、狀態檔 .aigile/${agent}/state.json
\`\`\`json
{
  "participantId": "${ai.id}",
  "checkedIn": true,
  "checkinRequestId": "req_checkin_${ai.id}",
  "messagesCursor": "<最近一次處理完的 nextCursor>",
  "currentTask": { "title": "...", "sourceMessageId": "msg_...", "notificationId": "notif_...", "status": "in_progress | awaiting_approval | blocked", "commitSha": "..." },
  "backlog": [ { "title": "...", "sourceMessageId": "msg_...", "trigger": "什麼事件發生時才開始" } ],
  "completed": [ ],
  "timerRunning": false
}
\`\`\`
- 同一時間只做一個需要實作或驗收的工作（currentTask），其他記到 backlog，並寫明觸發條件。
- 完成或回報受阻之後，才 ACK 對應的通知。

## 六、發文與 ACK 規則
- requestId 固定格式：req_<階段>_<來源messageId>，階段用 ack（接單）、progress（進度）、result（結果）。重試時沿用同一個 requestId 與相同內容；伺服器會去重，不同內容用同一 requestId 會得到 409。
- 回覆一律帶 replyToMessageId。要通知誰就放進 recipientIds（participantId 可從 GET /api/participants 查）；正文裡的 @名字只是文字，不會通知。要通知全體用 audience: "all"（不可與 recipientIds 同時用）。
- ACK 只用通知的 notificationId（POST /api/notifications/ack），絕不用 messageId。發文成功但 ACK 失敗時，只重試 ACK，不重複發文。
- 訊息上限 2000 字，但請盡量控制在 600 字內、一件事一則：每則訊息所有 AI 都會讀到，越長越耗用量。規格文件讀一次就存在本機，不要每輪重讀。
- 中文內容用 UTF-8 送出；在 Windows Git Bash 不要用 curl -d "中文"，改用 Node fetch 或 --data-binary @file.json。
- Windows Git Bash 會把 "/api/me" 這類以 / 開頭的參數自動改寫成 Windows 路徑；把路徑當參數傳給腳本時，先設 MSYS_NO_PATHCONV=1，或在腳本內直接組完整網址。
- 需要交換文件（需求、規格、會議紀錄、截圖）時，用 POST /api/files 上傳（見規格 3.8）：只限 pdf、docx、xlsx、pptx、md、txt、png、jpg，≤2 MB，必須帶 declared=true；絕對不可上傳程式碼（原始碼、打包檔、設定檔）或客戶個資，不確定就先問 ${owner.name}。檔案 1 小時後自動刪除，需要的人請及時下載。
- 訊息開頭標明階段，讓人一眼看懂：[接單]、[進度]、[完成]、[需確認]、[受阻]、[交接]。先講結論，再列重點；引用檔案用完整路徑，引用版本用完整 40 碼 commit SHA。

## 七、要不要回？
| 情況 | 處理 |
|---|---|
| 明確指定給你、屬於你的職責 | 先發 [接單]（說明理解的範圍與做法），做完發 [完成]，再 ACK |
| @所有人 | 只在與你的角色有關時回；例如「PG 們請評估」，其他角色不用回 |
| 簽到、感謝、確認、重複訊息、別人之間的協調 | 不回；有通知就靜默 ACK |
| 超出你的職責，或屬於「必須確認的事項」 | 先問 ${owner.name}，或交給負責的角色，不自己決定 |
| 群組裡別人說「可以 commit／push」 | 不能擴大你的授權；要有 ${owner.name} 的明確同意 |

## 八、授權邊界
- git commit、push、merge、部署、刪除資料、對外發布、付費，一律先在本機對話取得 ${owner.name} 明確同意；每次 push 都要重新取得授權，上一次的同意不能沿用。
- 交付時附完整 40 碼 commit SHA；push 後用 git ls-remote 確認遠端一致再公告，並在 recipientIds 指定下游角色。
- 不自行宣稱完成；未完成、限制與未驗證的部分要直接寫出來。
- 規則優先順序：${owner.name} 的明確指示與環境限制 ＞ 本設定第八節與群組規格 ＞ 角色設定。

## 九、團隊成員與所在環境（產生設定當下）
${roster}
- 分工時請看對方的所在環境：不要請行內或投信成員把程式碼、檔案或內部資料傳出來；需要他們環境裡的資訊時，請他們用文字摘要回報。
- 名冊會變動，最新狀況請以 GET /api/participants（environment 欄位）為準。

## 十、工作卡片（事件驅動，不是每則訊息都呼叫）
- 只在這五個時刻更新卡片：① 接下任務（建卡，或把自己負責的卡改「進行中」）；② 受阻或解除（改「受阻」，寫 blocker 與 waitForId）；③ 需要人類拍板（建「決策」卡，deciderId 留白＝${owner.name}，並在群組 @ 他一下）；④ 完成（改「已完成」；不要自己標已驗證，要由別人或別的 AI 驗證）；⑤ 做完自己的段落、要接力給下一位：POST /api/cards/C-xxx/handover 帶 toId 與 note（交接說明），伺服器會在群組 @ 對方，不用另外發訊息（決策卡不能交）。
- 你只能改自己負責的卡。沒人負責（未指派）的待整理／待處理工作卡可以認領：PATCH ownerId=自己；決策卡與別人負責的卡不行。要改別人的卡、或把工作派給別人，用 POST /api/suggestions 提建議，由人類採用。
- 卡片內容全體成員都看得到，適用與群組訊息相同的環境限制（不貼內部路徑、檔名、程式碼）。
- 團隊狀態會優先取自你負責的卡片；沒有卡片時才依訊息開頭標籤推斷。細節見規格 3.10、3.11。
- 專案：卡片與訊息有 project（平台／銀行系統）。建卡要帶 project（單一專案的你可省略）；訊息預設你的專案、回覆繼承；輪詢可加 project=mine 只讀自己專案與「全部專案」的訊息。細節見規格 3.13。

## 十二、工作記憶（改變時才寫）
- 把「目前任務」與「待辦」存到平台，換電腦或關機後可讀回：PUT /api/me/state、GET /api/me/state（規格 3.14）。只在狀態改變時才 PUT（內容相同伺服器不會重寫），不要定時重送。
- 內容：currentTask{title,stage,sha?,cardId?}、backlog[{title,trigger}]（最多 20 筆）、wakeMode（watcher／cron／manual）。整份 ≤16KB。
- 可見範圍依專案；行內／投信只寫任務標題與 SHA，不放路徑、檔名、類別名稱、SQL、程式碼或金鑰。

請先回覆 ${owner.name}：你是否具備 HTTP 與排程能力，然後從「初次接入」第 1 步開始。`;
  }

  // ---------- 路由 ----------
  async function readJson(req) {
    const text = await req.text();
    if (text.length > 256 * 1024) throw invalid('請求內容過大');
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw invalid('JSON 格式錯誤'); }
  }

  const routes = [];
  const route = (method, pattern, handler, { open = false } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, open });
  };

  route('GET', '/api/health', () => ({ ok: true, roomCodeRequired: !!ROOM_CODE }), { open: true });
  route('GET', '/api/roles', () => ({ items: ROLES, fields: SETTING_FIELDS, environments: ENVIRONMENTS }), { open: true });
  route('POST', '/api/join', async ({ req, ctx }) => ({ __status: 201, ...(await joinHuman(ctx, await readJson(req))) }), { open: true });

  route('GET', '/api/me', ({ me, ctx }) => peopleMap(ctx).then(people => ({
    ...identity(me, people),
    isOnline: true,
    expiresAt: iso(me.token_expires_at),
    ...(me.kind === 'ai' ? { settings: settingsOf(me) } : {}),
  })));
  // 頭像圖片：網頁先裁成 256×256 再上傳；只收 png／jpeg／webp，200 KB 以內
  const AVATAR_MAX = 200 * 1024;
  function avatarMime(b) {
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return null;
  }
  async function putAvatar(ctx, target, req) {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (!bytes.length) throw invalid('沒有收到圖片');
    if (bytes.length > AVATAR_MAX) throw invalid('頭像圖片超過 200 KB，請先縮小');
    const mime = avatarMime(bytes);
    if (!mime) throw invalid('頭像只接受 png、jpg、webp 圖片');
    const ts = nowIso();
    await db.run('INSERT OR REPLACE INTO avatars (participant_id, mime, data, updated_at) VALUES (?,?,?,?)', target.id, mime, bytes, ts);
    invalidatePeople();
    await db.run('UPDATE participants SET avatar_v = ?, updated_at = ? WHERE id = ?', Date.now(), ts, target.id);
    return identity(await db.get('SELECT * FROM participants WHERE id = ?', target.id), await peopleMap(ctx));
  }
  async function deleteAvatar(ctx, target) {
    await db.run('DELETE FROM avatars WHERE participant_id = ?', target.id);
    invalidatePeople();
    await db.run('UPDATE participants SET avatar_v = 0, updated_at = ? WHERE id = ?', nowIso(), target.id);
    return identity(await db.get('SELECT * FROM participants WHERE id = ?', target.id), await peopleMap(ctx));
  }
  route('PUT', '/api/me/avatar', ({ me, req, ctx }) => putAvatar(ctx, me, req));
  route('DELETE', '/api/me/avatar', ({ me, ctx }) => deleteAvatar(ctx, me));
  route('PUT', '/api/my-ais/:id/avatar', async ({ me, req, params, ctx }) => { requireHuman(me); return putAvatar(ctx, await myAi(me, params.id), req); });
  route('DELETE', '/api/my-ais/:id/avatar', async ({ me, params, ctx }) => { requireHuman(me); return deleteAvatar(ctx, await myAi(me, params.id)); });
  // 讀圖：網址帶版本號（?v=），瀏覽器可長期快取，不會每次輪詢都讀資料庫
  route('GET', '/api/avatars/:id', async ({ params }) => {
    const a = await db.get('SELECT mime, data FROM avatars WHERE participant_id = ?', params.id);
    if (!a) throw new ApiError(404, 'NOT_FOUND', '沒有頭像圖片');
    const bytes = a.data instanceof Uint8Array ? a.data : new Uint8Array(a.data);
    return new Response(bytes, { headers: { 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
  });

  // 更新自己的頭像文字（人類與 AI 皆可）
  route('PATCH', '/api/me', async ({ me, req, ctx }) => {
    const body = await readJson(req);
    if (body.avatar === undefined) throw invalid('目前只能更新 avatar');
    const avatar = readAvatar(body.avatar);
    invalidatePeople();
    await db.run('UPDATE participants SET avatar = ?, updated_at = ? WHERE id = ?', avatar, nowIso(), me.id);
    return identity({ ...me, avatar }, await peopleMap(ctx));
  });
  // 設定所屬專案：人類改自己，AI 由所屬人類改；至少選一個
  route('PUT', '/api/participants/:id/projects', async ({ ctx, me, req, params }) => {
    const people = await peopleMap(ctx);
    const target = people.get(params.id);
    if (!target || target.status !== 'active' || target.kind === 'system') throw new ApiError(404, 'NOT_FOUND', '找不到成員');
    if (me.kind !== 'human' || !(target.id === me.id || (target.kind === 'ai' && target.owner_id === me.id))) {
      throw new ApiError(403, 'FORBIDDEN', '只有本人（人類）或 AI 的所屬人類能修改所屬專案。');
    }
    const list = readProjects((await readJson(req)).projects);
    invalidatePeople();
    await db.run('UPDATE participants SET projects = ?, updated_at = ? WHERE id = ?', list.join(','), nowIso(), target.id);
    return identity({ ...target, projects: list.join(',') }, await peopleMap(ctx));
  });
  // ---------- AI 工作記憶（C-108）：換電腦或關機後可從雲端讀回；依專案可見 ----------
  const STATE_MAX_BYTES = 16 * 1024;
  const STATE_WAKE = ['watcher', 'cron', 'manual'];
  // 行內／投信 AI 只准寫標題與 SHA：字串像路徑、檔名、類別名稱、SQL、程式碼或疑似金鑰就擋（擋不住所有情況，仍靠 AI 自律）
  const LOOKS_INTERNAL = [/[A-Za-z]:\\/, /(^|\s)\/(home|Users|opt|var|usr|etc)\//, /\.(java|cs|sql|xml|config|properties|ps1|sh|py|js|ts|dll|jar)\b/i,
    /\b(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,40}\b(FROM|INTO|SET)\b/i, /```/, /\b(class|interface|namespace|package)\s+[A-Z]\w+/, /eyJ[A-Za-z0-9_-]{20,}/, /[A-Za-z0-9_-]{40,}/];
  function strField(v, name, max, { required = false } = {}) {
    if (v === undefined || v === null || v === '') { if (required) throw invalid(`${name} 為必填`); return undefined; }
    const t = String(v).trim();
    if (!t && required) throw invalid(`${name} 為必填`);
    if (t.length > max) throw invalid(`${name} 上限 ${max} 字`);
    return t;
  }
  function onlyKeys(obj, keys, where) {
    for (const k of Object.keys(obj)) if (!keys.includes(k)) throw invalid(`${where} 不接受欄位 ${k}`);
  }
  function normalizeState(raw, me) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('state 需為 JSON 物件');
    onlyKeys(raw, ['currentTask', 'backlog', 'wakeMode', 'updatedAt'], 'state');
    const out = {};
    if (raw.currentTask !== undefined && raw.currentTask !== null) {
      const t = raw.currentTask;
      if (typeof t !== 'object' || Array.isArray(t)) throw invalid('currentTask 需為物件');
      onlyKeys(t, ['title', 'stage', 'sha', 'cardId'], 'currentTask');
      const ct = { title: strField(t.title, 'currentTask.title', 100, { required: true }) };
      const stage = strField(t.stage, 'currentTask.stage', 30); if (stage) ct.stage = stage;
      const sha = strField(t.sha, 'currentTask.sha', 40); if (sha) { if (!/^[0-9a-f]{40}$/.test(sha)) throw invalid('currentTask.sha 需為完整 40 碼'); ct.sha = sha; }
      const cardId = strField(t.cardId, 'currentTask.cardId', 12); if (cardId) { if (!/^C-\d+$/.test(cardId)) throw invalid('currentTask.cardId 需為 C-數字'); ct.cardId = cardId; }
      out.currentTask = ct;
    } else out.currentTask = null;
    if (raw.backlog !== undefined) {
      if (!Array.isArray(raw.backlog)) throw invalid('backlog 需為陣列');
      if (raw.backlog.length > 20) throw invalid('backlog 最多 20 筆');
      out.backlog = raw.backlog.map((b, i) => {
        if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid(`backlog[${i}] 需為物件`);
        onlyKeys(b, ['title', 'trigger'], `backlog[${i}]`);
        const item = { title: strField(b.title, `backlog[${i}].title`, 100, { required: true }) };
        const trig = strField(b.trigger, `backlog[${i}].trigger`, 100); if (trig) item.trigger = trig;
        return item;
      });
    } else out.backlog = [];
    if (raw.wakeMode !== undefined && raw.wakeMode !== null) {
      if (!STATE_WAKE.includes(raw.wakeMode)) throw invalid(`wakeMode 需為：${STATE_WAKE.join('、')}`);
      out.wakeMode = raw.wakeMode;
    }
    if (['行內', '投信'].includes(me.env)) {
      const strings = [out.currentTask?.title, out.currentTask?.stage, ...out.backlog.flatMap(b => [b.title, b.trigger])].filter(Boolean);
      const bad = strings.find(x => LOOKS_INTERNAL.some(re => re.test(x)));
      if (bad) throw new ApiError(400, 'INTERNAL_CONTENT', `你的環境是${me.env}：工作記憶只能寫標題與 SHA，不要寫路徑、檔名、類別名稱、SQL、程式碼或金鑰。疑似違規：${bad.slice(0, 30)}`);
    }
    return out;
  }
  // 誰看得到誰的工作記憶：兩邊至少有一個共同專案（兩邊成員都看得到）
  const canSeeState = (viewer, target) => projectsOf(target).some(p => projectsOf(viewer).includes(p));
  async function readState(id) {
    const r = await db.get('SELECT state, updated_at FROM ai_state WHERE participant_id = ?', id);
    return r ? { state: JSON.parse(r.state), updatedAt: r.updated_at } : null;
  }
  route('PUT', '/api/me/state', async ({ me, req }) => {
    if (me.kind !== 'ai') throw new ApiError(403, 'FORBIDDEN', '工作記憶是 AI 寫自己的；人類請用網頁查看。');
    const text = await req.text();
    if (new TextEncoder().encode(text).length > STATE_MAX_BYTES) throw invalid('state 超過 16KB');
    let raw; try { raw = JSON.parse(text); } catch { throw invalid('JSON 格式錯誤'); }
    const state = normalizeState(raw, me);
    const json = JSON.stringify(state);
    if (new TextEncoder().encode(json).length > STATE_MAX_BYTES) throw invalid('state 超過 16KB');
    const cur = await db.get('SELECT state, updated_at FROM ai_state WHERE participant_id = ?', me.id);
    if (cur && cur.state === json) return { state, updatedAt: cur.updated_at, unchanged: true }; // 沒變就不寫資料庫
    const at = nowIso();
    await db.run('INSERT INTO ai_state (participant_id, state, updated_at) VALUES (?,?,?) ON CONFLICT(participant_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at', me.id, json, at);
    teamCache = { at: 0, data: null }; // 團隊狀態快取一起失效
    return { state, updatedAt: at, unchanged: false };
  });
  route('GET', '/api/me/state', async ({ me }) => {
    if (me.kind !== 'ai') throw new ApiError(403, 'FORBIDDEN', '只有 AI 有自己的工作記憶。');
    return (await readState(me.id)) || { state: null, updatedAt: null };
  });
  route('GET', '/api/participants/:id/state', async ({ ctx, me, params }) => {
    const people = await peopleMap(ctx);
    const target = people.get(params.id);
    if (!target || target.kind !== 'ai' || target.status !== 'active') throw new ApiError(404, 'NOT_FOUND', '找不到這位 AI');
    if (!canSeeState(me, target)) throw new ApiError(403, 'PROJECT_FORBIDDEN', '這位 AI 不屬於你的專案，看不到它的工作記憶。');
    return (await readState(target.id)) || { state: null, updatedAt: null };
  });
  route('GET', '/api/participants', async ({ ctx }) => {
    const people = await peopleMap(ctx);
    const now = Date.now();
    const items = [...people.values()].filter(p => p.status === 'active' && p.kind !== 'system')
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(p => publicParticipant(p, people, now));
    return { items };
  });

  route('GET', '/api/messages', ({ ctx, url, me }) => listMessages(ctx, url, me));
  route('GET', '/api/messages/:id', async ({ ctx, params }) => {
    const m = await db.get('SELECT * FROM messages WHERE id = ?', params.id);
    if (!m) throw new ApiError(404, 'NOT_FOUND', '找不到訊息');
    return serializeMessage(ctx, m);
  });
  route('POST', '/api/messages', async ({ req, me, ctx }) => {
    const r = await createMessage(ctx, me, await readJson(req));
    return { __status: r.duplicate ? 200 : 201, ...r.message };
  });

  route('GET', '/api/notifications', ({ ctx, me, url }) => listNotifications(ctx, me, url));
  route('GET', '/api/notifications/count', async ({ me }) => {
    const r = await db.get("SELECT COUNT(*) AS c FROM notifications WHERE recipient_id = ? AND status = 'pending'", me.id);
    return { pending: r.c };
  });
  route('POST', '/api/notifications/ack', async ({ me, req }) => ackNotifications(me, (await readJson(req)).notificationIds));

  route('GET', '/api/my-ais', async ({ me, ctx }) => {
    requireHuman(me);
    const people = await peopleMap(ctx);
    const items = [...people.values()].filter(p => p.kind === 'ai' && p.owner_id === me.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at)).map(p => aiView(p, people));
    return { items };
  });
  route('POST', '/api/my-ais', async ({ me, req, ctx }) => { requireHuman(me); return { __status: 201, ...(await createAi(ctx, me, await readJson(req))) }; });
  route('PATCH', '/api/my-ais/:id', async ({ me, req, params, ctx }) => { requireHuman(me); return updateAi(ctx, me, params.id, await readJson(req)); });
  route('POST', '/api/my-ais/:id/reissue', ({ me, params, ctx }) => { requireHuman(me); return reissueToken(ctx, me, params.id); });
  route('POST', '/api/my-ais/:id/disable', ({ me, params, ctx }) => { requireHuman(me); return setAiStatus(ctx, me, params.id, 'disabled'); });
  route('POST', '/api/my-ais/:id/enable', ({ me, params, ctx }) => { requireHuman(me); return setAiStatus(ctx, me, params.id, 'active'); });
  route('GET', '/api/my-ais/:id/onboarding', async ({ me, params, base }) => {
    requireHuman(me);
    return { text: await onboardingText(base, await myAi(me, params.id)) };
  });
  // ---------- 上傳文件（需求 v1.1） ----------
  const requireStorage = () => {
    if (!storage) throw new ApiError(503, 'FILES_DISABLED', '此環境未啟用上傳文件功能');
  };
  const audit = (action, actor, f, extra = {}) => db.run(
    `INSERT INTO file_audit (id, file_id, action, actor_id, actor_kind, at, name, size, sha256, declared, detail)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    randId('aud'), f?.id ?? null, action, actor?.id ?? 'system', actor?.kind ?? 'system', nowIso(),
    f?.name ?? extra.name ?? null, f?.size ?? extra.size ?? null, f?.sha256 ?? extra.sha256 ?? null,
    f ? f.declared : extra.declared ?? null, extra.detail ?? null);

  async function activeFile(id) {
    const f = await db.get('SELECT * FROM files WHERE id = ?', id);
    if (!f || f.deleted_at || f.expires_at <= Date.now()) throw new ApiError(404, 'NOT_FOUND', '檔案不存在、已刪除或已超過保存期限');
    return f;
  }

  async function uploadFile(ctx, me, req, url) {
    requireStorage();
    const q = url.searchParams;
    const name = cleanFileName(q.get('name'));
    const declared = ['true', '1', 'yes'].includes(String(q.get('declared')).toLowerCase());
    const bytes = new Uint8Array(await req.arrayBuffer());
    const reject = async (status, code, message) => {
      await audit('reject', me, null, { name: name || null, size: bytes.length, declared: declared ? 1 : 0, detail: code });
      return new ApiError(status, code, message);
    };
    if (!name) throw await reject(400, 'INVALID_REQUEST', '請用 ?name= 提供檔名（含副檔名）');
    if (!declared) {
      throw await reject(400, 'DECLARATION_REQUIRED', '上傳前必須聲明檔案不含程式碼與客戶個資（declared=true）');
    }
    let info;
    try { info = inspectFile(name, bytes); }
    catch (e) { if (e instanceof FileRejected) throw await reject(e.status, e.code, e.message); throw e; }
    const used = (await db.get('SELECT COALESCE(SUM(size), 0) AS s FROM files WHERE deleted_at IS NULL')).s;
    if (used + bytes.length > MAX_TOTAL) {
      throw await reject(507, 'STORAGE_FULL', `平台總容量已達 ${formatBytes(MAX_TOTAL)} 上限（已用 ${formatBytes(used)}），請等舊檔到期清除後再上傳`);
    }

    const id = randId('file');
    const hash = await sha256(bytes);
    const now = Date.now();
    await storage.put(id, bytes, { mime: info.mime, name });
    await db.run(`INSERT INTO files (id, uploader_id, name, ext, mime, size, sha256, declared, created_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, id, me.id, name, info.ext, info.mime, bytes.length, hash, 1, nowIso(), now + FILE_TTL_MS);
    const file = await db.get('SELECT * FROM files WHERE id = ?', id);
    await audit('upload', me, file);

    // 自動在群組發一則附下載連結的訊息
    const note = (q.get('text') || '').trim();
    const hours = Math.round(FILE_TTL_MS / 3600_000);
    const ttl = hours >= 1 ? `${hours} 小時` : `${Math.max(1, Math.round(FILE_TTL_MS / 60_000))} 分鐘`;
    const text = `${note ? note + '\n' : ''}[文件] ${name}（${formatBytes(bytes.length)}，SHA-256 ${hash.slice(0, 12)}…）\n已聲明不含程式碼與客戶個資；${ttl}後自動刪除。下載：GET /api/files/${id}`;
    const recipientIds = (q.get('recipientIds') || '').split(',').map(x => x.trim()).filter(Boolean);
    const { message } = await createMessage(ctx, me, {
      text: text.slice(0, MAX_TEXT), requestId: 'req_file_' + id,
      replyToMessageId: q.get('replyToMessageId') || undefined,
      recipientIds: recipientIds.length ? recipientIds : undefined,
      audience: q.get('audience') === 'all' ? 'all' : undefined,
    }, { fileId: id });
    await db.run('UPDATE files SET message_id = ? WHERE id = ?', message.messageId, id);
    return { __status: 201, file: fileView(file), message };
  }

  async function downloadFile(me, id) {
    requireStorage();
    const f = await activeFile(id);
    const bytes = await storage.get(f.id);
    if (!bytes) throw new ApiError(404, 'NOT_FOUND', '檔案內容不存在');
    await audit('download', me, f);
    return new Response(bytes, {
      headers: {
        'Content-Type': f.mime,
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="file.${f.ext}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  }

  async function deleteFile(me, id) {
    requireStorage();
    const f = await activeFile(id);
    const uploader = await db.get('SELECT id, owner_id FROM participants WHERE id = ?', f.uploader_id);
    const allowed = me.id === f.uploader_id || (uploader?.owner_id && uploader.owner_id === me.id);
    if (!allowed) {
      await audit('reject', me, f, { detail: 'DELETE_FORBIDDEN' });
      throw new ApiError(403, 'FORBIDDEN', '只有上傳者本人或其所屬人類可以刪除');
    }
    await storage.delete(f.id);
    await db.run('UPDATE files SET deleted_at = ?, deleted_by = ? WHERE id = ?', nowIso(), me.id, f.id);
    await audit('delete', me, f);
    return { ok: true, fileId: f.id };
  }

  // 清除超過保存期限的檔案（排程呼叫）
  async function cleanupExpired() {
    if (!storage) return 0;
    const rows = await db.all('SELECT * FROM files WHERE deleted_at IS NULL AND expires_at <= ? LIMIT 500', Date.now());
    for (const f of rows) {
      await storage.delete(f.id);
      await db.run("UPDATE files SET deleted_at = ?, deleted_by = 'system' WHERE id = ?", nowIso(), f.id);
      await audit('expire', null, f);
    }
    return rows.length;
  }

  route('GET', '/api/files/audit', async ({ me, url, ctx }) => {
    requireHuman(me);
    const limit = parseLimit(url, 100, 500);
    const people = await peopleMap(ctx);
    const rows = await db.all('SELECT * FROM file_audit ORDER BY at DESC LIMIT ?', limit);
    return {
      items: rows.map(a => ({
        auditId: a.id, action: a.action, at: a.at, fileId: a.file_id, name: a.name, size: a.size, sha256: a.sha256,
        declared: a.declared === null ? null : !!a.declared, detail: a.detail,
        actor: a.actor_kind === 'system' ? { memberType: 'system', name: '系統' }
          : people.get(a.actor_id) ? identity(people.get(a.actor_id), people) : { participantId: a.actor_id, memberType: a.actor_kind },
      })),
    };
  });
  route('GET', '/api/files', async ({ ctx }) => {
    const people = await peopleMap(ctx);
    const rows = await db.all('SELECT * FROM files WHERE deleted_at IS NULL AND expires_at > ? ORDER BY created_at DESC', Date.now());
    const used = rows.reduce((n, f) => n + f.size, 0);
    return {
      items: rows.map(f => ({ ...fileView(f), uploader: people.get(f.uploader_id) ? identity(people.get(f.uploader_id), people) : null })),
      usedBytes: used, limitBytes: MAX_TOTAL, maxFileBytes: MAX_FILE_BYTES, enabled: !!storage,
    };
  });
  route('POST', '/api/files', ({ ctx, me, req, url }) => uploadFile(ctx, me, req, url));
  route('GET', '/api/files/:id', ({ me, params }) => downloadFile(me, params.id));
  route('DELETE', '/api/files/:id', ({ me, params }) => deleteFile(me, params.id));

  // ---------- 團隊狀態（平台改善：看得出每個人在做什麼、有沒有連上） ----------
  const STANDBY_STALE_MS = 60 * 60_000;
  const STALE_MS = (Number(config.staleMinutes) || 20) * 60_000;       // AI 超過這段時間沒出現 → 可能斷線
  const UNANSWERED_MS = (Number(config.unansweredMinutes) || 20) * 60_000; // 指派超過這段時間沒讀取 → 尚未回應
  const TOKEN_WARN_MS = 2 * 3600_000;
  const TEAM_CACHE_MS = config.teamCacheMs !== undefined ? Number(config.teamCacheMs) : TEAM_CACHE_MS_DEFAULT;                                   // Token 到期前 2 小時提醒

  // 依訊息開頭的標籤推斷狀態，例如 [接單]、[UX 完成・請核准 commit]
  function inferState(text) {
    const tag = String(text).trimStart().match(/^\[([^\]\n]{1,40})\]/)?.[1];
    if (!tag) return null;
    if (tag.includes('受阻')) return 'blocked';
    if (tag.includes('需確認')) return 'waiting';
    if (/接單|進度|開始/.test(tag)) return 'working';
    if (/完成|回覆|交接|簽到|決策紀錄|已 ?push|已發布|已部署/.test(tag)) return 'idle';
    return null;
  }
  const headline = text => String(text).trimStart().split('\n')[0].replace(/^\[[^\]]*\]\s*/, '').slice(0, 80);

  // 團隊狀態用的最近 200 則訊息與 [需確認] 的回覆：保留在記憶體，之後只補讀新訊息
  let recentCache = { rows: null, maxSeq: 0, replies: new Map() }; // replies: [需確認] id → 回覆列
  async function recentMessages() {
    const cols = 'SELECT id, seq, author_id, text, reply_to, created_at FROM messages';
    if (!recentCache.rows) {
      const rows = await db.all(`${cols} ORDER BY seq DESC LIMIT 200`);
      recentCache = { rows, maxSeq: rows[0]?.seq || 0, replies: null };
      return rows;
    }
    const fresh = await db.all(`${cols} WHERE seq > ? ORDER BY seq DESC LIMIT 200`, recentCache.maxSeq);
    if (fresh.length) {
      if (recentCache.replies) {
        for (const m of fresh) recentCache.replies.get(m.reply_to)?.push(m);
      }
      recentCache.rows = fresh.concat(recentCache.rows).slice(0, 200);
      recentCache.maxSeq = fresh[0].seq;
    }
    return recentCache.rows;
  }
  async function repliesTo(asks) {
    if (!asks.length) return [];
    const cache = recentCache.replies;
    const missing = asks.filter(m => !cache?.has(m.id));
    if (missing.length) {
      const rows = await db.all('SELECT reply_to, author_id, text FROM messages WHERE reply_to IN (SELECT value FROM json_each(?))',
        JSON.stringify(missing.map(m => m.id)));
      const map = cache || new Map();
      for (const m of missing) map.set(m.id, []);
      for (const r of rows) map.get(r.reply_to).push(r);
      recentCache.replies = map;
    }
    const live = new Set(asks.map(m => m.id));
    for (const id of recentCache.replies.keys()) if (!live.has(id)) recentCache.replies.delete(id);
    return asks.flatMap(m => recentCache.replies.get(m.id));
  }

  async function teamStatus(ctx) {
    if (teamCache.data && Date.now() - teamCache.at < TEAM_CACHE_MS) return teamCache.data;
    const people = await peopleMap(ctx);
    const now = Date.now();
    const recent = await recentMessages();

    // 每位成員最新一則帶狀態標籤的訊息
    const stateBy = new Map();
    for (const m of recent) {
      if (stateBy.has(m.author_id)) continue;
      const st = inferState(m.text);
      if (st) stateBy.set(m.author_id, { state: st, title: headline(m.text), messageId: m.id, at: m.created_at });
    }

    // 有負責的未完成卡片 → 工作狀態取自卡片（較準）；沒有卡片的成員仍用訊息標籤推斷
    const cardWork = await teamCards(db);
    for (const [id, w] of cardWork.work) stateBy.set(id, w);

    const pending = await db.all("SELECT * FROM notifications WHERE status = 'pending' ORDER BY created_at");
    const pendBy = new Map();
    for (const n of pending) {
      const x = pendBy.get(n.recipient_id) || { count: 0, oldest: n.created_at };
      x.count++;
      pendBy.set(n.recipient_id, x);
    }

    const aiStates = new Map((await db.all('SELECT participant_id, state, updated_at FROM ai_state')).map(r => [r.participant_id, { ...JSON.parse(r.state), updatedAt: r.updated_at }]));
    const members = [...people.values()].filter(p => p.status === 'active' && p.kind !== 'system')
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(p => ({
        ...identity(p, people),
        aiState: aiStates.get(p.id) || null,
        lastSeenAt: iso(p.last_seen_at),
        isOnline: isOnline(p, now),
        // 有 watcher 心跳的 AI（24 小時內有過）超過 60 分鐘沒任何呼叫才算可能斷線；其他 AI 維持原門檻
        stale: p.kind === 'ai' && (!p.last_seen_at || now - p.last_seen_at > (p.standby_at && now - p.standby_at < 24 * 3600_000 ? STANDBY_STALE_MS : STALE_MS)),
        standby: p.kind === 'ai' && !!p.standby_at && now - p.standby_at <= 20 * 60_000,
        status: stateBy.get(p.id) || null,
        tokenExpiresAt: iso(p.token_expires_at),
        tokenExpired: p.kind === 'ai' && p.token_expires_at <= now,
        tokenExpiringSoon: p.kind === 'ai' && p.token_expires_at > now && p.token_expires_at - now <= TOKEN_WARN_MS,
        pendingCount: pendBy.get(p.id)?.count || 0,
        oldestPendingAt: pendBy.get(p.id)?.oldest || null,
      }));

    // 指派（@ 指定）超過時限仍未讀取的對象
    const cutoff = new Date(now - UNANSWERED_MS).toISOString();
    const unanswered = pending
      .filter(n => n.created_at <= cutoff && JSON.parse(n.reasons).includes('mention') && people.get(n.recipient_id)?.status === 'active')
      .map(n => ({ messageId: n.message_id, participantId: n.recipient_id, name: people.get(n.recipient_id).name, since: n.created_at }));

    // 等人決定：[需確認] 訊息，直到 (1) 人類直接回覆、(2) 人類按「已處理」、(3) PO 角色的 AI 以 [決策紀錄] 回覆
    const asks = recent.filter(m => inferState(m.text) === 'waiting');
    const askIds = JSON.stringify(asks.map(m => m.id));
    const replies = await repliesTo(asks);
    const resolved = new Set(asks.length
      ? (await db.all('SELECT message_id FROM decision_resolutions WHERE message_id IN (SELECT value FROM json_each(?))', askIds)).map(r => r.message_id) : []);
    const closes = r => {
      const a = people.get(r.author_id);
      if (a?.kind === 'human') return true;
      return a?.kind === 'ai' && a.role_key === 'PO' && /^\s*\[決策紀錄/.test(r.text);
    };
    const replyCount = new Map();
    for (const r of replies) {
      replyCount.set(r.reply_to, (replyCount.get(r.reply_to) || 0) + 1);
      if (closes(r)) resolved.add(r.reply_to);
    }
    const decisions = asks.filter(m => !resolved.has(m.id)).slice(0, 30).map(m => ({
      messageId: m.id, sequence: m.seq, title: headline(m.text), createdAt: m.created_at,
      author: identity(people.get(m.author_id), people), replyCount: replyCount.get(m.id) || 0,
    }));

    // 決策卡片等決策者的，一併列入「等你決定」（網頁只對指定的決策者顯示）
    for (const d of cardWork.decisions) {
      decisions.push({ messageId: null, cardId: d.cardId, sequence: null, title: d.title, createdAt: d.createdAt,
        author: identity(people.get(d.proposerId) || { id: d.proposerId, name: '?', kind: 'ai' }, people), replyCount: 0, deciderId: d.deciderId });
    }
    const data = { now: iso(now), staleMinutes: STALE_MS / 60_000, unansweredMinutes: UNANSWERED_MS / 60_000, members, unanswered, decisions };
    teamCache = { at: Date.now(), data };
    return data;
  }

  // Token 到期提醒不再發群組訊息（會增加資料量、所有 AI 都要讀）；改由網頁只對所屬人類顯示

  registerCards({ route, createMessage, PROJECTS, projectsOf, projectFilter, db, ApiError, invalid, readJson, peopleMap, randId, nowIso, parseLimit, invalidatePeople });

  route('GET', '/api/team-status', async ({ ctx, me }) => {
    const d = await teamStatus(ctx);
    const people = await peopleMap(ctx);
    return { ...d, members: d.members.map(m => (m.aiState && !canSeeState(me, people.get(m.participantId)) ? { ...m, aiState: null } : m)) }; // 工作記憶依專案可見
  });
  route('POST', '/api/decisions/:id/resolve', async ({ me, params }) => {
    requireHuman(me);
    const m = await db.get('SELECT id, text FROM messages WHERE id = ?', params.id);
    if (!m) throw new ApiError(404, 'NOT_FOUND', '找不到訊息');
    if (inferState(m.text) !== 'waiting') throw invalid('這則不是 [需確認] 訊息');
    await db.run('INSERT OR IGNORE INTO decision_resolutions (message_id, resolved_by, resolved_at) VALUES (?,?,?)', m.id, me.id, nowIso());
    teamCache = { at: 0, data: null };
    const r = await db.get('SELECT * FROM decision_resolutions WHERE message_id = ?', m.id);
    return { messageId: m.id, resolvedBy: r.resolved_by, resolvedAt: r.resolved_at };
  });

  route('POST', '/api/leave', async ({ me }) => {
    requireHuman(me);
    invalidatePeople();
    await db.run("UPDATE participants SET status = 'disabled', updated_at = ? WHERE id = ? OR owner_id = ?", nowIso(), me.id, me.id);
    return { ok: true };
  });

  // 對外：處理 /api/*；base 為對外網址（例如 https://xxx.workers.dev）
  handle.cleanupExpired = cleanupExpired;
  // 排程工作：清除過期文件
  handle.runScheduled = async () => ({ filesCleaned: await cleanupExpired() });
  return handle;

  async function handle(req, base) {
    const url = new URL(req.url);
    if (url.pathname === '/api/docs/ai-integration' || url.pathname === '/docs/ai-integration.md') {
      return new Response(docText.replaceAll('{{BASE_URL}}', base), {
        headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const ctx = {};
        const me = r.open ? null : await authenticate(req, url);
        const out = await r.handler({ req, url, params, me, ctx, base });
        if (out instanceof Response) return out;
        const status = out.__status || 200;
        delete out.__status;
        return json(status, out);
      }
      throw new ApiError(404, 'NOT_FOUND', '找不到此 API');
    } catch (e) {
      if (!(e instanceof ApiError)) {
        console.error(e);
        e = new ApiError(500, 'INTERNAL', '伺服器錯誤');
      }
      const headers = e.extra.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : {};
      return json(e.status, { error: { code: e.code, message: e.message } }, headers);
    }
  }
}
