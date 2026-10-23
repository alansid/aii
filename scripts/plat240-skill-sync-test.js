// PLAT-240 驗收測試：技能同步一次搞定（全部同步、每隻 AI 進度、通知合併、同步工具自己更新）
// 修正前：主人要每隻 AI 各按一次同步、看不到誰裝好了；每次上傳每隻 AI 各一則通知；
//   AI 用到 10/21 的舊 aigile-setup.mjs，把角色技能裝到共用區（同資料夾別的 AI 也載入），主人看不出來
// 測：全部同步（一次允許含腳本的、每隻一則叫醒私訊帶 --tool 與 SHA-256）、進度（等叫醒／同步中／已裝／失敗／離線／10 分鐘沒回應）、
//     ✓ 最新／● 有新版／⚠ 要處理、主人每次上傳一則通知、失敗才私訊、腳本跑前比對版本自己更新、規格 3.17
// 用法：node scripts/plat240-skill-sync-test.js
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
import { scriptHashes } from './script-hashes.mjs';

const pub = f => fileURLToPath(new URL('../public/' + f, import.meta.url));
const shaOf = b => crypto.createHash('sha256').update(b).digest('hex');
const SETUP_SHA = shaOf(fs.readFileSync(pub('aigile-setup.mjs')));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p240-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
// 腳本是獨立程序：開本機埠；aigile-setup.mjs 直接回 public 裡的檔（自我更新用）
const server = http.createServer(async (req, res) => {
  if (req.url === '/aigile-setup.mjs') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(pub('aigile-setup.mjs'))); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const run = (cwd, file, args) => new Promise(ok => execFile(process.execPath, [file, ...args], { cwd, env: { ...process.env, AIGILE_TOKEN: '', CLAUDECODE: '', CODEX_HOME: '', AIGILE_SETUP_UPDATED: '', AIGILE_CLAUDE_BIN: fileURLToPath(new URL('./fake-claude.mjs', import.meta.url)) } }, (e, out) => ok({ code: e ? e.code : 0, out })));
const skill = (name, extra = []) => [{ path: 'SKILL.md', text: `---\nname: ${name}\ndescription: ${name} 的說明\n---\n${name} 的規則\n` }, ...extra];
const ago = min => new Date(Date.now() - min * 60_000).toISOString();

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body; // 管理員
  const wang = (await call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body;
  await call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: wang.participant.participantId, projects: ['平台'] }] });
  const mkAi = async (owner, name, roleKey) => { const a = (await call(owner.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey, role: roleKey, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; assert.ok(a.participantId, JSON.stringify(a)); const row = await db.get('SELECT token, code FROM participants WHERE id = ?', a.participantId); return { id: a.participantId, tok: row.token, ag: `${roleKey}_${row.code}`, name }; };
  const pg1 = await mkAi(liu, 'PG一號', 'PG'), pg2 = await mkAi(liu, 'PG二號', 'PG'), po = await mkAi(liu, '平台PO', 'PO');
  const wpg = await mkAi(wang, '王的PG', 'PG');
  const up = (files, roles) => call(liu.token, '/api/projects/平台/skills', 'POST', { files, roles });
  const list = async (tok = liu.token) => (await call(tok, '/api/skill-sync')).body.items;
  const one = async id => (await list()).find(a => a.aiId === id);
  const beat = ai => app(new Request('http://localhost/api/notifications/count', { headers: { Authorization: `Bearer ${ai.tok}`, 'X-Aigile-Source': 'watcher' } }), 'http://localhost');
  await beat(pg1); await beat(pg2); // PG 一二號有 watcher 待命心跳，PO 沒有

  // 1. 上傳：主人只收一則通知「你有 N 隻 AI 會用到」＋同步清單連結
  await db.run("DELETE FROM dms WHERE from_id = 'system'");
  const r1 = await up(skill('pg-rules'), ['PG']);
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  const r2 = await up(skill('pg-tools', [{ path: 'scripts/run.sh', text: 'echo hi\n' }]), ['PG']); // 管理員傳的含腳本：直接上架
  assert.equal(r2.body.status, 'published');
  const tellLiu = await db.all("SELECT text, ai_id FROM dms WHERE from_id = 'system' AND human_id = ?", liu.participant.participantId);
  assert.equal(tellLiu.length, 2, '兩次上傳各一則（不是每隻 AI 一則）：' + JSON.stringify(tellLiu));
  assert.ok(tellLiu.every(d => d.text.includes('你有 2 隻 AI 會用到') && d.text.includes('/my-ai?sync=1') && d.text.includes('全部同步')), tellLiu[0].text);
  assert.equal((await db.all("SELECT 1 FROM dms WHERE from_id = 'system' AND human_id = ?", wang.participant.participantId)).length, 2, '王小明也是一次一則');

  // 2. 同步清單：每隻 AI × 每個技能；沒裝＝● 有新版；含腳本未允許＝等你允許
  let a1 = await one(pg1.id);
  assert.equal(a1.needs, true); assert.equal(a1.waitingAllow, 1);
  assert.deepEqual(a1.skills.map(s => [s.name, s.state]).sort(), [['pg-rules', 'new'], ['pg-tools', 'new']]);
  assert.equal(a1.skills.find(s => s.name === 'pg-tools').why, '含腳本，等你允許');
  assert.equal(a1.sync.state, 'idle'); assert.equal(a1.standby, true);
  assert.equal((await one(po.id)).skills.length, 0, 'PO 沒有 PG 技能');
  assert.equal((await one(po.id)).needs, false);
  assert.ok(!(await list()).some(a => a.aiId === wpg.id), '只列自己的 AI');
  assert.deepEqual((await call(liu.token, `/api/skill-sync?ids=${pg1.id},${wpg.id}`)).body.items.map(a => a.aiId), [pg1.id], '?ids 只看這幾隻（別人的不給）');
  assert.equal((await call(pg1.tok, '/api/skill-sync')).status, 403, 'AI 不能看主人的同步清單');

  // 3. 全部同步：一次允許含腳本的、每隻一則叫醒私訊（發送者是主人；帶 --skills-only、SHA-256；沒回報過工具＝提醒第一次加 --tool）
  assert.equal((await call(liu.token, '/api/skill-sync', 'POST', { aiIds: [pg1.id, wpg.id] })).status, 404, '別人的 AI 不能叫');
  assert.equal((await call(liu.token, '/api/skill-sync', 'POST', { aiIds: [po.id], allow: [{ aiId: po.id, skillId: r2.body.skillId }] })).status, 400, '允許的技能要是那隻 AI 會用到的');
  assert.equal((await call(liu.token, '/api/skill-sync', 'POST', { aiIds: [] })).status, 400);
  await db.run("DELETE FROM dms WHERE text LIKE '[技能同步]%'");
  const s1 = await call(liu.token, '/api/skill-sync', 'POST', { aiIds: [pg1.id, pg2.id, po.id], allow: [pg1.id, pg2.id].map(aiId => ({ aiId, skillId: r2.body.skillId })) });
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  assert.equal((await db.all('SELECT 1 FROM skill_allows WHERE skill_id = ?', r2.body.skillId)).length, 2, '一次允許兩隻');
  const wake = await db.all("SELECT ai_id, from_id, text FROM dms WHERE text LIKE '[技能同步]%'");
  assert.equal(wake.length, 3, '每隻一則叫醒');
  assert.ok(wake.every(d => d.from_id === liu.participant.participantId), '叫醒私訊發送者是主人（AI 要被叫醒）');
  const w1 = wake.find(d => d.ai_id === pg1.id).text;
  assert.ok(w1.includes(`--agent ${pg1.ag}`) && w1.includes('--skills-only') && w1.includes(SETUP_SHA) && w1.includes('第一次要加 --tool') && w1.includes('成功不用回我'), w1);
  const st = Object.fromEntries(s1.body.items.map(a => [a.aiId, a.sync.state]));
  assert.deepEqual(st, { [pg1.id]: 'waiting', [pg2.id]: 'waiting', [po.id]: 'offline' }, '在待命＝等叫醒；沒心跳＝離線');

  // 4. 真的跑同步（新版腳本）：開始回報 running、結束回報位置與工具版本 → ✓ 已裝、✓ 最新
  const wd = fs.mkdtempSync(path.join(dataDir, 'w-'));
  const put = (dir, ai) => { fs.mkdirSync(path.join(dir, `.aigile/${ai.ag}`), { recursive: true }); fs.writeFileSync(path.join(dir, `.aigile/${ai.ag}/.token`), ai.tok); };
  put(wd, pg1);
  const o1 = await run(wd, pub('aigile-setup.mjs'), ['--agent', pg1.ag, '--base', BASE, '--tool', 'claude', '--skills-only']);
  assert.equal(o1.code, 0, o1.out);
  a1 = await one(pg1.id);
  assert.equal(a1.sync.state, 'done', JSON.stringify(a1.sync));
  assert.ok(a1.sync.startedAt, '腳本開始時回報');
  assert.deepEqual(a1.skills.map(s => s.state), ['latest', 'latest'], JSON.stringify(a1.skills));
  assert.equal(a1.needs, false); assert.equal(a1.tool, 'claude'); assert.equal(a1.toolOld, false);
  const inst = await db.all('SELECT place FROM skill_installs WHERE ai_id = ?', pg1.id);
  assert.deepEqual(inst.map(x => x.place), ['own', 'own'], '角色技能回報裝在自己的代號資料夾');
  assert.equal((await db.get('SELECT setup_sha FROM skill_syncs WHERE ai_id = ?', pg1.id)).setup_sha, SETUP_SHA, '回報同步工具版本');
  // 下一次叫醒帶上次回報的 --tool
  await call(liu.token, `/api/my-ais/${pg1.id}/skills/sync`, 'POST');
  const w2 = (await db.all("SELECT text FROM dms WHERE ai_id = ? AND text LIKE '[技能同步]%' ORDER BY created_at DESC", pg1.id))[0].text;
  assert.ok(w2.includes(`--skills-only --tool claude`) && !w2.includes('第一次要加'), w2);
  assert.equal((await one(pg1.id)).sync.state, 'waiting', '舊的「同步」按鈕也記進度');

  // 5. 進度：同步中、10 分鐘沒回應（等叫醒或同步中都算）
  assert.equal((await call(pg2.tok, '/api/me/skills/sync-status', 'POST', { state: 'running', tool: 'codex' })).status, 200);
  assert.equal((await one(pg2.id)).sync.state, 'running');
  await db.run('UPDATE skill_syncs SET started_at = ? WHERE ai_id = ?', ago(11), pg2.id);
  await db.run('UPDATE skill_syncs SET requested_at = ? WHERE ai_id = ?', ago(12), pg2.id);
  assert.equal((await one(pg2.id)).sync.state, 'noreply', '同步中超過 10 分鐘');
  await db.run('UPDATE skill_syncs SET requested_at = ?, started_at = NULL, finished_at = NULL WHERE ai_id = ?', ago(11), pg1.id);
  assert.equal((await one(pg1.id)).sync.state, 'noreply', '叫醒 10 分鐘沒開始');
  assert.equal((await call(pg2.tok, '/api/me/skills/sync-status', 'POST', { state: 'done' })).status, 400);

  // 6. 失敗：腳本回報最後一行 → 清單顯示、平台私訊主人一則（成功不私訊）
  const before = (await db.all("SELECT 1 FROM dms WHERE from_id = 'system' AND text LIKE '%同步技能失敗%'")).length;
  assert.equal(before, 0, '成功不私訊主人');
  put(wd, pg2);
  const o2 = await run(wd, pub('aigile-setup.mjs'), ['--agent', pg2.ag, '--base', BASE, '--tool', 'bogus', '--skills-only']);
  assert.equal(o2.code, 1, o2.out);
  const a2 = await one(pg2.id);
  assert.equal(a2.sync.state, 'failed'); assert.match(a2.sync.lastLine, /技能：--tool 只能是 claude、codex、other/, a2.sync.lastLine);
  const fd = await db.all("SELECT human_id, text FROM dms WHERE from_id = 'system' AND text LIKE '%同步技能失敗%'");
  assert.equal(fd.length, 1); assert.equal(fd[0].human_id, liu.participant.participantId);
  assert.ok(fd[0].text.includes('PG二號') && fd[0].text.includes('/my-ai?sync=1'), fd[0].text);
  await call(pg2.tok, '/api/me/skills/sync-status', 'POST', { state: 'failed', lastLine: `Token 是 ${pg2.tok}` });
  assert.ok(!(await one(pg2.id)).sync.lastLine.includes(pg2.tok), '最後一行含 Token 不存');

  // 7. ⚠ 要處理：舊腳本（不回報工具版本）＝同步工具太舊；角色技能裝在共用區
  const ids = (await one(pg2.id)).skills.map(s => s.skillId);
  await call(pg2.tok, '/api/me/skills/installed', 'POST', { skillIds: ids }); // 10/21 舊腳本的回報
  let a3 = await one(pg2.id);
  assert.equal(a3.toolOld, true); assert.equal(a3.sync.state, 'done');
  assert.ok(a3.skills.every(s => s.state === 'fix' && /同步工具太舊/.test(s.why)), JSON.stringify(a3.skills));
  await call(pg2.tok, '/api/me/skills/installed', 'POST', { skillIds: ids, places: { [ids[0]]: 'shared', [ids[1]]: 'own' }, tool: 'claude', setupSha: SETUP_SHA });
  a3 = await one(pg2.id);
  assert.deepEqual(a3.skills.map(s => s.state), ['fix', 'latest']); assert.match(a3.skills[0].why, /角色技能裝在共用區/);
  // 有新版：已裝舊版＝● 有新版（寫出舊版號）
  const r3 = await up(skill('pg-rules').map(f => ({ ...f, text: f.text + '第二版\n' })), ['PG']);
  a1 = await one(pg1.id);
  const rules = a1.skills.find(s => s.name === 'pg-rules');
  assert.equal(rules.version, 2); assert.equal(rules.state, 'new'); assert.equal(rules.why, '已裝第 1 版，有第 2 版');
  assert.equal(r3.status, 201);
  // 下架：要移除的列出來
  await call(liu.token, '/api/projects/平台/skills/pg-tools/remove', 'POST');
  a1 = await one(pg1.id);
  assert.deepEqual(a1.removed, ['pg-tools']); assert.equal(a1.needs, true);
  assert.ok((await db.all("SELECT text FROM dms WHERE from_id = 'system' AND text LIKE '%下架%'")).some(d => d.text.includes('你有 2 隻 AI 裝過')), '下架也是一人一則');
  // 我的 AI › 技能：每個技能帶狀態
  const mine = (await call(liu.token, `/api/my-ais/${pg1.id}/skills`)).body;
  assert.equal(mine.items[0].state, 'new'); assert.deepEqual(mine.removed, ['pg-tools']);

  // 8. 同步工具自己更新：舊版 aigile-setup.mjs 跑前比對平台的 SHA-256 → 下載、核對、用新版重跑
  const wd2 = fs.mkdtempSync(path.join(dataDir, 'w-'));
  put(wd2, pg1);
  fs.mkdirSync(path.join(wd2, '.aigile/watcher'), { recursive: true });
  const old = path.join(wd2, '.aigile/watcher/aigile-setup.mjs');
  fs.writeFileSync(old, fs.readFileSync(pub('aigile-setup.mjs'), 'utf8') + '\n// 舊版\n');
  const o3 = await run(wd2, old, ['--agent', pg1.ag, '--base', BASE, '--tool', 'claude', '--skills-only']);
  assert.equal(o3.code, 0, o3.out);
  assert.match(o3.out, /同步工具跟平台版本不同，已下載新版（SHA-256 相符），用新版重跑/, o3.out);
  assert.match(o3.out, /完成：技能已同步/, '新版接著同步完');
  assert.equal(shaOf(fs.readFileSync(old)), SETUP_SHA, '檔案換成平台版本');
  a1 = await one(pg1.id);
  assert.equal(a1.sync.state, 'done'); assert.equal(a1.needs, false, JSON.stringify(a1));
  assert.ok(!fs.existsSync(path.join(wd2, `.aigile/${pg1.ag}/skills/pg-tools`)), '下架的移除了');

  // 9. 規格 3.17
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.match(spec, /成功不用回覆/); assert.match(spec, /先核對 `\.aigile\/watcher\/aigile-setup\.mjs`/);
  assert.ok([...spec].length <= 20000, '規格 2 萬字內');
  console.log('plat240-skill-sync-test：全部通過');
} catch (e) {
  console.error('plat240-skill-sync-test 失敗：', e.message, (e.stack || '').split('\n').find(l => l.includes('plat240-skill-sync-test')) || '');
  process.exitCode = 1;
} finally {
  server.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
