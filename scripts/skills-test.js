// C-346 驗收測試：角色技能庫——上傳、驗證、含腳本要別人核准、主人允許、手動同步、依工具裝對資料夾、下架移除
// 用法：node scripts/skills-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { canonical } from '../src/skills.js';

const pub = f => fileURLToPath(new URL('../public/' + f, import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-skills-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const server = http.createServer(async (req, res) => {
  const f = /^\/(watcher|aigile-wait|aigile-setup|aigile-opencode)\.mjs$/.exec(req.url);
  if (f) { res.writeHead(200); return res.end(fs.readFileSync(pub(f[0].slice(1)))); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const run = (cwd, args) => new Promise(ok => execFile(process.execPath, [pub('aigile-setup.mjs'), ...args], { cwd, env: { ...process.env, AIGILE_TOKEN: '', CLAUDECODE: '', CODEX_HOME: '' } }, (e, out) => ok({ code: e ? e.code : 0, out })));
const skill = (name, extra = [], body = '照著做') => [{ path: 'SKILL.md', text: `---\nname: ${name}\ndescription: ${name} 的說明\n---\n${body}\n` }, ...extra];

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body; // 管理員
  const wang = (await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body;
  const chen = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const W = wang.participant.participantId, C = chen.participant.participantId;
  await call(liu.token, `/api/participants/${W}/projects`, 'PUT', { projects: ['平台'] });
  await call(liu.token, `/api/participants/${C}/projects`, 'PUT', { projects: ['平台'] });
  await call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: W, leaderOf: ['平台'] }] }); // 王小明當平台 leader（第二位核准者）
  const leaders = (await call(liu.token, '/api/projects')).body.leaders?.['平台'] || [];
  const mkAi = async (owner, name, projects) => { const a = (await call(owner.token, '/api/my-ais', 'POST', { projects, roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; return { id: a.participantId, tok: (await db.get('SELECT token, code FROM participants WHERE id = ?', a.participantId)).token, code: (await db.get('SELECT code FROM participants WHERE id = ?', a.participantId)).code }; };
  const ai = await mkAi(liu, '平台助手', ['平台']);
  const bankAi = await mkAi(liu, '銀行助手', ['銀行系統']);
  const up = (tok, files, pj = '平台') => call(tok, `/api/projects/${encodeURIComponent(pj)}/skills`, 'POST', { files });

  // 上傳權限：leader 或管理員；一般成員不行
  assert.equal((await up(chen.token, skill('a'))).body.error?.code, 'NOT_LEADER', '一般成員不能上傳');
  // 驗證
  assert.equal((await up(liu.token, [{ path: 'README.md', text: 'x' }])).status, 400, '要有 SKILL.md');
  assert.equal((await up(liu.token, [{ path: 'SKILL.md', text: '沒有 frontmatter' }])).status, 400, '要有 name、description');
  assert.equal((await up(liu.token, skill('Bad_Name'))).status, 400, 'name 只能小寫英數與 -');
  assert.equal((await up(liu.token, skill('bin', [{ path: 'a.png', text: 'PNG\u0000\u0001' }]))).status, 400, '擋二進位');
  assert.equal((await up(liu.token, skill('big', [{ path: 'big.md', text: 'x'.repeat(1024 * 1024) }]))).status, 400, '超過 1 MB 擋');
  assert.equal((await up(liu.token, skill('near-limit', [{ path: 'big.md', text: '中'.repeat(300_000) }]))).status, 201, '接近 1 MB（900 KB）傳得上去（一般 API 上限只有 256 KB）');
  await call(liu.token, '/api/projects/平台/skills/near-limit/remove', 'POST');
  assert.equal((await up(liu.token, skill('evil', [{ path: '../x.md', text: 'x' }]))).status, 400, '檔名不能有 ..');
  assert.equal((await up(liu.token, skill('key', [{ path: 'k.md', text: '-----BEGIN RSA PRIVATE KEY-----' }]))).body.error?.code, 'SECRET_IN_TEXT', '擋私鑰');
  assert.equal((await up(liu.token, skill('tok', [{ path: 't.md', text: `token ${ai.tok}` }]))).body.error?.code, 'SECRET_IN_TEXT', '擋平台 Token');

  // 純文字：直接上架，AI 看得到、可以裝；主人收到私訊
  let r = await up(liu.token, skill('write-report'));
  assert.equal(r.status, 201); assert.equal(r.body.status, 'published', '純文字直接上架'); assert.equal(r.body.hasScripts, false);
  assert.equal((await up(liu.token, skill('write-report'))).body.error?.code, 'SAME_CONTENT', '內容一樣不用重傳');
  const dmOwner = async aiId => (await db.all("SELECT text FROM dms WHERE ai_id = ? AND text LIKE '[技能]%'", aiId)).map(x => x.text);
  assert.ok((await dmOwner(ai.id)).some(t => t.includes('write-report') && t.includes('第 1 版上架')), '上架私訊主人');
  assert.equal((await dmOwner(bankAi.id)).length, 0, '別專案的 AI 主人不收');
  let mine = (await call(ai.tok, '/api/me/skills')).body.items;
  assert.deepEqual(mine.map(x => [x.name, x.install]), [['write-report', true]]);
  assert.equal((await call(bankAi.tok, '/api/me/skills')).body.items.length, 0, '只發給該專案的 AI（行內技能不外流）');

  // 含腳本：待核准；上傳者自己不能核准；別的 leader 看全文與差異後核准
  r = await up(liu.token, skill('deploy-helper', [{ path: 'scripts/run.sh', text: 'echo hi\n' }]));
  assert.equal(r.body.status, 'pending', '含腳本要核准'); assert.equal(r.body.hasScripts, true);
  const sid = r.body.skillId;
  assert.ok(!(await call(ai.tok, '/api/me/skills')).body.items.some(x => x.name === 'deploy-helper'), '待核准的 AI 看不到');
  assert.ok(!(await call(chen.token, '/api/projects/平台/skills')).body.items.some(x => x.name === 'deploy-helper'), '一般成員看不到待核准的');
  assert.equal((await call(liu.token, `/api/skills/${sid}/review`, 'POST', { action: 'approve' })).body.error?.code, 'SELF_REVIEW', '上傳者不能自己核准');
  const reviewer = leaders.includes(W) ? wang : null;
  assert.ok(reviewer, 'leader 設得起來（測試前提）：' + JSON.stringify(leaders));
  const full = (await call(wang.token, `/api/skills/${sid}`)).body;
  assert.ok(full.files.some(f => f.path === 'scripts/run.sh' && f.text === 'echo hi\n'), '核准的人看得到全文');
  assert.equal((await call(wang.token, `/api/skills/${sid}/review`, 'POST', { action: 'reject' })).status, 400, '退回要寫原因');
  assert.equal((await call(wang.token, `/api/skills/${sid}/review`, 'POST', { action: 'approve', note: '看過了' })).body.status, 'published', '別的 leader 核准');

  // 主人允許才裝；允許的是這一版
  mine = (await call(ai.tok, '/api/me/skills')).body.items;
  let dh = mine.find(x => x.name === 'deploy-helper');
  assert.deepEqual([dh.hasScripts, dh.install], [true, false], '含腳本：主人沒允許不裝');
  assert.equal((await call(ai.tok, `/api/me/skills/${dh.skillId}/files`)).body.error?.code, 'NOT_ALLOWED', '沒允許下載不到');
  assert.equal((await call(wang.token, `/api/my-ais/${ai.id}/skills/${dh.skillId}`, 'PUT', { allow: true })).status, 404, '不是主人不能允許');

  // 依工具裝對資料夾（Claude Code），含腳本的先不裝
  const AG = `PG_${ai.code}`;
  const wd = fs.mkdtempSync(path.join(dataDir, 'w-'));
  fs.mkdirSync(path.join(wd, `.aigile/${AG}`), { recursive: true }); fs.writeFileSync(path.join(wd, `.aigile/${AG}/.token`), ai.tok);
  let o = await run(wd, ['--agent', AG, '--base', BASE, '--tool', 'claude', '--skills-only']);
  assert.equal(o.code, 0, o.out);
  assert.ok(fs.existsSync(path.join(wd, '.claude/skills/write-report/SKILL.md')), 'Claude Code 裝到 .claude/skills/');
  assert.ok(!fs.existsSync(path.join(wd, '.claude/skills/deploy-helper')), '含腳本沒允許不放進技能資料夾');
  assert.match(o.out, /deploy-helper（含腳本，等主人/);
  assert.ok(!fs.existsSync(path.join(wd, '.aigile/watcher')), '--skills-only 不動 watcher');

  await call(liu.token, `/api/my-ais/${ai.id}/skills/${dh.skillId}`, 'PUT', { allow: true });
  o = await run(wd, ['--agent', AG, '--base', BASE, '--tool', 'claude', '--skills-only']);
  assert.equal(fs.readFileSync(path.join(wd, '.claude/skills/deploy-helper/scripts/run.sh'), 'utf8'), 'echo hi\n', '主人允許後才裝');
  assert.match(o.out, /新裝 1/);

  // 新版：要重新核准、重新允許；同步後換新
  r = await up(liu.token, skill('deploy-helper', [{ path: 'scripts/run.sh', text: 'echo v2\n' }]));
  await call(wang.token, `/api/skills/${r.body.skillId}/review`, 'POST', { action: 'approve' });
  dh = (await call(ai.tok, '/api/me/skills')).body.items.find(x => x.name === 'deploy-helper');
  assert.deepEqual([dh.version, dh.install], [2, false], '新版要重新允許');
  await call(liu.token, `/api/my-ais/${ai.id}/skills/${dh.skillId}`, 'PUT', { allow: true });
  o = await run(wd, ['--agent', AG, '--base', BASE, '--tool', 'claude', '--skills-only']);
  assert.equal(fs.readFileSync(path.join(wd, '.claude/skills/deploy-helper/scripts/run.sh'), 'utf8'), 'echo v2\n', '同步後換新版');
  assert.match(o.out, /更新 1/);

  // 下架：同步後移除（只移除自己裝的；別人放的同名資料夾不碰）
  fs.mkdirSync(path.join(wd, '.claude/skills/my-own'), { recursive: true }); fs.writeFileSync(path.join(wd, '.claude/skills/my-own/SKILL.md'), '自己的');
  assert.equal((await call(chen.token, '/api/projects/平台/skills/write-report/remove', 'POST')).status, 403, '一般成員不能下架');
  assert.equal((await call(liu.token, '/api/projects/平台/skills/write-report/remove', 'POST')).status, 200);
  assert.ok((await dmOwner(ai.id)).some(t => t.includes('write-report') && t.includes('已下架')), '下架私訊主人');
  o = await run(wd, ['--agent', AG, '--base', BASE, '--tool', 'claude', '--skills-only']);
  assert.ok(!fs.existsSync(path.join(wd, '.claude/skills/write-report')), '下架的移除');
  assert.ok(fs.existsSync(path.join(wd, '.claude/skills/my-own/SKILL.md')), '不是自己裝的不碰');
  assert.match(o.out, /移除 1/);

  // 其他工具的資料夾：Codex → .agents/skills、其他 → .aigile/<代號>/skills（昱志：opencode 先不用）
  for (const [tool, dir] of [['codex', '.agents/skills'], ['other', `.aigile/${AG}/skills`]]) {
    const d = fs.mkdtempSync(path.join(dataDir, tool + '-'));
    fs.mkdirSync(path.join(d, `.aigile/${AG}`), { recursive: true }); fs.writeFileSync(path.join(d, `.aigile/${AG}/.token`), ai.tok);
    o = await run(d, ['--agent', AG, '--base', BASE, '--tool', tool, '--skills-only']);
    assert.ok(fs.existsSync(path.join(d, dir, 'deploy-helper/SKILL.md')), `${tool} 裝到 ${dir}：` + o.out);
  }

  o = await run(fs.mkdtempSync(path.join(dataDir, 'oc-')), ['--agent', AG, '--base', BASE, '--tool', 'opencode', '--skills-only']);
  assert.equal(o.code, 1, 'opencode 先不支援'); 

  // 同步按鈕：私訊 AI 請它跑 aigile-setup（AI 不自己查）
  assert.equal((await call(liu.token, `/api/my-ais/${ai.id}/skills/sync`, 'POST')).status, 200);
  assert.ok((await db.all("SELECT text FROM dms WHERE ai_id = ? AND from_id = ? AND text LIKE '[技能同步]%'", ai.id, liu.participant.participantId)).some(x => x.text.includes(`--agent ${AG}`) && x.text.includes('--skills-only')), '同步私訊帶指令');
  // 雜湊算法跟檢查腳本一致
  const files = skill('x');
  assert.equal(crypto.createHash('sha256').update(canonical(files)).digest('hex'), crypto.createHash('sha256').update(JSON.stringify(files.map(f => [f.path, f.text]).sort())).digest('hex'));
  console.log('skills-test：全部通過');
} catch (e) {
  console.error('skills-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  server.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
