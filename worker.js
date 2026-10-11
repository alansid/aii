// Cloudflare Workers 入口：/api/* 交給 core，其餘由靜態資源（public/）提供。
import { createApp } from './src/core.js';
import { wrapD1 } from './src/db-d1.js';
import { dbStorage } from './src/storage-db.js';
import docText from './docs/ai-integration.md';

let handle;
const app = env => {
  if (handle) return handle;
  const db = wrapD1(env.DB);
  handle = createApp({
    db,
    storage: dbStorage(db), // 檔案存 D1，不需要 R2
    docText,
    config: {
      roomCode: env.ROOM_CODE,
      aiTokenTtlHours: env.AI_TOKEN_TTL_HOURS,
      humanTokenTtlHours: env.HUMAN_TOKEN_TTL_HOURS,
      fileTtlHours: env.FILE_TTL_HOURS,
      staleMinutes: env.STALE_MINUTES,
      unansweredMinutes: env.UNANSWERED_MINUTES,
    },
  });
  return handle;
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/docs/ai-integration.md') {
      return env.ASSETS.fetch(request);
    }
    return app(env)(request, url.origin);
  },
  // 排程（每 10 分鐘）：清除過期文件、Token 到期提醒
  async scheduled(event, env, ctx) {
    ctx.waitUntil(app(env).runScheduled());
  },
};
