// Cloudflare D1 轉接：包成 core.js 需要的介面。
// D1 的 BLOB 參數要用 ArrayBuffer；Uint8Array（含 subarray 視圖）在此轉成剛好大小的 ArrayBuffer。
const toD1 = v => (ArrayBuffer.isView(v) ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v);

export function wrapD1(d1) {
  const prep = (sql, args) => d1.prepare(sql).bind(...args.map(toD1));
  return {
    async get(sql, ...args) { return (await prep(sql, args).first()) ?? null; },
    async all(sql, ...args) { return (await prep(sql, args).all()).results; },
    async run(sql, ...args) { return { changes: (await prep(sql, args).run()).meta.changes }; },
    async batch(stmts) { await d1.batch(stmts.map(([sql, args]) => prep(sql, args))); }, // D1 batch 為交易
  };
}
