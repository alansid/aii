// 工作卡片 API（第一階段）：卡片、狀態、完成／驗證、紀錄、關聯訊息。
// 權限：人類可改所有卡片；AI 只能建立卡片（負責人限自己或不指派）、修改自己負責的卡片。
// 「已驗證」必須由完成者以外的人或 AI 標記。決策卡片的決定與 AI 建議在後續階段。
export const CARD_STATUSES = ['待整理', '待處理', '進行中', '待確認', '受阻', '已完成', '已封存'];
export const CARD_TYPES = ['工作', '阻塞']; // 第二階段加入「決策」
const OPEN_STATUSES_SQL = "('已完成','已封存')";
export const CARD_LIMITS = { title: 100, reason: 500, next: 300, blocker: 300, criteria: 500 };
const CARD_NO_BASE = 100; // 顯示編號 = C-(seq + 100)

const FIELD_LABEL = { title: '標題', reason: '原因', next: '下一步', blocker: '阻塞', criteria: '完成條件' };
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

  async function load(no) {
    const c = await db.get('SELECT * FROM cards WHERE seq = ?', parseNo(no));
    if (!c) throw notFound();
    return c;
  }
  const logStmt = (seq, me, texts, at) => texts.map(t =>
    ['INSERT INTO card_log (card_seq, at, by_id, via, text) VALUES (?,?,?,?,?)', [seq, at, me.id, me.kind === 'human' ? '網頁' : 'API', t]]);

  // 換狀態的連動：完成者記錄；離開「已完成」時清掉完成與驗證
  function statusChange(c, to, me, at) {
    const sets = { status: to }, logs = [`狀態 ${c.status} → ${to}`];
    if (to === '已完成' && !c.done_by) { Object.assign(sets, { done_by: me.id, done_at: at }); logs.push('標為已完成'); }
    if (to !== '已完成' && c.status === '已完成') {
      Object.assign(sets, { done_by: null, done_at: null, verified_by: null, verified_at: null });
      if (c.verified_by) logs.push('移除已驗證標記');
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
    const defaultStatus = type === '阻塞' ? '受阻' : '待整理';
    const status = checkStatus(body.status ?? defaultStatus);
    if (status === '已完成' || status === '已封存') throw invalid('新卡片不能直接是已完成或已封存');
    const waitFor = await validPerson(people, body.waitForId, '等誰');
    const messageIds = Array.isArray(body.messageIds) ? [...new Set(body.messageIds.map(String))].slice(0, 10) : [];
    if (messageIds.length) {
      const found = await db.all('SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(messageIds));
      if (found.length !== messageIds.length) throw invalid('messageIds 有不存在的訊息');
    }
    const at = nowIso(), uid = randId('card');
    await db.run(`INSERT INTO cards (uid, type, title, reason, owner_id, status, next, blocker, wait_for_id, criteria, created_by, request_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, uid, type, title, text(body, 'reason') ?? '', owner, status, text(body, 'next') ?? '', text(body, 'blocker') ?? '',
      waitFor, text(body, 'criteria') ?? '', me.id, requestId, at, at);
    const c = await db.get('SELECT * FROM cards WHERE uid = ?', uid);
    await db.batch([
      ...logStmt(c.seq, me, [`建立卡片（類型：${type}）`], at),
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
    if (body.type !== undefined && checkType(body.type) !== c.type) { sets.type = body.type; logs.push(`類型改為 ${body.type}`); }
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
