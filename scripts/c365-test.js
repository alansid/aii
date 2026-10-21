// C-365 驗收測試：專案文件區（每個專案一個長期保存的文件區，有資料夾、可多選上傳）
// 修正前：檔案只能掛在訊息上、單檔 2 MB、1 小時自動刪除、一次一個，沒有地方放長期共用的文件（/api/projects/:id/docs 404）
// 修正後：專案成員可在文件區建資料夾（兩層內）、放檔、改名、搬移、刪除，留紀錄；別專案的人（含 API）看不到；
//         唯讀成員只能看／下載；單檔 20 MB、類型白名單與巨集檢查照舊；文件不會自動消失；本體存 R2（測試用記憶體假儲存）
// 用法：node scripts/c365-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';
import { dirStorage } from '../src/storage-dir.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-c365-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const store = memStorage();
const docText = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
const app = createApp({ db, storage: dbStorage(db), docStorage: store, docText, config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', fileTtlHours: '0.0001' } });
const BASE = 'http://localhost';
const req = async (token, p, method = 'GET', body, raw) => {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? {} : { 'Content-Type': 'application/json' }) };
  const r = await app(new Request(BASE + p, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) }), BASE);
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : new Uint8Array(await r.arrayBuffer()) };
};
const code = r => r.body?.error?.code;
const enc = s => new TextEncoder().encode(s);
const pdf = enc('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const n = enc(name), c = enc(content);
    const local = new Uint8Array(30 + n.length), v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint32(18, c.length, true); v.setUint32(22, c.length, true); v.setUint16(26, n.length, true);
    local.set(n, 30);
    const cd = new Uint8Array(46 + n.length), w = new DataView(cd.buffer);
    w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint32(20, c.length, true); w.setUint32(24, c.length, true); w.setUint16(28, n.length, true); w.setUint32(42, offset, true);
    cd.set(n, 46);
    parts.push(local, c); central.push(cd);
    offset += local.length + c.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
const docxMacro = zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:document/>'], ['word/vbaProject.bin', 'x']]);
const pj = encodeURIComponent('平台');

try {
  const liu = (await req(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body; // 管理員，兩個專案都在
  const chen = (await req(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  const bank = (await req(null, '/api/join', 'POST', { name: '銀行端', role: 'BA' })).body;
  const ro = (await req(null, '/api/join', 'POST', { name: '唯讀者', role: 'BU' })).body;
  const id = x => x.participant.participantId;
  await req(liu.token, `/api/participants/${id(chen)}/projects`, 'PUT', { projects: ['平台'] });
  await req(liu.token, `/api/participants/${id(bank)}/projects`, 'PUT', { projects: ['銀行系統'] });
  await req(liu.token, `/api/participants/${id(ro)}/projects`, 'PUT', { projects: ['平台'] });
  await req(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: id(ro), readOnlyIn: ['平台'] }] });
  const ai = (await req(chen.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: '程式開發', name: '陳的PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const up = (tok, name, bytes, extra = '') => req(tok, `/api/projects/${pj}/docs?name=${encodeURIComponent(name)}&declared=true${extra}`, 'POST', null, bytes);

  // 修正前：沒有文件區
  let r = await req(chen.token, `/api/projects/${pj}/docs`);
  assert.equal(r.status, 200, '專案文件區 API 要存在：' + JSON.stringify(r.body).slice(0, 200));
  assert.deepEqual([r.body.items, r.body.folders, r.body.enabled, r.body.canWrite, r.body.maxFileBytes, r.body.maxFolderDepth], [[], [], true, true, 20 * 1048576, 2]);

  // 2) 資料夾兩層內：建、改名、搬移、刪除（要先清空），都留紀錄
  const spec = (await req(chen.token, `/api/projects/${pj}/doc-folders`, 'POST', { name: '規格' })).body.folder;
  assert.ok(spec?.folderId, '建第一層資料夾');
  const v1 = (await req(chen.token, `/api/projects/${pj}/doc-folders`, 'POST', { name: 'v1', parentId: spec.folderId })).body.folder;
  assert.equal(v1.parentId, spec.folderId, '建第二層');
  assert.equal(code(await req(chen.token, `/api/projects/${pj}/doc-folders`, 'POST', { name: '太深', parentId: v1.folderId })), 'FOLDER_TOO_DEEP', '第三層不行');
  assert.equal(code(await req(chen.token, `/api/projects/${pj}/doc-folders`, 'POST', { name: '規格' })), 'NAME_TAKEN', '同一層不能同名');
  assert.equal(code(await req(chen.token, `/api/projects/${pj}/doc-folders`, 'POST', { name: 'a/b' })), 'INVALID_REQUEST', '名稱不能有斜線');
  const meet = (await req(chen.token, `/api/projects/${pj}/doc-folders`, 'POST', { name: '會議' })).body.folder;
  assert.equal(code(await req(chen.token, `/api/projects/${pj}/doc-folders/${spec.folderId}`, 'PATCH', { parentId: meet.folderId })), 'FOLDER_TOO_DEEP', '有子資料夾的不能放進別的資料夾（會變三層）');
  r = await req(chen.token, `/api/projects/${pj}/doc-folders/${v1.folderId}`, 'PATCH', { name: '第一版', parentId: meet.folderId });
  assert.equal(r.status, 200); assert.deepEqual([r.body.folder.name, r.body.folder.parentId], ['第一版', meet.folderId], '子資料夾改名＋搬到別的第一層');

  // 3) 多選上傳＝一個一個送，各自回成功或失敗原因（哪個檔、為什麼）
  const batch = [['需求.pdf', pdf], ['惡意.exe', exe], ['巨集.docx', docxMacro], ['筆記.md', enc('# 會議\n內容')], ['沒聲明.pdf', pdf, '&declared=false']];
  const results = [];
  for (const [name, bytes, flag] of batch) {
    const rr = await req(chen.token, `/api/projects/${pj}/docs?name=${encodeURIComponent(name)}${flag || '&declared=true'}&folderId=${spec.folderId}`, 'POST', null, bytes);
    results.push([name, rr.status, rr.body.error?.code || 'ok']);
  }
  assert.deepEqual(results, [['需求.pdf', 201, 'ok'], ['惡意.exe', 415, 'FILE_TYPE_NOT_ALLOWED'], ['巨集.docx', 415, 'OFFICE_MACRO_NOT_ALLOWED'], ['筆記.md', 201, 'ok'], ['沒聲明.pdf', 400, 'DECLARATION_REQUIRED']], '白名單、巨集、聲明照舊，逐檔回報');

  // 4) 單檔 20 MB：2 MB 以上（訊息附件的上限）可以，超過 20 MB 不行
  const big = new Uint8Array(5 * 1048576); big.set(pdf);
  r = await up(chen.token, '大檔.pdf', big);
  assert.equal(r.status, 201, '5 MB 可以（訊息附件只能 2 MB）');
  const huge = new Uint8Array(20 * 1048576 + 1); huge.set(pdf);
  r = await up(chen.token, '超大.pdf', huge);
  assert.deepEqual([r.status, code(r)], [413, 'FILE_TOO_LARGE'], '超過 20 MB 拒收');
  assert.match(r.body.error.message, /20 MB/);
  assert.equal(code(await up(chen.token, '放錯.pdf', pdf, `&folderId=nope`)), 'FOLDER_NOT_FOUND');

  // AI 也能放（同樣要聲明）
  r = await up(ai.token, 'AI 整理.txt', enc('整理好的紀錄'));
  assert.equal(r.status, 201, 'AI 成員可上傳');

  let list = (await req(chen.token, `/api/projects/${pj}/docs`)).body;
  const doc = list.items.find(d => d.name === '需求.pdf');
  assert.equal(list.items.length, 4); assert.equal(doc.folderId, spec.folderId); assert.equal(doc.uploader.name, '陳昭宇');
  assert.equal(store.map.size, 4, '本體存在文件儲存（R2），不在 D1');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM file_chunks')).n, 0, 'D1 沒有文件本體');

  // 下載
  r = await req(chen.token, doc.downloadUrl);
  assert.equal(r.status, 200); assert.deepEqual([...r.body], [...pdf], '下載內容一樣');
  assert.match(r.headers.get('content-disposition'), /attachment/);

  // 改名（副檔名不能換）、搬移
  r = await req(chen.token, `/api/projects/${pj}/docs/${doc.docId}`, 'PATCH', { name: '需求v2.exe' });
  assert.equal(r.body.doc.name, '需求v2.exe.pdf', '改名不能藉機換類型：保留原副檔名');
  r = await req(chen.token, `/api/projects/${pj}/docs/${doc.docId}`, 'PATCH', { name: '需求v2.pdf', folderId: v1.folderId });
  assert.deepEqual([r.body.doc.name, r.body.doc.folderId], ['需求v2.pdf', v1.folderId], '改名＋搬到子資料夾');
  r = await req(chen.token, `/api/projects/${pj}/docs/${doc.docId}`, 'PATCH', { folderId: null });
  assert.equal(r.body.doc.folderId, null, '搬到最上層');

  // 刪資料夾要先清空
  assert.equal(code(await req(chen.token, `/api/projects/${pj}/doc-folders/${spec.folderId}`, 'DELETE')), 'FOLDER_NOT_EMPTY', '裡面有東西不能刪');
  assert.equal((await req(chen.token, `/api/projects/${pj}/doc-folders/${v1.folderId}`, 'DELETE')).status, 200, '空資料夾可以刪');

  // 刪文件：本體從儲存刪掉、清單看不到
  const md = list.items.find(d => d.name === '筆記.md');
  assert.equal((await req(chen.token, `/api/projects/${pj}/docs/${md.docId}`, 'DELETE')).status, 200);
  assert.equal(store.map.has(`docs/${md.docId}`), false, '本體刪掉');
  assert.equal((await req(chen.token, `/api/projects/${pj}/docs/${md.docId}`)).status, 404, '刪了就下載不到');

  // 紀錄：專案異動紀錄（放檔、改名、搬移、刪除、資料夾）＋稽核
  const ev = (await req(chen.token, `/api/projects/${pj}/events?limit=50`)).body.items.map(e => e.text).join('\n');
  for (const re of [/陳昭宇 上傳文件「需求\.pdf」到 規格/, /陳昭宇 在 最上層 建資料夾「規格」/, /改名「需求\.pdf」→「需求v2\.exe\.pdf」/, /搬移「需求v2\.pdf」：第一版|搬移「需求v2\.pdf」：會議\/第一版 → 最上層/, /陳昭宇 刪除文件「筆記\.md」/, /陳昭宇 刪除資料夾「會議\/第一版」/, /資料夾 規格\/v1 → 會議\/第一版/]) assert.match(ev, re);
  const aud = (await req(chen.token, '/api/files/audit?limit=100')).body.items;
  for (const a of ['upload', 'download', 'rename', 'move', 'delete', 'reject']) assert.ok(aud.some(x => x.action === a), `稽核有 ${a}`);

  // 1) 隔離：別專案的人（含 API）看不到，一律 404，不透露有沒有
  for (const [m, p, b] of [['GET', `/api/projects/${pj}/docs`], ['GET', doc.downloadUrl], ['POST', `/api/projects/${pj}/doc-folders`, { name: 'x' }], ['PATCH', `/api/projects/${pj}/docs/${doc.docId}`, { name: 'x.pdf' }], ['DELETE', `/api/projects/${pj}/docs/${doc.docId}`]]) {
    r = await req(bank.token, p, m, b);
    assert.equal(r.status, 404, `別專案的人 ${m} ${p} 要 404，實際 ${r.status}`);
  }
  r = await up(bank.token, '偷放.pdf', pdf);
  assert.equal(r.status, 404, '別專案的人不能上傳');
  assert.equal((await req(bank.token, `/api/projects/${encodeURIComponent('銀行系統')}/docs`)).body.items.length, 0, '自己專案的文件區是空的（各專案分開）');
  assert.equal((await req(bank.token, `/api/projects/${encodeURIComponent('銀行系統')}/docs/${doc.docId}`)).status, 404, '換成自己專案的網址也拿不到別專案的檔');
  assert.ok(!(await req(bank.token, '/api/files/audit?limit=100')).body.items.some(x => x.fileId === doc.docId), '稽核也看不到別專案的文件');

  // 6) 唯讀成員：看得到、能下載；不能上傳、建資料夾、改名、搬移、刪除
  r = await req(ro.token, `/api/projects/${pj}/docs`);
  assert.equal(r.status, 200); assert.equal(r.body.canWrite, false, '唯讀：前端藏起上傳與管理按鈕');
  assert.equal((await req(ro.token, doc.downloadUrl)).status, 200, '唯讀可下載');
  assert.equal(code(await up(ro.token, '唯讀.pdf', pdf)), 'READ_ONLY');
  assert.equal(code(await req(ro.token, `/api/projects/${pj}/doc-folders`, 'POST', { name: '唯讀' })), 'READ_ONLY');
  assert.equal(code(await req(ro.token, `/api/projects/${pj}/docs/${doc.docId}`, 'PATCH', { name: 'x.pdf' })), 'READ_ONLY');
  assert.equal(code(await req(ro.token, `/api/projects/${pj}/docs/${doc.docId}`, 'DELETE')), 'READ_ONLY');

  // 5) 不會自動消失：訊息附件到期清除照跑，文件區不受影響
  await new Promise(res => setTimeout(res, 50));
  await app.runScheduled();
  list = (await req(chen.token, `/api/projects/${pj}/docs`)).body;
  assert.equal(list.items.length, 3, '排程清除後文件都還在');
  assert.equal((await req(chen.token, list.items[0].downloadUrl)).status, 200);

  // 沒綁 R2：文件區回 503（清單照常、標示未開通），其他功能不受影響
  const app2 = createApp({ db, storage: dbStorage(db), docText, config: { openJoin: '1', rateLimitPerMin: '100000' } });
  const r2 = await app2(new Request(`${BASE}/api/projects/${pj}/docs?name=a.pdf&declared=true`, { method: 'POST', headers: { Authorization: `Bearer ${chen.token}` }, body: pdf }), BASE);
  assert.equal(r2.status, 503); assert.equal((await r2.json()).error.code, 'DOCS_DISABLED');
  const l2 = await app2(new Request(`${BASE}/api/projects/${pj}/docs`, { headers: { Authorization: `Bearer ${chen.token}` } }), BASE);
  assert.equal((await l2.json()).enabled, false);

  // 本機資料夾儲存（node server.js 用）：存得進去、讀得回來、刪得掉，key 不能跳出資料夾
  const ds = dirStorage(path.join(dataDir, 'docs'));
  await ds.put('docs/doc_abc', pdf);
  assert.deepEqual([...(await ds.get('docs/doc_abc'))], [...pdf]);
  await ds.delete('docs/doc_abc');
  assert.equal(await ds.get('docs/doc_abc'), null);
  await assert.rejects(ds.put('../x', pdf));

  // 規格與網頁
  assert.match(docText, /\/api\/projects\/:id\/docs/, '規格寫明專案文件區 API');
  const web = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(web, /\/docs`/, '網頁有文件區'); assert.match(web, /multiple/, '可多選上傳'); assert.match(web, /專案文件/);
  const wr = fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(wr, /binding = "DOCS"/, 'wrangler 有 R2 綁定設定（開通前註解）');
  console.log('c365-test：全部通過');
} catch (e) {
  console.error('c365-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
