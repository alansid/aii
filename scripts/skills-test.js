// C-346 驗收測試：角色技能庫——上傳、驗證、上架規則、主人允許、手動同步、依工具裝對資料夾、角色、已裝、下架移除
// 上架規則（昱志 10/20）：純文字直接上架；含腳本的，leader／管理員上傳直接上架、其他成員上傳要 leader／管理員核准
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
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const run = (cwd, args) => new Promise(ok => execFile(process.execPath, [pub('aigile-setup.mjs'), ...args], { cwd, env: { ...process.env, AIGILE_TOKEN: '', CLAUDECODE: '', CODEX_HOME: '', AIGILE_CLAUDE_BIN: fileURLToPath(new URL('./fake-claude.mjs', import.meta.url)) } }, (e, out) => ok({ code: e ? e.code : 0, out })));
const skill = (name, extra = [], body = '照著做') => [{ path: 'SKILL.md', text: `---\nname: ${name}\ndescription: ${name} 的說明\n---\n${body}\n` }, ...extra];

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body; // 管理員
  const wang = (await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body;
  const chen = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const W = wang.participant.participantId, C = chen.participant.participantId;
  await call(liu.token, `/api/participants/${W}/projects`, 'PUT', { projects: ['平台'] });
  await call(liu.token, `/api/participants/${C}/projects`, 'PUT', { projects: ['平台'] });
  await call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: W, leaderOf: ['平台'] }] }); // 王小明是平台 leader
  const mkAi = async (owner, name, projects, roleKey = 'PG') => { const a = (await call(owner.token, '/api/my-ais', 'POST', { projects, roleKey, role: roleKey, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; const row = await db.get('SELECT token, code FROM participants WHERE id = ?', a.participantId); return { id: a.participantId, tok: row.token, code: row.code }; };
  const ai = await mkAi(liu, '平台助手', ['平台']);
  await mkAi(liu, '平台助手二號', ['平台']);
  const uxAi = await mkAi(liu, '平台UX助手', ['平台'], 'UX');
  const bankAi = await mkAi(liu, '銀行助手', ['銀行系統']);
  const up = (tok, files, roles, pj = '平台') => call(tok, `/api/projects/${encodeURIComponent(pj)}/skills`, 'POST', { files, ...(roles ? { roles } : {}) });

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
  assert.equal((await up(ai.tok, skill('by-ai'))).status, 403, 'AI 不能上傳');

  // 純文字：一般成員上傳也直接上架；平台私訊主人（每位主人一則，發送者是平台）
  await db.run("DELETE FROM dms WHERE text LIKE '🧩%'");
  let r = await up(chen.token, skill('write-report'));
  assert.equal(r.status, 201); assert.equal(r.body.status, 'published', '純文字：一般成員上傳直接上架'); assert.equal(r.body.hasScripts, false);
  assert.equal((await up(chen.token, skill('write-report'))).body.error?.code, 'SAME_CONTENT', '內容一樣不用重傳');
  const dms = await db.all("SELECT from_id, human_id, text FROM dms WHERE text LIKE '🧩%'");
  assert.equal(dms.length, 1, '劉昱志有三個平台 AI，只收一則');
  assert.ok(dms[0].from_id === 'system' && dms[0].text.includes('write-report') && dms[0].text.includes('你有 3 隻 AI 會用到') && dms[0].text.includes('/my-ai?sync=1'), '平台私訊主人：' + dms[0].text);
  let mine = (await call(ai.tok, '/api/me/skills')).body.items;
  assert.deepEqual(mine.map(x => [x.name, x.install]), [['write-report', true]]);
  assert.equal((await call(bankAi.tok, '/api/me/skills')).body.items.length, 0, '只發給該專案的 AI（行內技能不外流）');

  // 角色：給 UX 的技能，PG 的 AI 拿不到
  await up(liu.token, skill('ui-shot'), ['UX']);
  assert.ok((await call(uxAi.tok, '/api/me/skills')).body.items.some(x => x.name === 'ui-shot'), 'UX 的 AI 拿得到');
  assert.ok(!(await call(ai.tok, '/api/me/skills')).body.items.some(x => x.name === 'ui-shot'), 'PG 的 AI 拿不到給 UX 的技能');
  assert.equal((await up(liu.token, skill('bad-role'), ['CEO'])).status, 400, '角色要在清單內');

  // 含腳本：一般成員上傳 → 等核准；成員不能核准；leader 看全文與差異後核准
  r = await up(chen.token, skill('deploy-helper', [{ path: 'scripts/run.sh', text: 'echo hi\n' }]));
  assert.equal(r.body.status, 'pending', '成員上傳的含腳本要核准'); assert.equal(r.body.scripts, 1);
  const sid = r.body.skillId;
  assert.ok(!(await call(ai.tok, '/api/me/skills')).body.items.some(x => x.name === 'deploy-helper'), '待核准的 AI 看不到');
  assert.ok((await call(chen.token, '/api/projects/平台/skills')).body.items.some(x => x.name === 'deploy-helper' && x.status === 'pending'), '上傳者看得到自己待核准的');
  assert.equal((await call(chen.token, `/api/skills/${sid}/review`, 'POST', { action: 'approve' })).body.error?.code, 'NOT_LEADER', '一般成員不能核准');
  const full = (await call(wang.token, `/api/skills/${sid}`)).body;
  assert.ok(full.canReview && full.files.some(f => f.path === 'scripts/run.sh' && f.text === 'echo hi\n'), 'leader 看得到全文、可以核准');
  assert.equal((await call(wang.token, `/api/skills/${sid}/review`, 'POST', { action: 'reject' })).status, 400, '退回要寫原因');
  assert.equal((await call(wang.token, `/api/skills/${sid}/review`, 'POST', { action: 'approve', note: '看過了' })).body.status, 'published', 'leader 核准上架');
  // 待核准時又傳新版：舊的待核准版作廢，清單只剩新的那一版要審
  const p1 = (await up(chen.token, skill('two-step', [{ path: 'scripts/a.sh', text: 'echo 1\n' }]))).body;
  const p2 = (await up(chen.token, skill('two-step', [{ path: 'scripts/a.sh', text: 'echo 2\n' }]))).body;
  const pend = (await call(wang.token, '/api/projects/平台/skills')).body.items.filter(x => x.name === 'two-step');
  assert.deepEqual(pend.map(x => [x.version, x.status]), [[p2.version, 'pending']], '舊的待核准版作廢');
  assert.equal((await call(wang.token, `/api/skills/${p1.skillId}/review`, 'POST', { action: 'approve' })).body.error?.code, 'NOT_PENDING', '作廢的不能再核准');
  // 管理員上傳含腳本：直接上架（昱志 10/20 改的規則）
  r = await up(liu.token, skill('admin-tool', [{ path: 'scripts/a.py', text: 'print(1)\n' }]));
  assert.equal(r.body.status, 'published', 'leader／管理員上傳的含腳本直接上架');

  // 主人允許才裝；允許的是這一版
  mine = (await call(ai.tok, '/api/me/skills')).body.items;
  let dh = mine.find(x => x.name === 'deploy-helper');
  assert.deepEqual([dh.hasScripts, dh.install], [true, false], '含腳本：主人沒允許不裝');
  assert.equal((await call(ai.tok, `/api/me/skills/${dh.skillId}/files`)).body.error?.code, 'NOT_ALLOWED', '沒允許下載不到');
  assert.equal((await call(wang.token, `/api/my-ais/${ai.id}/skills/${dh.skillId}`, 'PUT', { allow: true })).status, 404, '不是主人不能允許');

  // 依工具裝對資料夾（Claude Code），含腳本的先不裝；--tool 記進 watcher.env
  const AG = `PG_${ai.code}`;
  const wd = fs.mkdtempSync(path.join(dataDir, 'w-'));
  fs.mkdirSync(path.join(wd, `.aigile/${AG}`), { recursive: true }); fs.writeFileSync(path.join(wd, `.aigile/${AG}/.token`), ai.tok);
  let o = await run(wd, ['--agent', AG, '--base', BASE, '--tool', 'claude', '--skills-only']);
  assert.equal(o.code, 0, o.out);
  assert.ok(fs.existsSync(path.join(wd, '.claude/skills/write-report/SKILL.md')), 'Claude Code 裝到 .claude/skills/');
  assert.ok(!fs.existsSync(path.join(wd, '.claude/skills/deploy-helper')), '含腳本沒允許不放進技能資料夾');
  assert.match(o.out, /deploy-helper（含腳本，等主人/);
  assert.match(fs.readFileSync(path.join(wd, `.aigile/${AG}/watcher.env`), 'utf8'), /^SKILL_TOOL=claude$/m, '工具記進 watcher.env');
  assert.ok(!fs.existsSync(path.join(wd, '.aigile/watcher')), '--skills-only 不動 watcher');
  let lib = (await call(liu.token, '/api/projects/平台/skills')).body.items;
  assert.deepEqual(lib.find(x => x.name === 'write-report').install, { target: 3, installed: 1, waitingOwner: 0 }, '已裝 1／3（沒限定角色：兩個 PG、一個 UX）');
  assert.equal(lib.find(x => x.name === 'deploy-helper').install.waitingOwner, 3, '含腳本：3 台等主人允許');
  // C-351：技能分頁一次拿全部（各專案數量、能否上傳／管理、待你核准、已裝數），抽屜才讀「裝到哪些 AI」
  const all = (await call(wang.token, '/api/skills')).body;
  assert.deepEqual(all.projects.map(p => p.id), ['平台'], '只列自己所在的專案');
  assert.ok(all.projects[0].canUpload && all.projects[0].canManage && all.projects[0].count > 0, 'leader 能上傳、能管理，有數量');
  assert.deepEqual(all.items.find(x => x.name === 'write-report').install, { target: 3, installed: 1, waitingOwner: 0 }, '清單就帶已裝數，不用再讀');
  assert.ok(all.items.find(x => x.name === 'two-step').canReview, 'leader 看得到要他核准的');
  const cAll = (await call(chen.token, '/api/skills')).body;
  assert.ok(!cAll.projects[0].canManage && !cAll.items.find(x => x.name === 'two-step').canReview, '一般成員（上傳者）不能核准');
  assert.ok((await call(liu.token, '/api/skills')).body.projects.some(p => p.id === '銀行系統'), '管理員看得到所有專案');
  assert.equal((await call(ai.tok, '/api/skills')).status, 200, 'AI 也能看清單');
  // C-352：我的 AI 清單帶「技能等你允許」數（跟該 AI 技能清單裡含腳本、還沒允許的一致）與待命狀態
  const myAis = (await call(liu.token, '/api/my-ais')).body.items, mine1 = myAis.find(a => a.participantId === ai.id);
  const waitN = (await call(liu.token, `/api/my-ais/${ai.id}/skills`)).body.items.filter(s => s.hasScripts && !s.allowed).length;
  assert.ok(waitN > 0 && mine1.skillsWaiting === waitN, `skillsWaiting ${mine1.skillsWaiting} = ${waitN}`);
  assert.equal(myAis.find(a => a.participantId === bankAi.id).skillsWaiting, 0, '別的專案的 AI 不算');
  assert.equal(typeof mine1.standby, 'boolean');
  const dhId = lib.find(x => x.name === 'deploy-helper').skillId;
  const det = (await call(liu.token, `/api/skills/${dhId}`)).body;
  assert.ok(det.canManage && det.installs.length === 3 && det.installs.every(a => a.state === 'waiting' && a.mine && a.owner === '劉昱志'), '抽屜：3 台都等主人（我）允許');
  assert.ok(!(await call(wang.token, `/api/skills/${dhId}`)).body.installs.some(a => a.mine), '別人的 AI 不算「我的」');
  assert.match((await up(ai.tok, skill('by-ai'))).body.error?.message || '', /AI 不能上傳技能，請所屬人類上傳/, 'AI 上傳的錯誤講清楚');

  await call(liu.token, `/api/my-ais/${ai.id}/skills/${dh.skillId}`, 'PUT', { allow: true });
  o = await run(wd, ['--agent', AG, '--base', BASE, '--skills-only']); // 沒帶 --tool：用 watcher.env 記的
  assert.equal(fs.readFileSync(path.join(wd, '.claude/skills/deploy-helper/scripts/run.sh'), 'utf8'), 'echo hi\n', '主人允許後才裝；沒帶 --tool 也裝對地方');
  assert.match(o.out, /新裝 1/);

  // 新版：成員上傳要重新核准、主人要重新允許；同步後換新
  r = await up(chen.token, skill('deploy-helper', [{ path: 'scripts/run.sh', text: 'echo v2\n' }]));
  assert.equal((await call(wang.token, `/api/skills/${r.body.skillId}`)).body.previous.version, 1, '核准畫面附上一版（算差異）');
  await call(wang.token, `/api/skills/${r.body.skillId}/review`, 'POST', { action: 'approve' });
  dh = (await call(ai.tok, '/api/me/skills')).body.items.find(x => x.name === 'deploy-helper');
  assert.deepEqual([dh.version, dh.install], [2, false], '新版要重新允許');
  await call(liu.token, `/api/my-ais/${ai.id}/skills/${dh.skillId}`, 'PUT', { allow: true });
  o = await run(wd, ['--agent', AG, '--base', BASE, '--skills-only']);
  assert.equal(fs.readFileSync(path.join(wd, '.claude/skills/deploy-helper/scripts/run.sh'), 'utf8'), 'echo v2\n', '同步後換新版');

  // 下架：同步後移除（只移除自己裝的；別人放的不碰）
  fs.mkdirSync(path.join(wd, '.claude/skills/my-own'), { recursive: true }); fs.writeFileSync(path.join(wd, '.claude/skills/my-own/SKILL.md'), '自己的');
  assert.equal((await call(chen.token, '/api/projects/平台/skills/write-report/remove', 'POST')).status, 403, '一般成員不能下架');
  assert.equal((await call(liu.token, '/api/projects/平台/skills/write-report/remove', 'POST')).status, 200);
  assert.ok((await db.all("SELECT text FROM dms WHERE from_id = 'system'")).some(x => x.text.includes('write-report') && x.text.includes('下架')), '下架私訊主人');
  o = await run(wd, ['--agent', AG, '--base', BASE, '--skills-only']);
  assert.ok(!fs.existsSync(path.join(wd, '.claude/skills/write-report')), '下架的移除');
  assert.ok(fs.existsSync(path.join(wd, '.claude/skills/my-own/SKILL.md')), '不是自己裝的不碰');
  assert.match(o.out, /移除 1/);

  // Codex → .agents/skills、其他 → .aigile/<代號>/skills；opencode 先不支援（昱志 10/20）
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
  assert.ok(fs.readFileSync(new URL('../src/core.js', import.meta.url), 'utf8').includes("d.from_id === 'system' ? '平台通知'"), '私訊裡平台發的顯示「平台通知」');
  // 雜湊算法跟檢查腳本一致
  const files = skill('x');
  assert.equal(crypto.createHash('sha256').update(canonical(files)).digest('hex'), crypto.createHash('sha256').update(JSON.stringify(files.map(f => [f.path, f.text]).sort())).digest('hex'));
  console.log('skills-test：全部通過');
} catch (e) {
  console.error('skills-test 失敗：', e.message, (e.stack || '').split('\n').filter(l => /skills|core/.test(l)).slice(0, 4).join(' | '));
  process.exitCode = 1;
} finally {
  server.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
