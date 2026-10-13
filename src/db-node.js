// 本機資料庫轉接：node:sqlite（同步）包成 core.js 需要的非同步介面。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openNodeDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  migrate(db);

  return {
    async get(sql, ...args) { return db.prepare(sql).get(...args) ?? null; },
    async all(sql, ...args) { return db.prepare(sql).all(...args); },
    async run(sql, ...args) { return { changes: Number(db.prepare(sql).run(...args).changes) }; },
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        for (const [sql, args] of stmts) db.prepare(sql).run(...args);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close() { db.close(); },
  };
}

// 早期版本的資料庫補欄位
function migrate(db) {
  const add = (table, defs) => {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    for (const [name, def] of Object.entries(defs)) {
      if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    }
  };
  add('participants', {
    role_key: "TEXT NOT NULL DEFAULT ''", style: "TEXT NOT NULL DEFAULT ''", autonomy: "TEXT NOT NULL DEFAULT ''",
    must_confirm: "TEXT NOT NULL DEFAULT ''", handoff: "TEXT NOT NULL DEFAULT ''",
    token_expires_at: 'INTEGER NOT NULL DEFAULT 0',
    env: "TEXT NOT NULL DEFAULT ''",
    avatar: "TEXT NOT NULL DEFAULT ''",
  });
  add('messages', { audience: 'TEXT', payload_hash: 'TEXT', file_id: 'TEXT' });
  const soon = Date.now() + 24 * 3600_000;
  db.prepare('UPDATE participants SET token_expires_at = ? WHERE token_expires_at = 0').run(soon);
}
