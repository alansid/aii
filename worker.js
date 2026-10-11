// Cloudflare Workers 入口：/api/* 交給 core，其餘由靜態資源（public/）提供。
import { createApp } from './src/core.js';
import { wrapD1 } from './src/db-d1.js';
import docText from './docs/ai-integration.md';

let handle;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/docs/ai-integration.md') {
      return env.ASSETS.fetch(request);
    }
    handle ??= createApp({
      db: wrapD1(env.DB),
      docText,
      config: {
        roomCode: env.ROOM_CODE,
        aiTokenTtlHours: env.AI_TOKEN_TTL_HOURS,
        humanTokenTtlHours: env.HUMAN_TOKEN_TTL_HOURS,
      },
    });
    return handle(request, url.origin);
  },
};
