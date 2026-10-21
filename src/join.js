// C-369 申請加入專案：leader 打開「開放申請」才看得到；同仁（只有人類）送申請；leader／管理員人工核准或拒絕，不自動加入
// 開放設定存在 app_settings 的 join_settings（{ 專案id: { open, note } }，一列）；申請存在 join_requests（migrations/0027_join_requests.sql）
// 通知用帳號通知（account_notices）：送出→該專案 leader（沒有 leader 就管理員）；結果→申請人
export const JOIN_NOTE_MAX = 200;
export const JOIN_DESC_MAX = 100;

export function registerJoin(d) {
  const { route, db, ApiError, invalid, readJson, randId, nowIso, requireHuman, peopleMap, projectsOf, PROJECTS, nameOf,
    loadProjects, projectRows, loadLeaders, adminOf, applyMembership, loadProjectRoles, saveProjectRoles, projRoles, readRole,
    loadReadOnly, invalidatePeople, projEvent } = d;

  async function joinSettings() {
    const r = await db.get("SELECT value FROM app_settings WHERE key = 'join_settings'").catch(() => null);
    try { return JSON.parse(r?.value || '{}') || {}; } catch { return {}; }
  }
  const notice = (pid, kind, detail) => ['INSERT INTO account_notices (id, participant_id, kind, detail, created_at) VALUES (?,?,?,?,?)', [randId('ntc'), pid, kind, String(detail || '').slice(0, 200), Date.now()]];
  const activeProject = pj => projectRows().find(r => r.id === pj);
  // 誰能審：該專案 leader、群組管理員（只有人類）
  async function reviewer(ctx, me, pj) {
    requireHuman(me);
    const [leaders, admin] = [await loadLeaders(), adminOf(await peopleMap(ctx))];
    if (admin?.id === me.id || (leaders[pj] || []).includes(me.id)) return { admin: admin?.id === me.id };
    throw new ApiError(403, 'NOT_REVIEWER', `只有「${nameOf(pj)}」的 leader 或群組管理員能處理申請。`);
  }
  const reviewersOf = (pj, leaders, admin) => { const l = (leaders[pj] || []).filter(Boolean); return l.length ? l : admin ? [admin.id] : []; };

  // leader／管理員：打開或關閉「開放申請」、寫給申請人看的說明
  route('PUT', '/api/projects/:id/join-settings', async ({ ctx, me, req, params }) => {
    await loadProjects(true);
    const row = activeProject(params.id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', '找不到這個專案');
    await reviewer(ctx, me, row.id);
    const body = await readJson(req);
    const note = String(body.note ?? '').trim();
    if (note.length > JOIN_DESC_MAX || /[\r\n]/.test(note)) throw invalid(`說明最多 ${JOIN_DESC_MAX} 字、不能換行`);
    const v = { open: body.open === true, note };
    const at = nowIso(), all = await joinSettings(), before = all[row.id];
    const stmts = [["INSERT INTO app_settings (key, value) VALUES ('join_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify({ ...all, [row.id]: v })]]];
    if (!!before?.open !== v.open) stmts.push(projEvent(row.id, me.id, `${me.name} ${v.open ? '打開' : '關閉'}「開放申請加入」`, at));
    await db.batch(stmts);
    return { project: row.id, ...v, pending: (await db.get("SELECT COUNT(*) AS n FROM join_requests WHERE project = ? AND status = 'pending'", row.id)).n };
  });

  // 同仁：可以申請的專案（只列開放、沒封存、自己還不在的）；附自己的申請狀態與上次被拒原因
  route('GET', '/api/join/projects', async ({ ctx, me }) => {
    requireHuman(me);
    await loadProjects();
    const [set, leaders, people] = [await joinSettings(), await loadLeaders(), await peopleMap(ctx)];
    const mine = projectsOf(me), admin = adminOf(people);
    const reqs = await db.all('SELECT * FROM join_requests WHERE participant_id = ? ORDER BY created_at DESC LIMIT 200', me.id);
    const last = pj => reqs.find(r => r.project === pj);
    const members = pj => [...people.values()].filter(p => p.status === 'active' && p.kind !== 'system' && projectsOf(p).includes(pj)).length;
    const items = projectRows().filter(r => !r.archived && !mine.includes(r.id) && (set[r.id]?.open || last(r.id)?.status === 'pending')).map(r => {
      const l = last(r.id), ls = (leaders[r.id] || []).map(id => people.get(id)?.name).filter(Boolean);
      return { id: r.id, name: r.name, note: set[r.id]?.note || '', open: !!set[r.id]?.open, leaders: ls, admin: ls.length ? null : admin?.name || null, members: members(r.id),
        status: l?.status === 'pending' ? 'pending' : null, lastRejected: l?.status === 'rejected' ? { reason: l.reason, at: l.decided_at } : null };
    });
    return { items };
  });

  // 同仁送出申請：只建申請，不會加入
  route('POST', '/api/projects/:id/join-requests', async ({ ctx, me, req, params }) => {
    requireHuman(me);
    await loadProjects();
    const row = activeProject(params.id), set = (await joinSettings())[params.id];
    if (!row || (!set?.open && !projectsOf(me).includes(params.id))) throw new ApiError(403, 'JOIN_CLOSED', '這個專案目前不開放申請');
    if (projectsOf(me).includes(row.id)) throw new ApiError(409, 'ALREADY_MEMBER', '你已經在這個專案');
    if (row.archived) throw new ApiError(409, 'PROJECT_ARCHIVED', '這個專案已封存');
    const body = await readJson(req);
    const note = String(body.note ?? '').trim();
    if (note.length > JOIN_NOTE_MAX) throw invalid(`想做什麼最多 ${JOIN_NOTE_MAX} 字`);
    const id = randId('jr'), at = nowIso();
    const [leaders, admin] = [await loadLeaders(), adminOf(await peopleMap(ctx))];
    try {
      await db.batch([['INSERT INTO join_requests (id, project, participant_id, note, status, created_at) VALUES (?,?,?,?,?,?)', [id, row.id, me.id, note, 'pending', at]],
        ...reviewersOf(row.id, leaders, admin).map(pid => notice(pid, 'join_request', `${me.name} 申請加入「${row.name}」`))]);
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) throw new ApiError(409, 'JOIN_PENDING', '審核中，等 leader 處理');
      throw e;
    }
    return { id, project: row.id, status: 'pending' };
  });

  // leader／管理員：待審申請（管理員看全部，leader 看自己帶的專案）；?project= 只看一個
  route('GET', '/api/join-requests', async ({ ctx, me, url }) => {
    requireHuman(me);
    const [leaders, people] = [await loadLeaders(), await peopleMap(ctx)];
    const isAdmin = adminOf(people)?.id === me.id;
    const pjs = isAdmin ? PROJECTS : PROJECTS.filter(pj => (leaders[pj] || []).includes(me.id));
    const only = url.searchParams.get('project');
    const want = only ? pjs.filter(pj => pj === only) : pjs;
    if (!want.length) return { items: [] };
    const rows = await db.all(`SELECT * FROM join_requests WHERE status = 'pending' AND project IN (SELECT value FROM json_each(?)) ORDER BY created_at LIMIT 200`, JSON.stringify(want));
    const rejected = rows.length ? await db.all(`SELECT participant_id, project, reason, decided_at FROM join_requests WHERE status = 'rejected' AND participant_id IN (SELECT value FROM json_each(?)) ORDER BY decided_at DESC`, JSON.stringify([...new Set(rows.map(r => r.participant_id))])) : [];
    return { items: rows.map(r => {
      const p = people.get(r.participant_id), lr = rejected.find(x => x.participant_id === r.participant_id && x.project === r.project);
      return { id: r.id, project: r.project, projectName: nameOf(r.project), participantId: r.participant_id, name: p?.name || '（已離開）', note: r.note, createdAt: r.created_at, lastRejected: lr ? { reason: lr.reason, at: lr.decided_at } : null };
    }) };
  });

  async function pendingReq(ctx, me, id) {
    const r = await db.get('SELECT * FROM join_requests WHERE id = ?', String(id));
    if (!r) throw new ApiError(404, 'NOT_FOUND', '找不到這個申請');
    const who = await reviewer(ctx, me, r.project);
    if (r.status !== 'pending') throw new ApiError(409, 'JOIN_DECIDED', r.status === 'approved' ? '這個申請已經核准了' : '這個申請已經拒絕了');
    return { r, ...who };
  }
  // 核准：選角色＋一般／唯讀；才變成員、寫專案異動、通知申請人
  route('POST', '/api/join-requests/:id/approve', async ({ ctx, me, req, params }) => {
    const { r, admin } = await pendingReq(ctx, me, params.id);
    await loadProjects(true);
    const row = activeProject(r.project);
    if (!row || row.archived) throw new ApiError(409, 'PROJECT_ARCHIVED', '這個專案已封存，不能核准');
    const body = await readJson(req);
    const role = readRole(body.role), ro = body.readOnly === true;
    const p = (await peopleMap(ctx)).get(r.participant_id);
    if (!p || p.status !== 'active' || p.kind !== 'human') throw new ApiError(409, 'APPLICANT_GONE', '申請人已停用或刪除，請拒絕這個申請');
    const at = nowIso();
    // 先改狀態（同一筆只會成功一次），再加入專案
    const upd = await db.run("UPDATE join_requests SET status = 'approved', role = ?, read_only = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", role, ro ? 1 : 0, me.id, at, r.id);
    if (!upd.changes) throw new ApiError(409, 'JOIN_DECIDED', '這個申請已經處理過了');
    if (!projectsOf(p).includes(r.project)) await applyMembership(ctx, me, [{ id: p.id, projects: PROJECTS.filter(x => projectsOf(p).includes(x) || x === r.project) }], { byLeader: !admin });
    if (role) { await loadProjectRoles(true); const cur = projRoles(); await saveProjectRoles({ ...cur, [p.id]: { ...(cur[p.id] || {}), [r.project]: role } }); }
    if (ro) {
      const map = { ...(await loadReadOnly(true)) };
      map[r.project] = [...new Set([...(map[r.project] || []), p.id])];
      await db.run("INSERT INTO app_settings (key, value) VALUES ('read_only', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(map));
      await loadReadOnly(true);
    }
    await db.batch([projEvent(r.project, me.id, `${me.name} 核准 ${p.name} 加入${role ? `（${role}）` : ''}${ro ? '，唯讀' : ''}`, at), notice(p.id, 'join_approved', `「${row.name}」已核准你加入${ro ? '（唯讀）' : ''}`)]);
    invalidatePeople();
    return { id: r.id, status: 'approved', project: r.project, participantId: p.id, role, readOnly: ro };
  });
  // 拒絕：一定要寫原因（給申請人看）；被拒可隨時再申請
  route('POST', '/api/join-requests/:id/reject', async ({ ctx, me, req, params }) => {
    const { r } = await pendingReq(ctx, me, params.id);
    const reason = String((await readJson(req)).reason ?? '').trim();
    if (!reason) throw invalid('拒絕要寫一句原因（申請人會看到）');
    if (reason.length > JOIN_NOTE_MAX) throw invalid(`原因最多 ${JOIN_NOTE_MAX} 字`);
    const at = nowIso();
    const upd = await db.run("UPDATE join_requests SET status = 'rejected', reason = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", reason, me.id, at, r.id);
    if (!upd.changes) throw new ApiError(409, 'JOIN_DECIDED', '這個申請已經處理過了');
    await db.batch([notice(r.participant_id, 'join_rejected', `「${nameOf(r.project)}」沒有核准你的申請：${reason}`)]);
    return { id: r.id, status: 'rejected' };
  });

  return { joinSettings };
}
