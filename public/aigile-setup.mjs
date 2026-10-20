#!/usr/bin/env node
// Aigile-Switch 接入檢查（C-327 C1）：一個指令做完接入的機械步驟，省掉 AI 反覆試錯的回合。零依賴，Node 22+。
//
// 做的事（每步印一行，最後印啟動指令；不印 Token）：
//   1. Node 版本   2. 用 Token 呼叫 GET /api/me 核對身分（401＝Token 失效）
//   3. 下載 watcher.mjs、aigile-wait.mjs 到 .aigile/watcher/ 並核對 SHA-256（已存在且相符就不動）
//   4. 寫 .aigile/<代號>/watcher.env：沒有就建；舊的缺 BELL_FILE、PID_FILE 等就補上，你改過的 WAKE_CMD 保留
//   5. git 資料夾就確認 .gitignore 有 .aigile/（沒有就補一行）
//   6. watcher 已在跑、但檔案或設定剛更新 → 提醒要重開（不會自己停掉它）
// 不會啟動 watcher、不會發文、不會改平台上的任何資料。
//
// 用法：node aigile-setup.mjs --agent PG --base https://平台網址
//   Token 先讀 .aigile/<代號>/.token；沒有檔才用環境變數 AIGILE_TOKEN_<代號>（例 AIGILE_TOKEN_PG）或 AIGILE_TOKEN。
//   環境變數跟檔案不一樣會提醒（舊的環境變數會蓋掉 watcher 讀的檔案，換了 Token 還是 401）。代理：設 HTTPS_PROXY 並加 NODE_USE_ENV_PROXY=1。
// 結束碼：0 全部完成；1 某一步失敗（最後一行寫卡在哪、怎麼辦，照著告訴所屬人類，不要自己換寫法重試）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const opt = name => { const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`)); return i < 0 ? '' : args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1] || ''; };
const AGENT = opt('agent');
const DIR = path.join('.aigile', AGENT || '_');
const BASE = (opt('base') || process.env.AIGILE_BASE || '').replace(/\/+$/, '');
const out = s => console.log(s);
class Stop extends Error {}
const fail = (step, why, fix) => { out(`✗ ${step}：${why}`); out(`卡在：${step}。怎麼辦：${fix}`); throw new Stop(); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

try {
if (!AGENT || !BASE) fail('參數', '缺 --agent 或 --base', '照接入設定第四節的指令原樣執行');
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) fail('Node 版本', `目前 ${process.versions.node}，要 22 以上`, '請所屬人類安裝 Node 22 以上');
out(`✓ Node ${process.versions.node}`);

let fileTok = ''; try { fileTok = fs.readFileSync(path.join(DIR, '.token'), 'utf8').trim(); } catch {}
const envName = [`AIGILE_TOKEN_${AGENT}`, 'AIGILE_TOKEN'].find(k => process.env[k]?.trim());
const envTok = envName ? process.env[envName].trim() : '';
const TOKEN = fileTok || envTok;
const head = t => t.slice(0, 4) + '…';
if (TOKEN) out(`✓ Token 來源：${fileTok ? `${DIR}/.token` : envName}（開頭 ${head(TOKEN)}）`);
if (fileTok && envTok && envTok !== fileTok) out(`! 環境變數 ${envName}（開頭 ${head(envTok)}）跟 .token 不一樣，已用 .token；請清掉舊的環境變數（它會蓋掉 watcher 與等待腳本讀的檔案）`);
if (!TOKEN) fail('Token', `找不到 ${DIR}/.token，也沒有 AIGILE_TOKEN_${AGENT}`, `先把接入設定裡的 Token 存成 ${DIR}/.token`);

const get = async p => {
  let r;
  try { r = await fetch(BASE + p, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Aigile-Source': 'setup' }, signal: AbortSignal.timeout(20_000) }); }
  catch (e) { fail('連線', `連不到 ${BASE}（${e.cause?.code || e.name}）`, '公司網路多半要代理：請所屬人類提供 HTTPS_PROXY，加上 NODE_USE_ENV_PROXY=1 再跑一次'); }
  if (r.status === 401) {
    const err = (await r.json().catch(() => null))?.error;
    if (!err) fail('Token', '401，但回應不是平台的（多半是公司代理擋的）', '把這行告訴所屬人類，請行內網路確認代理設定');
    if (/缺少 Authorization/.test(err.message)) fail('Token', `平台沒收到 Token（401 ${err.code}：${err.message}）`, '公司代理可能拿掉了 Authorization 標頭，請所屬人類找行內網路確認');
    fail('Token', `平台不認得這組 Token（401 ${err.code}：${err.message}；用的是開頭 ${head(TOKEN)}）`, '確認開頭跟網頁「我的 AI」最新重發的一致、網址是正式站不是 POC 站；不一致請所屬人類重發 Token，換掉 .token 再跑一次');
  }
  if (!r.ok) fail('連線', `${p} 回 HTTP ${r.status}`, '把這行告訴所屬人類');
  return r;
};

const me = await (await get('/api/me')).json();
if (me.memberType !== 'ai') fail('身分', '這個 Token 不是 AI 的', '確認 .token 存的是你自己的 Token');
out(`✓ 身分：${me.name}（${me.participantId}）`);

const cfg = await (await get('/api/me/watcher-env')).json();
if (cfg.agent && cfg.agent !== AGENT) fail('代號', `你的代號是 ${cfg.agent}，不是 ${AGENT}`, `把 Token 移到 .aigile/${cfg.agent}/.token，改用 --agent ${cfg.agent} 再跑一次（舊代號資料夾可能是別的 AI 的，不要動）`);
fs.mkdirSync(path.join('.aigile', 'watcher'), { recursive: true });
let changed = false;
for (const [f, want] of Object.entries(cfg.files)) {
  const dest = path.join('.aigile', 'watcher', f);
  let have = null; try { have = sha(fs.readFileSync(dest)); } catch {}
  if (have === want) { out(`✓ ${f} 已是最新`); continue; }
  const r = await fetch(`${BASE}/${f}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  const buf = r?.ok ? Buffer.from(await r.arrayBuffer()) : null;
  if (!buf) fail('下載', `${f} 下載失敗`, '請所屬人類照規格 3.12 自己下載');
  if (sha(buf) !== want) fail('核對', `${f} 的 SHA-256 跟平台給的不一樣`, '不要執行這個檔，告訴所屬人類');
  fs.writeFileSync(dest, buf); changed = true;
  out(`✓ ${f} ${have ? '已更新' : '已下載'}，SHA-256 相符`);
}

// watcher.env：平台給的是標準內容；本機已有的值（例如改過的 WAKE_CMD）保留，缺的補上
fs.mkdirSync(DIR, { recursive: true });
const envPath = path.join(DIR, 'watcher.env');
const parse = t => new Map(t.split(/\r?\n/).map(l => /^\s*([A-Z_]+)=(.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2]]));
let old = null; try { old = parse(fs.readFileSync(envPath, 'utf8')); } catch {}
const std = parse(cfg.env);
const merged = new Map(std);
if (old) for (const [k, v] of old) if (k === 'WAKE_CMD' || !std.has(k)) merged.set(k, v);
const added = old ? [...std.keys()].filter(k => !old.has(k)) : [];
const fixed = old ? ['AIGILE_BASE', 'AIGILE_ME'].filter(k => old.has(k) && old.get(k) !== std.get(k)) : [];
if (!old || added.length || fixed.length) {
  fs.writeFileSync(envPath, [...merged].map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  changed = true;
  out(old ? `✓ ${envPath} 補上 ${[...added, ...fixed].join('、')}` : `✓ 已建 ${envPath}`);
} else out(`✓ ${envPath} 完整`);

if (fs.existsSync('.git')) {
  let gi = ''; try { gi = fs.readFileSync('.gitignore', 'utf8'); } catch {}
  if (!/^\/?\.aigile\/?\s*$/m.test(gi)) { fs.appendFileSync('.gitignore', (gi && !gi.endsWith('\n') ? '\n' : '') + '.aigile/\n'); out('✓ .gitignore 補上 .aigile/'); }
  else out('✓ .gitignore 已有 .aigile/');
}

let pid = 0; try { pid = Number(fs.readFileSync(path.join(DIR, 'watcher.pid'), 'utf8').trim()); } catch {}
const running = pid > 0 && alive(pid);
const envArg = `--env-file=${envPath.replace(/\\/g, '/')}`;
out('');
if (running && changed) out(`! watcher（程序 ${pid}）用的是舊檔或舊設定：先停掉它，再用下面的指令重開`);
else if (running) out(`✓ watcher 已在執行（程序 ${pid}），不用再開`);
out(`啟動 watcher：node ${envArg} .aigile/watcher/watcher.mjs >> ${DIR.replace(/\\/g, '/')}/watcher.log 2>&1`);
out(`等待腳本：node ${envArg} .aigile/watcher/aigile-wait.mjs --agent ${AGENT} --max-min=110`);
out('完成：照上面兩行啟動（要先取得所屬人類同意的就先問）。');
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  process.exitCode = 1;
}
