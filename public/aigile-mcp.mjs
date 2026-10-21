#!/usr/bin/env node
// Aigile-Switch MCP 轉接（C-355）：把 Claude Code／Codex 的 stdio MCP 請求轉到平台 POST /api/mcp。零依賴，Node 22+。
//
// 每次請求都重讀 Token 檔：所屬人類重發 Token 後只要換 .aigile/<代號>/.token，不用改 MCP 設定、不用重開。
// Token 不放環境變數、不寫進 MCP 設定檔；這支腳本不印 Token。
//
// 用法（aigile-setup.mjs 會印出完整指令）：
//   node <絕對路徑>/.aigile/watcher/aigile-mcp.mjs --agent PG_XXXX [--base https://平台網址]
//   Token：這支腳本旁邊的 ../<代號>/.token；平台網址沒帶 --base 就讀 ../<代號>/watcher.env 的 AIGILE_BASE
//   代理：設 HTTPS_PROXY 並加 NODE_USE_ENV_PROXY=1
// stdout 只寫 MCP 回應（一行一則 JSON）；說明與錯誤寫 stderr。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = name => { const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`)); return i < 0 ? '' : args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1] || ''; };
const AGENT = opt('agent');
const HERE = path.dirname(fileURLToPath(import.meta.url)); // .aigile/watcher
const DIR = path.join(HERE, '..', AGENT || '_');
const log = msg => process.stderr.write(`[aigile-mcp] ${msg}\n`);
const envBase = () => { try { return /^AIGILE_BASE=(.*)$/m.exec(fs.readFileSync(path.join(DIR, 'watcher.env'), 'utf8'))?.[1].trim() || ''; } catch { return ''; } };
const BASE = (opt('base') || envBase()).replace(/\/+$/, '');
if (!AGENT || !BASE) { log(`缺 --agent，或找不到平台網址（--base 或 ${path.join(DIR, 'watcher.env')} 的 AIGILE_BASE）。先跑 aigile-setup.mjs`); process.exit(1); }
const TOKEN_FILE = path.join(DIR, '.token');

const send = text => process.stdout.write(text.trim() + '\n');
async function forward(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失敗' } })); }
  const id = Array.isArray(msg) ? null : msg?.id;
  const fail = message => (id === undefined || id === null ? log(message) : send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })));
  let token;
  try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return fail(`讀不到 Token 檔 ${TOKEN_FILE}`); }
  if (!token) return fail(`Token 檔是空的：${TOKEN_FILE}`);
  let r;
  try {
    r = await fetch(`${BASE}/api/mcp`, { method: 'POST', body: line, signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'X-Aigile-Source': 'mcp' } });
  } catch (e) { return fail(`連不到 ${BASE}（${e.cause?.code || e.name}）`); }
  if (r.status === 202) return; // 通知，不用回
  const text = await r.text();
  if (r.ok) return send(text);
  let why = text.slice(0, 200);
  try { const j = JSON.parse(text); if (j.jsonrpc) return send(text); why = `${j.error?.code}：${j.error?.message}`; } catch {}
  fail(`平台回 HTTP ${r.status}：${why}${r.status === 401 ? '（Token 失效：請所屬人類在網頁重發，換掉 .token 即可，不用改設定）' : ''}`);
}

const pending = new Set();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => { if (!line.trim()) return; const p = forward(line).catch(e => log(`轉送失敗：${e.message}`)).finally(() => pending.delete(p)); pending.add(p); });
rl.on('close', async () => { await Promise.allSettled([...pending]); process.exit(0); });
