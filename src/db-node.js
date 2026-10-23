// 本機資料庫轉接：node:sqlite（同步）包成 core.js 需要的非同步介面。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openNodeDb(file, { legacyProjects = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  try { db.exec(schema); } catch { migrate(db); db.exec(schema); } // C-302：舊資料庫先補欄位再建索引
  // 本機開發與測試沿用原本兩個專案（C-300 起新資料庫不自帶）；legacyProjects: false＝模擬全新的站
  if (legacyProjects) db.exec("INSERT OR IGNORE INTO projects (id, name, archived, created_at) VALUES ('平台', '平台', 0, '2026-01-01T00:00:00.000Z'); INSERT OR IGNORE INTO projects (id, name, archived, created_at) VALUES ('銀行系統', '銀行系統', 0, '2026-01-01T00:00:00.000Z');");
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
    if (!have.size) return; // 表還沒建（由 schema.sql 建，已含新欄位）
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
    avatar_v: 'INTEGER NOT NULL DEFAULT 0',
    standby_at: 'INTEGER NOT NULL DEFAULT 0',
    projects: "TEXT NOT NULL DEFAULT '平台,銀行系統'",
  });
  const hadProjNo = new Set(db.prepare('PRAGMA table_info(cards)').all().map(c => c.name)).has('proj_no');
  add('cards', {
    proj_no: 'INTEGER',
    project: "TEXT NOT NULL DEFAULT '平台'",
    decider_id: "TEXT",
    proposer_id: "TEXT",
    question: "TEXT NOT NULL DEFAULT ''",
    recommendation: "TEXT NOT NULL DEFAULT ''",
    options: "TEXT NOT NULL DEFAULT ''",
    impact: "TEXT NOT NULL DEFAULT ''",
    after_next: "TEXT NOT NULL DEFAULT ''",
    decision_result: "TEXT",
    decision_by: "TEXT",
    decision_at: "TEXT",
    decision_note: "TEXT NOT NULL DEFAULT ''",
  });
  // C-310：舊資料庫剛補上 proj_no → 舊卡依建立順序在各自專案內補號（同 migration 0022）
  if (!hadProjNo && db.prepare('SELECT COUNT(*) AS n FROM cards').get().n) {
    db.exec('UPDATE cards SET proj_no = (SELECT COUNT(*) FROM cards c2 WHERE c2.project = cards.project AND (c2.created_at < cards.created_at OR (c2.created_at = cards.created_at AND c2.seq <= cards.seq)))');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_proj_no ON cards (project, proj_no)');
  }
  add('messages', { audience: 'TEXT', payload_hash: 'TEXT', file_id: 'TEXT', project: 'TEXT', reply_from: 'TEXT' });
  add('skill_installs', { place: 'TEXT' }); // PLAT-240
  const soon = Date.now() + 24 * 3600_000;
  db.prepare('UPDATE participants SET token_expires_at = ? WHERE token_expires_at = 0').run(soon);
}
