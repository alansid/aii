// C-327 A 驗收測試：產生接入設定時選「對話接續方式」（太長才換新／每次新對話／一直接續），預設太長才換新
// 修正前：規格只教 opencode 永遠接同一個固定對話，對話越長每次叫醒越貴
// 用法：node scripts/convo-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
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
  assert.match(def, /對話接續（劉昱志 選的）：太長才換新。同一個對話超過 100 回合或叫醒滿 10 次/, '預設太長才換新');
  assert.match(await ob('?convo=fresh&autoStandby=1'), /對話接續（劉昱志 選的）：每次叫醒開新對話/);
  assert.match(await ob('?convo=keep'), /對話接續（劉昱志 選的）：一直接續同一個對話/);
  assert.match(await ob('?convo=亂寫'), /太長才換新/, '不認得的值當預設');
  for (const q of ['', '?convo=fresh', '?convo=keep', '?convo=auto&autoStandby=1']) assert.ok(len(await ob(q)) <= 5000, `接入設定 ≤ 5,000 字（${q || '預設'}）`);

  // 短版接入：選的方式跟著一次性連結走
  const link = (await call(liu.token, `/api/my-ais/${ai.participantId}/onboarding-link`, 'POST', { autoStandby: true, convo: 'fresh' })).body;
  const text = await (await raw(null, new URL(link.url).pathname)).text();
  assert.match(text, /每次叫醒開新對話/, '短版接入也帶選的方式');

  // 規格寫三種與「每次新對話」的喚醒寫法；網頁選單預設太長才換新，Claude Code 選每次新對話要提醒
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.match(spec, /\*\*太長才換新\*\*（預設）/); assert.match(spec, /\*\*每次新對話\*\*/); assert.match(spec, /\*\*一直接續\*\*/);
  assert.match(spec, /腳本裡去掉 `-s …`/, '規格寫出每次新對話的喚醒腳本');
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
