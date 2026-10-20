// C-295 重現測試：watcher 寫門鈴檔時 rename 被 Windows 擋（EPERM），門鈴檔要照樣更新
// 修正前：rename 失敗就放棄，bell.json 停在舊的，等待腳本沒被叫醒（昱志 10/19 @ 沒回）
// 用法：node scripts/bell-test.js
import fs from 'node:fs';
import assert from 'node:assert';

try {
  const src = fs.readFileSync(new URL('../public/watcher.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('function writeBell('), end = src.indexOf('\nfunction ring(', start);
  assert.ok(start > 0 && end > start, '找得到 writeBell');
  // 用假的檔案系統跑 watcher 的 writeBell：rename 前 N 次回 EPERM
  const run = failTimes => {
    const files = new Map(), logs = [];
    let fails = 0;
    const fakeFs = {
      writeFileSync: (f, t) => files.set(f, t),
      renameSync: (a, b) => { if (fails++ < failTimes) { const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; } files.set(b, files.get(a)); files.delete(a); },
      unlinkSync: f => files.delete(f),
    };
    const body = src.slice(start, end);
    const fn = new Function('writeFileSync', 'renameSync', 'unlinkSync', 'BELL_FILE', 'bell', 'log', 'process', `${body}; return writeBell;`);
    const writeBell = fn(fakeFs.writeFileSync, fakeFs.renameSync, fakeFs.unlinkSync, 'bell.json', { seq: 0 }, (...a) => logs.push(a.join(' ')), { pid: 1 });
    writeBell({ seq: 1, pending: 2 });
    return { bell: files.has('bell.json') ? JSON.parse(files.get('bell.json')) : null, tmpLeft: files.has('bell.json.tmp'), logs };
  };
  let r = run(0);
  assert.equal(r.bell?.seq, 1, '平常 rename 成功');
  r = run(2);
  assert.equal(r.bell?.seq, 1, 'rename 被擋兩次，重試後寫進去');
  r = run(99);
  assert.equal(r.bell?.seq, 1, 'rename 一直被擋：直接覆寫，門鈴照樣響'); assert.equal(r.tmpLeft, false, '暫存檔清掉');
  assert.equal(r.logs.length, 0, '沒有「寫門鈴檔失敗」');

  // 接入設定裡的雜湊：C-338 起自動產生（scripts/script-hashes.mjs，c338-test 驗）
  console.log('bell-test：全部通過');
} catch (e) {
  console.error('bell-test 失敗：', e.message);
  process.exitCode = 1;
}
