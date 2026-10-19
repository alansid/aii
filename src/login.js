// 人類登入（C-202）：邀請連結、裝置、6 位數配對碼、登入碼。
// 「怎麼證明你是誰」是可替換的一層：PROVIDERS 每一種方式只負責把憑證換成「是哪位成員」，
// 成功後一律由 issueDevice 發這台裝置的登入（dv_ 開頭，資料庫只存雜湊）。之後要接公司 SSO（OIDC／SAML），
// 加一個 provider（例如 sso: { verify }）就好，裝置清單、登出、重設登入都不用改。
// AI 的 Token 不經過這裡，維持原樣。
// C-223：再加帳號密碼（人類自己設）與主機救援連結（只救管理員，只能在主機用 npm run admin-rescue 產生）。
import { hashPassword, verifyPassword, normUsername, validUsername, USERNAME_RULE, PASSWORD_MIN, PASSWORD_MAX } from './password.js';

// C-308：邀請連結有效時間可選（預設 24 小時）；照舊只能用一次
export const INVITE_TTLS = { '15m': 15 * 60_000, '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 };
const INVITE_TTL_DEFAULT = '24h';
const PAIR_TTL_MS = 5 * 60_000;        // 配對碼 5 分鐘
const INVITE_LIST_MS = 7 * 86_400_000; // 邀請清單顯示最近 7 天
const DEVICE_PREFIX = 'dv_';
const LOCK_FAILS = 5;                  // C-223：同一個帳號連錯 5 次
const LOCK_MS = 15 * 60_000;           // 鎖 15 分鐘
const NOTICE_MS = 30 * 86_400_000;     // 安全通知留 30 天
const PWD_DEVICE = '帳號密碼登入';
const RESCUE_DEVICE = '救援登入';

// 由 User-Agent 推出「瀏覽器 · 系統」，只用來在「我的裝置」辨認
export function deviceLabel(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '其他';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} · ${os}` : b;
}
// C-223：「帳號密碼登入 · Safari（iPhone）」
export function deviceLabelAs(prefix, ua = '') {
  const [b, os] = deviceLabel(ua).split(' · ');
  return `${prefix} · ${b}${os ? `（${os}）` : ''}`;
}

export function registerLogin(d) {
  const { route, db, ApiError, invalid, readJson, randId, newToken, randomBytes, sha256, nowIso, iso, peopleMap, invalidatePeople, readRole, setInitialRoles, setInitialReadOnly,
    adminOf, requireAdmin, requireHuman, validateName, assertNameFree, newCode, PROJECTS, nameOf, createMessage, publicParticipant,
    groupName, humanTtlMs, failLimit = 10 } = d;

  // ---------- 嘗試失敗的限流（配對碼只有 6 位數，要擋猜測） ----------
  const fails = new Map();
  const WINDOW = 10 * 60_000;
  const ipOf = req => req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  function guard(req) {
    const now = Date.now();
    for (const key of [ipOf(req), '*']) {
      const f = fails.get(key);
      if (f && now - f.start < WINDOW && f.n >= (key === '*' ? failLimit * 10 : failLimit)) {
        throw new ApiError(429, 'TOO_MANY_ATTEMPTS', '嘗試太多次，請 10 分鐘後再試', { retryAfter: Math.ceil((f.start + WINDOW - now) / 1000) });
      }
    }
  }
  function failed(req) {
    const now = Date.now();
    for (const key of [ipOf(req), '*']) {
      const f = fails.get(key);
      if (!f || now - f.start >= WINDOW) fails.set(key, { start: now, n: 1 }); else f.n++;
    }
  }

  // ---------- 裝置 ----------
  async function issueDevice(participantId, req, label = deviceLabel(req.headers.get('user-agent') || '')) {
    const token = DEVICE_PREFIX + newToken();
    const now = Date.now();
    await db.run('INSERT INTO devices (id, participant_id, token_hash, label, created_at, last_used_at, expires_at) VALUES (?,?,?,?,?,?,?)',
      randId('dev'), participantId, await sha256(token), label, now, now, now + humanTtlMs);
    return token;
  }

  // ---------- C-223 帳號密碼 ----------
  const credOf = pid => db.get('SELECT * FROM credentials WHERE participant_id = ?', pid);
  const credView = c => (c ? { set: true, username: c.username, updatedAt: iso(c.updated_at) } : { set: false, username: null, updatedAt: null });
  const taken = () => new ApiError(409, 'USERNAME_TAKEN', '這個帳號已經有人用了，換一個。');
  const locked = until => new ApiError(429, 'ACCOUNT_LOCKED', '輸錯太多次，請 15 分鐘後再試。', { retryAfter: Math.ceil((until - Date.now()) / 1000) });
  function readUsername(raw) {
    const u = normUsername(raw);
    if (!validUsername(u)) throw invalid(USERNAME_RULE);
    return u;
  }
  function readPassword(raw, again) {
    const p = typeof raw === 'string' ? raw : '';
    if (p.length < PASSWORD_MIN) throw invalid(`密碼至少 ${PASSWORD_MIN} 碼`);
    if (p.length > PASSWORD_MAX) throw invalid(`密碼最多 ${PASSWORD_MAX} 碼`);
    if (again !== undefined && again !== p) throw invalid('兩次輸入的密碼不一樣');
    return p;
  }
  async function assertUsernameFree(u, pid) {
    const row = await db.get('SELECT participant_id FROM credentials WHERE username = ?', u);
    if (row && row.participant_id !== pid) throw taken();
  }
  async function saveCred(pid, username, password) {
    const now = Date.now();
    const hash = password ? await hashPassword(password) : null;
    try {
      if (hash) await db.run('INSERT INTO credentials (participant_id, username, pwd_hash, updated_at) VALUES (?,?,?,?) ON CONFLICT(participant_id) DO UPDATE SET username = excluded.username, pwd_hash = excluded.pwd_hash, updated_at = excluded.updated_at', pid, username, hash, now);
      else await db.run('UPDATE credentials SET username = ?, updated_at = ? WHERE participant_id = ?', username, now, pid);
    } catch (e) { if (/UNIQUE/i.test(e.message)) throw taken(); throw e; }
  }
  // 同帳號連錯 5 次鎖 15 分鐘；不存在的帳號一樣記、一樣鎖，不透露有沒有這個帳號
  async function lockedUntil(u) {
    const r = await db.get('SELECT locked_until FROM login_fails WHERE username = ?', u);
    return r && r.locked_until > Date.now() ? r.locked_until : 0;
  }
  async function addFail(u) {
    const now = Date.now();
    const r = await db.get('SELECT * FROM login_fails WHERE username = ?', u);
    const count = r && now - r.last_at < LOCK_MS && !r.locked_until ? r.count + 1 : 1;
    const until = count >= LOCK_FAILS ? now + LOCK_MS : 0;
    await db.run('INSERT INTO login_fails (username, count, last_at, locked_until) VALUES (?,?,?,?) ON CONFLICT(username) DO UPDATE SET count = excluded.count, last_at = excluded.last_at, locked_until = excluded.locked_until', u, until ? 0 : count, now, until);
    if (Math.random() < 0.05) await db.run('DELETE FROM login_fails WHERE last_at < ? AND locked_until < ?', now - 86_400_000, now);
    return until;
  }
  const clearFails = u => db.run('DELETE FROM login_fails WHERE username = ?', u);
  let dummyHash = null; // 帳號不存在時也算一次雜湊，花的時間一樣
  const dummy = async () => (dummyHash ||= await hashPassword(newToken()));

  // 只給本人看的安全通知（不發群組訊息，AI 看不到）
  const notice = (pid, kind, detail) => db.run('INSERT INTO account_notices (id, participant_id, kind, detail, created_at) VALUES (?,?,?,?,?)', randId('ntc'), pid, kind, String(detail || '').slice(0, 200), Date.now());

  route('GET', '/api/me/password', async ({ me }) => { requireHuman(me); return credView(await credOf(me.id)); });
  // 第一次設：帳號＋新密碼；之後改帳號或密碼都要先填目前密碼。改密碼後，其他用帳號密碼登入的裝置一起登出（這台不登出）
  route('PUT', '/api/me/password', async ({ me, req }) => {
    requireHuman(me);
    const body = await readJson(req);
    const cur = await credOf(me.id);
    const username = readUsername(body.username ?? cur?.username);
    const wantNew = body.newPassword !== undefined && body.newPassword !== null && body.newPassword !== '';
    const password = wantNew ? readPassword(body.newPassword, body.newPasswordAgain) : null;
    if (!cur && !password) throw invalid(`第一次設定請輸入新密碼（至少 ${PASSWORD_MIN} 碼）`);
    if (cur) {
      const until = await lockedUntil(cur.username);
      if (until) throw locked(until);
      if (!(await verifyPassword(String(body.currentPassword ?? ''), cur.pwd_hash))) {
        const u2 = await addFail(cur.username);
        if (u2) throw locked(u2);
        throw new ApiError(400, 'WRONG_PASSWORD', '目前密碼不對');
      }
      await clearFails(cur.username);
      if (!password && username === cur.username) throw invalid('沒有要改的內容');
    }
    await assertUsernameFree(username, me.id);
    await saveCred(me.id, username, password);
    let loggedOut = 0;
    if (cur && password) {
      const r = await db.run(`UPDATE devices SET revoked_at = ? WHERE participant_id = ? AND revoked_at IS NULL AND label LIKE '${PWD_DEVICE} · %' AND id != ?`, Date.now(), me.id, me.deviceId || '');
      loggedOut = r.changes;
    }
    return { ...credView(await credOf(me.id)), loggedOut };
  });
  route('GET', '/api/me/notices', async ({ me }) => {
    requireHuman(me);
    const rows = await db.all('SELECT * FROM account_notices WHERE participant_id = ? AND read_at IS NULL AND created_at > ? ORDER BY created_at DESC LIMIT 50', me.id, Date.now() - NOTICE_MS);
    return { items: rows.map(r => ({ id: r.id, kind: r.kind, detail: r.detail, createdAt: iso(r.created_at) })) };
  });
  route('POST', '/api/me/notices/read', async ({ me, req }) => {
    requireHuman(me);
    const ids = (await readJson(req)).ids;
    if (!Array.isArray(ids) || ids.length > 100) throw invalid('ids 需為陣列（最多 100 個）');
    for (const id of ids) await db.run('UPDATE account_notices SET read_at = ? WHERE id = ? AND participant_id = ? AND read_at IS NULL', Date.now(), String(id), me.id);
    return { ok: true };
  });
  // authenticate 用：把 Bearer 換成成員；回傳 { p, dev }，找不到回 null
  // C-240：一次查完（每次查詢都可能要跨洲來回）：裝置＋成員 JOIN；AI 的所屬人類狀態一起帶回（owner_status）
  async function resolve(token) {
    if (!token.startsWith(DEVICE_PREFIX)) {
      const row = await db.get('SELECT p.*, o.status AS owner_status FROM participants p LEFT JOIN participants o ON o.id = p.owner_id WHERE p.token = ?', token);
      return { p: row, dev: null };
    }
    const row = await db.get('SELECT p.*, d.id AS dv_id, d.revoked_at AS dv_revoked, d.expires_at AS dv_expires, d.last_used_at AS dv_last FROM devices d LEFT JOIN participants p ON p.id = d.participant_id WHERE d.token_hash = ?', await sha256(token));
    if (!row || row.dv_revoked) throw new ApiError(401, 'INVALID_TOKEN', '這台裝置已登出，請重新配對或用登入碼登入');
    if (row.dv_expires < Date.now()) throw new ApiError(401, 'TOKEN_EXPIRED', '這台裝置太久沒使用，登入已過期，請重新配對');
    const { dv_id, dv_revoked, dv_expires, dv_last, ...p } = row;
    return { p: p.id ? p : null, dev: { id: dv_id, last_used_at: dv_last } };
  }
  // 使用中自動展延；每 20 秒最多寫一次（回傳要執行的語句，讓呼叫端跟其他更新一起送）
  function touchStmt(dev, now = Date.now()) {
    if (now - dev.last_used_at < 20_000) return null;
    return ['UPDATE devices SET last_used_at = ?, expires_at = ? WHERE id = ?', [now, now + humanTtlMs, dev.id]];
  }
  async function touch(dev, now = Date.now()) { const s = touchStmt(dev, now); if (s) await db.run(s[0], ...s[1]); }

  // ---------- 邀請 ----------
  const listOf = s => String(s || '').split(',').map(x => x.trim()).filter(x => PROJECTS.includes(x));
  const inviteStatus = (iv, now = Date.now()) => (iv.used_at ? '已使用' : iv.revoked_at ? '已取消' : iv.expires_at <= now ? '已過期' : '有效');
  const inviteView = (iv, people) => ({
    id: iv.id, kind: iv.participant_id ? 'reset' : 'new', name: iv.name, role: roleText(iv.role), roles: rolesOf(iv.role), readOnly: roOf(iv.role), projects: listOf(iv.projects),
    status: inviteStatus(iv), createdAt: iso(iv.created_at), expiresAt: iso(iv.expires_at), usedAt: iso(iv.used_at),
    ttl: Object.keys(INVITE_TTLS).find(k => INVITE_TTLS[k] === iv.expires_at - iv.created_at) || null, // C-308
    usedByName: iv.used_by ? people.get(iv.used_by)?.name ?? null : null, createdByName: people.get(iv.created_by)?.name ?? null,
  });
  const inviteUrl = (base, token) => `${base}/invite/${token}`;
  // C-219：邀請的角色欄存 { 專案: 角色 } 的 JSON；舊資料是單一字串
  function rolesOf(raw) { const s = String(raw || ''); if (!s.startsWith('{')) return null; try { const r = JSON.parse(s); delete r.__ro; return r; } catch { return null; } }
  // C-294：邀請時勾的唯讀專案也存在角色欄的 JSON（__ro）
  function roOf(raw) { const s = String(raw || ''); if (!s.startsWith('{')) return []; try { return JSON.parse(s).__ro || []; } catch { return []; } }
  const roleText = raw => { const r = rolesOf(raw); return r ? Object.entries(r).map(([k, v]) => `${nameOf(k)} ${v}`).join('、') : String(raw || ''); };
  function readInviteProjects(raw) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw invalid('projects 需為陣列，例如 ["平台"]');
    const list = [...new Set(raw.map(x => String(x).trim()))];
    if (list.some(x => !PROJECTS.includes(x))) throw invalid(`projects 只能是（專案編號）：${PROJECTS.join('、')}`);
    return PROJECTS.filter(x => list.includes(x));
  }
  async function validInvite(token) {
    if (!token || typeof token !== 'string') return null;
    const iv = await db.get('SELECT * FROM invites WHERE token_hash = ?', await sha256(token));
    return iv && inviteStatus(iv) === '有效' ? iv : null;
  }
  // ttl 沒帶＝預設；帶了要是 15m／1h／24h／7d
  function readTtl(raw, fallback = INVITE_TTLS[INVITE_TTL_DEFAULT]) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    if (!Object.hasOwn(INVITE_TTLS, raw)) throw invalid(`ttl 只能是 ${Object.keys(INVITE_TTLS).join('、')}`);
    return INVITE_TTLS[raw];
  }
  async function newInviteToken(ivId, ttlMs) {
    const token = newToken(), now = Date.now();
    await db.run('UPDATE invites SET token_hash = ?, created_at = ?, expires_at = ?, revoked_at = NULL WHERE id = ?', await sha256(token), now, now + ttlMs, ivId);
    return token;
  }
  async function inviteOut(ctx, base, id, token) {
    const iv = await db.get('SELECT * FROM invites WHERE id = ?', id);
    return { invite: inviteView(iv, await peopleMap(ctx)), token, url: inviteUrl(base, token) };
  }

  route('POST', '/api/invites', async ({ me, ctx, req, base }) => {
    requireHuman(me);
    await requireAdmin(ctx, me, '邀請新成員');
    const body = await readJson(req);
    const name = validateName(body.name);
    await assertNameFree(name);
    const now = Date.now();
    const dup = await db.get('SELECT id FROM invites WHERE name = ? COLLATE NOCASE AND participant_id IS NULL AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?', name, now);
    if (dup) throw new ApiError(409, 'INVITE_EXISTS', `已經有給「${name}」的有效邀請，可以在「邀請」清單重新產生`);
    const projects = readInviteProjects(body.projects);
    const ttlMs = readTtl(body.ttl); // C-308
    // C-219：roles＝{ 專案: 角色 }（勾的每個專案各一個）；舊的 role 字串照舊收
    let role;
    if (body.roles && typeof body.roles === 'object' && !Array.isArray(body.roles)) {
      const r = {};
      for (const [k, v] of Object.entries(body.roles)) { if (!projects.includes(k)) throw invalid(`「${nameOf(k)}」沒有勾選，不能設角色`); const x = readRole(v); if (x) r[k] = x; }
      role = Object.keys(r).length ? JSON.stringify(r) : '';
    } else {
      role = String(body.role ?? '').trim();
      if (role.length > 30) throw invalid('角色最多 30 字');
    }
    if (Array.isArray(body.readOnly) && body.readOnly.length) { // C-294
      const ro = [...new Set(body.readOnly.map(String))];
      const out = ro.filter(x => !projects.includes(x));
      if (out.length) throw invalid(`唯讀的專案要先勾選：${out.map(nameOf).join('、')}`);
      role = JSON.stringify({ ...(rolesOf(role) || {}), __ro: ro });
    }
    const id = randId('inv'), token = newToken();
    await db.run('INSERT INTO invites (id, token_hash, name, role, projects, participant_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, await sha256(token), name, role, projects.join(','), null, me.id, now, now + ttlMs);
    return { __status: 201, ...(await inviteOut(ctx, base, id, token)) };
  });
  route('GET', '/api/invites', async ({ me, ctx }) => {
    await requireAdmin(ctx, me, '查看邀請');
    const rows = await db.all('SELECT * FROM invites WHERE created_at > ? ORDER BY created_at DESC LIMIT 100', Date.now() - INVITE_LIST_MS);
    const people = await peopleMap(ctx);
    return { items: rows.map(iv => inviteView(iv, people)) };
  });
  async function myInvite(ctx, me, id) {
    await requireAdmin(ctx, me, '管理邀請');
    const iv = await db.get('SELECT * FROM invites WHERE id = ?', id);
    if (!iv) throw new ApiError(404, 'NOT_FOUND', '找不到這個邀請');
    return iv;
  }
  // 重新產生／重發：同樣內容換新連結，舊連結立刻失效，重新計時（沒帶 ttl 就沿用原本的有效時間）
  route('POST', '/api/invites/:id/regenerate', async ({ me, ctx, params, base, req }) => {
    const iv = await myInvite(ctx, me, params.id);
    const prevTtl = Object.values(INVITE_TTLS).find(v => v === iv.expires_at - iv.created_at) || INVITE_TTLS[INVITE_TTL_DEFAULT];
    const ttlMs = readTtl((await readJson(req).catch(() => ({}))).ttl, prevTtl);
    if (iv.used_at) throw new ApiError(400, 'INVITE_USED', `${iv.name} 已經用這個邀請加入，不需要重發`);
    if (!iv.participant_id) {
      const taken = await db.get('SELECT id FROM participants WHERE name = ?', iv.name);
      if (taken) throw new ApiError(409, 'NAME_TAKEN', `「${iv.name}」已經是成員了，不需要邀請`);
    }
    return inviteOut(ctx, base, iv.id, await newInviteToken(iv.id, ttlMs));
  });
  route('POST', '/api/invites/:id/cancel', async ({ me, ctx, params }) => {
    const iv = await myInvite(ctx, me, params.id);
    if (iv.used_at) throw new ApiError(400, 'INVITE_USED', '這個邀請已經用過了');
    if (!iv.revoked_at) await db.run('UPDATE invites SET revoked_at = ? WHERE id = ?', Date.now(), iv.id);
    return { invite: inviteView(await db.get('SELECT * FROM invites WHERE id = ?', iv.id), await peopleMap(ctx)) };
  });

  // 被邀請的人打開連結：有效就給畫面要的資料；失效一律同一句，不分原因
  route('POST', '/api/auth/invite/peek', async ({ req, ctx }) => {
    guard(req);
    const body = await readJson(req);
    const iv = await validInvite(body.token);
    const people = await peopleMap(ctx);
    const admin = adminOf(people);
    if (!iv) { failed(req); return { valid: false, adminName: admin?.name || null }; }
    return { valid: true, kind: iv.participant_id ? 'reset' : 'new', inviterName: people.get(iv.created_by)?.name || admin?.name || null,
      groupName: await groupName(), name: iv.participant_id ? people.get(iv.participant_id)?.name ?? iv.name : iv.name,
      role: roleText(iv.role), projects: listOf(iv.projects).map(id => ({ id, name: nameOf(id) })), expiresAt: iso(iv.expires_at) };
  }, { open: true });

  // 管理員「重設登入」：作廢舊登入碼、登出該人所有裝置，產生給他的新邀請連結
  route('POST', '/api/participants/:id/reset-login', async ({ me, ctx, params, base, req }) => {
    requireHuman(me);
    await requireAdmin(ctx, me, '重設成員登入');
    const t = (await peopleMap(ctx)).get(params.id);
    if (!t || t.kind !== 'human' || t.status !== 'active') throw new ApiError(404, 'NOT_FOUND', '找不到這位人類成員');
    if (t.id === me.id) throw new ApiError(400, 'RESET_SELF', '要換自己的登入碼，請到「API 資訊與登入碼」按「換一組登入碼」');
    const ttlMs = readTtl((await readJson(req).catch(() => ({}))).ttl); // C-308
    const now = Date.now(), id = randId('inv'), token = newToken();
    invalidatePeople();
    await db.batch([
      ['UPDATE participants SET token = ?, updated_at = ? WHERE id = ?', [newToken(), nowIso(), t.id]],
      ['UPDATE devices SET revoked_at = ? WHERE participant_id = ? AND revoked_at IS NULL', [now, t.id]],
      ['DELETE FROM pair_codes WHERE participant_id = ?', [t.id]],
      ['DELETE FROM credentials WHERE participant_id = ?', [t.id]], // C-223：密碼一起清掉，用新邀請連結重設
      ['UPDATE invites SET revoked_at = ? WHERE participant_id = ? AND used_at IS NULL AND revoked_at IS NULL', [now, t.id]],
      ['INSERT INTO invites (id, token_hash, name, role, projects, participant_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, await sha256(token), t.name, t.role || '', String(t.projects || ''), t.id, me.id, now, now + ttlMs]],
    ]);
    return inviteOut({}, base, id, token);
  });

  // ---------- 登入碼（長期保留） ----------
  route('GET', '/api/me/login-code', ({ me }) => { requireHuman(me); return { code: me.token }; });
  // 換一組：舊的立刻失效；已登入的裝置不受影響
  route('POST', '/api/me/rotate-code', async ({ me }) => {
    requireHuman(me);
    const code = newToken();
    invalidatePeople();
    await db.run('UPDATE participants SET token = ?, updated_at = ? WHERE id = ?', code, nowIso(), me.id);
    return { code };
  });

  // ---------- 我的裝置與配對碼 ----------
  route('GET', '/api/devices', async ({ me }) => {
    requireHuman(me);
    const rows = await db.all('SELECT * FROM devices WHERE participant_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_used_at DESC', me.id, Date.now());
    return { items: rows.map(r => ({ id: r.id, label: r.label, createdAt: iso(r.created_at), lastUsedAt: iso(r.last_used_at), current: r.id === me.deviceId })) };
  });
  route('POST', '/api/devices/:id/logout', async ({ me, params }) => {
    requireHuman(me);
    const r = await db.run('UPDATE devices SET revoked_at = ? WHERE id = ? AND participant_id = ? AND revoked_at IS NULL', Date.now(), params.id, me.id);
    if (!r.changes) throw new ApiError(404, 'NOT_FOUND', '找不到這台裝置');
    return { ok: true, current: params.id === me.deviceId };
  });
  route('POST', '/api/devices/pair-code', async ({ me }) => {
    requireHuman(me);
    const now = Date.now();
    await db.run('DELETE FROM pair_codes WHERE participant_id = ? OR expires_at < ?', me.id, now - 86_400_000);
    for (;;) {
      const n = new DataView(randomBytes(4).buffer).getUint32(0) % 1_000_000;
      const code = String(n).padStart(6, '0');
      if (await db.get('SELECT 1 AS x FROM pair_codes WHERE code = ? AND used_at IS NULL AND expires_at > ?', code, now)) continue;
      await db.run('INSERT OR REPLACE INTO pair_codes (code, participant_id, created_at, expires_at) VALUES (?,?,?,?)', code, me.id, now, now + PAIR_TTL_MS);
      return { code, expiresAt: iso(now + PAIR_TTL_MS) };
    }
  });
  // 網頁登出：只登出這台
  route('POST', '/api/auth/logout', async ({ me }) => {
    if (me.deviceId) await db.run('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', Date.now(), me.deviceId);
    return { ok: true };
  });

  // ---------- 身分來源（可替換的一層） ----------
  const gone = (msg = '這個邀請連結已失效') => new ApiError(400, 'INVITE_INVALID', msg);
  const PROVIDERS = {
    // 邀請連結：新成員加入，或「重設登入」後回到原本的身分
    invite: {
      label: '邀請連結',
      async verify(body, ctx) {
        const iv = await validInvite(body.token);
        if (!iv) return null;
        const now = Date.now();
        let pid = iv.participant_id, name = iv.name, created = false;
        if (!pid) {
          name = validateName(body.name ?? iv.name);
          await assertNameFree(name);
        } else {
          const t = await db.get("SELECT * FROM participants WHERE id = ? AND status = 'active'", pid);
          if (!t) throw gone();
          name = t.name;
        }
        // C-223：選填帳號密碼；三格都空＝不設，填了就要都對（在佔用邀請前檢查，錯了連結還能用）
        const any = [body.username, body.password, body.passwordAgain].some(x => x !== undefined && x !== null && x !== '');
        let cred = null;
        if (any) {
          cred = { username: readUsername(body.username), password: readPassword(body.password, body.passwordAgain) };
          await assertUsernameFree(cred.username, pid);
        }
        // 先佔用（一次性）：同時按兩次只有一次成功
        const r = await db.run('UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?', now, iv.id, now);
        if (!r.changes) throw gone();
        if (!pid) {
          pid = randId('p');
          const ts = nowIso();
          invalidatePeople();
          const roles = rolesOf(iv.role);
          await db.run(`INSERT INTO participants (id, kind, name, role, code, token, token_expires_at, created_at, updated_at, last_seen_at, projects)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`, pid, 'human', name, roles ? Object.values(roles)[0] || '' : iv.role || '', await newCode(), newToken(), 0, ts, ts, now, listOf(iv.projects).join(','));
          await setInitialRoles(pid, roles || Object.fromEntries(listOf(iv.projects).map(pj => [pj, iv.role || ''])));
          if (roOf(iv.role).length) await setInitialReadOnly(pid, roOf(iv.role)); // C-294
          created = true;
        }
        await db.run('UPDATE invites SET used_by = ? WHERE id = ?', pid, iv.id);
        if (cred) await saveCred(pid, cred.username, cred.password);
        // 通知邀請的管理員「X 已加入」
        invalidatePeople();
        const c2 = {};
        const people = await peopleMap(c2);
        const p = people.get(pid), inviter = people.get(iv.created_by);
        if (inviter && inviter.status === 'active') {
          const proj = listOf(iv.projects);
          const text = created
            ? `[通知] ${name} 已加入（${[roleText(iv.role), proj.length ? '專案：' + proj.map(nameOf).join('、') : '還沒有專案'].filter(Boolean).join('，')}）`
            : `[通知] ${name} 已用新的邀請連結重新登入`;
          await createMessage(c2, p, { text, requestId: `invite_${iv.id}_${now}`, recipientIds: [inviter.id], project: proj.length === 1 ? proj[0] : 'all' }, { systemNotice: true }).catch(e => console.error('join notice failed:', e.message));
        }
        Object.assign(ctx, c2);
        return p;
      },
    },
    // 6 位數配對碼：已登入的裝置產生，5 分鐘、一次性
    pair: {
      label: '裝置配對',
      async verify(body) {
        const code = String(body.code ?? '').replace(/\D/g, '');
        if (code.length !== 6) return null;
        const now = Date.now();
        const row = await db.get('SELECT * FROM pair_codes WHERE code = ? AND used_at IS NULL AND expires_at > ?', code, now);
        if (!row) return null;
        const r = await db.run('UPDATE pair_codes SET used_at = ? WHERE code = ? AND used_at IS NULL', now, code);
        if (!r.changes) return null;
        return db.get("SELECT * FROM participants WHERE id = ? AND kind = 'human' AND status = 'active'", row.participant_id);
      },
    },
    // 登入碼：長期保留、不設期限；換一組或被重設登入後舊的失效
    code: {
      label: '登入碼',
      async verify(body) {
        const code = String(body.code ?? '').trim();
        if (!code || code.startsWith(DEVICE_PREFIX)) return null;
        const p = await db.get("SELECT * FROM participants WHERE token = ? AND status = 'active'", code);
        if (p && p.kind !== 'human') throw new ApiError(400, 'AI_TOKEN', '這是 AI 助手的 Token，只能給 AI 透過 API 使用，不能登入網頁。請貼你本人的登入碼。');
        return p;
      },
    },
    // C-223 帳號密碼：錯誤只說「帳號或密碼不對」；鎖住時密碼對也不放行
    password: {
      label: '帳號密碼',
      device: PWD_DEVICE,
      notice: 'password_login',
      async verify(body) {
        const u = normUsername(body.username);
        const pw = typeof body.password === 'string' ? body.password : '';
        if (!validUsername(u) || !pw || pw.length > PASSWORD_MAX) { await verifyPassword('x', await dummy()); return null; }
        const until = await lockedUntil(u);
        if (until) throw locked(until);
        const c = await db.get('SELECT * FROM credentials WHERE username = ?', u);
        const ok = await verifyPassword(pw, c?.pwd_hash || await dummy());
        const p = ok && c ? await db.get("SELECT * FROM participants WHERE id = ? AND kind = 'human' AND status = 'active'", c.participant_id) : null;
        if (!p) { const u2 = await addFail(u); if (u2) throw locked(u2); return null; }
        await clearFails(u);
        return p;
      },
    },
    // C-223 主機救援連結：一次性、15 分鐘、只給管理員
    rescue: {
      label: '主機救援連結',
      device: RESCUE_DEVICE,
      notice: 'rescue_login',
      async verify(body, ctx, req) {
        if (!body.token || typeof body.token !== 'string') return null;
        const now = Date.now();
        const row = await db.get('SELECT * FROM rescue_links WHERE token_hash = ?', await sha256(body.token));
        if (!row || row.used_at || row.expires_at <= now) return null;
        const admin = adminOf(await peopleMap(ctx));
        if (!admin || admin.id !== row.participant_id) return null;
        const r = await db.run('UPDATE rescue_links SET used_at = ?, used_device = ? WHERE id = ? AND used_at IS NULL', now, deviceLabelAs(RESCUE_DEVICE, req.headers.get('user-agent') || ''), row.id);
        if (!r.changes) return null;
        return db.get("SELECT * FROM participants WHERE id = ? AND kind = 'human' AND status = 'active'", row.participant_id);
      },
    },
  };
  const FAIL_MSG = {
    password: '帳號或密碼不對。',
    rescue: '這個救援連結已失效（15 分鐘、只能用一次）。請聯絡管理員。',
    invite: '這個邀請連結已失效',
    pair: '配對碼不對或已過期，請在已登入的裝置重新產生',
    code: '登入碼無效。請確認是從同一個網站（網址相同）複製的。',
  };
  route('POST', '/api/auth/:method', async ({ req, params, ctx }) => {
    const prov = PROVIDERS[params.method];
    if (!prov) throw new ApiError(404, 'NOT_FOUND', '沒有這種登入方式');
    guard(req);
    const body = await readJson(req);
    const p = await prov.verify(body, ctx, req);
    if (!p) { failed(req); throw new ApiError(400, params.method === 'invite' ? 'INVITE_INVALID' : params.method === 'rescue' ? 'RESCUE_INVALID' : 'LOGIN_FAILED', FAIL_MSG[params.method]); }
    const label = prov.device ? deviceLabelAs(prov.device, req.headers.get('user-agent') || '') : undefined;
    const token = await issueDevice(p.id, req, label);
    if (prov.notice) await notice(p.id, prov.notice, label).catch(e => console.error('notice failed:', e.message));
    return { token, participant: publicParticipant(p, await peopleMap(ctx)) };
  }, { open: true });

  return { resolve, touch, touchStmt, methods: Object.keys(PROVIDERS) };
}
