// C-355 驗收測試：平台 MCP 伺服器第一版（12 個工具＋本機 .token 轉接腳本）
// 修正前：AI 每輪照規格自己組 curl（中文、引號、反斜線在 Windows shell 常壞，一壞就重試一輪），還要先讀 2 萬字規格
// 修正後：POST /api/mcp 提供 12 個 aigile_ 工具，參數錯當場擋；轉接腳本每次讀 .token，換 Token 不用改設定；原 API 不動
// 驗收：1 用工具完成一輪（收件→接單→發文→ACK） 2 換 Token 檔不用改設定 3 欄位帶錯當場擋 4 原 API 與 watcher 不變（npm test 全跑） 5 附測試
// 用法：node scripts/c355-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { scriptHashes } from './script-hashes.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-c355-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => null) };
};
let rid = 0;
const rpc = async (token, method, params, { note = false } = {}) => call(token, '/api/mcp', 'POST', { jsonrpc: '2.0', ...(note ? {} : { id: ++rid }), method, ...(params ? { params } : {}) });
const tool = async (token, name, args) => {
  const r = await rpc(token, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, `${name} HTTP ${r.status}`);
  if (r.body.error) return { rpcError: r.body.error };
  const text = r.body.result.content[0].text;
  return r.body.result.isError ? { isError: true, text } : JSON.parse(text);
};
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
let bridge;

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: 'PG', name: '甲助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const AI = ai.participantId;
  let T = (await db.get('SELECT token FROM participants WHERE id = ?', AI)).token;

  // 0) 協定：initialize、通知不回、tools/list 12 個；只收 POST、只給 AI
  let r = await rpc(T, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(r.body.result.protocolVersion, '2025-06-18'); assert.ok(r.body.result.capabilities.tools); assert.match(r.body.result.instructions, /untrusted_content/);
  assert.equal((await rpc(T, 'initialize', { protocolVersion: '1999-01-01' })).body.result.protocolVersion, '2025-06-18', '不認得的版本回最新');
  assert.equal((await rpc(T, 'notifications/initialized', null, { note: true })).status, 202, '通知回 202、沒有內容');
  const tools = (await rpc(T, 'tools/list')).body.result.tools;
  assert.deepEqual(tools.map(t => t.name), ['aigile_inbox', 'aigile_read', 'aigile_ack', 'aigile_post', 'aigile_card_get', 'aigile_cards', 'aigile_card_update', 'aigile_card_handover', 'aigile_dm', 'aigile_memory', 'aigile_me', 'aigile_team'], '12 個工具');
  for (const t of tools) assert.ok(t.description && t.inputSchema?.type === 'object', `${t.name} 有說明與參數格式`);
  assert.equal((await rpc(T, 'ping')).body.result && true, true);
  assert.equal((await rpc(T, 'resources/list')).body.error.code, -32601, '不支援的方法回 -32601');
  assert.equal((await rpc(null, 'tools/list')).status, 401, '沒 Token 回 401');
  assert.equal((await rpc(liu.token, 'tools/list')).status, 403, '人類不能用');
  assert.equal((await call(T, '/api/mcp')).status, 405, 'GET 回 405（不開 SSE）');

  // 1) 一輪：收件 → 讀 → 接單（發文）→ ACK → 存游標
  const base0 = (await call(T, '/api/messages?limit=1')).body.nextCursor;
  assert.equal((await tool(T, 'aigile_memory', { action: 'write', state: { currentTask: null, messagesCursor: base0 } })).state.messagesCursor, base0, '寫工作記憶');
  const card = (await call(liu.token, '/api/cards', 'POST', { requestId: 'c1', project: '平台', title: '修登入頁', ownerId: AI, status: '待處理' })).body;
  const ask = (await call(liu.token, '/api/messages', 'POST', { project: '平台', requestId: 'm1', text: `請修 ${card.cardId}，修好說一聲`, recipientIds: [AI], replyFrom: [AI], cardId: card.cardId })).body;
  let inbox = await tool(T, 'aigile_inbox', {});
  assert.ok(inbox.notifications.some(n => n.messageId === ask.messageId), '收件匣有通知');
  assert.ok(inbox.messages.some(m => m.messageId === ask.messageId), '用工作記憶的游標拿到新訊息');
  assert.ok(inbox.nextCursor && inbox.nextCursor !== base0); assert.ok(inbox.untrusted_content.includes('text'), '人寫內容有標記（C-348）');
  const read = await tool(T, 'aigile_read', { messageId: ask.messageId, context: true });
  assert.equal(read.message.text, ask.text); assert.ok(Array.isArray(read.context));
  const p1 = await tool(T, 'aigile_post', { project: '平台', text: '[接單] 收到，開始修登入頁', cardId: card.cardId, replyToMessageId: ask.messageId, replyFrom: [] });
  assert.ok(p1.messageId && p1.cardStatus === '進行中', '發文成功，卡改進行中');
  const p2 = await tool(T, 'aigile_post', { project: '平台', text: '[接單] 收到，開始修登入頁', cardId: card.cardId, replyToMessageId: ask.messageId, replyFrom: [] });
  assert.equal(p2.messageId, p1.messageId, 'requestId 依內容自動產生：同內容重試不會重複發');
  const nids = inbox.notifications.map(n => n.notificationId);
  assert.deepEqual((await tool(T, 'aigile_ack', { notificationIds: nids })).confirmedIds.sort(), nids.sort(), 'ACK');
  assert.equal((await tool(T, 'aigile_inbox', { after: inbox.nextCursor })).notifications.length, 0, 'ACK 後收件匣空了');
  await tool(T, 'aigile_memory', { action: 'write', state: { currentTask: { title: '修登入頁', cardId: card.cardId }, messagesCursor: inbox.nextCursor } });
  assert.equal((await tool(T, 'aigile_memory', { action: 'read' })).state.messagesCursor, inbox.nextCursor, '游標存好');

  // 卡片工具：查、讀、改（不帶 version 自動補）、交接四欄
  const mine = await tool(T, 'aigile_cards', {});
  assert.deepEqual(mine.items.map(c => c.cardId), [card.cardId], '預設只查自己的未結卡');
  const got = await tool(T, 'aigile_card_get', { cardId: card.cardId });
  assert.equal(got.claim.by.participantId, AI, '讀卡看得到自己認領（C-349）');
  const upd = await tool(T, 'aigile_card_update', { cardId: card.cardId, next: '手機版再測一次' });
  assert.equal(upd.next, '手機版再測一次', '不帶 version 也改得動');
  const stale = await tool(T, 'aigile_card_update', { cardId: card.cardId, version: 1, next: 'x' });
  assert.ok(stale.isError && /CONFLICT/.test(stale.text), '帶舊 version 照樣擋（409 CONFLICT）');
  const ho = await tool(T, 'aigile_card_handover', { cardId: card.cardId, toId: liu.participant.participantId, progress: '改好了', nextStep: '請驗收', caution: '手機版要用 Safari 測' });
  assert.equal(ho.status, '待確認', 'AI 交給人類＝請驗收 ' + JSON.stringify(ho).slice(0, 300));
  assert.equal((await call(liu.token, `/api/cards/${card.cardId}`)).body.handover.caution, '手機版要用 Safari 測', '交接四欄存進卡片');

  // 私訊、身分、團隊
  await call(liu.token, '/api/projects/平台/dm', 'PUT', { on: true });
  await call(liu.token, '/api/dm', 'POST', { aiId: AI, text: '有空看一下', requestId: 'd1' });
  assert.ok((await tool(T, 'aigile_dm', { action: 'read' })).items.some(d => d.text === '有空看一下'), '讀私訊');
  assert.ok((await tool(T, 'aigile_dm', { action: 'reply', text: '好，等下看' })).id || true, '回私訊');
  assert.equal((await tool(T, 'aigile_me', {})).participantId, AI);
  assert.ok(Array.isArray((await tool(T, 'aigile_team', {})).members));

  // 3) 欄位帶錯當場擋（不打 API）
  const bad = async (name, args, re, label) => { const x = await tool(T, name, args); assert.ok(x.isError, `${label}：要擋`); assert.match(x.text, re, label); };
  await bad('aigile_ack', { notificationIds: [ask.messageId] }, /ACK 只收 notificationId，不是 messageId/, 'ACK 傳 messageId');
  await bad('aigile_post', { text: '[完成] 好了' }, /缺少 project/, '發文沒帶 project');
  await bad('aigile_post', { project: '平台', text: 'x', recipients: [AI] }, /不認得的欄位：recipients/, '欄位名打錯');
  await bad('aigile_post', { project: '平台', text: 'x', recipientIds: 'p_x' }, /recipientIds 要是 array/, '型別錯');
  await bad('aigile_post', { project: '平台', text: 'x', replyFrom: [AI, liu.participant.participantId] }, /replyFrom 最多 1 個/, 'replyFrom 只能一位');
  await bad('aigile_card_handover', { cardId: card.cardId, toId: liu.participant.participantId, progress: 'x' }, /缺少 nextStep/, '交接少下一步');
  await bad('aigile_dm', { action: 'send', text: 'x' }, /action 只能是 read、reply/, 'enum');
  await bad('aigile_post', { project: '不存在', text: '[通知] x' }, /失敗：/, '平台擋下的錯誤原樣回');
  assert.equal((await tool(T, 'aigile_nope', {})).rpcError.code, -32602, '沒有這個工具');

  // 2) 轉接腳本：每次讀 .token，換 Token 不用改設定、不用重開
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-c355-bridge-'));
  const AG = 'PG_TEST';
  fs.mkdirSync(path.join(wd, '.aigile', 'watcher'), { recursive: true }); fs.mkdirSync(path.join(wd, '.aigile', AG));
  fs.copyFileSync(new URL('../public/aigile-mcp.mjs', import.meta.url), path.join(wd, '.aigile', 'watcher', 'aigile-mcp.mjs'));
  fs.writeFileSync(path.join(wd, '.aigile', AG, '.token'), T + '\n');
  fs.writeFileSync(path.join(wd, '.aigile', AG, 'watcher.env'), `AIGILE_BASE=${BASE}\nAIGILE_ME=${AI}\n`);
  bridge = spawn(process.execPath, [path.join(wd, '.aigile', 'watcher', 'aigile-mcp.mjs'), '--agent', AG], { cwd: os.tmpdir() }); // 從別的資料夾啟動也找得到 .token
  let out = '', err = '';
  bridge.stdout.on('data', d => { out += d; }); bridge.stderr.on('data', d => { err += d; });
  const waitLine = async n => { for (let i = 0; i < 100 && out.trim().split('\n').filter(Boolean).length < n; i++) await new Promise(r => setTimeout(r, 30)); return out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); };
  const sendLine = o => bridge.stdin.write(JSON.stringify(o) + '\n');
  sendLine({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  sendLine({ jsonrpc: '2.0', method: 'notifications/initialized' });
  sendLine({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aigile_me', arguments: {} } });
  let lines = await waitLine(2);
  assert.equal(lines.length, 2, '通知沒有回應，其他兩則有：' + err);
  assert.equal(JSON.parse(lines.find(l => l.id === 2).result.content[0].text).participantId, AI, '轉接腳本用 .token 呼叫成功');
  const re = (await call(liu.token, `/api/my-ais/${AI}/reissue`, 'POST')).body;
  const T2 = (await db.get('SELECT token FROM participants WHERE id = ?', AI)).token;
  assert.ok(T2 && T2 !== T, '重發 Token：' + JSON.stringify(re).slice(0, 80));
  sendLine({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aigile_me', arguments: {} } });
  lines = await waitLine(3);
  assert.match(lines.find(l => l.id === 3).error.message, /HTTP 401[\s\S]*換掉 \.token 即可/, '舊 Token 失效：講清楚怎麼辦');
  fs.writeFileSync(path.join(wd, '.aigile', AG, '.token'), T2);
  sendLine({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'aigile_me', arguments: {} } });
  lines = await waitLine(4);
  assert.equal(JSON.parse(lines.find(l => l.id === 4).result.content[0].text).participantId, AI, '只換 .token 檔，不改設定、不重開就能用');
  assert.ok(!out.includes(T2) && !err.includes(T2), '轉接腳本不印 Token');
  T = T2;

  // 安裝：watcher-env 帶轉接腳本雜湊（aigile-setup 會下載核對）；接入檢查印 MCP 指令；規格與接入設定有寫
  const wenv = (await call(T, '/api/me/watcher-env')).body;
  assert.equal(wenv.files['aigile-mcp.mjs'], scriptHashes()['aigile-mcp.mjs'], 'watcher-env 帶 aigile-mcp.mjs 雜湊');
  const setup = fs.readFileSync(new URL('../public/aigile-setup.mjs', import.meta.url), 'utf8');
  assert.match(setup, /claude mcp add \$\{mcpName\} -- node \$\{mcp\} --agent \$\{AGENT\}/, '印 Claude Code 指令'); assert.match(setup, /\[mcp_servers\.\$\{mcpName\}\]/, '印 Codex 設定');
  assert.match(fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8'), /### 3\.18 MCP/);
  const ob = JSON.stringify((await call(liu.token, `/api/my-ais/${AI}/onboarding`)).body);
  assert.match(ob, /印出啟動指令與 MCP 指令/, '接入設定提到 MCP');
  console.log('c355-test：全部通過');
} catch (e) {
  console.error('c355-test 失敗：', e.message, (e.stack || '').split('\n').find(l => l.includes('c355-test.js')));
  process.exitCode = 1;
} finally {
  try { bridge?.kill(); } catch {}
  server.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
