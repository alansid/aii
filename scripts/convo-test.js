// C-327 A 驗收測試：產生接入設定時選「對話接續方式」（太長才換新／每次新對話／一直接續），預設太長才換新
// 修正前：規格只教 opencode 永遠接同一個固定對話，對話越長每次叫醒越貴
// 用法：node scripts/convo-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-convo-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000' } });
const raw = (token, p, method = 'GET', body) => app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
const call = async (...a) => { const r = await raw(...a); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const len = s => [...s].length;

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const ob = async q => (await call(liu.token, `/api/my-ais/${ai.participantId}/onboarding${q}`)).body.text;

  const def = await ob('');
  assert.match(def, /對話接續（劉昱志 選的）：太長才換新，同一個對話叫醒滿 10 次就換新。opencode：WAKE_CMD=node \.aigile\/watcher\/aigile-opencode\.mjs --agent PG --mode auto/, '預設太長才換新，WAKE_CMD 照選的方式寫好');
  const fr = await ob('?convo=fresh&autoStandby=1');
  assert.match(fr, /對話接續（劉昱志 選的）：每次叫醒開新對話/); assert.match(fr, /--mode fresh/); assert.match(fr, /Claude Code 照規格 3\.12 用 claude -p/);
  assert.match(await ob('?convo=keep'), /一直接續同一個對話.*--mode keep/);
  assert.ok(!/100 回合/.test(def) && !/100 回合/.test(fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8')), 'UX 退回：機器數不到的「100 回合」拿掉');

  // UX 退回 C-331：「太長才換新」要真的有東西在數。用假的 opencode 跑 aigile-opencode.mjs
  const OC = fileURLToPath(new URL('../public/aigile-opencode.mjs', import.meta.url));
  const fake = path.join(dataDir, 'fake-opencode.mjs');
  fs.writeFileSync(fake, `import fs from 'node:fs';
const a = process.argv.slice(2); let s = { n: 0, sessions: [], calls: [] };
try { s = JSON.parse(fs.readFileSync('oc.json', 'utf8')); } catch {}
if (a[0] === 'run') {
  const ti = a.indexOf('--title'), si = a.indexOf('-s'); let id;
  if (a.includes('--continue')) id = 'CONTINUE';
  else if (ti >= 0) { id = 'ses_' + (++s.n); s.sessions.push({ id, title: a[ti + 1] }); }
  else if (si >= 0) id = a[si + 1]; else id = 'fresh_' + (++s.n);
  s.calls.push({ id, prompt: a[a.length - 1] }); fs.writeFileSync('oc.json', JSON.stringify(s));
} else if (a[0] === 'session') console.log(JSON.stringify(s.sessions));
`);
  const wake = (cwd, mode) => new Promise(r => execFile(process.execPath, [OC, '--agent', 'PG', '--mode', mode], { cwd, env: { ...process.env, OPENCODE_BIN: `"${process.execPath}" "${fake}"` } }, (e) => r(e ? e.code : 0)));
  const calls = d => JSON.parse(fs.readFileSync(path.join(d, 'oc.json'), 'utf8')).calls.map(c => c.id);
  const d1 = fs.mkdtempSync(path.join(dataDir, 'oc-'));
  for (let i = 0; i < 11; i++) assert.equal(await wake(d1, 'auto'), 0);
  const c1 = calls(d1);
  assert.deepEqual(c1.slice(0, 10), Array(10).fill('ses_1'), '前 10 次同一個對話');
  assert.equal(c1[10], 'ses_2', '第 11 次叫醒用新對話');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d1, '.aigile/PG/opencode.json'), 'utf8')).wakes, 1, '換新後重新數');
  assert.match(JSON.parse(fs.readFileSync(path.join(d1, 'oc.json'), 'utf8')).calls[0].prompt, /Aigile agent PG/, '提示帶代號');
  assert.match(fs.readFileSync(path.join(d1, '.aigile/PG/wake.log'), 'utf8'), /開新對話 aigile-PG-/, 'wake.log 記換新');
  // 舊的手動固定對話（事故那種長對話）：太長才換新直接換新；一直接續就沿用
  const d2 = fs.mkdtempSync(path.join(dataDir, 'oc-')); fs.mkdirSync(path.join(d2, '.aigile/PG'), { recursive: true }); fs.writeFileSync(path.join(d2, '.aigile/PG/opencode-session'), 'ses_old');
  await wake(d2, 'auto'); assert.deepEqual(calls(d2), ['ses_1'], '舊固定對話：auto 直接換新');
  const d3 = fs.mkdtempSync(path.join(dataDir, 'oc-')); fs.mkdirSync(path.join(d3, '.aigile/PG'), { recursive: true }); fs.writeFileSync(path.join(d3, '.aigile/PG/opencode-session'), 'ses_old');
  for (let i = 0; i < 12; i++) await wake(d3, 'keep');
  assert.deepEqual([...new Set(calls(d3))], ['ses_old'], 'keep 一直用同一個');
  const d4 = fs.mkdtempSync(path.join(dataDir, 'oc-'));
  await wake(d4, 'fresh'); await wake(d4, 'fresh');
  assert.deepEqual(calls(d4), ['fresh_1', 'fresh_2'], 'fresh 每次新對話，不用 -s、不用 --continue');
  assert.match(await ob('?convo=亂寫'), /太長才換新/, '不認得的值當預設');
  for (const q of ['', '?convo=fresh', '?convo=keep', '?convo=auto&autoStandby=1']) assert.ok(len(await ob(q)) <= 5000, `接入設定 ≤ 5,000 字（${q || '預設'}）`);

  // 短版接入：選的方式跟著一次性連結走
  const link = (await call(liu.token, `/api/my-ais/${ai.participantId}/onboarding-link`, 'POST', { autoStandby: true, convo: 'fresh' })).body;
  const text = await (await raw(null, new URL(link.url).pathname)).text();
  assert.match(text, /每次叫醒開新對話/, '短版接入也帶選的方式');

  // 規格寫三種與「每次新對話」的喚醒寫法；網頁選單預設太長才換新，Claude Code 選每次新對話要提醒
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.match(spec, /\*\*太長才換新\*\*（預設）/); assert.match(spec, /\*\*每次新對話\*\*/); assert.match(spec, /\*\*一直接續\*\*/);
  assert.match(spec, /WAKE_CMD=node \.aigile\/watcher\/aigile-opencode\.mjs --agent <代號> --mode/, '規格寫出 opencode 喚醒腳本');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /let convoMode = 'auto';/, '網頁預設太長才換新');
  assert.match(js, /Claude Code 選這個會在背景另開對話，你在畫面上看不到/, 'Claude Code 選每次新對話有提醒');
  assert.match(js, /onboarding\?convo=\$\{convoMode\}/, '完整接入設定帶選的方式');
  assert.match(js, /autoStandby: !!autoStandbyConsent, convo: convoMode/, '短版接入帶選的方式');
  console.log('convo-test：全部通過');
} catch (e) {
  console.error('convo-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
