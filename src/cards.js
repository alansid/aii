// 工作卡片 API（第一階段）：卡片、狀態、完成／驗證、紀錄、關聯訊息。
// 權限：人類可改所有卡片；AI 只能建立卡片（負責人限自己或不指派）、修改自己負責的卡片。
// 「已驗證」必須由完成者以外的人或 AI 標記。
// AI 建議（第三階段）：AI 只能建議改別人的卡片／替別人建卡，由人類採用或略過。
// 決策卡片（第二階段）：只有指定決策者（人類）能決定；要求補充會把球丟回提案人，補充後自動回到決策者。AI 建議在後續階段。
export const CARD_STATUSES = ['待整理', '待處理', '進行中', '待確認', '受阻', '已完成', '已封存'];
export const CARD_TYPES = ['工作', '阻塞', '決策', '人類紀錄'];
// C-218：人類紀錄卡——人類記內容；AI 平常的列表、增量、計數、團隊狀態都不含，不發任何群組訊息；
// AI 主動查（type=人類紀錄 或卡號）讀得到（含紀錄），只能讀；唯一能做的是整理完標已完成並註明「已整理到 C-xxx」
export const NOTE = '人類紀錄';
const NOTE_LOG = '紀錄'; // card_log.via：卡上的人類紀錄（不發群組）
const MERGED = /^已整理到 (C-\d+)/;
const BUILTIN_RESULTS = ['不同意', '要求補充']; // 決定時固定可用，不可當選項名稱
// C-336：用 IN 列出狀態才走得到 idx_cards_status（NOT IN、!= 會逐列濾）
const UNFINISHED_SQL = "('待整理','待處理','進行中','待確認','受阻')";
const NOT_ARCHIVED_SQL = "('待整理','待處理','進行中','待確認','受阻','已完成')";
export const CARD_LIMITS = { title: 100, reason: 500, next: 300, blocker: 300, criteria: 500, question: 200, recommendation: 500, impact: 200, afterNext: 300, note: 500, option: 40, handover: 300, record: 1000 };
const CARD_NO_BASE = 100; // 顯示編號 = C-(seq + 100)

const FIELD_LABEL = { title: '標題', reason: '原因', next: '下一步', blocker: '阻塞', criteria: '完成條件', question: '決策問題', recommendation: '建議方案', impact: '影響', afterNext: '決定後', handover: '交接說明' };
const DECISION_COL = { question: 'question', recommendation: 'recommendation', impact: 'impact', afterNext: 'after_next' };
const cardNo = seq => `C-${seq + CARD_NO_BASE}`;


// C-161 卡片瘦身：已完成＋已驗證滿 7 天自動封存（未驗證的永遠不自動封存）
export const ARCHIVE_DAYS = 7;
export async function autoArchive(db, now = Date.now()) {
  const cutoff = new Date(now - ARCHIVE_DAYS * 86400_000).toISOString();
  const rows = await db.all("SELECT seq FROM cards WHERE status = '已完成' AND verified_by IS NOT NULL AND COALESCE(verified_at, done_at) <= ?", cutoff);
  if (!rows.length) return 0;
  const at = new Date(now).toISOString(), stmts = [];
  for (const r of rows) {
    stmts.push(["UPDATE cards SET status = '已封存', updated_at = ?, version = version + 1 WHERE seq = ? AND status = '已完成'", [at, r.seq]]);
    stmts.push(['INSERT INTO card_log (card_seq, at, by_id, via, text) VALUES (?,?,?,?,?)', [r.seq, at, 'system', '系統', `系統自動封存（完成滿 ${ARCHIVE_DAYS} 天）`]]);
  }
  await db.batch(stmts);
  return rows.length;
}

// 團隊狀態用：每位負責人手上最急的未完成卡片、以及等決策者的決策卡（只讀未完成的卡片，量很小）
const WORK_RANK = { 受阻: 0, 待確認: 1, 進行中: 2, 待處理: 3 };
const WORK_STATE = { 受阻: 'blocked', 待確認: 'waiting', 進行中: 'working', 待處理: 'todo' };
// 每位負責人「目前工作」＝最優先的那張未結卡＋張數；allow 用來只算看的人看得到的專案（C-235）
export function workFrom(open, allow = () => true) {
  const byOwner = new Map();
  for (const c of open) {
    if (!allow(c)) continue;
    const cur = byOwner.get(c.owner_id) || { best: null, count: 0 };
    cur.count++;
    if (!cur.best || WORK_RANK[c.status] < WORK_RANK[cur.best.status]) cur.best = c;
    byOwner.set(c.owner_id, cur);
  }
  return new Map([...byOwner].map(([id, { best, count }]) => [id,
    { state: WORK_STATE[best.status], title: best.title, cardId: cardNo(best.seq), at: best.updated_at, cardCount: count, source: 'card' }]));
}
export async function teamCards(db) {
  const open = await db.all("SELECT seq, owner_id, status, title, updated_at, project FROM cards WHERE owner_id IS NOT NULL AND type != '人類紀錄' AND status IN ('待處理','進行中','待確認','受阻') ORDER BY updated_at DESC");
  const work = workFrom(open);
  const decisions = await db.all("SELECT seq, title, question, proposer_id, decider_id, created_at, project FROM cards WHERE type = '決策' AND status = '待確認' AND decision_result IS NULL ORDER BY created_at DESC LIMIT 30");
  return { work, open, decisions: decisions.map(d => ({ cardId: cardNo(d.seq), title: d.question || d.title, createdAt: d.created_at, proposerId: d.proposer_id, deciderId: d.decider_id, project: d.project })) };
}

export function registerCards({ route, searchQuota = () => {}, cardKey = () => null, cardSeqByKey = async () => null, createMessage, isolatedFrom, canSeeMessage = async () => true, projectName = id => id, archiveEveryMs = 10 * 60_000, PROJECTS, projectsOf, projectFilter, db, ApiError, invalid, readJson, peopleMap, randId, nowIso, parseLimit, invalidatePeople, cardStaleHours }) {
  const STALE_CARD_MS = (cardStaleHours !== undefined && cardStaleHours !== '' && Number.isFinite(Number(cardStaleHours)) ? Number(cardStaleHours) : 24) * 3600_000; // C-144：卡片多久沒更新才可能過時
  const notFound = () => new ApiError(404, 'NOT_FOUND', '找不到這張卡片');
  let archivedAt = 0;
  const maybeArchive = async () => { if (Date.now() - archivedAt < archiveEveryMs) return; archivedAt = Date.now(); await autoArchive(db).catch(e => console.error('autoArchive', e.message)); };
  // C-146 A：卡片的專案看專案欄位；舊卡標題的「[專案]」前綴在通知裡去掉，改用【專案】標記
  const plainTitle = t => { const m = /^\s*\[([^\]\n]{1,20})\]\s*/.exec(t); return m && (PROJECTS.includes(m[1]) || ['平台', '銀行系統'].includes(m[1])) ? t.slice(m[0].length) || t : t; };
  const parseNo = id => {
    const m = /^C-(\d+)$/.exec(id);
    const seq = m ? Number(m[1]) - CARD_NO_BASE : NaN;
    if (!Number.isInteger(seq) || seq < 1) throw notFound();
    return seq;
  };
  const ref = (people, id) => {
    const p = id && people.get(id);
    return p ? { participantId: p.id, name: p.status === 'deleted' ? p.name + '（已刪除）' : p.name, memberType: p.kind, ...(p.status === 'deleted' ? { deleted: true } : {}) } : null;
  };
  const mark = (people, by, at) => (by ? { by: ref(people, by), at } : null);

  const view = (c, people) => ({
    cardId: cardNo(c.seq), key: cardKey(c), type: c.type, project: c.project, title: c.title, reason: c.reason, status: c.status, // C-310：key＝專案代號號（PLAT-12）
    owner: ref(people, c.owner_id), next: c.next, blocker: c.blocker, waitFor: ref(people, c.wait_for_id), criteria: c.criteria,
    createdBy: ref(people, c.created_by), createdAt: c.created_at, updatedAt: c.updated_at, version: c.version,
    done: mark(people, c.done_by, c.done_at), verified: mark(people, c.verified_by, c.verified_at),
    ...(c.type === '決策' ? { decision: decisionView(c, people) } : {}),
    ...(c.merged_into ? { mergedInto: c.merged_into } : {}),
  });
  // C-218：「已整理到 C-xxx」（人類紀錄卡被 AI 整理後留下的紀錄）與「整理自」
  async function attachMerged(rows) {
    const notes = rows.filter(c => c.type === NOTE);
    if (!notes.length) return rows;
    const logs = await db.all("SELECT card_seq, text FROM card_log WHERE card_seq IN (SELECT value FROM json_each(?)) AND text LIKE '已整理到 C-%' ORDER BY id", JSON.stringify(notes.map(c => c.seq)));
    const m = new Map(logs.map(l => [l.card_seq, MERGED.exec(l.text)?.[1]]));
    return rows.map(c => (m.get(c.seq) ? { ...c, merged_into: m.get(c.seq) } : c));
  }
  const notesOf = async seq => (await db.all('SELECT at, by_id, text FROM card_log WHERE card_seq = ? AND via = ? ORDER BY id', seq, NOTE_LOG));
  const noteView = (people, l) => ({ at: l.at, by: ref(people, l.by_id), text: l.text });
  const aiNoteForbidden = () => new ApiError(403, 'HUMAN_NOTE_READONLY', '這是人類紀錄卡：AI 只能讀。整理完請另建一張卡，並可把這張標「已完成」同時帶 mergedInto（例如 C-230），其他都不能改。');
  const parseOptions = c => { try { return JSON.parse(c.options || '[]'); } catch { return []; } };
  const decisionView = (c, people) => ({
    question: c.question || c.title, proposer: ref(people, c.proposer_id), decider: ref(people, c.decider_id),
    recommendation: c.recommendation, options: parseOptions(c), impact: c.impact, afterNext: c.after_next,
    deferred: c.status === '受阻' && !c.decision_result && String(c.blocker).startsWith('暫緩（'), result: c.decision_result, by: ref(people, c.decision_by), at: c.decision_at, note: c.decision_note,
  });

  const canEdit = (me, c) => me.kind === 'human' || c.owner_id === me.id || (!c.owner_id && c.created_by === me.id);
  const requireEdit = (me, c) => {
    if (!canEdit(me, c)) {
      throw new ApiError(403, 'NOT_CARD_OWNER', '這張卡片不是你負責的。AI 只能修改自己負責的卡片（未指派、待整理或待處理的非決策卡可用 PATCH ownerId=自己 認領）；要改別人的卡片，請提建議或在群組留言。');
    }
  };

  // 指派（負責人、等誰）只能選同專案成員；跨專案擋下並說明（C-146 B）
  function sameProject(people, id, project, label) {
    if (!id || !project) return;
    const p = people.get(id);
    if (!projectsOf(p).includes(project)) throw new ApiError(400, 'PROJECT_MISMATCH', `${label}「${p?.name || id}」不屬於這張卡的專案（${project}），只能指派同專案成員。`);
  }
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

  // me 有給時套用 C-146 A 隔離：不屬於卡片專案的成員視為找不到
  // C-310：新卡在所屬專案拿下一個號（先寫 NULL 再補，唯一索引不會撞）
  const assignProjNo = uid => db.run('UPDATE cards SET proj_no = (SELECT COALESCE(MAX(c2.proj_no), 0) + 1 FROM cards c2 WHERE c2.project = cards.project) WHERE uid = ? AND proj_no IS NULL', uid);
  async function load(no, me = null) {
    const c = await db.get('SELECT * FROM cards WHERE seq = ?', parseNo(no));
    if (!c) throw notFound();
    if (me && isolatedFrom(me) && !projectsOf(me).includes(c.project)) throw new ApiError(403, 'CARD_FORBIDDEN', '這張卡屬於其他專案，你沒有權限查看。'); // C-181：不寫專案名
    return c;
  }
  const logStmt = (seq, me, texts, at) => texts.map(t =>
    ['INSERT INTO card_log (card_seq, at, by_id, via, text) VALUES (?,?,?,?,?)', [seq, at, me.id, me.kind === 'human' ? '網頁' : 'API', t]]);

  // 換狀態的連動：完成者記錄；離開「已完成」時清掉完成與驗證
  function statusChange(c, to, me, at) {
    if (c.type === '決策' && to === '已完成') throw new ApiError(400, 'USE_DECIDE', '決策卡片要由指定決策者用 POST /api/cards/:id/decide 決定，不能直接標為已完成。');
    const sets = { status: to }, logs = [`狀態 ${c.status} → ${to}`];
    // C-161：離開「已完成」或「已封存」都清掉完成／驗證標記（重新打開的封存卡要重新完成＋驗證，7 天重新計）
    const leaving = (c.status === '已完成' && to !== '已完成') || (c.status === '已封存' && to !== '已封存');
    if (to === '已完成' && (!c.done_by || leaving)) { Object.assign(sets, { done_by: me.id, done_at: at }); logs.push('標為已完成'); }
    if (leaving) {
      Object.assign(sets, { verified_by: null, verified_at: null }, to === '已完成' ? {} : { done_by: null, done_at: null });
      if (c.verified_by) logs.push('移除已驗證標記');
      if (c.status === '已封存') logs.push('重新打開');
      if (c.decision_result) { // 重開決策卡：決定作廢
        Object.assign(sets, { decision_result: null, decision_by: null, decision_at: null, decision_note: '' });
        logs.push('決定已撤回');
        if (to === '待確認') Object.assign(sets, { wait_for_id: c.decider_id });
      }
    }
    // C-168：人類標「已完成」就是最終驗收，同時記為已驗證（驗證人＝本人）；AI 完成的卡、決策卡照舊要別人驗
    if (to === '已完成' && me.kind === 'human' && c.type !== '決策' && (leaving || !c.verified_by)) { Object.assign(sets, { verified_by: me.id, verified_at: at }); logs.push('人類完成即驗收'); }
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

  // 可能過時（C-144）：未結案、updated_at 超過門檻，且關聯訊息在 updated_at 之後 1 分鐘以上又有新動態（[通知] 系統訊息不算）
  // C-245：原本每次讀卡片列表都把所有未結案卡的關聯訊息整批 JOIN（一天 300 萬列讀取）。
  // 改成先用 updated_at 索引只挑「夠久沒更新」的未結案卡，再只讀這幾張的關聯訊息；結果在記憶體留一下（門檻 24 小時時為 60 秒）。
  // C-322：一天還有約 30 萬列。找舊卡改用狀態索引只讀未結案的（原本把已完成、已封存的舊卡也讀進來再丟）；
  // 關聯訊息第一次讀完記在記憶體，之後只補讀新加的關聯（card_msgs 只會新增、訊息不會改）；快取 1 → 5 分鐘
  const STALE_CACHE_MS = Math.min(300_000, STALE_CARD_MS / 60);
  const OPEN_LIST = JSON.stringify(CARD_STATUSES.filter(s => !['已完成', '已封存'].includes(s)));
  let staleCache = { at: 0, map: null };
  const linkLatest = new Map(); // card_seq → 最新一則非 [通知] 關聯訊息 { id, at }（只留目前「夠久沒更新」的未結卡）
  let linkRowid = null;          // 讀到哪一筆 card_msgs
  const bump = (seq, r) => { const cur = linkLatest.get(seq); if (!cur || r.at > cur.at) linkLatest.set(seq, { id: r.id, at: r.at }); };
  async function staleHints() {
    if (staleCache.map && Date.now() - staleCache.at < STALE_CACHE_MS) return staleCache.map;
    const now = Date.now(), out = new Map();
    const old = await db.all('SELECT seq, updated_at FROM cards WHERE status IN (SELECT value FROM json_each(?)) AND updated_at < ?', OPEN_LIST, new Date(now - STALE_CARD_MS).toISOString());
    const oldSeqs = new Set(old.map(c => c.seq));
    if (linkRowid === null) linkRowid = (await db.get('SELECT COALESCE(MAX(rowid), 0) AS r FROM card_msgs')).r;
    else {
      const fresh = await db.all(`SELECT cm.rowid AS rid, cm.card_seq AS seq, m.id AS id, m.created_at AS at, m.text LIKE '[通知]%' AS sys
        FROM card_msgs cm JOIN messages m ON m.id = cm.message_id WHERE cm.rowid > ?`, linkRowid);
      for (const r of fresh) { linkRowid = Math.max(linkRowid, r.rid); if (!r.sys && linkLatest.has(r.seq)) bump(r.seq, r); }
    }
    for (const seq of linkLatest.keys()) if (!oldSeqs.has(seq)) linkLatest.delete(seq); // 結案或又更新了就不用記
    const need = old.filter(c => !linkLatest.has(c.seq)).map(c => c.seq);
    if (need.length) {
      for (const seq of need) linkLatest.set(seq, null);
      for (const r of await db.all(`SELECT cm.card_seq AS seq, m.id AS id, m.created_at AS at FROM card_msgs cm JOIN messages m ON m.id = cm.message_id
        WHERE cm.card_seq IN (SELECT value FROM json_each(?)) AND m.text NOT LIKE '[通知]%'`, JSON.stringify(need))) bump(r.seq, r);
    }
    if (old.length) {
      const latest = linkLatest;
      for (const c of old) {
        const l = latest.get(c.seq);
        if (l && Date.parse(l.at) - Date.parse(c.updated_at) > Math.min(60_000, STALE_CARD_MS)) out.set(c.seq, { lastUpdatedAt: c.updated_at, latestMessageAt: l.at, latestMessageId: l.id });
      }
    }
    staleCache = { at: now, map: out };
    return out;
  }
  const withStale = (v, c, stale) => (stale.get(c.seq)?.lastUpdatedAt === c.updated_at ? { ...v, staleHint: stale.get(c.seq) } : v);

  // C-312：卡片列表（合併搜尋 /api/search 也用；quota: false 由呼叫端算次數）
  async function listCards({ ctx, me, url }, { quota = true } = {}) {
    await maybeArchive();
    const q = url.searchParams, limit = (q.get('q') || '').trim() ? Math.min(parseLimit(url, 100, 200), 20) : parseLimit(url, 100, 200); // C-312：有關鍵字最多 20 筆
    const offset = Math.max(0, Math.min(Number.parseInt(q.get('offset') || '0', 10) || 0, 100_000)); // C-161：已封存分頁
    const where = [], args = [];
    const status = q.get('status');
    if (status === 'open') where.push(`status IN ${UNFINISHED_SQL}`);
    else if (status) { where.push('status = ?'); args.push(checkStatus(status)); }
    else if (!q.get('since') && q.get('include') !== 'archived') where.push(`status IN ${NOT_ARCHIVED_SQL}`);
    if (q.get('owner')) { where.push('owner_id = ?'); args.push(q.get('owner')); }
    if (q.get('type')) { where.push('type = ?'); args.push(checkType(q.get('type'))); }
    else if (me.kind !== 'human') where.push("type != '人類紀錄'"); // C-218：AI 平常的列表、增量不含
    if (q.get('since')) { where.push('updated_at > ?'); args.push(String(q.get('since'))); }
    const pf = projectFilter(q.get('project'), me, 'project', false);
    if (pf) { where.push(pf.sql); args.push(...pf.args); }
    if (isolatedFrom(me)) { const mine = projectsOf(me); where.push(mine.length ? `project IN (${mine.map(() => '?').join(',')})` : '1 = 0'); args.push(...mine); }
    const kw = (q.get('q') || '').trim();
    if (kw) { // C-312：關鍵字搜尋卡片（人類、AI 都算）：至少 2 字、算進每人每分鐘 10 次、最多 20 筆
      if ([...kw].length < 2) throw invalid('搜尋至少 2 個字');
      if (quota) await searchQuota(me);
    }
    // C-310：打卡號（PLAT-12 或 C-212）也找得到那張
    const kwSeq = !kw ? null : (await cardSeqByKey(kw)) ?? (/^C-\d+$/i.test(kw) ? Number(kw.slice(2)) - 100 : null);
    if (kw) { where.push(`(title LIKE ? ESCAPE '\\' OR next LIKE ? ESCAPE '\\'${kwSeq !== null ? ' OR seq = ?' : ''})`); const like = `%${kw.replace(/[%_\\]/g, m => '\\' + m)}%`; args.push(like, like, ...(kwSeq !== null ? [kwSeq] : [])); }
    const rows = await db.all(`SELECT * FROM cards ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC, seq DESC LIMIT ? OFFSET ?`, ...args, limit + 1, offset);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const people = await peopleMap(ctx);
    const stale = await staleHints();
    let out = items;
    if (q.get('since')) { // 增量同步：過時狀態會隨時間改變、卡片本身沒更新，所以把目前過時的卡也一併帶回
      const have = new Set(items.map(c => c.seq));
      const extra = [...stale.keys()].filter(seq => !have.has(seq));
      if (extra.length) out = [...items, ...(await db.all(`SELECT * FROM cards WHERE seq IN (SELECT value FROM json_each(?))${pf ? ' AND ' + pf.sql : ''}`, JSON.stringify(extra), ...(pf ? pf.args : [])))].filter(c => me.kind === 'human' || c.type !== NOTE || q.get('type') === NOTE);
    }
    let counts;
    if (q.get('counts') === '1') { // C-161：已封存總數（依可見專案）
      const mine = isolatedFrom(me) ? projectsOf(me) : null;
      const cw = mine ? ` AND project IN (${mine.map(() => '?').join(',') || "''"})` : '';
      counts = { archived: (await db.get(`SELECT COUNT(*) AS n FROM cards WHERE status = '已封存'${cw}${me.kind === 'human' ? '' : " AND type != '人類紀錄'"}`, ...(mine || []))).n };
    }
    out = await attachMerged(out);
    const withNotes = q.get('type') === NOTE; // 主動查人類紀錄：一次拿全部，含紀錄
    const noteMap = withNotes && out.length ? new Map() : null;
    if (noteMap) for (const l of await db.all('SELECT card_seq, at, by_id, text FROM card_log WHERE via = ? AND card_seq IN (SELECT value FROM json_each(?)) ORDER BY id', NOTE_LOG, JSON.stringify(out.map(c => c.seq)))) { if (!noteMap.has(l.card_seq)) noteMap.set(l.card_seq, []); noteMap.get(l.card_seq).push(noteView(people, l)); }
    return { items: out.map(c => ({ ...withStale(view(c, people), c, stale), ...(noteMap ? { notes: noteMap.get(c.seq) || [] } : {}) })), hasMore, ...(counts ? { counts } : {}), nextSince: items.reduce((m, c) => (c.updated_at > m ? c.updated_at : m), q.get('since') || '') || null };
  }
  route('GET', '/api/cards', args => listCards(args));

  route('GET', '/api/cards/:id', async ({ ctx, me, params }) => {
    await maybeArchive();
    const c = (await attachMerged([await load(params.id, me)]))[0];
    const people = await peopleMap(ctx);
    // C-245：只有人類紀錄卡會「已整理到」；只查這些卡的紀錄，不掃整張 card_log
    const mergedFrom = c.type === NOTE ? [] : (await db.all("SELECT DISTINCT card_seq FROM card_log WHERE card_seq IN (SELECT seq FROM cards WHERE type = ?) AND text = ? ORDER BY card_seq", NOTE, `已整理到 ${cardNo(c.seq)}`)).map(r => cardNo(r.card_seq));
    const [log, msgs] = await Promise.all([
      db.all('SELECT at, by_id, via, text FROM card_log WHERE card_seq = ? ORDER BY id DESC LIMIT 200', c.seq),
      db.all('SELECT message_id FROM card_msgs WHERE card_seq = ? ORDER BY rowid', c.seq),
    ]);
    return {
      ...withStale(view(c, people), c, await staleHints()), messageIds: msgs.map(m => m.message_id),
      log: log.filter(l => l.via !== NOTE_LOG).map(l => ({ at: l.at, by: l.by_id === 'system' ? { participantId: 'system', name: '系統', memberType: 'system' } : ref(people, l.by_id), via: l.via, text: l.text })),
      ...(c.type === NOTE ? { notes: (await notesOf(c.seq)).map(l => noteView(people, l)) } : {}),
      ...(mergedFrom.length ? { mergedFrom } : {}),
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
    if (type === NOTE && me.kind !== 'human') throw new ApiError(403, 'HUMAN_ONLY', '人類紀錄只有人類能建立。');
    const title = text(body, 'title', { required: true });
    if (title === undefined) throw invalid('title 為必填');
    const owner = await validPerson(people, body.ownerId, '負責人');
    if (me.kind === 'ai' && owner && owner !== me.id) {
      throw new ApiError(403, 'ASSIGN_OTHERS', 'AI 不能直接把卡片指派給別人；負責人請留空或填自己，並在 next 寫清楚要誰接手。');
    }
    const defaultStatus = type === '阻塞' ? '受阻' : type === '決策' ? '待確認' : type === NOTE ? '進行中' : '待整理';
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
    sameProject(people, owner, project, '負責人');
    if (type !== '決策') sameProject(people, waitFor, project, '等誰');
    if (type === NOTE) humansOnly(people, [owner, waitFor]);
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
    await assignProjNo(uid); // C-310
    const c = await db.get('SELECT * FROM cards WHERE uid = ?', uid);
    await db.batch([
      ...logStmt(c.seq, me, [`建立卡片（類型：${type}）`, ...(type === '決策' ? [`等 ${people.get(dec.decider_id)?.name} 決定`] : [])], at),
      ...messageIds.map(m => ['INSERT OR IGNORE INTO card_msgs (card_seq, message_id) VALUES (?,?)', [c.seq, m]]),
    ]);
    // C-155：建卡時指定了別人（負責人、等誰、決策者）就通知對方，和交接一樣會叫醒 AI
    const who = [owner && `負責人 ${people.get(owner)?.name}`, waitFor && (type === '決策' ? `等 ${people.get(waitFor)?.name} 決定` : `等 ${people.get(waitFor)?.name}`)].filter(Boolean).join('；');
    if (type !== NOTE) await notifyCard(ctx, me, c, [owner, waitFor], `建立卡片${who ? '，' + who : ''}`, 'create'); // 人類紀錄不發群組訊息
    return { __status: 201, ...view(await load(cardNo(c.seq)), people) };
  });

  route('PATCH', '/api/cards/:id', async ({ ctx, me, req, params }) => {
    const body = await readJson(req);
    const c = await load(params.id, me);
    // C-218：AI 對人類紀錄卡唯一能做的：整理完標「已完成」並註明 mergedInto（不能改其他欄位）
    if (c.type === NOTE && me.kind !== 'human') {
      const keys = Object.keys(body).filter(k => k !== 'version');
      if (!(body.status === '已完成' && body.mergedInto && keys.every(k => ['status', 'mergedInto'].includes(k)))) throw aiNoteForbidden();
      const into = await load(String(body.mergedInto), me).catch(() => { throw invalid('mergedInto 要是看得到的卡號，例如 C-230'); });
      if (into.type === NOTE) throw invalid('mergedInto 要是整理後的一般卡片，不能是另一張人類紀錄');
      if (into.project !== c.project) throw invalid('mergedInto 的卡要在同一個專案');
      if (c.status === '已完成') throw new ApiError(409, 'ALREADY_DONE', '這張人類紀錄已經是已完成。');
      const at = nowIso(), ch = statusChange(c, '已完成', me, at);
      invalidatePeople();
      await save(c, ch.sets, [...ch.logs, `已整理到 ${cardNo(into.seq)}`], me, at);
      return view((await attachMerged([await load(params.id)]))[0], await peopleMap(ctx));
    }
    // 認領：AI 可把「未指派、待整理或待處理、非決策」的卡片的負責人設為自己
    const claiming = me.kind === 'ai' && !c.owner_id && body.ownerId === me.id && c.type !== '決策' && c.type !== NOTE && ['待整理', '待處理'].includes(c.status);
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
      sets.proj_no = null; // C-310：在新專案拿新號；C-319：存檔後用同一條語句取號（先查再寫會在同時移卡時撞號）
    }
    if (body.type !== undefined && checkType(body.type) !== c.type) {
      if (body.type === '決策' || c.type === '決策') throw new ApiError(400, 'TYPE_LOCKED', '決策卡片的類型不能改，工作或阻塞卡片也不能改成決策。請另外建立一張。');
      if (body.type === NOTE && me.kind !== 'human') throw new ApiError(403, 'HUMAN_ONLY', '只有人類能把卡片改成人類紀錄。');
      sets.type = body.type; logs.push(`類型改為 ${body.type}`);
      // 人類紀錄 → 工作／阻塞：紀錄一起公開（預設）或刪掉
      if (c.type === NOTE && body.publishNotes === false) { sets.__dropNotes = true; logs.push('改類型時刪掉卡上的紀錄'); }
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
    if (sets.owner_id !== undefined || sets.project !== undefined) sameProject(people, sets.owner_id !== undefined ? sets.owner_id : c.owner_id, sets.project || c.project, '負責人');
    // C-218：人類紀錄的負責人、等誰只能是人類（AI 負責的卡要先換人類才能改成人類紀錄）
    if ((sets.type || c.type) === NOTE) humansOnly(people, [sets.owner_id !== undefined ? sets.owner_id : c.owner_id, sets.wait_for_id !== undefined ? sets.wait_for_id : c.wait_for_id], sets.type === NOTE);
    const dropNotes = sets.__dropNotes; delete sets.__dropNotes;
    if (c.type !== '決策' && (sets.wait_for_id !== undefined || sets.project !== undefined)) sameProject(people, sets.wait_for_id !== undefined ? sets.wait_for_id : c.wait_for_id, sets.project || c.project, '等誰');
    if (Object.keys(sets).length) {
      invalidatePeople(); // 團隊狀態快取一起失效
      await save(c, sets, logs, me, nowIso());
      if (sets.project !== undefined) await assignProjNo(c.uid);
      if (dropNotes) await db.run('DELETE FROM card_log WHERE card_seq = ? AND via = ?', c.seq, NOTE_LOG);
      const parts = [], to = [];
      if (sets.owner_id) { parts.push(claiming ? `${people.get(sets.owner_id)?.name} 認領` : `負責人改為 ${people.get(sets.owner_id)?.name}`); to.push(sets.owner_id); }
      if (sets.wait_for_id) {
        const after = await load(params.id);
        parts.push(c.type === '決策' ? `請 ${people.get(sets.wait_for_id)?.name} 決定` : `等 ${people.get(sets.wait_for_id)?.name}${after.blocker ? '：' + after.blocker : ''}`);
        to.push(sets.wait_for_id);
      }
      if (parts.length && !claiming && (sets.type || c.type) !== NOTE) await notifyCard(ctx, me, c, to, parts.join('；'), 'edit'); // 人類紀錄不發群組訊息
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

  // 暫緩／恢復（C-139）：不新增狀態，沿用「受阻」＋阻塞原因以「暫緩（」開頭。暫緩的決策卡離開待處理清單，恢復後回到「待確認」
  const DEFER_PREFIX = '暫緩（';
  const isDeferred = c => c.type === '決策' && c.status === '受阻' && !c.decision_result && String(c.blocker).startsWith(DEFER_PREFIX);
  function requireDeferParty(me, c) {
    if (c.type !== '決策') throw invalid('只有決策卡片能暫緩或恢復');
    if (me.id !== c.decider_id && me.id !== c.proposer_id && me.id !== c.created_by) throw new ApiError(403, 'NOT_PARTY', '只有這張決策卡的決策者或提案人能暫緩或恢復。');
  }
  route('POST', '/api/cards/:id/defer', async ({ ctx, me, req, params }) => {
    const body = await readJson(req);
    const c = await load(params.id);
    requireDeferParty(me, c);
    if (c.decision_result) throw new ApiError(409, 'DECIDED', '這張決策卡片已經決定了，不能暫緩。');
    if (c.status !== '待確認') throw new ApiError(409, 'NOT_PENDING', '決策卡片要在「待確認」才能暫緩。');
    if (body.version !== undefined && Number(body.version) !== c.version) throw new ApiError(409, 'CONFLICT', '這張卡片剛被別人修改過，請重新讀取後再試。');
    const people = await peopleMap(ctx), at = nowIso();
    const reason = String(body.reason ?? '').trim();
    const blocker = `${DEFER_PREFIX}${people.get(me.id)?.name || me.name}）${reason ? '：' + reason : ''}`;
    if (blocker.length > CARD_LIMITS.blocker) throw invalid(`暫緩原因太長（整句上限 ${CARD_LIMITS.blocker} 字）`);
    await save(c, { status: '受阻', blocker, wait_for_id: c.decider_id }, ['狀態 待確認 → 受阻', blocker], me, at);
    invalidatePeople();
    await notifyCard(ctx, me, c, [c.proposer_id || c.created_by, c.decider_id], blocker, 'defer');
    return view(await load(params.id), people);
  });
  route('POST', '/api/cards/:id/resume', async ({ ctx, me, params }) => {
    const c = await load(params.id);
    requireDeferParty(me, c);
    if (!isDeferred(c)) throw new ApiError(409, 'NOT_DEFERRED', '這張決策卡片目前不是暫緩狀態。');
    const people = await peopleMap(ctx), at = nowIso();
    await save(c, { status: '待確認', blocker: '', wait_for_id: c.decider_id }, ['狀態 受阻 → 待確認', '恢復（結束暫緩）'], me, at);
    invalidatePeople();
    await notifyCard(ctx, me, c, [c.proposer_id || c.created_by, c.decider_id], '已恢復，回到待確認', 'resume');
    return view(await load(params.id), people);
  });

  // C-242：人類驗收不通過 →「退回」：卡回到交過來的那個 AI、狀態回進行中；原因發一則回覆到交接訊息
  route('POST', '/api/cards/:id/reject', async ({ ctx, me, req, params }) => {
    if (me.kind !== 'human') throw new ApiError(403, 'FORBIDDEN', '只有人類能退回驗收。');
    const body = await readJson(req);
    const c = await load(params.id, me);
    if (c.type === NOTE || c.type === '決策' || c.status !== '待確認') throw new ApiError(400, 'NOT_VERIFYING', '只有「等驗收」（待確認、不是決策卡）的卡片可以退回。');
    if (c.owner_id !== me.id && c.wait_for_id !== me.id) throw new ApiError(403, 'NOT_CARD_OWNER', '只有負責驗收的人能退回。');
    if (body.version !== undefined && Number(body.version) !== c.version) throw new ApiError(409, 'CONFLICT', '這張卡片剛被別人修改過，請重新讀取後再試。');
    const reason = text({ reason: body.reason }, 'reason', { required: true });
    if (!reason) throw invalid('退回原因（reason）為必填');
    const people = await peopleMap(ctx);
    // 交過來的 AI：這張卡最近一則由 AI 發的 [交接] 訊息的作者
    const hos = await db.all("SELECT m.id, m.author_id FROM card_msgs cm JOIN messages m ON m.id = cm.message_id WHERE cm.card_seq = ? AND m.text LIKE '[交接]%' ORDER BY m.seq DESC LIMIT 20", c.seq);
    const ho = hos.find(m => people.get(m.author_id)?.kind === 'ai' && people.get(m.author_id)?.status === 'active');
    if (!ho) throw new ApiError(400, 'NO_HANDOVER_SOURCE', '找不到把這張卡交過來的 AI，請改用「交接」交給要處理的人。');
    const ai = people.get(ho.author_id), at = nowIso();
    await save(c, { owner_id: ai.id, status: '進行中', wait_for_id: null }, [`退回 ${me.name} → ${ai.name}：${reason}（狀態 待確認 → 進行中）`], me, at);
    invalidatePeople();
    let messageId = null, notifyError = null;
    try {
      const r = await createMessage(ctx, me, { text: `[退回] ${c.project ? `【${projectName(c.project)}】` : ''}${cardNo(c.seq)} ${plainTitle(c.title)} → @${ai.name}：${reason}`, requestId: `reject_${c.uid}_${c.version}`, replyToMessageId: ho.id, recipientIds: [ai.id], project: c.project });
      messageId = r.message.messageId;
      await db.run('INSERT OR IGNORE INTO card_msgs (card_seq, message_id) VALUES (?,?)', c.seq, messageId);
    } catch (err) { notifyError = err.message; }
    return { ...view(await load(params.id), people), rejectMessageId: messageId, ...(notifyError ? { notifyError } : {}) };
  });
  route('POST', '/api/cards/:id/verify', async ({ ctx, me, params }) => {
    const c = await load(params.id, me); // C-333 B1：驗證者必須看得到這張卡（屬於卡片專案）
    if (c.type === NOTE && me.kind !== 'human') throw aiNoteForbidden();
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
    const tag = cur.project ? `【${projectName(cur.project)}】` : '';
    const plain = plainTitle(cur.title);
    const msg = `[通知] ${tag}${cardNo(c.seq)} ${plain}：${summary}`.slice(0, 1900);
    try {
      const r = await createMessage(ctx, me, { text: msg, requestId: `cardev_${c.uid}_${key}_${cur.version}`.slice(0, 128), recipientIds: ids, project: cur.project });
      await db.run('INSERT OR IGNORE INTO card_msgs (card_seq, message_id) VALUES (?,?)', c.seq, r.message.messageId);
    } catch (err) { console.error('card notify failed:', err.message); }
  }

  // 交接：負責人把自己的卡交給指定成員。接手者回到「待處理」；伺服器代交接者在群組發一則 [交接] 並 @ 對方（既有 @ 通知）
  route('POST', '/api/cards/:id/handover', async ({ ctx, me, req, params }) => {
    const body = await readJson(req);
    const c = await load(params.id, me);
    if (c.type === NOTE && me.kind !== 'human') throw aiNoteForbidden();
    if (me.kind === 'ai' && c.owner_id !== me.id) throw new ApiError(403, 'NOT_CARD_OWNER', 'AI 只能交接自己負責的卡片。');
    if (c.type === '決策') throw new ApiError(400, 'NO_HANDOVER_DECISION', '決策卡片不能交接，它本來就在等決策者決定。');
    if (c.status === '已完成' || c.status === '已封存') throw new ApiError(400, 'CARD_CLOSED', '已完成或已封存的卡片不能交接。');
    if (body.version !== undefined && Number(body.version) !== c.version) throw new ApiError(409, 'CONFLICT', '這張卡片剛被別人修改過，請重新讀取後再試。');
    const people = await peopleMap(ctx, [String(body.toId ?? '')]); // C-248：剛加入的成員可能還不在這份程式的快取
    const to = await validPerson(people, body.toId, '接手者');
    if (!to) throw invalid('toId 為必填：要交給誰');
    if (to === c.owner_id || to === me.id) throw new ApiError(400, 'SAME_OWNER', '不能交給目前的負責人或自己。');
    if (!projectsOf(people.get(to)).includes(c.project)) throw new ApiError(400, 'PROJECT_MISMATCH', `接手者不屬於這張卡的專案（${c.project}）；只能交給同專案成員，或兩邊都屬於的成員。`);
    if (c.type === NOTE) humansOnly(people, [to]);
    const note = text({ handover: body.note }, 'handover', { required: true });
    if (note === undefined) throw invalid('交接說明（note）為必填');
    const at = nowIso(), fromName = people.get(c.owner_id || me.id)?.name || me.name, toName = people.get(to).name;
    // C-241：交接只換負責人、留紀錄，狀態維持（進行中還是進行中）；接手者接單時自己改
    // C-242：唯一例外——AI 交給人類＝請人類驗收：狀態改「待確認」、等誰＝那位人類（人類紀錄、決策卡不套用）
    const fromP = people.get(c.owner_id || me.id), toP = people.get(to);
    const verify = c.type !== NOTE && c.type !== '決策' && fromP?.kind === 'ai' && toP?.kind === 'human';
    const sets = { owner_id: to };
    if (c.wait_for_id === to) sets.wait_for_id = null;
    if (verify) Object.assign(sets, { status: '待確認', wait_for_id: to });
    // 顧問回饋：原本「待確認」的卡交出去（不是請人類驗收）→ 改進行中、清掉等誰，免得接手的人掛著上一棒的等待對象；「受阻」照舊維持
    const reopen = !verify && c.status === '待確認';
    if (reopen) Object.assign(sets, { status: '進行中', wait_for_id: null });
    // C-317：還在「待整理」的卡交出去 → 「待處理」（等接手的人 [接單] 後自動變進行中）
    const queued = !verify && !reopen && c.status === '待整理' && c.type !== NOTE;
    if (queued) sets.status = '待處理';
    const stateNote = verify ? `狀態 ${c.status} → 待確認，等 ${toName} 驗收` : reopen ? '狀態 待確認 → 進行中' : queued ? `狀態 待整理 → 待處理，等 ${toName} 接手` : `狀態維持：${c.status}`;
    const logs = [`交接 ${fromName} → ${toName}：${note}（${stateNote}）`];
    await save(c, sets, logs, me, at);
    invalidatePeople();
    // 專案標記取自卡片的專案欄位（C-146 A）
    const msgText = `[交接] ${c.project ? `【${projectName(c.project)}】` : ''}${cardNo(c.seq)} ${plainTitle(c.title)} → @${toName}：${note}（${verify ? '等你驗收' : stateNote}）`;
    let messageId = null, notifyError = null;
    if (c.type === NOTE) return { ...view(await load(params.id), people), handoverMessageId: null }; // C-218：人類紀錄交接不發群組訊息
    try {
      const r = await createMessage(ctx, me, { text: msgText, requestId: `handover_${c.uid}_${c.version}`, recipientIds: [to], project: c.project });
      messageId = r.message.messageId;
      await db.run('INSERT OR IGNORE INTO card_msgs (card_seq, message_id) VALUES (?,?)', c.seq, messageId);
    } catch (err) { notifyError = err.message; }
    return { ...view(await load(params.id), people), handoverMessageId: messageId, ...(notifyError ? { notifyError } : {}) };
  });

  function humansOnly(people, ids, changingType = false) {
    for (const id of ids) {
      if (id && people.get(id)?.kind !== 'human') throw new ApiError(400, 'HUMAN_NOTE_HUMANS', changingType ? `負責人或等誰是 AI（${people.get(id)?.name}）：請先改成人類，才能改成人類紀錄。` : `人類紀錄的負責人、等誰只能是人類（${people.get(id)?.name || id} 是 AI）。`);
    }
  }
  route('POST', '/api/cards/:id/notes', async ({ ctx, me, req, params }) => {
    if (me.kind !== 'human') throw aiNoteForbidden();
    const c = await load(params.id, me);
    if (c.type !== NOTE) throw invalid('只有人類紀錄卡用「紀錄」；其他卡片請用想法與回覆（會發到群組）。');
    const t = String((await readJson(req)).text ?? '').trim();
    if (!t) throw invalid('紀錄不能空白');
    if (t.length > CARD_LIMITS.record) throw invalid(`紀錄上限 ${CARD_LIMITS.record} 字`);
    const at = nowIso();
    await db.run('INSERT INTO card_log (card_seq, at, by_id, via, text) VALUES (?,?,?,?,?)', c.seq, at, me.id, NOTE_LOG, t);
    await db.run('UPDATE cards SET updated_at = ?, version = version + 1 WHERE seq = ?', at, c.seq);
    const people = await peopleMap(ctx);
    return { cardId: cardNo(c.seq), notes: (await notesOf(c.seq)).map(l => noteView(people, l)) };
  });
  route('POST', '/api/cards/:id/messages', async ({ ctx, me, req, params }) => {
    const c = await load(params.id, me); // C-333 B1
    if (c.type === NOTE && me.kind !== 'human') throw aiNoteForbidden();
    requireEdit(me, c);
    const mid = String((await readJson(req)).messageId || '');
    const m = await db.get('SELECT id, project, created_at FROM messages WHERE id = ?', mid);
    if (!m || !(await canSeeMessage(me, m))) throw invalid('找不到這則訊息'); // 看不到的訊息不能掛
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
  // C-333 B4：建議所屬專案＝卡片專案，沒有卡（新建建議）用建議內容的專案
  const SUG_PROJECT_SQL = "COALESCE((SELECT c.project FROM cards c WHERE c.seq = s.card_seq), json_extract(s.payload, '$.project'))";
  async function loadSug(id, me = null) {
    const r = await db.get(`SELECT s.*, ${SUG_PROJECT_SQL} AS sug_project FROM suggestions s WHERE s.id = ?`, parseSug(id));
    if (!r || (me && isolatedFrom(me) && !projectsOf(me).includes(r.sug_project))) throw new ApiError(404, 'NOT_FOUND', '找不到這則建議');
    return r;
  }
  // 針對某張卡的建議：卡片在建議之後有任何存檔就算過期，只能略過（C-144）
  const isExpired = (r, card) => r.state === 'pending' && !!card && card.updated_at > r.created_at;
  // cardMap：清單先一次查好卡片（C-336 R7，避免每則各查一次）
  async function sugView(r, people, cardMap = null) {
    const p = JSON.parse(r.payload || '{}');
    const card = !r.card_seq ? null : cardMap ? cardMap.get(r.card_seq) ?? null : await db.get('SELECT seq, title, status, updated_at, project FROM cards WHERE seq = ?', r.card_seq);
    return {
      project: card?.project ?? p.project ?? null,
      suggestionId: sugNo(r.id), kind: r.kind, state: r.state, expired: isExpired(r, card), from: ref(people, r.from_id), why: r.why, basisMessageId: r.basis_message_id, createdAt: r.created_at,
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
      if (type === NOTE) throw new ApiError(403, 'HUMAN_ONLY', '人類紀錄只有人類能建立。');
      const owner = await validPerson(people, body.ownerId, '負責人');
      if (!owner || owner === me.id) throw new ApiError(400, 'USE_POST', '替自己建卡或不指派負責人，請直接用 POST /api/cards；建議只用在「把工作指派給別人」。');
      const mineP = projectsOf(me);
      const sp = body.project ?? (mineP.length === 1 ? mineP[0] : undefined);
      if (!PROJECTS.includes(sp)) throw invalid(`project 為必填：${PROJECTS.join('、')}`);
      payload = { type, project: sp, title, reason: text(body, 'reason') ?? '', ownerId: owner, next: text(body, 'next') ?? '', blocker: text(body, 'blocker') ?? '',
        waitForId: await validPerson(people, body.waitForId, '等誰'), criteria: text(body, 'criteria') ?? '' };
    } else if (kind === 'status') {
      const c = await load(String(body.cardId ?? ''), me); // C-333：看不到的卡不能提建議
      if (c.type === NOTE) throw aiNoteForbidden();
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
    const mine = isolatedFrom(me) ? projectsOf(me) : null; // C-333 B4：只屬部分專案的人類只看自己專案的建議
    const rows = me.kind !== 'human'
      ? await db.all('SELECT * FROM suggestions WHERE state = ? AND from_id = ? ORDER BY id DESC LIMIT ?', st, me.id, limit)
      : !mine
        ? await db.all('SELECT * FROM suggestions WHERE state = ? ORDER BY id DESC LIMIT ?', st, limit)
        : mine.length
          ? await db.all(`SELECT s.* FROM suggestions s WHERE s.state = ? AND ${SUG_PROJECT_SQL} IN (${mine.map(() => '?').join(',')}) ORDER BY s.id DESC LIMIT ?`, st, ...mine, limit)
          : [];
    const people = await peopleMap(ctx);
    const seqs = [...new Set(rows.map(r => r.card_seq).filter(Boolean))];
    const cardMap = new Map(seqs.length ? (await db.all('SELECT seq, title, status, updated_at, project FROM cards WHERE seq IN (SELECT value FROM json_each(?))', JSON.stringify(seqs))).map(c => [c.seq, c]) : []);
    return { items: await Promise.all(rows.map(r => sugView(r, people, cardMap))) };
  });

  const humanOnly = me => { if (me.kind !== 'human') throw new ApiError(403, 'FORBIDDEN', '只有人類成員能採用或略過建議。'); };
  async function claim(r, me, at, resultSeq = null, state = 'applied') {
    const res = await db.run("UPDATE suggestions SET state = ?, resolved_by = ?, resolved_at = ?, result_card_seq = ? WHERE id = ? AND state = 'pending'", state, me.id, at, resultSeq, r.id);
    if (!res.changes) throw new ApiError(409, 'NOT_PENDING', '這則建議已經被處理過了。');
  }

  route('POST', '/api/suggestions/:id/apply', async ({ ctx, me, req, params }) => {
    humanOnly(me);
    const body = await readJson(req);
    return applySuggestion(ctx, me, await loadSug(params.id, me), body, null);
  });

  // collect：批次時傳入陣列，通知先收集起來，最後每位收件人合併成一則；單筆採用維持原本逐筆通知
  async function applySuggestion(ctx, me, r, body, collect) {
    if (r.state !== 'pending') throw new ApiError(409, 'NOT_PENDING', '這則建議已經被處理過了。');
    const people = await peopleMap(ctx), p = JSON.parse(r.payload || '{}'), at = nowIso();
    const aiName = people.get(r.from_id)?.name || 'AI';
    const note = (c, ids, summary, key) => (collect ? collect.push({ c, ids, summary }) : notifyCard(ctx, me, c, ids, summary, key));
    if (r.kind === 'status') {
      const c = await db.get('SELECT * FROM cards WHERE seq = ?', r.card_seq);
      if (!c) throw notFound();
      if (c.updated_at > r.created_at) throw new ApiError(409, 'EXPIRED', '這張卡在建議之後已有變動，建議已過期，只能略過。');
      if (c.status === p.to) { await claim(r, me, at, c.seq); return view(c, people); }
      const ch = statusChange(c, p.to, me, at);
      const sets = { ...ch.sets }, logs = ch.logs.map((t, i) => (i === 0 ? `採用 ${aiName} 的建議：${t}` : t));
      if (p.waitForId && p.waitForId !== c.wait_for_id) { sets.wait_for_id = p.waitForId; logs.push(`等誰改為 ${people.get(p.waitForId)?.name}`); }
      await save(c, sets, logs, me, at);
      await claim(r, me, at, c.seq);
      invalidatePeople();
      await note(c, [r.from_id, p.waitForId], `採用了 ${aiName} 的建議：狀態改為 ${p.to}`, `sug${r.id}`);
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
      f.criteria ?? '', r.from_id, `sug_${r.id}`, at, at, f.project || PROJECTS[0]); // C-300：不寫死「平台」
    await assignProjNo(uid); // C-310
    const c = await db.get('SELECT * FROM cards WHERE uid = ?', uid);
    await db.batch([
      ...logStmt(c.seq, me, [`採用 ${aiName} 的建議建立卡片（類型：${f.type}）`], at),
      ...(r.basis_message_id ? [['INSERT OR IGNORE INTO card_msgs (card_seq, message_id) VALUES (?,?)', [c.seq, r.basis_message_id]]] : []),
    ]);
    await claim(r, me, at, c.seq);
    invalidatePeople();
    await note(c, [r.from_id, f.ownerId, f.waitForId], `採用了 ${aiName} 的建議建立這張卡${f.ownerId ? '，負責人 ' + people.get(f.ownerId)?.name : ''}`, `sug${r.id}`);
    return { __status: 201, ...view(c, people) };
  }

  // 批次採用／略過（C-107）：只接受明確列出的建議（上限 50），不做「全部採用」；僅人類；逐筆沿用單筆邏輯，部分失敗不中斷
  route('POST', '/api/suggestions/batch', async ({ ctx, me, req }) => {
    humanOnly(me);
    const body = await readJson(req);
    if (!['apply', 'skip'].includes(body.action)) throw invalid("action 需為 'apply' 或 'skip'");
    const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map(String) : [])];
    if (!ids.length) throw invalid('ids 為必填：要處理的建議編號（例如 ["S-1","S-2"]）');
    if (ids.length > 50) throw invalid('一次最多 50 則');
    const results = [], collect = [];
    for (const id of ids) {
      try {
        const r = await loadSug(id, me);
        if (body.action === 'skip') await claim(r, me, nowIso(), null, 'skipped');
        else await applySuggestion(ctx, me, r, {}, collect);
        results.push({ id, ok: true });
      } catch (e) { results.push({ id, ok: false, error: e.code || 'ERROR', message: e.message }); }
    }
    // 通知合併：每位收件人（提案 AI、新負責人、等待對象）只發一則，列出與他有關的卡
    const byTo = new Map();
    for (const it of collect) for (const to of new Set(it.ids)) if (to && to !== me.id) { if (!byTo.has(to)) byTo.set(to, new Map()); byTo.get(to).set(cardNo(it.c.seq), it.c.project); }
    const sample = ids.slice(0, 3).join('');
    for (const [to, cards] of byTo) {
      const nos = [...cards.keys()], projects = new Set(cards.values());
      try {
        await createMessage(ctx, me, { text: `[通知] 批次採用了 AI 建議，與你有關的 ${nos.length} 張卡：${nos.join('、')}`.slice(0, 1900), requestId: `sugbatch_${to}_${sample}_${nos.length}_${Date.now()}`.slice(0, 128), recipientIds: [to], project: projects.size === 1 ? [...projects][0] : undefined });
      } catch (err) { console.error('batch notify failed:', err.message); }
    }
    return { action: body.action, results, done: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length };
  });

  route('POST', '/api/suggestions/:id/skip', async ({ ctx, me, params }) => {
    humanOnly(me);
    const r = await loadSug(params.id, me);
    await claim(r, me, nowIso(), null, 'skipped');
    return sugView(await loadSug(params.id), await peopleMap(ctx));
  });
  return { listCards };
}
