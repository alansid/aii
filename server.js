// 本機啟動：node server.js（零相依，Node 22.13+）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/core.js';
import { openNodeDb } from './src/db-node.js';
import { dbStorage } from './src/storage-db.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const db = openNodeDb(path.join(DATA_DIR, 'switch.db'));
const handle = createApp({
  db,
  storage: dbStorage(db),
  docText: fs.readFileSync(path.join(ROOT, 'docs', 'ai-integration.md'), 'utf8'),
  config: {
    roomCode: process.env.ROOM_CODE,
    aiTokenTtlHours: process.env.AI_TOKEN_TTL_HOURS,
    humanTokenTtlHours: process.env.HUMAN_TOKEN_TTL_HOURS,
    fileTtlHours: process.env.FILE_TTL_HOURS,
    fileMaxTotalMb: process.env.FILE_MAX_TOTAL_MB,
  },
});

// 每 10 分鐘清除超過保存期限的上傳文件
const cleanup = () => handle.cleanupExpired().catch(e => console.error('cleanup', e));
cleanup();
setInterval(cleanup, 10 * 60_000).unref();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(res, pathname) {
  let rel;
  try { rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname); } catch { rel = '/'; }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  const base = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  const url = new URL(req.url, base);
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/docs/ai-integration.md') return serveStatic(res, url.pathname);

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
