// 工作卡片 API（第一階段）：卡片、狀態、完成／驗證、紀錄、關聯訊息。
// 權限：人類可改所有卡片；AI 只能建立卡片（負責人限自己或不指派）、修改自己負責的卡片。
// 「已驗證」必須由完成者以外的人或 AI 標記。
// 決策卡片（第二階段）：只有指定決策者（人類）能決定；要求補充會把球丟回提案人，補充後自動回到決策者。AI 建議在後續階段。
export const CARD_STATUSES = ['待整理', '待處理', '進行中', '待確認', '受阻', '已完成', '已封存'];
export const CARD_TYPES = ['工作', '阻塞', '決策'];
const BUILTIN_RESULTS = ['不同意', '要求補充']; // 決定時固定可用，不可當選項名稱
const OPEN_STATUSES_SQL = "('已完成','已封存')";
export const CARD_LIMITS = { title: 100, reason: 500, next: 300, blocker: 300, criteria: 500, question: 200, recommendation: 500, impact: 200, afterNext: 300, note: 500, option: 40 };
const CARD_NO_BASE = 100; // 顯示編號 = C-(seq + 100)

const FIELD_LABEL = { title: '標題', reason: '原因', next: '下一步', blocker: '阻塞', criteria: '完成條件', question: '決策問題', recommendation: '建議方案', impact: '影響', afterNext: '決定後' };
const DECISION_COL = { question: 'question', recommendation: 'recommendation', impact: 'impact', afterNext: 'after_next' };
const cardNo = seq => `C-${seq + CARD_NO_BASE}`;

export function registerCards({ route, db, ApiError, invalid, readJson, peopleMap, randId, nowIso, parseLimit, invalidatePeople }) {
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
    cardId: cardNo(c.seq), type: c.type, title: c.title, reason: c.reason, status: c.status,
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
      throw new ApiError(403, 'NOT_CARD_OWNER', '這張卡片不是你負責的。AI 只能修改自己負責的卡片；要改別人的卡片，請請所屬人類處理或在群組留言。');
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

  route('GET', '/api/cards', async ({ ctx, url }) => {
    const q = url.searchParams, limit = parseLimit(url, 100, 200);
    const where = [], args = [];
    const status = q.get('status');
    if (status === 'open') where.push(`status NOT IN ${OPEN_STATUSES_SQL}`);
    else if (status) { where.push('status = ?'); args.push(checkStatus(status)); }
    else if (!q.get('since') && q.get('include') !== 'archived') where.push("status != '已封存'");
    if (q.get('owner')) { where.push('owner_id = ?'); args.push(q.get('owner')); }
    if (q.get('type')) { where.push('type = ?'); args.push(checkType(q.get('type'))); }
    if (q.get('since')) { where.push('updated_at > ?'); args.push(String(q.get('since'))); }
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
    const messageIds = Array.isArray(body.messageIds) ? [...new Set(body.messageIds.map(String))].slice(0, 10) : [];
    if (messageIds.length) {
      const found = await db.all('SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(messageIds));
      if (found.length !== messageIds.length) throw invalid('messageIds 有不存在的訊息');
    }
    const at = nowIso(), uid = randId('card');
    await db.run(`INSERT INTO cards (uid, type, title, reason, owner_id, status, next, blocker, wait_for_id, criteria, created_by, request_id, created_at, updated_at,
      decider_id, proposer_id, question, recommendation, options, impact, after_next)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, uid, type, title, text(body, 'reason') ?? '', owner, status, text(body, 'next') ?? '', text(body, 'blocker') ?? '',
      waitFor, text(body, 'criteria') ?? '', me.id, requestId, at, at,
      dec.decider_id, dec.proposer_id, dec.question, dec.recommendation, dec.options, dec.impact, dec.after_next);
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
    requireEdit(me, c);
    if (body.version !== undefined && Number(body.version) !== c.version) {
      throw new ApiError(409, 'CONFLICT', '這張卡片剛被別人修改過，請重新讀取後再試。');
    }
    const people = await peopleMap(ctx), sets = {}, logs = [];
    for (const key of ['title', 'reason', 'next', 'blocker', 'criteria']) {
      const v = text(body, key, { required: key === 'title' });
      if (v !== undefined && v !== c[key]) { sets[key] = v; logs.push(`${FIELD_LABEL[key]}已修改`); }
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
      if (owner !== c.owner_id) { sets.owner_id = owner; logs.push(`負責人改為 ${people.get(owner)?.name || '未指派'}`); }
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
}
