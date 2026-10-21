// C-365 本機（node server.js）的專案文件存放處：data/docs 資料夾，介面同 storage-r2.js。Worker 不載入這支。
import fs from 'node:fs';
import path from 'node:path';
import { safeKey } from './storage-r2.js';

export function dirStorage(dir) {
  const file = key => path.join(dir, ...safeKey(key).split('/'));
  return {
    async put(key, bytes) { const f = file(key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes); },
    async get(key) { try { return new Uint8Array(fs.readFileSync(file(key))); } catch { return null; } },
    async delete(key) { try { fs.unlinkSync(file(key)); } catch {} },
  };
}
