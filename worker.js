// Cloudflare Workers 入口：/api/* 交給 core，其餘由靜態資源（public/）提供。
import { createApp } from './src/core.js';
import { wrapD1 } from './src/db-d1.js';
import { dbStorage } from './src/storage-db.js';
import { r2Storage } from './src/storage-r2.js'; // C-365 專案文件區
import docText from './docs/ai-integration.md';
import flowsText from './docs/flows.md'; // C-291：要登入才讀得到
import releases from './generated/releases.json'; // C-291：npm run deploy 會先產生
import scriptHashes from './generated/script-hashes.json'; // C-338 C4：同上，AI 下載腳本的 SHA-256

let handle;
const app = env => {
  if (handle) return handle;
  const db = wrapD1(env.DB);
  handle = createApp({
    db,
    storage: dbStorage(db), // 訊息附件存 D1，不需要 R2
    docStorage: env.DOCS ? r2Storage(env.DOCS) : null, // C-365 專案文件區存 R2；還沒綁定 DOCS 就回 503，其他功能照常
    docText,
    flowsText,
    releases,
    scriptHashes,
    config: {
      roomCode: env.ROOM_CODE,
      openJoin: env.OPEN_JOIN,
      aiTokenTtlHours: env.AI_TOKEN_TTL_HOURS,
      humanTokenTtlHours: env.HUMAN_TOKEN_TTL_HOURS,
      fileTtlHours: env.FILE_TTL_HOURS,
      docMaxTotalMb: env.DOC_MAX_TOTAL_MB,
      staleMinutes: env.STALE_MINUTES,
      unansweredMinutes: env.UNANSWERED_MINUTES,
      tokenWarnHours: env.TOKEN_WARN_HOURS,
      cardStaleHours: env.CARD_STALE_HOURS,
      supabaseUrl: env.SUPABASE_URL,
      supabaseKey: env.SUPABASE_KEY,
      supabaseTopic: env.SUPABASE_TOPIC,
    },
  });
  return handle;
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/docs/ai-integration.md') {
      // 網頁頁面（沒有副檔名的網址，wrangler.toml 的 run_worker_first）：換上群組名與連結預覽；其他靜態檔照舊
      const req = new Request(request);
      req.headers.delete('if-none-match'); req.headers.delete('if-modified-since');
      const res = await env.ASSETS.fetch(req);
      if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
      const h = new Headers(res.headers);
      h.delete('content-length'); h.delete('etag'); h.set('cache-control', 'no-cache');
      return new Response(await app(env).pageHtml(await res.text(), url.origin), { status: res.status, headers: h });
    }
    return app(env)(request, url.origin, ctx); // C-337 B6：門鈴用這次請求自己的 waitUntil
  },
  // 排程（每 10 分鐘）：清除過期文件、Token 到期提醒
  async scheduled(event, env, ctx) {
    ctx.waitUntil(app(env).runScheduled().then(() => app(env).flushBells()));
  },
};
