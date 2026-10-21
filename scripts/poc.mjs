// C-296 POC 獨立部署：同一份程式部署到另一個 Cloudflare 帳號（用量、資料都跟正式平台分開）
// Token 由所屬人類存在 .cloudflare-poc.env（不進 git）：
//   CLOUDFLARE_API_TOKEN=<新帳號的 API Token，權限：Workers Scripts 編輯、D1 編輯>
//   CLOUDFLARE_ACCOUNT_ID=<新帳號的 Account ID>
// 用法：
//   node scripts/poc.mjs check     看 Token 能不能用（列出帳號，不改任何東西）
//   node scripts/poc.mjs setup     建 D1（第一次）、寫進 wrangler.poc.toml、建表
//   node scripts/poc.mjs secrets   設即時門鈴（共用正式平台的 Supabase，頻道改 aigile-poc）
//   node scripts/poc.mjs deploy    產生版本紀錄後部署到 POC
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const ENV_FILE = new URL('.cloudflare-poc.env', root), CONF = 'wrangler.poc.toml';
if (!fs.existsSync(ENV_FILE)) { console.error('找不到 .cloudflare-poc.env：請所屬人類在平台資料夾建這個檔（格式見本檔開頭說明）。'); process.exit(2); }
const env = { ...process.env };
for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!env.CLOUDFLARE_API_TOKEN) { console.error('.cloudflare-poc.env 裡沒有 CLOUDFLARE_API_TOKEN'); process.exit(2); }
const win = process.platform === 'win32';
const wr = (args, opts = {}) => spawnSync('npx', ['--yes', 'wrangler@4', ...args], { cwd: root, env, shell: win, encoding: 'utf8', stdio: opts.capture ? 'pipe' : 'inherit', input: opts.input });
const q = s => (win ? `"${s.replace(/"/g, '\\"')}"` : s);

const cmd = process.argv[2];
if (cmd === 'check') {
  process.exit(wr(['whoami']).status ?? 1);
} else if (cmd === 'setup') {
  let conf = fs.readFileSync(new URL(CONF, root), 'utf8');
  if (conf.includes('TO_BE_CREATED')) {
    const r = wr(['d1', 'create', 'aigile-poc'], { capture: true });
    process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
    const id = /database_id\s*=\s*"([0-9a-f-]{36})"|"database_id":\s*"([0-9a-f-]{36})"|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(r.stdout || '');
    if (!id) { console.error('建 D1 失敗或找不到 database_id，請看上面的訊息'); process.exit(1); }
    conf = conf.replace('TO_BE_CREATED', id[1] || id[2] || id[3]);
    fs.writeFileSync(new URL(CONF, root), conf);
    console.log('已建 D1 aigile-poc，寫進', CONF);
  }
  // 建表：schema.sql 一段一段送（--file 在部分 Token 權限下會回 Authentication error）
  const sql = fs.readFileSync(new URL('src/schema.sql', root), 'utf8').split('\n').map(l => l.replace(/\s*--.*$/, '')).filter(l => l.trim()).join('\n'); // 行尾註解也拿掉（合成一行後會吃掉後面）
  const stmts = sql.split(/;\s*\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (let i = 0; i < stmts.length; i += 10) {
    const chunk = stmts.slice(i, i + 10).join('; ') + ';';
    const r = wr(['d1', 'execute', 'aigile-poc', '--remote', '--config', CONF, '--command', q(chunk)], { capture: true });
    if (r.status) { process.stderr.write(r.stdout + r.stderr); console.error(`建表失敗（第 ${i + 1} 段起）`); process.exit(1); }
  }
  console.log(`已建表（${stmts.length} 個指令）`);
} else if (cmd === 'secrets') {
  const w = fs.readFileSync('D:/aii/.aigile/PG/watcher.env', 'utf8'), get = k => (new RegExp(`^${k}=(.*)$`, 'm').exec(w) || [])[1];
  for (const [k, v] of [['SUPABASE_URL', get('SUPABASE_URL')], ['SUPABASE_KEY', get('SUPABASE_KEY')], ['SUPABASE_TOPIC', 'aigile-poc']]) {
    if (!v) { console.error(`沒有 ${k}，略過（AI 改成每 15 分鐘巡檢）`); continue; }
    const r = wr(['secret', 'put', k, '--config', CONF], { capture: true, input: v + '\n' });
    console.log(k, r.status ? '失敗' : '已設定');
  }
} else if (cmd === 'r2') { // C-365：看 POC 帳號的 R2 bucket（開通後確認 aigile-switch-docs 在不在）
  process.exit(wr(['r2', 'bucket', 'list']).status ?? 1);
} else if (cmd === 'deploy') {
  if (fs.readFileSync(new URL(CONF, root), 'utf8').includes('TO_BE_CREATED')) { console.error('還沒建 D1：先跑 node scripts/poc.mjs setup'); process.exit(1); }
  const g = spawnSync('node', ['scripts/releases.mjs'], { cwd: root, stdio: 'inherit' });
  if (g.status) process.exit(g.status);
  process.exit(wr(['deploy', '--config', CONF]).status ?? 1);
} else {
  console.log('用法：node scripts/poc.mjs check | setup | secrets | r2 | deploy');
}
