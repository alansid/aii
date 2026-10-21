// C-356 重現測試：Codex 沒開網路時，連規格都下載不到 → 開網路的說明與症狀要寫在 AI 直接拿到的文字裡
// 修正前：短版只寫「curl 錯誤 7」、沒寫 127.0.0.1:9／連線被拒；完整版只說「見規格 3.12」（AI 下載不到規格，看不到解法）
// （改用 node 下載、SEC_E_NO_CREDENTIALS 症狀：昱志 10/21 說先不做，等他 Codex 實測）
// 用法：node scripts/c356-test.js [要測的 app.js 路徑]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const js = fs.readFileSync(process.argv[2] || new URL('../public/app.js', import.meta.url), 'utf8');
const i0 = js.indexOf('  function shortOnboardingText'), i1 = js.indexOf('\n  }\n', i0) + 4;
const shortOnboardingText = new Function('state', `${js.slice(i0, i1)}; return shortOnboardingText;`)({ me: { name: '劉昱志' } });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-c356-'));

try {
  // 短版：Codex 開網路寫在下載之前；症狀寫清楚；不是代理
  const text = shortOnboardingText({ name: 'codex-pg', role: 'PG' }, { agent: 'PG_ABCD', url: 'https://x/api/setup/abc' });
  assert.match(text, /sandbox_mode = "workspace-write"/, '貼上的文字就有 sandbox 設定');
  assert.match(text, /network_access = true/, '貼上的文字就有 network_access');
  assert.ok(text.indexOf('network_access') < text.indexOf('curl -s'), '開網路寫在下載之前');
  for (const k of ['127.0.0.1:9', 'curl 錯誤 7', '連線被拒']) assert.ok(text.includes(k), '短版寫出症狀：' + k);
  assert.match(text, /不是代理/, '叫 AI 別說成代理問題');
  assert.match(text, /開 network_access 後重開 Codex/, '告訴主人的那句話寫好');

  // 完整接入設定：第三節第 1 步就寫（不靠規格，AI 這時還下載不到規格）
  const db = openNodeDb(path.join(dataDir, 'switch.db'));
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000' } });
  const call = async (token, p, method = 'GET', body) => { const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost'); return r.json(); };
  const liu = await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' });
  const ai = await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name: 'codex-pg', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' });
  const ob = (await call(liu.token, `/api/my-ais/${ai.participantId}/onboarding`)).text;
  const step1 = /\n1\. 確認能呼叫 HTTP API[^\n]*/.exec(ob)?.[0] || '';
  for (const k of ['127.0.0.1:9', 'curl 錯誤 7', '連線被拒', '不是代理', 'sandbox_mode = "workspace-write"', 'network_access = true']) assert.ok(step1.includes(k), '完整版第三節第 1 步有：' + k);
  assert.ok([...ob].length <= 5000, '接入設定仍在 5,000 字內');
  console.log('c356-test：全部通過');
} catch (e) {
  console.error('c356-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
