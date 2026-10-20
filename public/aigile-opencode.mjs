#!/usr/bin/env node
// Aigile-Switch opencode 喚醒腳本（C-331）：watcher 的 WAKE_CMD 指向它。依「對話接續方式」決定接舊對話或開新對話，次數由它數，
// 不靠 AI 自己記得換新（行內事故：同一個對話叫醒到幾百回合，每回合重讀整段歷史）。零依賴，Node 18+。
//
// 用法（寫在 watcher.env）：WAKE_CMD=node .aigile/watcher/aigile-opencode.mjs --agent PG --mode auto
//   --mode auto   太長才換新（預設）：同一個對話叫醒滿 --every 次（預設 10）就開新對話
//   --mode fresh  每次叫醒都開新對話（最省；接續靠工作記憶）
//   --mode keep   一直接同一個對話（越長越貴）
// 狀態：.aigile/<代號>/opencode.json（目前對話編號、這個對話叫醒了幾次）；輸出附加到 .aigile/<代號>/wake.log
// 舊的 .aigile/<代號>/opencode-session（以前手動建的固定對話）：auto 會直接換新，keep 沿用。
// 不用 --continue（它接這個資料夾最近的對話，同資料夾有別的 AI 會接錯人）。OPENCODE_BIN 可指定 opencode 指令。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`)); return i < 0 ? def : args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1] ?? def; };
const AGENT = String(opt('agent', ''));
const MODE = ['auto', 'fresh', 'keep'].includes(opt('mode', 'auto')) ? opt('mode', 'auto') : 'auto';
const EVERY = Math.max(1, Number(opt('every', 10)) || 10);
if (!/^[A-Za-z0-9_-]+$/.test(AGENT)) { console.error('缺 --agent <代號>'); process.exit(40); }
const DIR = path.join('.aigile', AGENT);
const STATE = path.join(DIR, 'opencode.json'), LEGACY = path.join(DIR, 'opencode-session'), LOG = path.join(DIR, 'wake.log');
const BIN = process.env.OPENCODE_BIN || 'opencode';
const PROMPT = `You are Aigile agent ${AGENT}. Doorbell: read your saved Aigile notes, .aigile/${AGENT}/state.json and GET /api/me/state, run one round per section 4.1 of the Aigile spec, then stop.`;
fs.mkdirSync(DIR, { recursive: true });

const q = a => `"${String(a).replace(/"/g, '\\"')}"`;
const note = s => fs.appendFileSync(LOG, `${new Date().toISOString()} [aigile-opencode] ${s}\n`);
function oc(list, capture = false) {
  const cmd = `${BIN} ${list.map(q).join(' ')}`;
  if (capture) return spawnSync(cmd, { shell: true, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const fd = fs.openSync(LOG, 'a');
  try { return spawnSync(cmd, { shell: true, stdio: ['ignore', fd, fd] }); } finally { fs.closeSync(fd); }
}
let st = {};
try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
if (!st.session) { try { const old = fs.readFileSync(LEGACY, 'utf8').trim(); if (old) st = { session: old, wakes: MODE === 'auto' ? EVERY : 0, legacy: true }; } catch {} }
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));

function newSession() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const title = `aigile-${AGENT}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  note(`開新對話 ${title}（方式 ${MODE}${st.session ? `，舊對話叫醒 ${st.wakes || 0} 次` : ''}）`);
  const r = oc(['run', '--title', title, PROMPT]);
  const list = oc(['session', 'list', '--format', 'json'], true);
  let id = null;
  try { const j = JSON.parse(list.stdout); id = (Array.isArray(j) ? j : j.sessions || j.items || []).filter(s => s.title === title).map(s => s.id).pop() || null; } catch {}
  if (!id) note('WARN 找不到新對話的編號，下次叫醒會再開新對話');
  st = { session: id, wakes: 1, title, startedAt: d.toISOString() };
  save();
  if (id) fs.writeFileSync(LEGACY, id);
  return r.status ?? 1;
}

let code;
if (MODE === 'fresh') { note('每次新對話'); code = oc(['run', PROMPT]).status ?? 1; }
else if (st.session && (MODE === 'keep' || (st.wakes || 0) < EVERY)) {
  st.wakes = (st.wakes || 0) + 1; save();
  note(`接續對話 ${st.session}（第 ${st.wakes} 次${MODE === 'auto' ? `，滿 ${EVERY} 次換新` : ''}）`);
  code = oc(['run', '-s', st.session, PROMPT]).status ?? 1;
} else code = newSession();
process.exit(code);
