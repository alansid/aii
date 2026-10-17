// C-223 主機救援：產生一次性管理員登入連結（15 分鐘、用一次就失效）。網頁沒有按鈕、也沒有 API 可以叫，
// 只有拿著主機部署權限的人能跑（正式環境要 wrangler 已登入那個 Cloudflare 帳號）。只救管理員；其他人忘記密碼請管理員「重設登入」。
// 用法：
//   npm run admin-rescue                                   正式環境（Cloudflare D1）
//   npm run admin-rescue -- --local [資料夾] [--base 網址]   本機 node server.js（預設 ./data、http://localhost:3000）
// 每次產生都記在 rescue_links（誰＝主機使用者@主機名稱、何時），並在管理員的收件匣發一則安全通知。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROD_URL = process.env.APP_URL || 'https://aigile-switch.alansid87.workers.dev';
const TTL_MS = 15 * 60_000;
const args = process.argv.slice(2);
const local = args.includes('--local');
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const base = (opt('--base') || (local ? 'http://localhost:' + (process.env.PORT || 3000) : PROD_URL)).replace(/\/+$/, '');

const b64url = bytes => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const randId = (prefix, n = 16) => `${prefix}_${Array.from(crypto.getRandomValues(new Uint8Array(n)), b => B62[b % 62]).join('')}`;
const sha256 = async s => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), b => b.toString(16).padStart(2, '0')).join('');
const who = `${os.userInfo().username}@${os.hostname()}`.replace(/[^\w.@-]/g, '_').slice(0, 80);
const ADMIN_SQL = "SELECT id, name FROM participants WHERE kind = 'human' AND status = 'active' ORDER BY created_at, id LIMIT 1";

// 正式環境：透過 wrangler 對 D1 下指令（跟 scripts/migrate.js 一樣用 --command）
function d1(sql) {
  const win = process.platform === 'win32';
  const arg = win ? `"${sql.replace(/"/g, '\\"')}"` : sql;
  const r = spawnSync('npx', ['--yes', 'wrangler@4', 'd1', 'execute', 'aigile-switch', '--remote', '--json', '--command', arg], { cwd: ROOT, shell: win, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); throw new Error('wrangler 執行失敗：要有這個 Cloudflare 帳號的部署權限（npx wrangler login）'); }
  const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')));
  return out.flatMap(x => x.results || []);
}

const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
const now = Date.now();
const hash = await sha256(token);
const linkId = randId('rsc'), noticeId = randId('ntc');
let admin;
if (local) {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(path.resolve(opt('--local') && !opt('--local').startsWith('--') ? opt('--local') : path.join(ROOT, 'data')), 'switch.db');
  if (!fs.existsSync(file)) throw new Error('找不到資料庫：' + file);
  const db = new DatabaseSync(file);
  admin = db.prepare(ADMIN_SQL).get();
  if (!admin) throw new Error('群組還沒有管理員');
  db.prepare('INSERT INTO rescue_links (id, token_hash, participant_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)').run(linkId, hash, admin.id, who, now, now + TTL_MS);
  db.prepare("INSERT INTO account_notices (id, participant_id, kind, detail, created_at) VALUES (?,?,'rescue_link',?,?)").run(noticeId, admin.id, who, now);
  db.close();
} else {
  admin = d1(ADMIN_SQL)[0];
  if (!admin) throw new Error('群組還沒有管理員');
  // 值都是這支程式產生的（id、雜湊、時間、已過濾的主機名稱），沒有外部輸入
  d1(`INSERT INTO rescue_links (id, token_hash, participant_id, created_by, created_at, expires_at) VALUES ('${linkId}', '${hash}', '${admin.id}', '${who}', ${now}, ${now + TTL_MS}); `
    + `INSERT INTO account_notices (id, participant_id, kind, detail, created_at) VALUES ('${noticeId}', '${admin.id}', 'rescue_link', '${who}', ${now});`);
}
console.log(`一次性管理員登入連結（15 分鐘有效，用一次就失效）：\n${base}/rescue/${token}\n`);
console.log(`管理員：${admin.name}。已記錄（${who}，${new Date(now).toLocaleString('zh-TW')}），並在管理員的收件匣發安全通知。`);
