// Cloudflare D1 轉接：包成 core.js 需要的介面。
export function wrapD1(d1) {
  const prep = (sql, args) => d1.prepare(sql).bind(...args);
  return {
    async get(sql, ...args) { return (await prep(sql, args).first()) ?? null; },
    async all(sql, ...args) { return (await prep(sql, args).all()).results; },
    async run(sql, ...args) { return { changes: (await prep(sql, args).run()).meta.changes }; },
    async batch(stmts) { await d1.batch(stmts.map(([sql, args]) => prep(sql, args))); }, // D1 batch 為交易
  };
}
