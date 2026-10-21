// 本機啟動：node server.js（零相依，Node 22.13+）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/core.js';
import { openNodeDb } from './src/db-node.js';
import { dbStorage } from './src/storage-db.js';
import { dirStorage } from './src/storage-dir.js'; // C-365 本機的專案文件區（不需要 R2）
import { scriptHashes } from './scripts/script-hashes.mjs'; // C-338 C4

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const db = openNodeDb(path.join(DATA_DIR, 'switch.db'));
const handle = createApp({
  db,
  storage: dbStorage(db),
  docStorage: dirStorage(path.join(DATA_DIR, 'docs')),
  docText: fs.readFileSync(path.join(ROOT, 'docs', 'ai-integration.md'), 'utf8'),
  flowsText: fs.readFileSync(path.join(ROOT, 'docs', 'flows.md'), 'utf8'), // C-291
  scriptHashes: scriptHashes(), // C-338 C4：從 public/ 現算
  releases: (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'generated', 'releases.json'), 'utf8')); } catch { return null; } })(), // npm run releases 產生
  config: {
    roomCode: process.env.ROOM_CODE,
    openJoin: process.env.OPEN_JOIN ?? '1', // 本機預設開放自己加入（測試與種子資料用）；正式環境（Workers）預設關閉
    authFailLimit: process.env.AUTH_FAIL_LIMIT,
    rateLimitPerMin: process.env.RATE_LIMIT_PER_MIN, // 只給本機測試用；正式環境固定每分鐘 120
    aiTokenTtlHours: process.env.AI_TOKEN_TTL_HOURS,
    humanTokenTtlHours: process.env.HUMAN_TOKEN_TTL_HOURS,
    fileTtlHours: process.env.FILE_TTL_HOURS,
    fileMaxTotalMb: process.env.FILE_MAX_TOTAL_MB,
    docMaxTotalMb: process.env.DOC_MAX_TOTAL_MB,
    staleMinutes: process.env.STALE_MINUTES,
    unansweredMinutes: process.env.UNANSWERED_MINUTES,
    teamCacheMs: process.env.TEAM_CACHE_MS,
    tokenWarnHours: process.env.TOKEN_WARN_HOURS,
    cardStaleHours: process.env.CARD_STALE_HOURS,
    archiveEveryMs: process.env.ARCHIVE_EVERY_MS,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_KEY,
    supabaseTopic: process.env.SUPABASE_TOPIC,
  },
});

// 每 10 分鐘：清除過期文件、Token 到期提醒
const scheduled = () => handle.runScheduled().catch(e => console.error('scheduled', e));
scheduled();
setInterval(scheduled, 10 * 60_000).unref();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(res, pathname, origin) {
  let rel;
  try { rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname); } catch { rel = '/'; }
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file.startsWith(PUBLIC_DIR + path.sep) && !path.extname(file) && !fs.existsSync(file)) file = path.join(PUBLIC_DIR, 'index.html'); // C-169：/p/平台/訊息（C-282 起 /p/<代號>/messages） 等網頁路徑
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  if (path.extname(file) === '.html') { // 跟正式環境一樣：換上群組名與連結預覽
    return handle.pageHtml(fs.readFileSync(file, 'utf8'), origin).then(html => { res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }); res.end(html); });
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  const base = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  const url = new URL(req.url, base);
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/docs/ai-integration.md') return serveStatic(res, url.pathname, url.origin);

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
  const request = new Request(url, { method: req.method, headers: req.headers, body });
  const response = await handle(request, base);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => {
  console.log(`Aigile-Switch 已啟動：http://localhost:${PORT}`);
  if (process.env.ROOM_CODE) console.log('已啟用群組密碼 (ROOM_CODE)');
});
