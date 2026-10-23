// C-387（PLAT-239）驗收測試：有勾角色的技能裝到各自代號資料夾，同資料夾的 AI 不會讀到彼此的角色技能（方案 B，不搬資料夾）
// 修正前：同一個資料夾啟動的 PO 和 PG，技能都裝在共用的 .claude/skills，Claude Code 會整包載入，PO 讀到 PG 的角色技能
// 測：有角色 → .aigile/<代號>/skills；沒角色 → 照 --tool 的共用區；共用區的舊角色技能搬走（有清單、沒清單都搬）；別人裝的不碰、不覆蓋
// 用法：node scripts/c387-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const pub = f => fileURLToPath(new URL('../public/' + f, import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-c387-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
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
const skill = name => [{ path: 'SKILL.md', text: `---\nname: ${name}\ndescription: ${name} 的說明\n---\n${name} 的硬規則\n` }];

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body; // 管理員
  const mkAi = async (name, roleKey) => { const a = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey, role: roleKey, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; const row = await db.get('SELECT token, code FROM participants WHERE id = ?', a.participantId); return { id: a.participantId, tok: row.token, ag: `${roleKey}_${row.code}` }; };
  const pg = await mkAi('程式助手', 'PG'), po = await mkAi('產品助手', 'PO');
  const up = (files, roles) => call(liu.token, '/api/projects/平台/skills', 'POST', { files, ...(roles ? { roles } : {}) });
  for (const [n, roles] of [['common-tool'], ['pg-rules', ['PG']], ['po-rules', ['PO']]]) assert.equal((await up(skill(n), roles)).status, 201, n);

  // 1. /api/me/skills 帶 roles
  const items = (await call(pg.tok, '/api/me/skills')).body.items;
  assert.deepEqual(Object.fromEntries(items.map(x => [x.name, x.roles])), { 'common-tool': [], 'pg-rules': ['PG'] }, 'PG 拿到沒角色的與 PG 的，各帶 roles');

  // 同一個資料夾（PO 和 PG 一起在 D:\aii 那種）
  const wd = fs.mkdtempSync(path.join(dataDir, 'w-'));
  const shared = n => path.join(wd, '.claude/skills', n), own = (ai, n) => path.join(wd, `.aigile/${ai.ag}/skills`, n);
  const plant = (dir, agent, sha = 'old') => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), '舊版'); fs.writeFileSync(path.join(dir, '.aigile-skill.json'), JSON.stringify({ agent, skillId: 'x', version: 1, sha256: sha })); };
  for (const ai of [pg, po]) { fs.mkdirSync(path.join(wd, `.aigile/${ai.ag}`), { recursive: true }); fs.writeFileSync(path.join(wd, `.aigile/${ai.ag}/.token`), ai.tok); }
  // 修正前裝的樣子：PG 的 pg-rules 在共用區（有清單）；PO 的 po-rules 在共用區（清單弄丟了）；common-tool 是 PO 裝的別版
  plant(shared('pg-rules'), pg.ag);
  fs.writeFileSync(path.join(wd, `.aigile/${pg.ag}/skills.json`), JSON.stringify({ 'pg-rules': { skillId: 'x', version: 1, sha256: 'old', dir: shared('pg-rules') } }));
  plant(shared('po-rules'), po.ag);
  plant(shared('common-tool'), po.ag);

  // 2. PG 同步：角色技能進自己的代號資料夾；共用區自己的舊檔搬走；PO 的不碰；同名別人裝的不覆蓋
  let o = await run(wd, ['--agent', pg.ag, '--base', BASE, '--tool', 'claude', '--skills-only']);
  assert.equal(o.code, 0, o.out);
  assert.match(fs.readFileSync(path.join(own(pg, 'pg-rules'), 'SKILL.md'), 'utf8'), /pg-rules 的硬規則/, '有角色 → .aigile/<代號>/skills');
  assert.ok(!fs.existsSync(shared('pg-rules')), '共用區的舊角色技能（自己裝的）搬走');
  assert.ok(fs.existsSync(shared('po-rules')), '別人（PO）裝的不碰');
  assert.ok(!fs.existsSync(own(pg, 'po-rules')), 'PG 拿不到 PO 的角色技能');
  assert.equal(JSON.parse(fs.readFileSync(path.join(shared('common-tool'), '.aigile-skill.json'), 'utf8')).agent, po.ag, '同名別人裝的不覆蓋');
  assert.match(o.out, /common-tool（[^）]*已有不是你裝的同名技能，沒有覆蓋）/);
  assert.match(o.out, /角色技能 1 個在 \.aigile\/PG_[A-Z0-9]+\/skills（新對話開始時讀一次）/, '印出角色技能在哪');
  const man = JSON.parse(fs.readFileSync(path.join(wd, `.aigile/${pg.ag}/skills.json`), 'utf8'));
  assert.equal(path.resolve(wd, man['pg-rules'].dir), path.resolve(own(pg, 'pg-rules')), '清單記新位置');

  // 3. PO 同步：沒清單的舊檔也搬；沒角色的 common-tool 是自己裝的 → 更新到共用區
  o = await run(wd, ['--agent', po.ag, '--base', BASE, '--tool', 'claude', '--skills-only']);
  assert.equal(o.code, 0, o.out);
  assert.ok(fs.existsSync(path.join(own(po, 'po-rules'), 'SKILL.md')) && !fs.existsSync(shared('po-rules')), 'PO 的角色技能搬到它的代號資料夾（清單弄丟也搬）');
  assert.match(fs.readFileSync(path.join(shared('common-tool'), 'SKILL.md'), 'utf8'), /common-tool 的硬規則/, '沒角色 → 照 --tool 裝共用區（保留自動觸發）');
  assert.deepEqual(fs.readdirSync(path.join(wd, '.claude/skills')).sort(), ['common-tool'], '共用區只剩沒角色的');

  // 4. PG 再同步：沒變就不重裝；共用區同一版（PO 裝的）也算已裝
  o = await run(wd, ['--agent', pg.ag, '--base', BASE, '--skills-only']);
  assert.match(o.out, /新裝 0、更新 0、移除 0/, o.out);
  const lib = (await call(liu.token, '/api/projects/平台/skills')).body.items;
  assert.deepEqual(['common-tool', 'pg-rules', 'po-rules'].map(n => lib.find(x => x.name === n).install.installed), [2, 1, 1], '已裝數照新位置算');

  // 5. --tool other：本來就在代號資料夾，照舊
  const wo = fs.mkdtempSync(path.join(dataDir, 'o-'));
  fs.mkdirSync(path.join(wo, `.aigile/${pg.ag}`), { recursive: true }); fs.writeFileSync(path.join(wo, `.aigile/${pg.ag}/.token`), pg.tok);
  o = await run(wo, ['--agent', pg.ag, '--base', BASE, '--tool', 'other', '--skills-only']);
  assert.deepEqual(fs.readdirSync(path.join(wo, `.aigile/${pg.ag}/skills`)).sort(), ['common-tool', 'pg-rules'], 'other 全部在代號資料夾：' + o.out);

  // 6. 規格、接入設定寫了
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.match(spec, /有勾角色的一律裝 `\.aigile\/<代號>\/skills\/<名稱>\/`/, '規格 3.17 寫安裝位置');
  assert.match(spec, /SKILL\.md 只放硬規則與完成判定（約 1,500 字），範本另放 templates\.md/, '規格寫角色技能寫法建議');
  const ob = (await call(liu.token, `/api/my-ais/${pg.id}/onboarding`)).body.text;
  assert.match(ob, new RegExp(`新對話讀一次 \\.aigile/${pg.ag}/skills/\\*/SKILL\\.md（範本用到才讀）`), '第零節：新對話讀一次角色技能');
  assert.match(ob, /同步技能（角色技能裝在你的代號資料夾）/, '第四節：角色技能裝在代號資料夾');
  console.log('c387-test：全部通過');
} catch (e) {
  console.error('c387-test 失敗：', e.message, (e.stack || '').split('\n').find(l => l.includes('c387-test')) || '');
  process.exitCode = 1;
} finally {
  server.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
