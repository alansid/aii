// C-291 版本紀錄：產生的 releases.json 要新的在上面、時間一律 UTC、事故對照兩邊都標到
// 重現測試：修正前 commit 時間是 +08:00、部署時間是 UTC，用字串排序會把新版排到下面（v0.73.0 事故）
// 用法：node scripts/releases-test.js
import fs from 'node:fs';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

try {
  execFileSync('node', ['scripts/releases.mjs'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' });
  const j = JSON.parse(fs.readFileSync(new URL('../public/releases.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.ok(j.items.length > 100, '有版本資料');
  assert.ok(j.items.every(r => /Z$/.test(r.at)), '時間一律 UTC（Z 結尾）');
  for (let i = 1; i < j.items.length; i++) assert.ok(Date.parse(j.items[i - 1].at) >= Date.parse(j.items[i].at), `新的在上面：${j.items[i - 1].version} 要在 ${j.items[i].version} 前面`);
  assert.equal(j.current, pkg, 'current＝package.json 版本');
  const v0588 = j.items.find(r => r.version === '0.58.8'), v0662 = j.items.find(r => r.version === '0.66.2');
  assert.ok(v0588?.causes.some(c => c.fix === 'C-248'), 'v0.58.8 標「造成 C-248」');
  assert.ok(v0662?.fixes.some(f => f.cause === 'C-256'), 'v0.66.2 標「修正 C-256 造成的」');
  assert.ok(j.items.find(r => r.version === '0.72.6')?.cards.includes('C-290'), '版本對應到卡片');
  assert.ok(fs.readFileSync(new URL('../public/flows.md', import.meta.url), 'utf8').includes('## 一、登入（L）'), '流程圖已複製');
  console.log('releases-test：全部通過');
} catch (e) {
  console.error('releases-test 失敗：', e.message);
  process.exitCode = 1;
}
