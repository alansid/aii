// 上傳文件 v1.1 驗收測試：逐條對照驗收條件。
// 用法：npm run test:files
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3998;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-files-'));

function startServer(env = {}) {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ...env }, stdio: 'pipe',
  });
  const ready = new Promise((res, rej) => {
    server.stdout.on('data', d => { if (String(d).includes('已啟動')) res(); });
    server.on('exit', c => rej(new Error('server exited ' + c)));
  });
  return { server, ready };
}
async function stopServer(server) {
  const exited = new Promise(res => server.once('exit', res));
  server.kill();
  await exited;
}
const json = async (token, p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const upload = async (token, name, bytes, { declared = true, extra = '' } = {}) => {
  const q = new URLSearchParams({ name, ...(declared ? { declared: 'true' } : {}) });
  const r = await fetch(`${BASE}/api/files?${q}${extra}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: bytes });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const code = r => r.body?.error?.code;

// ---- 測試檔案 ----
const enc = s => new TextEncoder().encode(s);
const pdf = enc('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // MZ 執行檔檔頭
// 最小 zip（store，不壓縮），足以讓伺服器讀中央目錄
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const n = enc(name), c = enc(content);
    const local = new Uint8Array(30 + n.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true);
    v.setUint32(18, c.length, true); v.setUint32(22, c.length, true); v.setUint16(26, n.length, true);
    local.set(n, 30);
    const cd = new Uint8Array(46 + n.length);
    const w = new DataView(cd.buffer);
    w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true);
    w.setUint32(20, c.length, true); w.setUint32(24, c.length, true); w.setUint16(28, n.length, true);
    w.setUint32(42, offset, true);
    cd.set(n, 46);
    parts.push(local, c); central.push(cd);
    offset += local.length + c.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
const docx = zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:document/>']]);
const docxMacro = zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:document/>'], ['word/vbaProject.bin', 'x']]);

(async () => {
  let { server, ready } = startServer({ FILE_MAX_TOTAL_MB: '1' });
  await ready;
  try {
    const j = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
    const liu = await j('/api/join', { name: '劉昱志', role: 'UX' });
    const percy = await j('/api/join', { name: 'Percy', role: 'PO' });
    const r = ROLES.find(x => x.key === 'PG');
    const aiR = await json(liu.token, '/api/my-ais', 'POST', { roleKey: 'PG', role: r.role, name: '劉昱志的程式開發助手',
      duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff });
    const ai = aiR.body;

    // AC1：白名單內、≤2MB 可上傳，群組自動出現附下載連結的訊息
    const up = await upload(liu.token, '需求規格.pdf', pdf);
    assert.equal(up.status, 201, 'AC1 pdf 上傳');
    assert.ok(up.body.message.text.includes('/api/files/' + up.body.file.fileId), 'AC1 訊息含下載連結');
    assert.equal(up.body.message.file.fileId, up.body.file.fileId, 'AC1 訊息附檔');
    for (const [n, b] of [['截圖.png', png], ['會議紀錄.docx', docx], ['筆記.md', enc('# 會議\n- 決議 A')], ['說明.txt', enc('純文字')]]) {
      assert.equal((await upload(liu.token, n, b)).status, 201, `AC1 ${n}`);
    }
    const dl = await fetch(`${BASE}/api/files/${up.body.file.fileId}`, { headers: { Authorization: `Bearer ${percy.token}` } });
    assert.equal(dl.status, 200, 'AC1 其他成員可下載');
    assert.deepEqual(new Uint8Array(await dl.arrayBuffer()), pdf, 'AC1 下載內容一致');
    assert.ok(dl.headers.get('content-disposition').includes(encodeURIComponent('需求規格.pdf')), 'AC1 中文檔名');
    const msgs = (await json(percy.token, '/api/messages?limit=50')).body.items;
    assert.ok(msgs.some(m => m.file?.fileId === up.body.file.fileId), 'AC1 群組看得到');

    // AC1（AI）：AI 也可以上傳，但必須帶聲明
    assert.equal((await upload(ai.token, 'AI報告.pdf', pdf)).status, 201, 'AI 可上傳');
    assert.equal(code(await upload(ai.token, 'AI報告2.pdf', pdf, { declared: false })), 'DECLARATION_REQUIRED', 'AI 未帶聲明被拒');

    // AC2：.exe 改名成 .pdf、含巨集的 Office 會被拒絕
    assert.equal(code(await upload(liu.token, '偽裝.pdf', exe)), 'FILE_SIGNATURE_MISMATCH', 'AC2 exe 偽裝 pdf');
    assert.equal(code(await upload(liu.token, '偽裝.png', pdf)), 'FILE_SIGNATURE_MISMATCH', 'AC2 pdf 偽裝 png');
    assert.equal(code(await upload(liu.token, '巨集.docx', docxMacro)), 'OFFICE_MACRO_NOT_ALLOWED', 'AC2 含巨集');
    assert.equal(code(await upload(liu.token, '假的.xlsx', docx)), 'FILE_SIGNATURE_MISMATCH', 'AC2 docx 改名 xlsx');
    assert.equal(code(await upload(liu.token, 'app.js', enc('console.log(1)'))), 'FILE_TYPE_NOT_ALLOWED', '白名單外');
    assert.equal(code(await upload(liu.token, 'a.zip', docx)), 'FILE_TYPE_NOT_ALLOWED', 'zip 不允許');

    // AC3：未聲明、超過 10MB、總容量已滿 → 拒絕並顯示明確原因
    const noDecl = await upload(liu.token, 'x.pdf', pdf, { declared: false });
    assert.equal(code(noDecl), 'DECLARATION_REQUIRED'); assert.ok(noDecl.body.error.message.includes('聲明'));
    const big = new Uint8Array(2 * 1024 * 1024 + 1); big.set(pdf);
    const tooBig = await upload(liu.token, 'big.pdf', big);
    assert.equal(code(tooBig), 'FILE_TOO_LARGE'); assert.ok(tooBig.body.error.message.includes('2 MB'));
    const half = new Uint8Array(700 * 1024); half.set(pdf);
    assert.equal((await upload(liu.token, 'half1.pdf', half)).status, 201);
    const full = await upload(liu.token, 'half2.pdf', half);
    assert.equal(code(full), 'STORAGE_FULL', 'AC3 總容量已滿'); assert.equal(full.status, 507);

    // AC4：非上傳者本人或其所屬人類刪除 → 403；所屬人類可刪 AI 上傳的檔
    const aiFile = (await json(liu.token, '/api/files')).body.items.find(f => f.name === 'AI報告.pdf');
    assert.equal((await json(percy.token, `/api/files/${up.body.file.fileId}`, 'DELETE')).status, 403, 'AC4 別人刪 403');
    assert.equal((await json(ai.token, `/api/files/${up.body.file.fileId}`, 'DELETE')).status, 403, 'AC4 AI 刪主人的檔 403');
    assert.equal((await json(liu.token, `/api/files/${aiFile.fileId}`, 'DELETE')).status, 200, 'AC4 所屬人類可刪 AI 的檔');
    assert.equal((await json(liu.token, `/api/files/${up.body.file.fileId}`, 'DELETE')).status, 200, 'AC4 本人可刪');
    assert.equal((await fetch(`${BASE}/api/files/${up.body.file.fileId}`, { headers: { Authorization: `Bearer ${percy.token}` } })).status, 404, '刪除後 404');

    // AC6：稽核查得到上傳／下載／刪除／拒絕，含人類／AI 身分與 SHA-256
    const audit = (await json(liu.token, '/api/files/audit?limit=500')).body.items;
    const has = (action, pred = () => true) => audit.some(a => a.action === action && pred(a));
    assert.ok(has('upload', a => a.actor.memberType === 'human' && /^[0-9a-f]{64}$/.test(a.sha256)), 'AC6 人類上傳');
    assert.ok(has('upload', a => a.actor.memberType === 'ai'), 'AC6 AI 上傳');
    assert.ok(has('download', a => a.actor.name === 'Percy'), 'AC6 下載');
    assert.ok(has('delete'), 'AC6 刪除');
    assert.ok(has('reject', a => a.detail === 'FILE_SIGNATURE_MISMATCH'), 'AC6 拒絕');
    assert.equal((await json(ai.token, '/api/files/audit')).status, 403, '稽核僅限人類');

    // AC5：超過保存期限 → 下載 404，排程清除並留下稽核
    await stopServer(server);
    ({ server, ready } = startServer({ FILE_TTL_HOURS: String(1 / 3600) })); // 1 秒
    await ready;
    const short = await upload(liu.token, '短期.pdf', pdf);
    assert.equal(short.status, 201);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal((await fetch(`${BASE}/api/files/${short.body.file.fileId}`, { headers: { Authorization: `Bearer ${liu.token}` } })).status, 404, 'AC5 過期 404');
    await stopServer(server);
    ({ server, ready } = startServer());
    await ready; // 啟動時會執行一次清除
    await new Promise(r => setTimeout(r, 300));
    const audit2 = (await json(liu.token, '/api/files/audit?limit=500')).body.items;
    assert.ok(audit2.some(a => a.action === 'expire' && a.fileId === short.body.file.fileId), 'AC5 到期清除有稽核');
    const { DatabaseSync } = await import('node:sqlite');
    const chk = new DatabaseSync(path.join(dataDir, 'switch.db'));
    assert.equal(chk.prepare('SELECT COUNT(*) AS n FROM file_chunks WHERE file_id = ?').get(short.body.file.fileId).n, 0, 'AC5 檔案實體已刪除');
    chk.close();

    console.log('files: all acceptance checks passed');
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
