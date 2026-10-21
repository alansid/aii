// C-365 專案文件區：每個專案一個長期保存的文件區（不自動過期），有資料夾（最多兩層）。
// 本體存 R2（docStorage；本機用資料夾、測試用記憶體），目錄與中繼資料存 D1 的 docs／doc_folders。
// 權限：只有該專案成員看得到（別專案的人一律 404，API 也一樣）；唯讀成員只能看、下載。
// 上傳沿用訊息附件的規則：類型白名單、檔頭比對、Office 巨集檢查、必須聲明不含程式碼與客戶個資；單檔上限 20 MB。
// 每次上傳、下載、刪除、改名、搬移都記在 file_audit；放檔、改名、搬移、刪除、建資料夾也寫進專案異動紀錄。
import { inspectFile, cleanFileName, FileRejected, formatBytes } from './files.js';

export const DOC_MAX_FILE_BYTES = 20 * 1024 * 1024;          // 單檔 20 MB（C-366 昱志決定）
export const DOC_MAX_TOTAL_BYTES = 9 * 1024 * 1024 * 1024;   // 全部專案合計 9 GB（R2 免費 10 GB，留一點空間）
export const FOLDER_DEPTH = 2;                               // 資料夾最多兩層

export function registerDocs({ route, db, ApiError, invalid, readJson, readBody, randId, nowIso, sha256, peopleMap, identity, projectsOf, PROJECTS, assertWritable, loadReadOnly, roIn, audit, docStorage, maxFileBytes = DOC_MAX_FILE_BYTES, maxTotalBytes = DOC_MAX_TOTAL_BYTES }) {
  const notFound = () => new ApiError(404, 'NOT_FOUND', '找不到這個專案的文件區');
  // 不是這個專案的成員：當作不存在（不透露有這個專案或檔案）
  function memberOf(me, pj) {
    if (!PROJECTS.includes(pj) || !projectsOf(me).includes(pj)) throw notFound();
  }
  async function writable(me, pj) {
    memberOf(me, pj);
    await assertWritable(me, pj);
  }
  const requireStore = () => { if (!docStorage) throw new ApiError(503, 'DOCS_DISABLED', '此環境還沒開通專案文件區的儲存空間（R2）'); };
  const event = (pj, me, text) => db.run('INSERT INTO project_events (project_id, at, actor_id, text) VALUES (?,?,?,?)', pj, nowIso(), me.id, text);

  async function folderOf(pj, id) {
    const f = await db.get('SELECT * FROM doc_folders WHERE id = ? AND project = ? AND deleted_at IS NULL', id, pj);
    if (!f) throw new ApiError(404, 'FOLDER_NOT_FOUND', '找不到這個資料夾（可能已刪除，或不在這個專案）');
    return f;
  }
  async function docOf(pj, id) {
    const d = await db.get('SELECT * FROM docs WHERE id = ? AND project = ? AND deleted_at IS NULL', id, pj);
    if (!d) throw new ApiError(404, 'NOT_FOUND', '找不到這個文件（可能已刪除，或不在這個專案）');
    return d;
  }
  // folderId：空字串／null＝最上層
  const readFolderId = v => (v === undefined ? undefined : v === null || v === '' ? null : String(v));
  // 資料夾路徑（顯示在紀錄裡）：「規格/v1」；最上層是「最上層」
  async function pathOf(pj, folderId) {
    if (!folderId) return '最上層';
    const f = await db.get('SELECT * FROM doc_folders WHERE id = ? AND project = ?', folderId, pj);
    if (!f) return '最上層';
    const p = f.parent_id ? await db.get('SELECT name FROM doc_folders WHERE id = ?', f.parent_id) : null;
    return p ? `${p.name}/${f.name}` : f.name;
  }
  function readFolderName(raw) {
    const name = String(raw ?? '').trim();
    if (!name || name.length > 50 || /[\\/\n\r\u0000-\u001f]/.test(name)) throw invalid('資料夾名稱需為 1～50 字，不可含 / \\ 或換行');
    return name;
  }
  async function siblingTaken(pj, parentId, name, exceptId = '') {
    return !!(await db.get(`SELECT id FROM doc_folders WHERE project = ? AND deleted_at IS NULL AND name = ? AND id != ? AND ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'}`, pj, name, exceptId, ...(parentId ? [parentId] : [])));
  }
  const docView = (d, people) => ({
    docId: d.id, name: d.name, ext: d.ext, size: d.size, sha256: d.sha256, folderId: d.folder_id || null,
    uploader: people.get(d.uploader_id) ? identity(people.get(d.uploader_id), people) : { participantId: d.uploader_id },
    createdAt: d.created_at, updatedAt: d.updated_at,
    downloadUrl: `/api/projects/${encodeURIComponent(d.project)}/docs/${d.id}`,
  });
  const folderView = f => ({ folderId: f.id, name: f.name, parentId: f.parent_id || null, createdAt: f.created_at, createdBy: f.created_by });

  // 清單：整個專案的資料夾與文件一次給（前端自己組樹）
  route('GET', '/api/projects/:id/docs', async ({ ctx, me, params }) => {
    const pj = params.id;
    memberOf(me, pj);
    await loadReadOnly();
    const people = await peopleMap(ctx);
    const folders = await db.all('SELECT * FROM doc_folders WHERE project = ? AND deleted_at IS NULL ORDER BY name', pj);
    const docs = await db.all('SELECT * FROM docs WHERE project = ? AND deleted_at IS NULL ORDER BY name', pj);
    const used = (await db.get('SELECT COALESCE(SUM(size), 0) AS s FROM docs WHERE deleted_at IS NULL')).s;
    return {
      project: pj, folders: folders.map(folderView), items: docs.map(d => docView(d, people)),
      projectBytes: docs.reduce((n, d) => n + d.size, 0), usedBytes: used, limitBytes: maxTotalBytes, maxFileBytes,
      maxFolderDepth: FOLDER_DEPTH, enabled: !!docStorage, canWrite: !roIn(me, pj),
    };
  });

  // 上傳一個檔（原始位元組）：?name=檔名&folderId=&declared=true。多選上傳＝前端一個一個送，各自回成功或失敗原因
  route('POST', '/api/projects/:id/docs', async ({ ctx, me, req, url, params }) => {
    const pj = params.id;
    await writable(me, pj);
    requireStore();
    const q = url.searchParams;
    const name = cleanFileName(q.get('name'));
    const declared = ['true', '1', 'yes'].includes(String(q.get('declared')).toLowerCase());
    let bytes = new Uint8Array(0);
    const reject = async (status, code, message, size = bytes.length) => {
      await audit('reject', me, null, { name: name || null, size, declared: declared ? 1 : 0, detail: `${code}（專案文件 ${pj}）` });
      return new ApiError(status, code, message);
    };
    try { bytes = await readBody(req, maxFileBytes, `檔案超過 ${maxFileBytes / 1048576} MB 上限`, 'FILE_TOO_LARGE'); }
    catch (e) { if (e instanceof ApiError && e.status === 413) throw await reject(413, e.code, e.message, Number(req.headers.get('content-length')) || maxFileBytes + 1); throw e; }
    if (!name) throw await reject(400, 'INVALID_REQUEST', '請用 ?name= 提供檔名（含副檔名）');
    if (!declared) throw await reject(400, 'DECLARATION_REQUIRED', '上傳前必須聲明檔案不含程式碼與客戶個資（declared=true）');
    let info;
    try { info = inspectFile(name, bytes, maxFileBytes); }
    catch (e) { if (e instanceof FileRejected) throw await reject(e.status, e.code, e.message); throw e; }
    const folderId = readFolderId(q.get('folderId')) || null;
    if (folderId) await folderOf(pj, folderId);
    const used = (await db.get('SELECT COALESCE(SUM(size), 0) AS s FROM docs WHERE deleted_at IS NULL')).s;
    if (used + bytes.length > maxTotalBytes) throw await reject(507, 'STORAGE_FULL', `文件區總容量已達 ${formatBytes(maxTotalBytes)} 上限（已用 ${formatBytes(used)}），請先刪掉不用的文件`);
    const id = randId('doc'), at = nowIso();
    const hash = await sha256(bytes);
    await docStorage.put(`docs/${id}`, bytes, { mime: info.mime, name });
    await db.run('INSERT INTO docs (id, project, folder_id, name, ext, mime, size, sha256, uploader_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, pj, folderId, name, info.ext, info.mime, bytes.length, hash, me.id, at, at);
    const d = await db.get('SELECT * FROM docs WHERE id = ?', id);
    await audit('upload', me, { ...d, declared: 1 }, {});
    await event(pj, me, `${me.name} 上傳文件「${name}」到 ${await pathOf(pj, folderId)}（${formatBytes(bytes.length)}）`);
    return { __status: 201, doc: docView(d, await peopleMap(ctx)) };
  });

  route('GET', '/api/projects/:id/docs/:docId', async ({ me, params }) => {
    memberOf(me, params.id);
    requireStore();
    const d = await docOf(params.id, params.docId);
    const bytes = await docStorage.get(`docs/${d.id}`);
    if (!bytes) throw new ApiError(404, 'NOT_FOUND', '文件內容不存在');
    await audit('download', me, { ...d, declared: 1 });
    return new Response(bytes, {
      headers: {
        'Content-Type': d.mime,
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="file.${d.ext}"; filename*=UTF-8''${encodeURIComponent(d.name)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  });

  // 改名／搬移：{ name?, folderId? }（folderId: null＝搬到最上層）。改名不能換副檔名（類型檢查是照副檔名做的）
  route('PATCH', '/api/projects/:id/docs/:docId', async ({ ctx, me, req, params }) => {
    const pj = params.id;
    await writable(me, pj);
    const d = await docOf(pj, params.docId);
    const body = await readJson(req);
    const sets = [], args = [], notes = [];
    if (body.name !== undefined) {
      let name = cleanFileName(body.name);
      if (!name) throw invalid('name 不可空白');
      const ext = (name.match(/\.([A-Za-z0-9]+)$/)?.[1] || '').toLowerCase();
      if (ext !== d.ext) name = `${name}.${d.ext}`; // 沒寫或寫錯副檔名：補回原本的，不能藉改名換類型
      if (name !== d.name) { sets.push('name = ?'); args.push(name); notes.push(`改名「${d.name}」→「${name}」`); await audit('rename', me, { ...d, declared: 1 }, { detail: name }); }
    }
    const to = readFolderId(body.folderId);
    if (to !== undefined && (to || null) !== (d.folder_id || null)) {
      if (to) await folderOf(pj, to);
      sets.push('folder_id = ?'); args.push(to);
      notes.push(`搬移「${d.name}」：${await pathOf(pj, d.folder_id)} → ${await pathOf(pj, to)}`);
      await audit('move', me, { ...d, declared: 1 }, { detail: await pathOf(pj, to) });
    }
    if (sets.length) {
      await db.run(`UPDATE docs SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...args, nowIso(), d.id);
      await event(pj, me, `${me.name} ${notes.join('；')}`);
    }
    return { doc: docView(await db.get('SELECT * FROM docs WHERE id = ?', d.id), await peopleMap(ctx)) };
  });

  route('DELETE', '/api/projects/:id/docs/:docId', async ({ me, params }) => {
    const pj = params.id;
    await writable(me, pj);
    requireStore();
    const d = await docOf(pj, params.docId);
    await docStorage.delete(`docs/${d.id}`);
    await db.run('UPDATE docs SET deleted_at = ?, deleted_by = ? WHERE id = ?', nowIso(), me.id, d.id);
    await audit('delete', me, { ...d, declared: 1 });
    await event(pj, me, `${me.name} 刪除文件「${d.name}」（${await pathOf(pj, d.folder_id)}）`);
    return { ok: true, docId: d.id };
  });

  // 資料夾：{ name, parentId? }；parentId 只能是第一層資料夾（最多兩層）
  route('POST', '/api/projects/:id/doc-folders', async ({ me, req, params }) => {
    const pj = params.id;
    await writable(me, pj);
    const body = await readJson(req);
    const name = readFolderName(body.name);
    const parentId = readFolderId(body.parentId) || null;
    if (parentId) {
      const p = await folderOf(pj, parentId);
      if (p.parent_id) throw new ApiError(400, 'FOLDER_TOO_DEEP', `資料夾最多 ${FOLDER_DEPTH} 層，「${p.name}」底下不能再建資料夾`);
    }
    if (await siblingTaken(pj, parentId, name)) throw new ApiError(409, 'NAME_TAKEN', `這裡已經有「${name}」資料夾`);
    const id = randId('dfo'), at = nowIso();
    await db.run('INSERT INTO doc_folders (id, project, parent_id, name, created_by, created_at) VALUES (?,?,?,?,?,?)', id, pj, parentId, name, me.id, at);
    await event(pj, me, `${me.name} 在 ${await pathOf(pj, parentId)} 建資料夾「${name}」`);
    return { __status: 201, folder: folderView(await db.get('SELECT * FROM doc_folders WHERE id = ?', id)) };
  });

  // 資料夾改名／搬移：{ name?, parentId? }。有子資料夾的只能放最上層（不然會變三層）
  route('PATCH', '/api/projects/:id/doc-folders/:folderId', async ({ me, req, params }) => {
    const pj = params.id;
    await writable(me, pj);
    const f = await folderOf(pj, params.folderId);
    const body = await readJson(req);
    const name = body.name === undefined ? f.name : readFolderName(body.name);
    const to = readFolderId(body.parentId);
    const parentId = to === undefined ? f.parent_id || null : to;
    if (parentId) {
      if (parentId === f.id) throw new ApiError(400, 'FOLDER_TOO_DEEP', '資料夾不能放進自己');
      const p = await folderOf(pj, parentId);
      if (p.parent_id) throw new ApiError(400, 'FOLDER_TOO_DEEP', `資料夾最多 ${FOLDER_DEPTH} 層，「${p.name}」底下不能再放資料夾`);
      if (await db.get('SELECT id FROM doc_folders WHERE parent_id = ? AND deleted_at IS NULL LIMIT 1', f.id)) throw new ApiError(400, 'FOLDER_TOO_DEEP', `「${f.name}」裡面還有資料夾，只能放在最上層（最多 ${FOLDER_DEPTH} 層）`);
    }
    if (name === f.name && (parentId || null) === (f.parent_id || null)) return { folder: folderView(f) };
    if (await siblingTaken(pj, parentId, name, f.id)) throw new ApiError(409, 'NAME_TAKEN', `這裡已經有「${name}」資料夾`);
    const from = await pathOf(pj, f.id);
    await db.run('UPDATE doc_folders SET name = ?, parent_id = ? WHERE id = ?', name, parentId, f.id);
    await event(pj, me, `${me.name} 資料夾 ${from} → ${await pathOf(pj, f.id)}`);
    return { folder: folderView(await db.get('SELECT * FROM doc_folders WHERE id = ?', f.id)) };
  });

  // 刪資料夾：要先清空（不連帶刪裡面的文件，避免一次誤刪一整批）
  route('DELETE', '/api/projects/:id/doc-folders/:folderId', async ({ me, params }) => {
    const pj = params.id;
    await writable(me, pj);
    const f = await folderOf(pj, params.folderId);
    const docs = (await db.get('SELECT COUNT(*) AS n FROM docs WHERE folder_id = ? AND deleted_at IS NULL', f.id)).n;
    const subs = (await db.get('SELECT COUNT(*) AS n FROM doc_folders WHERE parent_id = ? AND deleted_at IS NULL', f.id)).n;
    if (docs || subs) throw new ApiError(409, 'FOLDER_NOT_EMPTY', `「${f.name}」裡面還有${docs ? ` ${docs} 個文件` : ''}${subs ? ` ${subs} 個資料夾` : ''}，請先搬走或刪除`);
    const from = await pathOf(pj, f.id);
    await db.run('UPDATE doc_folders SET deleted_at = ?, deleted_by = ? WHERE id = ?', nowIso(), me.id, f.id);
    await event(pj, me, `${me.name} 刪除資料夾「${from}」`);
    return { ok: true, folderId: f.id };
  });
}
