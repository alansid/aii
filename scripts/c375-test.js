// C-375 用詞統一：全站叫「要你處理」與「AI」，不再出現「要你做（的）」「等你處理」「AI 助手」
// 掃網頁、伺服器、規格與 README（不連任何站）。用法：node scripts/c375-test.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  ...['public', 'src', 'docs'].flatMap(d => fs.readdirSync(path.join(root, d)).filter(f => /\.(js|mjs|html|css|md)$/.test(f)).map(f => path.join(d, f))),
  'README.md', 'package.json',
];
const BAD = [/要你做/, /等你處理/, /AI ?助手/];
const hits = [];
for (const f of files) {
  fs.readFileSync(path.join(root, f), 'utf8').split('\n').forEach((line, i) => {
    for (const re of BAD) if (re.test(line)) hits.push(`${f}:${i + 1} ${line.trim().slice(0, 80)}`);
  });
}
if (hits.length) { console.error('c375-test 失敗：還有舊說法\n' + hits.join('\n')); process.exit(1); }
console.log(`c375-test：全部通過（掃 ${files.length} 個檔）`);
