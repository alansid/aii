#!/usr/bin/env node
// Aigile-Switch 接入檢查（C-327 C1）：一個指令做完接入的機械步驟，省掉 AI 反覆試錯的回合。零依賴，Node 22+。
//
// 做的事（每步印一行，最後印啟動指令；不印 Token）：
//   1. Node 版本   2. 用 Token 呼叫 GET /api/me 核對身分（401＝Token 失效）
//   3. 下載 watcher.mjs、aigile-wait.mjs 到 .aigile/watcher/ 並核對 SHA-256（已存在且相符就不動）
//   4. 寫 .aigile/<代號>/watcher.env：沒有就建；舊的缺 BELL_FILE、PID_FILE 等就補上，你改過的 WAKE_CMD 保留
//   5. git 資料夾就確認 .gitignore 有 .aigile/（沒有就補一行）
//   6. watcher 已在跑、但檔案或設定剛更新 → 提醒要重開（不會自己停掉它）
//   7. （C-346）同步技能：下載專案已上架的技能、核對雜湊、裝到工具的技能資料夾；含腳本的要主人允許才裝；下架的移除（只移除自己裝的）
//   8. （C-372）Claude Code：直接裝 MCP（claude mcp add aigile-<代號小寫>，這個資料夾；已裝就跳過）；Codex 印設定讓你自己加
// 不會啟動 watcher、不會發文、不會改平台上的任何資料。
//
// 用法：node aigile-setup.mjs --agent PG_XXXX --base https://平台網址 [--tool claude|codex|other] [--skills-only]
//   --tool 決定技能裝哪裡：claude → .claude/skills、codex → .agents/skills、其他工具 other → .aigile/<代號>/skills（opencode 先不支援）
//   --skills-only 只同步技能（主人在網頁按「同步」時用），不動 watcher
//   Token 先讀 .aigile/<代號>/.token；沒有檔才用環境變數 AIGILE_TOKEN_<代號>（例 AIGILE_TOKEN_PG）或 AIGILE_TOKEN。
//   環境變數跟檔案不一樣會提醒（舊的環境變數會蓋掉 watcher 讀的檔案，換了 Token 還是 401）。代理：設 HTTPS_PROXY 並加 NODE_USE_ENV_PROXY=1。
// 結束碼：0 全部完成；1 某一步失敗（最後一行寫卡在哪、怎麼辦，照著告訴所屬人類，不要自己換寫法重試）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = name => { const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`)); return i < 0 ? '' : args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1] || ''; };
const AGENT = opt('agent');
const DIR = path.join('.aigile', AGENT || '_');
const BASE = (opt('base') || process.env.AIGILE_BASE || '').replace(/\/+$/, '');
const out = s => console.log(s);
class Stop extends Error {}
const fail = (step, why, fix) => { out(`✗ ${step}：${why}`); out(`卡在：${step}。怎麼辦：${fix}`); throw new Stop(); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
// C-344：Codex 預設沙盒（workspace-write）不准連網；只要開網路，不用完全權限（官方設定名稱，2026-10 查證）
const CODEX_FIX = "Codex 沙盒預設不能連網：請所屬人類在 ~/.codex/config.toml 加 sandbox_mode = \"workspace-write\" 與 [sandbox_workspace_write] network_access = true（或啟動時加 --sandbox workspace-write -c 'sandbox_workspace_write.network_access=true'），不用開完全權限（danger-full-access）；改完重開 Codex 再跑一次";
const inCodexSandbox = process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1';
const SKILLS_ONLY = args.includes('--skills-only');
// 工具：這次有帶 --tool 就用它（並記進 watcher.env 的 SKILL_TOOL）；沒帶就用上次記的；都沒有才自己判斷
const envTool = (() => { try { return /^SKILL_TOOL=(.*)$/m.exec(fs.readFileSync(path.join('.aigile', AGENT || '_', 'watcher.env'), 'utf8'))?.[1].trim() || ''; } catch { return ''; } })();
const TOOL = opt('tool') || envTool || (process.env.CLAUDECODE === '1' ? 'claude' : process.env.CODEX_SANDBOX_NETWORK_DISABLED !== undefined || process.env.CODEX_HOME ? 'codex' : 'other');
// 技能整包雜湊：跟平台同一個算法（依路徑排序的 [路徑, 內容]）
const canonical = files => JSON.stringify(files.map(x => [x.path, x.text]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
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
  catch (e) {
    const code = e.cause?.code || e.name;
    if (inCodexSandbox) fail('連線', `連不到 ${BASE}（${code}；你在 Codex 沙盒裡，網路沒開）`, CODEX_FIX);
    fail('連線', `連不到 ${BASE}（${code}）`, `公司網路多半要代理：請所屬人類提供 HTTPS_PROXY，加上 NODE_USE_ENV_PROXY=1 再跑一次。如果你是 Codex：${CODEX_FIX}`);
  }
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

// ---------- C-346 技能同步 ----------
async function syncSkills() {
  if (!['claude', 'codex', 'other'].includes(TOOL)) fail('技能', `--tool 只能是 claude、codex、other（收到 ${TOOL}）`, '照接入設定寫的 --tool 原樣執行');
  const r = await fetch(BASE + '/api/me/skills', { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Aigile-Source': 'setup' }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r || r.status === 404) return out('（平台沒有技能庫，略過技能）');
  if (!r.ok) fail('技能', `/api/me/skills 回 HTTP ${r.status}`, '把這行告訴所屬人類');
  const list = (await r.json()).items;
  const root = { claude: '.claude/skills', codex: '.agents/skills' }[TOOL] || path.join(DIR, 'skills');
  const manPath = path.join(DIR, 'skills.json');
  let man = {}; try { man = JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch {}
  const mark = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.aigile-skill.json'), 'utf8')); } catch { return null; } };
  const mine = dir => mark(dir)?.agent === AGENT; // 只動自己裝的（同資料夾別的 AI 裝的不碰）
  const want = new Map(), skipped = [];
  for (const it of list) (it.install ? want.set(it.name, it) : skipped.push(`${it.name}（含腳本，等主人在「我的 AI › 技能」允許）`));
  let add = 0, upd = 0, rm = 0;
  for (const [name, m] of Object.entries(man)) {
    const w = want.get(name);
    if (w && m.dir === path.join(root, name)) continue;
    if (mine(m.dir)) fs.rmSync(m.dir, { recursive: true, force: true });
    delete man[name];
    if (!w) rm++;
  }
  for (const [name, it] of want) {
    const dir = path.join(root, name);
    if (man[name]?.sha256 === it.sha256 && fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
    const other = fs.existsSync(dir) && !mine(dir) ? mark(dir) : null;
    if (fs.existsSync(dir) && !mine(dir)) {
      if (other?.sha256 === it.sha256) continue; // 同資料夾別的 AI 已裝同一版
      skipped.push(`${name}（${dir.replace(/\\/g, '/')} 已有不是你裝的同名技能，沒有覆蓋）`); continue;
    }
    const pr = await get(`/api/me/skills/${it.skillId}/files`);
    const pkg = await pr.json();
    if (sha(canonical(pkg.files)) !== it.sha256) fail('技能', `${name} 的雜湊跟平台給的不一樣`, '不要安裝，告訴所屬人類');
    for (const x of pkg.files) if (path.isAbsolute(x.path) || x.path.split('/').some(seg => !seg || seg === '.' || seg === '..')) fail('技能', `${name} 有不合法的檔名 ${x.path}`, '不要安裝，告訴所屬人類');
    fs.rmSync(dir, { recursive: true, force: true });
    for (const x of pkg.files) { const p = path.join(dir, ...x.path.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, x.text); }
    fs.writeFileSync(path.join(dir, '.aigile-skill.json'), JSON.stringify({ agent: AGENT, skillId: it.skillId, version: it.version, sha256: it.sha256 }));
    man[name] ? upd++ : add++;
    man[name] = { skillId: it.skillId, version: it.version, sha256: it.sha256, dir };
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(manPath, JSON.stringify(man, null, 1));
  // 記住工具（之後按「同步」不用再帶 --tool）
  if (opt('tool') && opt('tool') !== envTool) {
    const ep = path.join(DIR, 'watcher.env');
    let t = ''; try { t = fs.readFileSync(ep, 'utf8'); } catch {}
    t = /^SKILL_TOOL=.*$/m.test(t) ? t.replace(/^SKILL_TOOL=.*$/m, 'SKILL_TOOL=' + TOOL) : (t && !t.endsWith('\n') ? t + '\n' : t) + 'SKILL_TOOL=' + TOOL + '\n';
    fs.writeFileSync(ep, t);
  }
  // 回報裝了哪些版本（技能庫的「已裝」）；同資料夾別的 AI 已裝同一版也算
  const have = [...want.values()].filter(it => mark(path.join(root, it.name))?.sha256 === it.sha256).map(it => it.skillId);
  await fetch(BASE + '/api/me/skills/installed', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Aigile-Source': 'setup' }, body: JSON.stringify({ skillIds: have }), signal: AbortSignal.timeout(20_000) }).catch(() => {});
  out(`✓ 技能（${TOOL} → ${root.replace(/\\/g, '/')}）：新裝 ${add}、更新 ${upd}、移除 ${rm}，共 ${Object.keys(man).length} 個`);
  if (skipped.length) out(`! 沒裝：${skipped.join('；')}`);
}
if (SKILLS_ONLY) { await syncSkills(); out('完成：技能已同步。'); } else {
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
await syncSkills();
out('');
if (running && changed) out(`! watcher（程序 ${pid}）用的是舊檔或舊設定：先停掉它，再用下面的指令重開`);
else if (running) out(`✓ watcher 已在執行（程序 ${pid}），不用再開`);
out(`啟動 watcher：node ${envArg} .aigile/watcher/watcher.mjs >> ${DIR.replace(/\\/g, '/')}/watcher.log 2>&1`);
out(`等待腳本：node ${envArg} .aigile/watcher/aigile-wait.mjs --agent ${AGENT} --max-min=110`);
// C-355：平台有 MCP 就印安裝指令（用絕對路徑，MCP 從哪個資料夾啟動都找得到；Token 由轉接腳本每次讀 .token，不寫進設定）
if (cfg.files['aigile-mcp.mjs']) {
  const mcp = path.resolve('.aigile', 'watcher', 'aigile-mcp.mjs').replace(/\\/g, '/');
  const mcpName = `aigile-${AGENT.toLowerCase()}`; // C-370：名稱帶代號，同台多個 AI 不撞名、不用到別人的身分
  const addArgs = ['mcp', 'add', mcpName, '--', 'node', mcp, '--agent', AGENT];
  out(`MCP 名稱 ${mcpName}：名稱帶代號，同資料夾多個 AI 可並存；每輪改用 aigile_ 工具（不用自己組 curl），只呼叫 ${mcpName} 這組，不用別人代號的`);
  if (TOOL === 'claude') {
    // C-372：直接裝（這個資料夾）；已有同名就跳過；失敗印指令讓 AI 手動裝，不中斷其他檢查。AIGILE_CLAUDE_BIN 給測試用假的 claude
    const bin = process.env.AIGILE_CLAUDE_BIN || '';
    const q = s => `"${String(s).replace(/"/g, '\\"')}"`;
    const claude = a => (/\.m?js$/.test(bin) ? spawnSync(process.execPath, [bin, ...a], { encoding: 'utf8', timeout: 60_000 })
      : spawnSync([bin || 'claude', ...a].map(q).join(' '), { shell: true, encoding: 'utf8', timeout: 60_000 }));
    const manual = `claude ${addArgs.map(a => (/\s/.test(a) ? q(a) : a)).join(' ')}`;
    if (claude(['mcp', 'get', mcpName]).status === 0) out(`✓ MCP：Claude Code 已裝 ${mcpName}（不重裝）`);
    else {
      const r = claude(addArgs);
      if (r.status === 0) out(`✓ MCP：已幫 Claude Code 裝好 ${mcpName}（這個資料夾；重開 Claude Code 對話後生效）`);
      else out(`! MCP 沒裝成（${String(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').pop().slice(0, 120) || '找不到 claude 指令'}）：請自己在這個資料夾執行 ${manual}`);
    }
  } else out(`  Claude Code → claude ${addArgs.join(' ')}`);
  out(`  Codex → ~/.codex/config.toml 加 [mcp_servers.${mcpName}]，command = "node"，args = ["${mcp}", "--agent", "${AGENT}"]（這檔全機共用：同台每個 AI 用自己的名稱，不要蓋掉別人的）`);
}
out('完成：照上面兩行啟動（要先取得所屬人類同意的就先問）。');
}
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  process.exitCode = 1;
}
