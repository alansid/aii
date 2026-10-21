// C-365 專案文件區的檔案本體存放處。三種實作介面相同：put(key, bytes, { mime, name })、get(key) → Uint8Array|null、delete(key)
// - r2Storage：正式環境（Cloudflare R2，wrangler.toml 綁定 DOCS）
// - dirStorage：本機 node server.js（data/docs 資料夾，不需要 R2；在 storage-dir.js，Worker 不載入 node:fs）
// - memStorage：測試用
export function r2Storage(bucket) {
  return {
    async put(key, bytes, { mime } = {}) { await bucket.put(key, bytes, mime ? { httpMetadata: { contentType: mime } } : undefined); },
    async get(key) { const o = await bucket.get(key); return o ? new Uint8Array(await o.arrayBuffer()) : null; },
    async delete(key) { await bucket.delete(key); },
  };
}

// key 只允許英數、底線、斜線、連字號（由程式產生，不含使用者輸入）
export const safeKey = key => { if (!/^[A-Za-z0-9_\-/]+$/.test(key) || key.includes('..')) throw new Error('bad storage key'); return key; };

export function memStorage() {
  const m = new Map();
  return {
    map: m,
    async put(key, bytes) { m.set(safeKey(key), new Uint8Array(bytes)); },
    async get(key) { return m.get(key) ?? null; },
    async delete(key) { m.delete(key); },
  };
}
