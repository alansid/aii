// C-291 版本紀錄：從 git log 產生 generated/releases.json（版本、上線時間、卡片、commit），部署時打包進 Worker，要登入才讀得到（GET /api/releases）。
// 流程圖 docs/flows.md 也打包進 Worker（GET /api/flows）。兩個都不放 public，外人讀不到（C-291 退回）。
// 用法：
//   node scripts/releases.mjs            只重新產生
//   node scripts/releases.mjs --deployed 把 package.json 目前版本的上線時間記成現在（部署時用：npm run deploy）
// 事故對照、補記的上線時間放在 docs/releases-notes.json（手寫）。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const notesFile = new URL('docs/releases-notes.json', root);
const notes = fs.existsSync(notesFile) ? JSON.parse(fs.readFileSync(notesFile, 'utf8')) : { deployed: {}, incidents: [] };
notes.deployed ||= {}; notes.incidents ||= [];
const version = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')).version;
if (process.argv.includes('--deployed')) {
  notes.deployed[version] = new Date().toISOString();
  fs.writeFileSync(notesFile, JSON.stringify(notes, null, 2) + '\n');
}

// 由舊到新讀 commit；標題結尾「(v0.72.6)」或開頭「v0.30.0 」是版本號；沒有版本號的 commit 算進前一個版本
const log = execFileSync('git', ['log', '--reverse', '--format=%h%x1f%aI%x1f%s'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const VER = /\(v(\d+\.\d+\.\d+)\)\s*$|^v(\d+\.\d+\.\d+)\b/;
const CARD = /\bC-\d{3,}\b/g;
const byVer = new Map();
let last = null;
for (const line of log) {
  const [sha, rawAt, subject] = line.split('\x1f');
  const at = new Date(rawAt).toISOString(); // 一律 UTC，才能跟部署時間比較（commit 時間是 +08:00）
  const m = VER.exec(subject);
  const v = m ? (m[1] || m[2]) : last;
  if (!v) continue;
  if (!byVer.has(v)) byVer.set(v, { version: v, at, commits: [], cards: new Set() });
  const r = byVer.get(v);
  r.commits.push({ sha, at, title: subject.replace(VER, '').trim() });
  for (const c of subject.match(CARD) || []) r.cards.add(c);
  if (m) { last = v; r.at = at; } // 版本時間＝帶版本號的那個 commit
}
const items = [...byVer.values()].map(r => ({
  version: r.version,
  deployedAt: notes.deployed[r.version] || null, // 有記到部署時間就用；沒有就看 commit 時間（通常幾分鐘內就部署）
  at: notes.deployed[r.version] || r.at,
  cards: [...r.cards],
  commits: r.commits,
  causes: notes.incidents.filter(i => i.causeVersion === r.version).map(i => ({ fix: i.fix, fixVersion: i.fixVersion, note: i.note })),
  fixes: notes.incidents.filter(i => i.fixVersion === r.version).map(i => ({ cause: i.cause, causeVersion: i.causeVersion, note: i.note, flow: i.flow })),
})).sort((a, b) => b.at.localeCompare(a.at));
fs.mkdirSync(new URL('generated/', root), { recursive: true });
fs.writeFileSync(new URL('generated/releases.json', root), JSON.stringify({ generatedAt: new Date().toISOString(), current: version, incidents: notes.incidents, items }) + '\n');
for (const f of ['public/releases.json', 'public/flows.md']) fs.rmSync(new URL(f, root), { force: true }); // 舊版放在 public，外人讀得到，拿掉
console.log(`generated/releases.json：${items.length} 個版本（目前 v${version}）`);
