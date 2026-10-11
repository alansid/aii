// 檔案存在資料庫（本機 SQLite／Cloudflare D1 共用），不需要 R2。
// D1 單筆資料上限約 2 MB，所以切成 512 KB 一塊存放。
const CHUNK = 512 * 1024;

export function dbStorage(db) {
  return {
    async put(key, bytes) {
      const stmts = [['DELETE FROM file_chunks WHERE file_id = ?', [key]]];
      for (let i = 0, n = 0; i < bytes.length; i += CHUNK, n++) {
        stmts.push(['INSERT INTO file_chunks (file_id, idx, data) VALUES (?,?,?)', [key, n, bytes.subarray(i, i + CHUNK)]]);
      }
      await db.batch(stmts);
    },
    async get(key) {
      const rows = await db.all('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY idx', key);
      if (!rows.length) return null;
      const parts = rows.map(r => r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data));
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let off = 0;
      for (const p of parts) { out.set(p, off); off += p.length; }
      return out;
    },
    async delete(key) { await db.run('DELETE FROM file_chunks WHERE file_id = ?', key); },
  };
}
