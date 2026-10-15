// 工作卡片 API（第一階段）：卡片、狀態、完成／驗證、紀錄、關聯訊息。
// 權限：人類可改所有卡片；AI 只能建立卡片（負責人限自己或不指派）、修改自己負責的卡片。
// 「已驗證」必須由完成者以外的人或 AI 標記。
// AI 建議（第三階段）：AI 只能建議改別人的卡片／替別人建卡，由人類採用或略過。
// 決策卡片（第二階段）：只有指定決策者（人類）能決定；要求補充會把球丟回提案人，補充後自動回到決策者。AI 建議在後續階段。
export const CARD_STATUSES = ['待整理', '待處理', '進行中', '待確認', '受阻', '已完成', '已封存'];
export const CARD_TYPES = ['工作', '阻塞', '決策'];
const BUILTIN_RESULTS = ['不同意', '要求補充']; // 決定時固定可用，不可當選項名稱
const OPEN_STATUSES_SQL = "('已完成','已封存')";
export const CARD_LIMITS = { title: 100, reason: 500, next: 300, blocker: 300, criteria: 500, question: 200, recommendation: 500, impact: 200, afterNext: 300, note: 500, option: 40, handover: 300 };
const CARD_NO_BASE = 100; // 顯示編號 = C-(seq + 100)

const FIELD_LABEL = { title: '標題', reason: '原因', next: '下一步', blocker: '阻塞', criteria: '完成條件', question: '決策問題', recommendation: '建議方案', impact: '影響', afterNext: '決定後', handover: '交接說明' };
const DECISION_COL = { question: 'question', recommendation: 'recommendation', impact: 'impact', afterNext: 'after_next' };
const cardNo = seq => `C-${seq + CARD_NO_BASE}`;


// 團隊狀態用：每位負責人手上最急的未完成卡片、以及等決策者的決策卡（只讀未完成的卡片，量很小）
const WORK_RANK = { 受阻: 0, 待確認: 1, 進行中: 2, 待處理: 3 };
const WORK_STATE = { 受阻: 'blocked', 待確認: 'waiting', 進行中: 'working', 待處理: 'todo' };
export async function teamCards(db) {
  const open = await db.all("SELECT seq, owner_id, status, title, updated_at FROM cards WHERE owner_id IS NOT NULL AND status IN ('待處理','進行中','待確認','受阻') ORDER BY updated_at DESC");
  const byOwner = new Map();
  for (const c of open) {
    const cur = byOwner.get(c.owner_id) || { best: null, count: 0 };
    cur.count++;
    if (!cur.best || WORK_RANK[c.status] < WORK_RANK[cur.best.status]) cur.best = c;
    byOwner.set(c.owner_id, cur);
  }
  const work = new Map([...byOwner].map(([id, { best, count }]) => [id,
    { state: WORK_STATE[best.status], title: best.title, cardId: cardNo(best.seq), at: best.updated_at, cardCount: count, source: 'card' }]));
  const decisions = await db.all("SELECT seq, title, question, proposer_id, decider_id, created_at FROM cards WHERE type = '決策' AND status = '待確認' AND decision_result IS NULL ORDER BY created_at DESC LIMIT 30");
  return { work, decisions: decisions.map(d => ({ cardId: cardNo(d.seq), title: d.question || d.title, createdAt: d.created_at, proposerId: d.proposer_id, deciderId: d.decider_id })) };
}

export function registerCards({ route, createMessage, PROJECTS, projectsOf, projectFilter, db, ApiError, invalid, readJson, peopleMap, randId, nowIso, parseLimit, invalidatePeople }) {
  const notFound = () => new ApiError(404, 'NOT_FOUND', '找不到這張卡片');
  const parseNo = id => {
    const m = /^C-(\d+)$/.exec(id);
    const seq = m ? Number(m[1]) - CARD_NO_BASE : NaN;
    if (!Number.isInteger(seq) || seq < 1) throw notFound();
    return seq;
  };
  const ref = (people, id) => {
    const p = id && people.get(id);
    return p ? { participantId: p.id, name: p.name, memberType: p.kind } : null;
  };
  const mark = (people, by, at) => (by ? { by: ref(people, by), at } : null);

  const view = (c, people) => ({
    cardId: cardNo(c.seq), type: c.type, project: c.project, title: c.title, reason: c.reason, status: c.status,
    owner: ref(people, c.owner_id), next: c.next, blocker: c.blocker, waitFor: ref(people, c.wait_for_id), criteria: c.criteria,
    createdBy: ref(people, c.created_by), createdAt: c.created_at, updatedAt: c.updated_at, version: c.version,
    done: mark(people, c.done_by, c.done_at), verified: mark(people, c.verified_by, c.verified_at),
    ...(c.type === '決策' ? { decision: decisionView(c, people) } : {}),
  });
  const parseOptions = c => { try { return JSON.parse(c.options || '[]'); } catch { return []; } };
  const decisionView = (c, people) => ({
    question: c.question || c.title, proposer: ref(people, c.proposer_id), decider: ref(people, c.decider_id),
    recommendation: c.recommendation, options: parseOptions(c), impact: c.impact, afterNext: c.after_next,
    result: c.decision_result, by: ref(people, c.decision_by), at: c.decision_at, note: c.decision_note,
  });

  const canEdit = (me, c) => me.kind === 'human' || c.owner_id === me.id || (!c.owner_id && c.created_by === me.id);
  const requireEdit = (me, c) => {
    if (!canEdit(me, c)) {
      throw new ApiError(403, 'NOT_CARD_OWNER', '這張卡片不是你負責的。AI 只能修改自己負責的卡片（未指派、待整理或待處理的非決策卡可用 PATCH ownerId=自己 認領）；要改別人的卡片，請提建議或在群組留言。');
    }
  };

  async function validPerson(people, id, label) {
    if (id === null || id === '' || id === undefined) return null;
    const p = people.get(String(id));
    if (!p || p.kind === 'system' || p.status !== 'active') throw invalid(`${label}不是有效的成員`);
    return p.id;
  }
  function text(body, key, { required = false } = {}) {
    if (body[key] === undefined) return undefined;
    const v = String(body[key] ?? '').trim();
    if (required && !v) throw invalid(`${FIELD_LABEL[key]}不可空白`);
    if (v.length > CARD_LIMITS[key]) throw invalid(`${FIELD_LABEL[key]}上限 ${CARD_LIMITS[key]} 字`);
    return v;
  }
  const checkStatus = s => { if (!CARD_STATUSES.includes(s)) throw invalid(`status 需為：${CARD_STATUSES.join('、')}`); return s; };
  const checkType = t => { if (!CARD_TYPES.includes(t)) throw invalid(`type 需為：${CARD_TYPES.join('、')}`); return t; };

  function readOptions(raw) {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split('\n');
    const out = [...new Set(list.map(x => String(x ?? '').trim()).filter(Boolean))];
    if (out.length > 4) throw invalid('選項最多 4 個');
    for (const o of out) {
      if (o.length > CARD_LIMITS.option) throw invalid(`每個選項上限 ${CARD_LIMITS.option} 字`);
      if (BUILTIN_RESULTS.includes(o)) throw invalid(`選項不能叫「${o}」，這兩個決定方式本來就有`);
    }
    return out;
  }
  async function validDecider(people, id) {
    const p = people.get(String(id || ''));
    if (!p || p.kind !== 'human' || p.status !== 'active') throw invalid('決策者必須是人類成員');
    return p.id;
  }
  const decisionFields = c => (c.type === '決策' ? c : null);

  async function load(no) {
    const c = await db.get('SELECT * FROM cards WHERE seq = ?', parseNo(no));
    if (!c) throw notFound();
    return c;
  }
  const logStmt = (seq, me, texts, at) => texts.map(t =>
    ['INSERT INTO card_log (card_seq, at, by_id, via, text) VALUES (?,?,?,?,?)', [seq, at, me.id, me.kind === 'human' ? '網頁' : 'API', t]]);

  // 換狀態的連動：完成者記錄；離開「已完成」時清掉完成與驗證
  function statusChange(c, to, me, at) {
    if (c.type === '決策' && to === '已完成') throw new ApiError(400, 'USE_DECIDE', '決策卡片要由指定決策者用 POST /api/cards/:id/decide 決定，不能直接標為已完成。');
    const sets = { status: to }, logs = [`狀態 ${c.status} → ${to}`];
    if (to === '已完成' && !c.done_by) { Object.assign(sets, { done_by: me.id, done_at: at }); logs.push('標為已完成'); }
    if (to !== '已完成' && c.status === '已完成') {
      Object.assign(sets, { done_by: null, done_at: null, verified_by: null, verified_at: null });
      if (c.verified_by) logs.push('移除已驗證標記');
      if (c.decision_result) { // 重開決策卡：決定作廢
        Object.assign(sets, { decision_result: null, decision_by: null, decision_at: null, decision_note: '' });
        logs.push('決定已撤回');
        if (to === '待確認') Object.assign(sets, { wait_for_id: c.decider_id });
      }
    }
    return { sets, logs };
  }
  async function save(c, sets, logs, me, at) {
    const keys = Object.keys(sets);
    const sql = `UPDATE cards SET ${keys.map(k => `${k} = ?`).join(', ')}${keys.length ? ', ' : ''}updated_at = ?, version = version + 1 WHERE seq = ? AND version = ?`;
    // 版本相符才更新；D1／SQLite 都用同一條語句，失敗（0 筆）代表同時有人改過
    const r = await db.run(sql, ...keys.map(k => sets[k]), at, c.seq, c.version);
    if (!r.changes) throw new ApiError(409, 'CONFLICT', '這張卡片剛被別人修改過，請重新讀取後再試。');
    if (logs.length) await db.batch(logStmt(c.seq, me, logs, at));
  }

  route('GET', '/api/cards', async ({ ctx, me, url }) => {
    const q = url.searchParams, limit = parseLimit(url, 100, 200);
    const where = [], args = [];
    const status = q.get('status');
    if (status === 'open') where.push(`status NOT IN ${OPEN_STATUSES_SQL}`);
    else if (status) { where.push('status = ?'); args.push(checkStatus(status)); }
    else if (!q.get('since') && q.get('include') !== 'archived') where.push("status != '已封存'");
    if (q.get('owner')) { where.push('owner_id = ?'); args.push(q.get('owner')); }
    if (q.get('type')) { where.push('type = ?'); args.push(checkType(q.get('type'))); }
    if (q.get('since')) { where.push('updated_at > ?'); args.push(String(q.get('since'))); }
    const pf = projectFilter(q.get('project'), me, 'project', false);
    if (pf) { where.push(pf.sql); args.push(...pf.args); }
    const kw = (q.get('q') || '').trim();
    if (kw) { where.push("(title LIKE ? ESCAPE '\\' OR next LIKE ? ESCAPE '\\')"); const like = `%${kw.replace(/[%_\\]/g, m => '\\' + m)}%`; args.push(like, like); }
    const rows = await db.all(`SELECT * FROM cards ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC, seq DESC LIMIT ?`, ...args, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const people = await peopleMap(ctx);
    return { items: items.map(c => view(c, people)), hasMore, nextSince: items.reduce((m, c) => (c.updated_at > m ? c.updated_at : m), q.get('since') || '') || null };
  });

  route('GET', '/api/cards/:id', async ({ ctx, params }) => {
    const c = await load(params.id);
    const people = await peopleMap(ctx);
    const [log, msgs] = await Promise.all([
      db.all('SELECT at, by_id, via, text FROM card_log WHERE card_seq = ? ORDER BY id DESC LIMIT 200', c.seq),
      db.all('SELECT message_id FROM card_msgs WHERE card_seq = ? ORDER BY rowid', c.seq),
    ]);
    return {
      ...view(c, people), messageIds: msgs.map(m => m.message_id),
      log: log.map(l => ({ at: l.at, by: ref(people, l.by_id), via: l.via, text: l.text })),
    };
  });

  route('POST', '/api/cards', async ({ ctx, me, req }) => {
    const body = await readJson(req);
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
    if (!requestId || requestId.length > 128) throw invalid('requestId 為必填，長度 1～128');
    const people = await peopleMap(ctx);
    const dup = await db.get('SELECT * FROM cards WHERE created_by = ? AND request_id = ?', me.id, requestId);
    if (dup) return { __status: 200, ...view(dup, people), duplicate: true };

    const type = checkType(body.type ?? '工作');
    const title = text(body, 'title', { required: true });
    if (title === undefined) throw invalid('title 為必填');
    const owner = await validPerson(people, body.ownerId, '負責人');
    if (me.kind === 'ai' && owner && owner !== me.id) {
      throw new ApiError(403, 'ASSIGN_OTHERS', 'AI 不能直接把卡片指派給別人；負責人請留空或填自己，並在 next 寫清楚要誰接手。');
    }
    const defaultStatus = type === '阻塞' ? '受阻' : type === '決策' ? '待確認' : '待整理';
    const status = checkStatus(body.status ?? defaultStatus);
    if (status === '已完成' || status === '已封存') throw invalid('新卡片不能直接是已完成或已封存');
    let waitFor = await validPerson(people, body.waitForId, '等誰');
    // 決策卡片：指定決策者（人類）；預設是自己，AI 預設是所屬人類。建立後一定在等決策者
    let dec = { decider_id: null, proposer_id: null, question: '', recommendation: '', options: '', impact: '', after_next: '' };
    if (type === '決策') {
      if (status !== '待確認') throw invalid('決策卡片建立時狀態固定為「待確認」');
      const deciderId = body.deciderId ?? (me.kind === 'human' ? me.id : people.get(me.id)?.owner_id);
      const decider = await validDecider(people, deciderId);
      const options = readOptions(body.options);
      dec = {
        decider_id: decider, proposer_id: me.id, question: text(body, 'question') || title, recommendation: text(body, 'recommendation') ?? '',
        options: JSON.stringify(options), impact: text(body, 'impact') ?? '', after_next: text(body, 'afterNext') ?? '',
      };
      waitFor = decider;
    } else if (body.deciderId !== undefined || body.question !== undefined || body.options !== undefined) {
      throw invalid('只有決策卡片可以填決策者、問題或選項');
    }
    const mine = projectsOf(me);
    let project = body.project;
    if (project === undefined || project === null || project === '') {
      if (mine.length !== 1) throw invalid(`project 為必填：${PROJECTS.join('、')}`);
      project = mine[0];
    }
    if (!PROJECTS.includes(project)) throw invalid(`project 需為：${PROJECTS.join('、')}`);
    if (!mine.includes(project)) throw new ApiError(403, 'PROJECT_FORBIDDEN', '你不屬於這個專案，不能在這個專案建卡。');
    const messageIds = Array.isArray(body.messageIds) ? [...new Set(body.messageIds.map(String))].slice(0, 10) : [];
    if (messageIds.length) {
      const found = await db.all('SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(messageIds));
      if (found.length !== messageIds.length) throw invalid('messageIds 有不存在的訊息');
    }
    const at = nowIso(), uid = randId('card');
    await db.run(`INSERT INTO cards (uid, type, title, reason, owner_id, status, next, blocker, wait_for_id, criteria, created_by, request_id, created_at, updated_at,
      decider_id, proposer_id, question, recommendation, options, impact, after_next, project)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, uid, type, title, text(body, 'reason') ?? '', owner, status, text(body, 'next') ?? '', text(body, 'blocker') ?? '',
      waitFor, text(body, 'criteria') ?? '', me.id, requestId, at, at,
      dec.decider_id, dec.proposer_id, dec.question, dec.recommendation, dec.options, dec.impact, dec.after_next, project);
    const c = await db.get('SELECT * FROM cards WHERE uid = ?', uid);
    await db.batch([
      ...logStmt(c.seq, me, [`建立卡片（類型：${type}）`, ...(type === '決策' ? [`等 ${people.get(dec.decider_id)?.name} 決定`] : [])], at),
      ...messageIds.map(m => ['INSERT OR IGNORE INTO card_msgs (card_seq, message_id) VALUES (?,?)', [c.seq, m]]),
    ]);
    return { __status: 201, ...view(c, people) };
  });

  route('PATCH', '/api/cards/:id', async ({ ctx, me, req, params }) => {
    const body = await readJson(req);
    const c = await load(params.id);
    // 認領：AI 可把「未指派、待整理或待處理、非決策」的卡片的負責人設為自己
    const claiming = me.kind === 'ai' && !c.owner_id && body.ownerId === me.id && c.type !== '決策' && ['待整理', '待處理'].includes(c.status);
    if (!claiming) requireEdit(me, c);
    if (body.version !== undefined && Number(body.version) !== c.version) {
      throw new ApiError(409, 'CONFLICT', '這張卡片剛被別人修改過，請重新讀取後再試。');
    }
    const people = await peopleMap(ctx), sets = {}, logs = [];
    for (const key of ['title', 'reason', 'next', 'blocker', 'criteria']) {
      const v = text(body, key, { required: key === 'title' });
      if (v !== undefined && v !== c[key]) { sets[key] = v; logs.push(`${FIELD_LABEL[key]}已修改`); }
    }
    if (body.project !== undefined && body.project !== c.project) {
      if (!PROJECTS.includes(body.project)) throw invalid(`project 需為：${PROJECTS.join('、')}`);
      if (me.kind === 'ai' && !projectsOf(me).includes(body.project)) throw new ApiError(403, 'PROJECT_FORBIDDEN', '你不屬於這個專案，不能把卡片改到那個專案。');
      sets.project = body.project; logs.push(`專案改為 ${body.project}`);
    }
    if (body.type !== undefined && checkType(body.type) !== c.type) {
      if (body.type === '決策' || c.type === '決策') throw new ApiError(400, 'TYPE_LOCKED', '決策卡片的類型不能改，工作或阻塞卡片也不能改成決策。請另外建立一張。');
      sets.type = body.type; logs.push(`類型改為 ${body.type}`);
    }
    // 決策欄位：只有決策卡片、且尚未決定時可改；補充後自動回到決策者
    const touchesDecision = ['question', 'recommendation', 'impact', 'afterNext', 'options', 'deciderId'].some(k => body[k] !== undefined);
    if (touchesDecision) {
      if (c.type !== '決策') throw invalid('只有決策卡片可以填決策者、問題或選項');
      if (c.decision_result) throw new ApiError(409, 'DECIDED', '這張決策卡片已經決定了，不能再改決策內容；要重新討論請先把狀態改回「待確認」。');
      let edited = false;
      for (const key of ['question', 'recommendation', 'impact', 'afterNext']) {
        const v = text(body, key, { required: key === 'question' });
        if (v !== undefined && v !== c[DECISION_COL[key]]) { sets[DECISION_COL[key]] = v; logs.push(`${FIELD_LABEL[key]}已修改`); edited = true; }
      }
      if (body.options !== undefined) {
        const o = JSON.stringify(readOptions(body.options));
        if (o !== (c.options || '[]')) { sets.options = o; logs.push('選項已修改'); edited = true; }
      }
      if (body.deciderId !== undefined && body.deciderId !== c.decider_id) {
        if (me.kind !== 'human') throw new ApiError(403, 'FORBIDDEN', '只有人類成員能更換決策者。');
        const d = await validDecider(people, body.deciderId);
        sets.decider_id = d; logs.push(`決策者改為 ${people.get(d).name}`);
        if (c.status === '待確認' && c.wait_for_id === c.decider_id) sets.wait_for_id = d;
      }
      if (edited && c.status === '待確認' && c.wait_for_id && c.wait_for_id === c.proposer_id && c.proposer_id !== (sets.decider_id || c.decider_id)) {
        sets.wait_for_id = sets.decider_id || c.decider_id;
        logs.push(`已補充，改為等 ${people.get(sets.wait_for_id)?.name} 決定`);
      }
    }
    if (body.ownerId !== undefined) {
      const owner = await validPerson(people, body.ownerId, '負責人');
      if (me.kind === 'ai' && owner !== c.owner_id && owner !== me.id) {
        throw new ApiError(403, 'ASSIGN_OTHERS', 'AI 不能直接把卡片轉給別人；請在 next 寫清楚要誰接手。');
      }
      if (owner !== c.owner_id) { sets.owner_id = owner; logs.push(claiming ? `${people.get(owner)?.name} 認領了這張卡片` : `負責人改為 ${people.get(owner)?.name || '未指派'}`); }
    }
    if (body.waitForId !== undefined) {
      const w = await validPerson(people, body.waitForId, '等誰');
      if (w !== c.wait_for_id) { sets.wait_for_id = w; logs.push(`等誰改為 ${people.get(w)?.name || '不用等人'}`); }
    }
    if (body.status !== undefined && checkStatus(body.status) !== c.status) {
      const ch = statusChange(c, body.status, me, nowIso());
      Object.assign(sets, ch.sets); logs.push(...ch.logs);
    }
    if (Object.keys(sets).length) {
      invalidatePeople(); // 團隊狀態快取一起失效
      await save(c, sets, logs, me, nowIso());
      const parts = [], to = [];
      if (sets.owner_id) { parts.push(claiming ? `${people.get(sets.owner_id)?.name} 認領` : `負責人改為 ${people.get(sets.owner_id)?.name}`); to.push(sets.owner_id); }
      if (sets.wait_for_id) {
        const after = await load(params.id);
        parts.push(c.type === '決策' ? `請 ${people.get(sets.wait_for_id)?.name} 決定` : `等 ${people.get(sets.wait_for_id)?.name}${after.blocker ? '：' + after.blocker : ''}`);
        to.push(sets.wait_for_id);
      }
      if (parts.length && !claiming) await notifyCard(ctx, me, c, to, parts.join('；'), 'edit');
    }
    return view(await load(params.id), people);
  });

  // 決定：只有指定決策者（人類）能做。result 可以是某個選項、「不同意」（需寫原因）或「要求補充」（需寫要補什麼）
  route('POST', '/api/cards/:id/decide', async ({ ctx, me, req, params }) => {
    const body = await readJson(req);
    const c = await load(params.id);
    if (c.type !== '決策') throw invalid('這不是決策卡片');
    if (c.decision_result) throw new ApiError(409, 'DECIDED', '這張決策卡片已經決定了。');
    if (c.status !== '待確認') throw new ApiError(409, 'NOT_PENDING', '決策卡片要在「待確認」才能決定。');
    if (me.kind !== 'human' || me.id !== c.decider_id) {
      throw new ApiError(403, 'NOT_DECIDER', '只有這張卡片指定的決策者能做決定。');
    }
    if (body.version !== undefined && Number(body.version) !== c.version) throw new ApiError(409, 'CONFLICT', '這張卡片剛被別人修改過，請重新讀取後再試。');
    const result = String(body.result ?? '').trim();
    const options = parseOptions(c);
    const allowed = [...(options.length ? options : ['同意']), ...BUILTIN_RESULTS];
    if (!allowed.includes(result)) throw invalid(`result 需為：${allowed.join('、')}`);
    const note = String(body.note ?? '').trim();
    if (note.length > CARD_LIMITS.note) throw invalid(`說明上限 ${CARD_LIMITS.note} 字`);
    if (BUILTIN_RESULTS.includes(result) && !note) throw invalid(result === '不同意' ? '不同意請寫原因' : '要求補充請寫要補什麼');
    const people = await peopleMap(ctx), at = nowIso();
    if (result === '要求補充') {
      const back = c.proposer_id && people.get(c.proposer_id)?.status === 'active' ? c.proposer_id : c.created_by;
      await save(c, { wait_for_id: back }, [`要求補充：${note}`, `等誰改為 ${people.get(back)?.name}`], me, at);
    } else {
      await save(c, { status: '已完成', wait_for_id: null, decision_result: result, decision_by: me.id, decision_at: at, decision_note: note, done_by: me.id, done_at: at },
        [`決定：${result}${note ? `（${note}）` : ''}`, `狀態 待確認 → 已完成`], me, at);
    }
    invalidatePeople();
    const back2 = result === '要求補充'
      ? (c.proposer_id && people.get(c.proposer_id)?.status === 'active' ? c.proposer_id : c.created_by)
      : (c.proposer_id || c.created_by);
    await notifyCard(ctx, me, c, [back2], result === '要求補充' ? `要求補充：${note}` : `決定「${result}」${note ? '：' + note : ''}`, 'decide');
    return view(await load(params.id), people);
  });

  route('POST', '/api/cards/:id/verify', async ({ ctx, me, params }) => {
    const c = await load(params.id);
    if (c.status !== '已完成') throw new ApiError(409, 'NOT_DONE', '卡片要先是「已完成」才能標為已驗證。');
    if (c.verified_by) throw new ApiError(409, 'ALREADY_VERIFIED', '這張卡片已經驗證過了。');
    if (c.done_by === me.id) throw new ApiError(403, 'SELF_VERIFY', '完成者不能自己標為已驗證，請由其他人或其他 AI 驗證。');
    const at = nowIso();
    await save(c, { verified_by: me.id, verified_at: at }, ['標為已驗證'], me, at);
    return view(await load(params.id), await peopleMap(ctx));
  });

  // 卡片動作通知（C-115）：以動作者身分在群組發一則 [通知] 並 @ 相關成員（走既有 @ 通知與門鈴）。
  // requestId 帶卡號＋事件＋卡片版本，同一動作不會重複發；動作者自己不通知；失敗不影響動作本身。
  async function notifyCard(ctx, me, c, toIds, summary, key) {
    const ids = [...new Set(toIds.filter(id => id && id !== me.id))];
    if (!ids.length) return;
    const cur = await load(cardNo(c.seq));
    const tag = cur.title.startsWith('[平台]') ? '【平台】' : cur.title.startsWith('[銀行系統]') ? '【銀行系統】' : '';
    const plain = cur.title.replace('[平台]', '').replace('[銀行系統]', '').trim();
    const msg = `[通知] ${tag}${cardNo(c.seq)} ${plain}：${summary}`.slice(0, 1900);
    try {
      const r = await createMessage(ctx, me, { text: msg, requestId: `cardev_${c.uid}_${key}_${cur.version}`.slice(0, 128), recipientIds: ids, project: cur.project });
      await db.run('INSERT OR IGNORE INTO card_msgs (card_seq, message_id) VALUES (?,?)', c.seq, r.message.messageId);
    } catch (err) { console.error('card notify failed:', err.message); }
  }

  // 交接：負責人把自己的卡交給指定成員。接手者回到「待處理」；伺服器代交接者在群組發一則 [交接] 並 @ 對方（既有 @ 通知）
  route('POST', '/api/cards/:id/handover', async ({ ctx, me, req, params }) => {
    const body = await readJson(req);
    const c = await load(params.id);
    if (me.kind === 'ai' && c.owner_id !== me.id) throw new ApiError(403, 'NOT_CARD_OWNER', 'AI 只能交接自己負責的卡片。');
    if (c.type === '決策') throw new ApiError(400, 'NO_HANDOVER_DECISION', '決策卡片不能交接，它本來就在等決策者決定。');
    if (c.status === '已完成' || c.status === '已封存') throw new ApiError(400, 'CARD_CLOSED', '已完成或已封存的卡片不能交接。');
    if (body.version !== undefined && Number(body.version) !== c.version) throw new ApiError(409, 'CONFLICT', '這張卡片剛被別人修改過，請重新讀取後再試。');
    const people = await peopleMap(ctx);
    const to = await validPerson(people, body.toId, '接手者');
    if (!to) throw invalid('toId 為必填：要交給誰');
    if (to === c.owner_id || to === me.id) throw new ApiError(400, 'SAME_OWNER', '不能交給目前的負責人或自己。');
    if (!projectsOf(people.get(to)).includes(c.project)) throw new ApiError(400, 'PROJECT_MISMATCH', `接手者不屬於這張卡的專案（${c.project}）；只能交給同專案成員，或兩邊都屬於的成員。`);
    const note = text({ handover: body.note }, 'handover', { required: true });
    if (note === undefined) throw invalid('交接說明（note）為必填');
    const at = nowIso(), fromName = people.get(c.owner_id || me.id)?.name || me.name, toName = people.get(to).name;
    const sets = { owner_id: to, status: '待處理' };
    if (c.wait_for_id === to) sets.wait_for_id = null;
    const logs = [`交接 ${fromName} → ${toName}：${note}`];
    if (c.status !== '待處理') logs.push(`狀態 ${c.status} → 待處理`);
    await save(c, sets, logs, me, at);
    invalidatePeople();
    // 專案標記取自卡片標題前綴，沒有前綴就不加
    const proj = /^\[(平台|銀行系統)\]\s*/.exec(c.title);
    const msgText = `[交接] ${proj ? `【${proj[1]}】` : ''}${cardNo(c.seq)} ${c.title.slice(proj ? proj[0].length : 0)} → @${toName}：${note}`;
    let messageId = null, notifyError = null;
    try {
      const r = await createMessage(ctx, me, { text: msgText, requestId: `handover_${c.uid}_${c.version}`, recipientIds: [to], project: c.project });
      messageId = r.message.messageId;
      await db.run('INSERT OR IGNORE INTO card_msgs (card_seq, message_id) VALUES (?,?)', c.seq, messageId);
    } catch (err) { notifyError = err.message; }
    return { ...view(await load(params.id), people), handoverMessageId: messageId, ...(notifyError ? { notifyError } : {}) };
  });

  route('POST', '/api/cards/:id/messages', async ({ ctx, me, req, params }) => {
    const c = await load(params.id);
    requireEdit(me, c);
    const mid = String((await readJson(req)).messageId || '');
    if (!(await db.get('SELECT id FROM messages WHERE id = ?', mid))) throw invalid('找不到這則訊息');
    const n = (await db.get('SELECT COUNT(*) AS n FROM card_msgs WHERE card_seq = ?', c.seq)).n;
    if (n >= 50) throw invalid('一張卡片最多關聯 50 則訊息');
    await db.run('INSERT OR IGNORE INTO card_msgs (card_seq, message_id) VALUES (?,?)', c.seq, mid);
    return { cardId: cardNo(c.seq), messageId: mid };
  });

  // ===== AI 建議（第三階段） =====
  const SUG_PENDING_MAX = 20;
  const sugNo = id => `S-${id}`;
  const parseSug = id => {
    const m = /^S-(\d+)$/.exec(id);
    if (!m) throw new ApiError(404, 'NOT_FOUND', '找不到這則建議');
    return Number(m[1]);
  };
  async function loadSug(id) {
    const r = await db.get('SELECT * FROM suggestions WHERE id = ?', parseSug(id));
    if (!r) throw new ApiError(404, 'NOT_FOUND', '找不到這則建議');
    return r;
  }
  async function sugView(r, people) {
    const p = JSON.parse(r.payload || '{}');
    const card = r.card_seq ? await db.get('SELECT seq, title, status FROM cards WHERE seq = ?', r.card_seq) : null;
    return {
      suggestionId: sugNo(r.id), kind: r.kind, state: r.state, from: ref(people, r.from_id), why: r.why, basisMessageId: r.basis_message_id, createdAt: r.created_at,
      card: card ? { cardId: cardNo(card.seq), title: card.title, status: card.status } : null,
      to: p.to ?? null, waitFor: ref(people, p.waitForId),
      create: r.kind === 'create' ? { type: p.type, title: p.title, reason: p.reason, owner: ref(people, p.ownerId), next: p.next, blocker: p.blocker, waitFor: ref(people, p.waitForId), criteria: p.criteria } : null,
      resolvedBy: ref(people, r.resolved_by), resolvedAt: r.resolved_at, resultCardId: r.result_card_seq ? cardNo(r.result_card_seq) : null,
    };
  }

  route('POST', '/api/suggestions', async ({ ctx, me, req }) => {
    if (me.kind !== 'ai') throw invalid('建議是給 AI 用的：人類請直接建立或修改卡片。');
    const body = await readJson(req);
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
    if (!requestId || requestId.length > 128) throw invalid('requestId 為必填，長度 1～128');
    const people = await peopleMap(ctx);
    const dup = await db.get('SELECT * FROM suggestions WHERE from_id = ? AND request_id = ?', me.id, requestId);
    if (dup) return { __status: 200, ...(await sugView(dup, people)), duplicate: true };
    const why = String(body.why ?? '').trim();
    if (!why) throw invalid('why 為必填：請說明為什麼建議這樣改');
    if (why.length > 300) throw invalid('why 上限 300 字');
    if (body.basisMessageId && !(await db.get('SELECT id FROM messages WHERE id = ?', String(body.basisMessageId)))) throw invalid('找不到 basisMessageId 這則訊息');
    const pending = (await db.get("SELECT COUNT(*) AS n FROM suggestions WHERE from_id = ? AND state = 'pending'", me.id)).n;
    if (pending >= SUG_PENDING_MAX) throw new ApiError(429, 'TOO_MANY_SUGGESTIONS', `你還有 ${pending} 則建議沒被處理，請先等人類處理再提新的。`);

    const kind = body.kind;
    let cardSeq = null, payload;
    if (kind === 'create') {
      const title = text(body, 'title', { required: true });
      if (title === undefined) throw invalid('title 為必填');
      const type = checkType(body.type ?? '工作');
      if (type === '決策') throw invalid('決策卡片請直接用 POST /api/cards 建立（它本來就是等人類決定）。');
      const owner = await validPerson(people, body.ownerId, '負責人');
      if (!owner || owner === me.id) throw new ApiError(400, 'USE_POST', '替自己建卡或不指派負責人，請直接用 POST /api/cards；建議只用在「把工作指派給別人」。');
      const mineP = projectsOf(me);
      const sp = body.project ?? (mineP.length === 1 ? mineP[0] : undefined);
      if (!PROJECTS.includes(sp)) throw invalid(`project 為必填：${PROJECTS.join('、')}`);
      payload = { type, project: sp, title, reason: text(body, 'reason') ?? '', ownerId: owner, next: text(body, 'next') ?? '', blocker: text(body, 'blocker') ?? '',
        waitForId: await validPerson(people, body.waitForId, '等誰'), criteria: text(body, 'criteria') ?? '' };
    } else if (kind === 'status') {
      const c = await load(String(body.cardId ?? ''));
      const to = checkStatus(body.status);
      if (canEdit(me, c)) throw new ApiError(400, 'USE_PATCH', '這張是你負責的卡片，請直接用 PATCH /api/cards/:id 修改。');
      if (c.status === to) throw new ApiError(400, 'NO_CHANGE', `這張卡片已經是「${to}」了。`);
      if (c.type === '決策' && to === '已完成') throw new ApiError(400, 'USE_DECIDE', '決策卡片要由決策者決定，不能建議直接完成。');
      cardSeq = c.seq;
      payload = { to, waitForId: await validPerson(people, body.waitForId, '等誰') };
      const same = await db.get("SELECT * FROM suggestions WHERE from_id = ? AND state = 'pending' AND kind = 'status' AND card_seq = ? AND payload = ?", me.id, cardSeq, JSON.stringify(payload));
      if (same) return { __status: 200, ...(await sugView(same, people)), duplicate: true };
    } else throw invalid("kind 需為 'create' 或 'status'");
    const at = nowIso();
    await db.run('INSERT INTO suggestions (kind, from_id, card_seq, payload, basis_message_id, why, request_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
      kind, me.id, cardSeq, JSON.stringify(payload), body.basisMessageId ? String(body.basisMessageId) : null, why, requestId, at);
    const row = await db.get('SELECT * FROM suggestions WHERE from_id = ? AND request_id = ?', me.id, requestId);
    return { __status: 201, ...(await sugView(row, people)) };
  });

  route('GET', '/api/suggestions', async ({ ctx, me, url }) => {
    const st = url.searchParams.get('state') || 'pending';
    if (!['pending', 'applied', 'skipped'].includes(st)) throw invalid('state 需為 pending、applied 或 skipped');
    const limit = parseLimit(url, 100, 200);
    const rows = me.kind === 'human'
      ? await db.all('SELECT * FROM suggestions WHERE state = ? ORDER BY id DESC LIMIT ?', st, limit)
      : await db.all('SELECT * FROM suggestions WHERE state = ? AND from_id = ? ORDER BY id DESC LIMIT ?', st, me.id, limit);
    const people = await peopleMap(ctx);
    return { items: await Promise.all(rows.map(r => sugView(r, people))) };
  });

  const humanOnly = me => { if (me.kind !== 'human') throw new ApiError(403, 'FORBIDDEN', '只有人類成員能採用或略過建議。'); };
  async function claim(r, me, at, resultSeq = null, state = 'applied') {
    const res = await db.run("UPDATE suggestions SET state = ?, resolved_by = ?, resolved_at = ?, result_card_seq = ? WHERE id = ? AND state = 'pending'", state, me.id, at, resultSeq, r.id);
    if (!res.changes) throw new ApiError(409, 'NOT_PENDING', '這則建議已經被處理過了。');
  }

  route('POST', '/api/suggestions/:id/apply', async ({ ctx, me, req, params }) => {
    humanOnly(me);
    const body = await readJson(req);
    const r = await loadSug(params.id);
    if (r.state !== 'pending') throw new ApiError(409, 'NOT_PENDING', '這則建議已經被處理過了。');
    const people = await peopleMap(ctx), p = JSON.parse(r.payload || '{}'), at = nowIso();
    const aiName = people.get(r.from_id)?.name || 'AI';
    if (r.kind === 'status') {
      const c = await db.get('SELECT * FROM cards WHERE seq = ?', r.card_seq);
      if (!c) throw notFound();
      if (c.status === p.to) { await claim(r, me, at, c.seq); return view(c, people); }
      const ch = statusChange(c, p.to, me, at);
      const sets = { ...ch.sets }, logs = ch.logs.map((t, i) => (i === 0 ? `採用 ${aiName} 的建議：${t}` : t));
      if (p.waitForId && p.waitForId !== c.wait_for_id) { sets.wait_for_id = p.waitForId; logs.push(`等誰改為 ${people.get(p.waitForId)?.name}`); }
      await save(c, sets, logs, me, at);
      await claim(r, me, at, c.seq);
      invalidatePeople();
      await notifyCard(ctx, me, c, [r.from_id, p.waitForId], `採用了 ${aiName} 的建議：狀態改為 ${p.to}`, `sug${r.id}`);
      return view(await db.get('SELECT * FROM cards WHERE seq = ?', c.seq), people);
    }
    // create：採用時可以先改欄位
    const f = { ...p };
    for (const k of ['title', 'reason', 'next', 'blocker', 'criteria']) { const v = text(body, k, { required: k === 'title' }); if (v !== undefined) f[k] = v; }
    if (body.type !== undefined) { f.type = checkType(body.type); if (f.type === '決策') throw invalid('決策卡片請直接建立'); }
    if (body.project !== undefined) { if (!PROJECTS.includes(body.project)) throw invalid(`project 需為：${PROJECTS.join('、')}`); f.project = body.project; }
    if (body.ownerId !== undefined) f.ownerId = await validPerson(people, body.ownerId, '負責人');
    if (body.waitForId !== undefined) f.waitForId = await validPerson(people, body.waitForId, '等誰');
    const status = f.type === '阻塞' ? '受阻' : '待處理';
    const uid = randId('card');
    await db.run(`INSERT INTO cards (uid, type, title, reason, owner_id, status, next, blocker, wait_for_id, criteria, created_by, request_id, created_at, updated_at, project)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, uid, f.type, f.title, f.reason ?? '', f.ownerId ?? null, status, f.next ?? '', f.blocker ?? '', f.waitForId ?? null,
      f.criteria ?? '', r.from_id, `sug_${r.id}`, at, at, f.project || '平台');
    const c = await db.get('SELECT * FROM cards WHERE uid = ?', uid);
    await db.batch([
      ...logStmt(c.seq, me, [`採用 ${aiName} 的建議建立卡片（類型：${f.type}）`], at),
      ...(r.basis_message_id ? [['INSERT OR IGNORE INTO card_msgs (card_seq, message_id) VALUES (?,?)', [c.seq, r.basis_message_id]]] : []),
    ]);
    await claim(r, me, at, c.seq);
    invalidatePeople();
    await notifyCard(ctx, me, c, [r.from_id, f.ownerId, f.waitForId], `採用了 ${aiName} 的建議建立這張卡${f.ownerId ? '，負責人 ' + people.get(f.ownerId)?.name : ''}`, `sug${r.id}`);
    return { __status: 201, ...view(c, people) };
  });

  route('POST', '/api/suggestions/:id/skip', async ({ ctx, me, params }) => {
    humanOnly(me);
    const r = await loadSug(params.id);
    await claim(r, me, nowIso(), null, 'skipped');
    return sugView(await loadSug(params.id), await peopleMap(ctx));
  });
}
