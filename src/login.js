// 人類登入（C-202）：邀請連結、裝置、6 位數配對碼、登入碼。
// 「怎麼證明你是誰」是可替換的一層：PROVIDERS 每一種方式只負責把憑證換成「是哪位成員」，
// 成功後一律由 issueDevice 發這台裝置的登入（dv_ 開頭，資料庫只存雜湊）。之後要接公司 SSO（OIDC／SAML），
// 加一個 provider（例如 sso: { verify }）就好，裝置清單、登出、重設登入都不用改。
// AI 的 Token 不經過這裡，維持原樣。

const INVITE_TTL_MS = 15 * 60_000;     // 邀請連結 15 分鐘
const PAIR_TTL_MS = 5 * 60_000;        // 配對碼 5 分鐘
const INVITE_LIST_MS = 7 * 86_400_000; // 邀請清單顯示最近 7 天
const DEVICE_PREFIX = 'dv_';

// 由 User-Agent 推出「瀏覽器 · 系統」，只用來在「我的裝置」辨認
export function deviceLabel(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '其他';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} · ${os}` : b;
}

export function registerLogin(d) {
  const { route, db, ApiError, invalid, readJson, randId, newToken, randomBytes, sha256, nowIso, iso, peopleMap, invalidatePeople,
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
  async function issueDevice(participantId, req) {
    const token = DEVICE_PREFIX + newToken();
    const now = Date.now();
    await db.run('INSERT INTO devices (id, participant_id, token_hash, label, created_at, last_used_at, expires_at) VALUES (?,?,?,?,?,?,?)',
      randId('dev'), participantId, await sha256(token), deviceLabel(req.headers.get('user-agent') || ''), now, now, now + humanTtlMs);
    return token;
  }
  // authenticate 用：把 Bearer 換成成員；回傳 { p, dev }，找不到回 null
  async function resolve(token) {
    if (!token.startsWith(DEVICE_PREFIX)) return { p: await db.get('SELECT * FROM participants WHERE token = ?', token), dev: null };
    const dev = await db.get('SELECT * FROM devices WHERE token_hash = ?', await sha256(token));
    if (!dev || dev.revoked_at) throw new ApiError(401, 'INVALID_TOKEN', '這台裝置已登出，請重新配對或用登入碼登入');
    if (dev.expires_at < Date.now()) throw new ApiError(401, 'TOKEN_EXPIRED', '這台裝置太久沒使用，登入已過期，請重新配對');
    return { p: await db.get('SELECT * FROM participants WHERE id = ?', dev.participant_id), dev };
  }
  // 使用中自動展延；每 20 秒最多寫一次
  async function touch(dev, now = Date.now()) {
    if (now - dev.last_used_at < 20_000) return;
    await db.run('UPDATE devices SET last_used_at = ?, expires_at = ? WHERE id = ?', now, now + humanTtlMs, dev.id);
  }

  // ---------- 邀請 ----------
  const listOf = s => String(s || '').split(',').map(x => x.trim()).filter(x => PROJECTS.includes(x));
  const inviteStatus = (iv, now = Date.now()) => (iv.used_at ? '已使用' : iv.revoked_at ? '已取消' : iv.expires_at <= now ? '已過期' : '有效');
  const inviteView = (iv, people) => ({
    id: iv.id, kind: iv.participant_id ? 'reset' : 'new', name: iv.name, role: iv.role, projects: listOf(iv.projects),
    status: inviteStatus(iv), createdAt: iso(iv.created_at), expiresAt: iso(iv.expires_at), usedAt: iso(iv.used_at),
    usedByName: iv.used_by ? people.get(iv.used_by)?.name ?? null : null, createdByName: people.get(iv.created_by)?.name ?? null,
  });
  const inviteUrl = (base, token) => `${base}/invite/${token}`;
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
  async function newInviteToken(ivId) {
    const token = newToken(), now = Date.now();
    await db.run('UPDATE invites SET token_hash = ?, created_at = ?, expires_at = ?, revoked_at = NULL WHERE id = ?', await sha256(token), now, now + INVITE_TTL_MS, ivId);
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
    const role = String(body.role ?? '').trim();
    if (role.length > 30) throw invalid('角色最多 30 字');
    const projects = readInviteProjects(body.projects);
    const id = randId('inv'), token = newToken();
    await db.run('INSERT INTO invites (id, token_hash, name, role, projects, participant_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, await sha256(token), name, role, projects.join(','), null, me.id, now, now + INVITE_TTL_MS);
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
  // 重新產生／重發：同樣內容換新連結，舊連結立刻失效，重新計時 15 分鐘
  route('POST', '/api/invites/:id/regenerate', async ({ me, ctx, params, base }) => {
    const iv = await myInvite(ctx, me, params.id);
    if (iv.used_at) throw new ApiError(400, 'INVITE_USED', `${iv.name} 已經用這個邀請加入，不需要重發`);
    if (!iv.participant_id) {
      const taken = await db.get('SELECT id FROM participants WHERE name = ?', iv.name);
      if (taken) throw new ApiError(409, 'NAME_TAKEN', `「${iv.name}」已經是成員了，不需要邀請`);
    }
    return inviteOut(ctx, base, iv.id, await newInviteToken(iv.id));
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
      role: iv.role, projects: listOf(iv.projects).map(id => ({ id, name: nameOf(id) })), expiresAt: iso(iv.expires_at) };
  }, { open: true });

  // 管理員「重設登入」：作廢舊登入碼、登出該人所有裝置，產生給他的新邀請連結
  route('POST', '/api/participants/:id/reset-login', async ({ me, ctx, params, base }) => {
    requireHuman(me);
    await requireAdmin(ctx, me, '重設成員登入');
    const t = (await peopleMap(ctx)).get(params.id);
    if (!t || t.kind !== 'human' || t.status !== 'active') throw new ApiError(404, 'NOT_FOUND', '找不到這位人類成員');
    if (t.id === me.id) throw new ApiError(400, 'RESET_SELF', '要換自己的登入碼，請到「API 資訊與登入碼」按「換一組登入碼」');
    const now = Date.now(), id = randId('inv'), token = newToken();
    invalidatePeople();
    await db.batch([
      ['UPDATE participants SET token = ?, updated_at = ? WHERE id = ?', [newToken(), nowIso(), t.id]],
      ['UPDATE devices SET revoked_at = ? WHERE participant_id = ? AND revoked_at IS NULL', [now, t.id]],
      ['DELETE FROM pair_codes WHERE participant_id = ?', [t.id]],
      ['UPDATE invites SET revoked_at = ? WHERE participant_id = ? AND used_at IS NULL AND revoked_at IS NULL', [now, t.id]],
      ['INSERT INTO invites (id, token_hash, name, role, projects, participant_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, await sha256(token), t.name, t.role || '', String(t.projects || ''), t.id, me.id, now, now + INVITE_TTL_MS]],
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
        // 先佔用（一次性）：同時按兩次只有一次成功
        const r = await db.run('UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?', now, iv.id, now);
        if (!r.changes) throw gone();
        if (!pid) {
          pid = randId('p');
          const ts = nowIso();
          invalidatePeople();
          await db.run(`INSERT INTO participants (id, kind, name, role, code, token, token_expires_at, created_at, updated_at, last_seen_at, projects)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`, pid, 'human', name, iv.role || '', await newCode(), newToken(), 0, ts, ts, now, listOf(iv.projects).join(','));
          created = true;
        }
        await db.run('UPDATE invites SET used_by = ? WHERE id = ?', pid, iv.id);
        // 通知邀請的管理員「X 已加入」
        invalidatePeople();
        const c2 = {};
        const people = await peopleMap(c2);
        const p = people.get(pid), inviter = people.get(iv.created_by);
        if (inviter && inviter.status === 'active') {
          const proj = listOf(iv.projects);
          const text = created
            ? `[通知] ${name} 已加入（${[iv.role, proj.length ? '專案：' + proj.map(nameOf).join('、') : '還沒有專案'].filter(Boolean).join('，')}）`
            : `[通知] ${name} 已用新的邀請連結重新登入`;
          await createMessage(c2, p, { text, requestId: `invite_${iv.id}_${now}`, recipientIds: [inviter.id], project: proj.length === 1 ? proj[0] : 'all' }).catch(e => console.error('join notice failed:', e.message));
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
  };
  const FAIL_MSG = {
    invite: '這個邀請連結已失效',
    pair: '配對碼不對或已過期，請在已登入的裝置重新產生',
    code: '登入碼無效。請確認是從同一個網站（網址相同）複製的。',
  };
  route('POST', '/api/auth/:method', async ({ req, params, ctx }) => {
    const prov = PROVIDERS[params.method];
    if (!prov) throw new ApiError(404, 'NOT_FOUND', '沒有這種登入方式');
    guard(req);
    const body = await readJson(req);
    const p = await prov.verify(body, ctx);
    if (!p) { failed(req); throw new ApiError(400, params.method === 'invite' ? 'INVITE_INVALID' : 'LOGIN_FAILED', FAIL_MSG[params.method]); }
    const token = await issueDevice(p.id, req);
    return { token, participant: publicParticipant(p, await peopleMap(ctx)) };
  }, { open: true });

  return { resolve, touch, methods: Object.keys(PROVIDERS) };
}
