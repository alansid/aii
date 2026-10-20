// C-346 角色技能庫：專案 leader／管理員上傳技能包（資料夾含 SKILL.md），AI 由主人手動同步、依工具裝到對的資料夾。
// 昱志四項決定：含腳本的包要「上傳者以外」的 leader／管理員看全文與差異後核准；每個 AI 的主人允許才安裝含腳本的包；
// 同步全手動（主人按「同步」或重跑 aigile-setup），AI 不自己查、不加輪詢；執行照工具權限，不另外問。
// 純文字（只有說明文件）直接上架。一個版本一列；新版上架後舊版標 superseded。
export const SKILL_MAX_BYTES = 1024 * 1024;
export const SKILL_MAX_FILES = 100;
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/; // Claude Code、Codex、opencode 共通的技能名稱規則
const SEG_RE = /^[A-Za-z0-9._-]+$/;
// 會被執行的檔：放在 scripts/ 底下，或副檔名是常見腳本
const SCRIPT_EXT = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|lua|go|exe|dll|so)$/i;
// 常見金鑰樣式（平台成員 Token 另由 assertNoSecret 擋）
const KEYISH = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bsk-[A-Za-z0-9_-]{20,}|\bghp_[A-Za-z0-9]{30,}|\bxox[abp]-[A-Za-z0-9-]{10,}/;

// 整包雜湊：依路徑排序後的 [路徑, 內容] 陣列做 SHA-256（aigile-setup.mjs 用同樣算法核對）
export const canonical = files => JSON.stringify(files.map(f => [f.path, f.text]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}
export const isScript = path => path.startsWith('scripts/') || SCRIPT_EXT.test(path);

export function registerSkills({ route, db, ApiError, invalid, readJson, randId, nowIso, sha256, peopleMap, projectsOf, PROJECTS, nameOf,
  loadLeaders, adminOf, assertNoSecret, writeDm, myAi, requireHuman }) {
  const bytes = s => new TextEncoder().encode(s).length;

  async function canManage(ctx, me, pj) {
    if (me.kind !== 'human') return false;
    const people = await peopleMap(ctx);
    if (adminOf(people)?.id === me.id) return true;
    return ((await loadLeaders())[pj] || []).includes(me.id);
  }
  const requireProject = pj => { if (!PROJECTS.includes(pj)) throw new ApiError(404, 'NOT_FOUND', '找不到這個專案'); };
  const inProject = (me, pj) => projectsOf(me).includes(pj);

  // 驗證上傳的檔案：要 SKILL.md（frontmatter 有 name、description）、1 MB 內、100 個檔內、只收文字、擋金鑰
  async function validate(files) {
    if (!Array.isArray(files) || !files.length) throw invalid('files 需為 [{ path, text }]，至少一個檔');
    if (files.length > SKILL_MAX_FILES) throw invalid(`一個技能最多 ${SKILL_MAX_FILES} 個檔`);
    const seen = new Set();
    let total = 0;
    const out = files.map(f => {
      const path = String(f?.path || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
      if (!path || path.length > 200 || path.startsWith('/') || path.split('/').some(s => !SEG_RE.test(s) || s === '.' || s === '..')) throw invalid(`檔名不合法：${path || '（空白）'}（只能用英數、. _ -，不能有 ..）`);
      if (seen.has(path)) throw invalid(`檔名重複：${path}`);
      seen.add(path);
      if (typeof f.text !== 'string') throw invalid(`${path} 不是文字檔（技能只收文字，二進位檔請拿掉）`);
      if (f.text.includes('\u0000') || f.text.includes('�')) throw invalid(`${path} 看起來是二進位檔（技能只收文字）`);
      total += bytes(f.text);
      if (KEYISH.test(f.text)) throw new ApiError(400, 'SECRET_IN_TEXT', `${path} 裡有像金鑰的內容（私鑰、雲端金鑰、Token），請拿掉再上傳`);
      return { path, text: f.text };
    });
    if (total > SKILL_MAX_BYTES) throw invalid(`技能整包要在 1 MB 內（目前 ${(total / 1048576).toFixed(2)} MB）`);
    const skill = out.find(f => f.path === 'SKILL.md');
    if (!skill) throw invalid('最上層要有 SKILL.md');
    const fm = parseFrontmatter(skill.text);
    if (!fm?.name || !fm?.description) throw invalid('SKILL.md 開頭要有 frontmatter，寫 name 與 description');
    if (!NAME_RE.test(fm.name) || fm.name.length > 64) throw invalid(`name「${fm.name}」只能用小寫英數與單一連字號（1～64 字），也是資料夾名`);
    for (const f of out) await assertNoSecret(f.text); // 平台成員的 Token、接入連結
    return { files: out, name: fm.name, description: fm.description.slice(0, 300), size: total, hasScripts: out.some(f => isScript(f.path)) };
  }

  const view = (r, people, { withFiles = false } = {}) => ({
    skillId: r.id, project: r.project, name: r.name, version: r.version, description: r.description, sha256: r.sha256, size: r.size,
    hasScripts: !!r.has_scripts, status: r.status,
    uploadedBy: { participantId: r.uploaded_by, name: people?.get(r.uploaded_by)?.name || '?' }, uploadedAt: r.uploaded_at,
    ...(r.reviewed_by ? { reviewedBy: { participantId: r.reviewed_by, name: people?.get(r.reviewed_by)?.name || '?' }, reviewedAt: r.reviewed_at, reviewNote: r.review_note || '' } : {}),
    ...(withFiles ? { files: JSON.parse(r.files) } : {}),
  });

  // 上架或撤下時私訊專案裡每個 AI 的主人（用該 AI 的身分私訊主人，不叫醒任何 AI；AI 不自己查）
  async function tellOwners(ctx, pj, text, key) {
    const people = await peopleMap(ctx);
    for (const ai of [...people.values()].filter(p => p.kind === 'ai' && p.status === 'active' && projectsOf(p).includes(pj))) {
      const human = people.get(ai.owner_id);
      if (!human || human.status !== 'active') continue;
      await writeDm({ human, ai, from: ai.id, text, project: pj, requestId: `skill_${key}_${ai.id}` }).catch(() => {});
    }
  }
  async function publish(ctx, r, by) {
    const at = nowIso();
    await db.batch([
      ["UPDATE skills SET status = 'superseded' WHERE project = ? AND name = ? AND status = 'published' AND id != ?", [r.project, r.name, r.id]],
      ["UPDATE skills SET status = 'published', reviewed_by = COALESCE(?, reviewed_by), reviewed_at = COALESCE(?, reviewed_at) WHERE id = ?", [by, by ? at : null, r.id]],
    ]);
    await tellOwners(ctx, r.project, `[技能] ${nameOf(r.project)} 的「${r.name}」第 ${r.version} 版上架${r.has_scripts ? '（含腳本：要你在「我的 AI › 技能」允許才會安裝）' : ''}。要裝請在「我的 AI › 技能」按「同步」，或請 AI 重跑 aigile-setup。`, r.id);
  }

  // ---------- 技能庫（專案設定）----------
  route('GET', '/api/projects/:id/skills', async ({ ctx, me, params }) => {
    const pj = params.id; requireProject(pj);
    if (!inProject(me, pj)) throw new ApiError(403, 'FORBIDDEN', '你不屬於這個專案');
    const manage = await canManage(ctx, me, pj);
    const rows = await db.all('SELECT id, project, name, version, description, sha256, size, has_scripts, status, uploaded_by, uploaded_at, reviewed_by, reviewed_at, review_note FROM skills WHERE project = ? ORDER BY name, version DESC', pj);
    const people = await peopleMap(ctx);
    const shown = rows.filter(r => manage ? r.status !== 'superseded' : r.status === 'published');
    const leaders = ((await loadLeaders())[pj] || []).filter(id => people.get(id)?.status === 'active');
    const admin = adminOf(people);
    return { items: shown.map(r => view(r, people)), canManage: manage, reviewers: [...new Set([...leaders, ...(admin ? [admin.id] : [])])].map(id => ({ participantId: id, name: people.get(id)?.name || '?' })) };
  });
  route('POST', '/api/projects/:id/skills', async ({ ctx, me, params, req }) => {
    const pj = params.id; requireProject(pj);
    if (!(await canManage(ctx, me, pj))) throw new ApiError(403, 'NOT_LEADER', '只有這個專案的 leader 或群組管理員能上傳技能');
    const v = await validate((await readJson(req, 2.5 * 1024 * 1024)).files); // 一般 API 上限 256 KB，技能包放寬
    const sha = await sha256(canonical(v.files));
    const last = await db.get('SELECT version, sha256 FROM skills WHERE project = ? AND name = ? ORDER BY version DESC LIMIT 1', pj, v.name);
    if (last?.sha256 === sha) throw new ApiError(409, 'SAME_CONTENT', `「${v.name}」內容跟第 ${last.version} 版一樣，不用重傳`);
    const id = randId('sk'), at = nowIso();
    const r = { id, project: pj, name: v.name, version: (last?.version || 0) + 1, description: v.description, files: JSON.stringify(v.files), sha256: sha, size: v.size, has_scripts: v.hasScripts ? 1 : 0, status: v.hasScripts ? 'pending' : 'published', uploaded_by: me.id, uploaded_at: at };
    await db.run('INSERT INTO skills (id, project, name, version, description, files, sha256, size, has_scripts, status, uploaded_by, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      r.id, r.project, r.name, r.version, r.description, r.files, r.sha256, r.size, r.has_scripts, 'pending', r.uploaded_by, r.uploaded_at);
    if (!v.hasScripts) await publish(ctx, r, null); // 純文字直接上架
    return { __status: 201, ...view({ ...r }, await peopleMap(ctx)) };
  });
  // 單一版本：全文；待核准的附上目前上架版的檔案，網頁算差異
  route('GET', '/api/skills/:id', async ({ ctx, me, params }) => {
    const r = await db.get('SELECT * FROM skills WHERE id = ?', params.id);
    if (!r || !inProject(me, r.project)) throw new ApiError(404, 'NOT_FOUND', '找不到這個技能');
    const manage = await canManage(ctx, me, r.project);
    if (r.status !== 'published' && !manage) throw new ApiError(404, 'NOT_FOUND', '找不到這個技能');
    const prev = await db.get("SELECT * FROM skills WHERE project = ? AND name = ? AND status IN ('published', 'superseded') AND version < ? ORDER BY version DESC LIMIT 1", r.project, r.name, r.version);
    const people = await peopleMap(ctx);
    return { ...view(r, people, { withFiles: true }), previous: prev ? view(prev, people, { withFiles: true }) : null };
  });
  // 核准／退回：上傳者以外的 leader 或管理員，看過全文與差異才按
  route('POST', '/api/skills/:id/review', async ({ ctx, me, params, req }) => {
    const r = await db.get('SELECT * FROM skills WHERE id = ?', params.id);
    if (!r || !inProject(me, r.project)) throw new ApiError(404, 'NOT_FOUND', '找不到這個技能');
    if (!(await canManage(ctx, me, r.project))) throw new ApiError(403, 'NOT_LEADER', '只有這個專案的 leader 或群組管理員能核准');
    if (r.uploaded_by === me.id) throw new ApiError(403, 'SELF_REVIEW', '含腳本的技能要由上傳者以外的 leader 或管理員核准；請先在專案設定多設一位 leader');
    if (r.status !== 'pending') throw new ApiError(409, 'NOT_PENDING', '這個版本已經處理過了');
    const body = await readJson(req);
    if (!['approve', 'reject'].includes(body.action)) throw invalid('action 需為 approve 或 reject');
    const note = String(body.note || '').trim().slice(0, 300);
    if (body.action === 'reject') {
      if (!note) throw invalid('退回要寫原因');
      await db.run("UPDATE skills SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending'", me.id, nowIso(), note, r.id);
    } else {
      await db.run('UPDATE skills SET review_note = ? WHERE id = ?', note, r.id);
      await publish(ctx, r, me.id);
    }
    return view(await db.get('SELECT * FROM skills WHERE id = ?', r.id), await peopleMap(ctx));
  });
  // 下架：目前上架的版本（含待核准的）全部收起，私訊主人
  route('POST', '/api/projects/:id/skills/:name/remove', async ({ ctx, me, params }) => {
    const pj = params.id; requireProject(pj);
    if (!(await canManage(ctx, me, pj))) throw new ApiError(403, 'NOT_LEADER', '只有這個專案的 leader 或群組管理員能下架技能');
    const r = await db.run("UPDATE skills SET status = 'removed' WHERE project = ? AND name = ? AND status IN ('published', 'pending')", pj, params.name);
    if (!r.changes) throw new ApiError(404, 'NOT_FOUND', '沒有上架中的這個技能');
    await tellOwners(ctx, pj, `[技能] ${nameOf(pj)} 的「${params.name}」已下架。請在「我的 AI › 技能」按「同步」，或請 AI 重跑 aigile-setup，會把它從技能資料夾移除。`, 'rm_' + pj + '_' + params.name + '_' + Date.now());
    return { removed: r.changes };
  });

  // ---------- AI 與主人 ----------
  // 某個 AI 可用的技能：它所屬專案已上架的；含腳本的要主人允許「這一版」
  async function skillsFor(ai) {
    const pjs = projectsOf(ai).filter(x => PROJECTS.includes(x));
    if (!pjs.length) return [];
    const rows = await db.all("SELECT id, project, name, version, description, sha256, size, has_scripts FROM skills WHERE status = 'published' AND project IN (SELECT value FROM json_each(?)) ORDER BY name", JSON.stringify(pjs));
    const allowed = new Set((await db.all('SELECT skill_id FROM skill_allows WHERE ai_id = ?', ai.id)).map(x => x.skill_id));
    return rows.map(r => ({ skillId: r.id, project: r.project, name: r.name, version: r.version, description: r.description, sha256: r.sha256, size: r.size,
      hasScripts: !!r.has_scripts, allowed: !r.has_scripts || allowed.has(r.id), install: !r.has_scripts || allowed.has(r.id) }));
  }
  route('GET', '/api/me/skills', async ({ me }) => {
    if (me.kind !== 'ai') throw new ApiError(403, 'FORBIDDEN', '技能是給 AI 的');
    return { items: await skillsFor(me) };
  });
  route('GET', '/api/me/skills/:id/files', async ({ me, params }) => {
    if (me.kind !== 'ai') throw new ApiError(403, 'FORBIDDEN', '技能是給 AI 的');
    const it = (await skillsFor(me)).find(x => x.skillId === params.id);
    if (!it) throw new ApiError(404, 'NOT_FOUND', '找不到這個技能（可能已下架或你不在這個專案）');
    if (!it.install) throw new ApiError(403, 'NOT_ALLOWED', '含腳本的技能要主人在「我的 AI › 技能」允許才能安裝');
    const r = await db.get('SELECT files, sha256, name FROM skills WHERE id = ?', it.skillId);
    return { name: r.name, sha256: r.sha256, files: JSON.parse(r.files) };
  });
  route('GET', '/api/my-ais/:id/skills', async ({ me, params }) => {
    requireHuman(me);
    return { items: await skillsFor(await myAi(me, params.id)) };
  });
  // 主人允許／收回某一版含腳本的技能（新版要重新允許）
  route('PUT', '/api/my-ais/:id/skills/:skillId', async ({ me, params, req }) => {
    requireHuman(me);
    const ai = await myAi(me, params.id);
    const it = (await skillsFor(ai)).find(x => x.skillId === params.skillId);
    if (!it) throw new ApiError(404, 'NOT_FOUND', '找不到這個技能');
    const allow = (await readJson(req)).allow === true;
    if (allow) await db.run('INSERT OR IGNORE INTO skill_allows (ai_id, skill_id, by_id, at) VALUES (?,?,?,?)', ai.id, it.skillId, me.id, nowIso());
    else await db.run('DELETE FROM skill_allows WHERE ai_id = ? AND skill_id = ?', ai.id, it.skillId);
    return (await skillsFor(ai)).find(x => x.skillId === params.skillId);
  });
  // 同步：私訊 AI 請它跑一次 aigile-setup（只有主人按才會叫醒；AI 不自己查）
  route('POST', '/api/my-ais/:id/skills/sync', async ({ ctx, me, params, base }) => {
    requireHuman(me);
    const ai = await myAi(me, params.id);
    const people = await peopleMap(ctx);
    const pj = projectsOf(ai).find(x => PROJECTS.includes(x)) || null;
    const agent = `${ai.role_key && ai.role_key !== 'custom' ? ai.role_key : 'AI'}_${ai.code}`;
    await writeDm({ human: people.get(me.id) || me, ai, from: me.id, project: pj, requestId: 'skillsync_' + ai.id + '_' + Date.now(),
      text: `[技能同步] 請在你的工作資料夾跑一次：node .aigile/watcher/aigile-setup.mjs --agent ${agent} --base ${base} --tool <claude|codex|other> --skills-only，跑完把最後幾行回報給我。` });
    return { ok: true };
  });
}
