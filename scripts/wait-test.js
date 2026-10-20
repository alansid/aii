// C-246 驗收測試：aigile-wait.mjs（有事才醒）＋ watcher 門鈴檔。
// 用法：node scripts/wait-test.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3994;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-wait-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-waitwd-'));
const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, RATE_LIMIT_PER_MIN: '100000' }, stdio: 'pipe' });
const ready = new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('已啟動')) res(); }); server.on('exit', c => rej(new Error('server exited ' + c))); });
const call = async (token, p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const WAIT = path.join(ROOT, 'public', 'aigile-wait.mjs');
const WATCHER = path.join(ROOT, 'public', 'watcher.mjs');
// 跑等待腳本，回傳 { code, lines, ms }
function runWait(extraArgs = [], env = {}) {
  return new Promise(res => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [WAIT, '--agent', 'T', ...extraArgs], { cwd: work, env: { ...process.env, AIGILE_BASE: BASE, ...env }, stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', code => res({ code, lines: out.trim().split('\n'), last: out.trim().split('\n').pop(), ms: Date.now() - t0, proc: p }));
    runWait.last = p;
  });
}
const dir = path.join(work, '.aigile', 'T');
const writeBell = (seq, pending, ago = 0) => fs.writeFileSync(path.join(dir, 'bell.json'), JSON.stringify({ v: 1, seq, pending, heartbeatAt: new Date(Date.now() - ago).toISOString(), pid: process.pid }));
const alive = () => fs.writeFileSync(path.join(dir, 'watcher.pid'), String(process.pid)); // 用測試程序自己當「活著的 watcher」
const noWatcher = () => { for (const f of ['watcher.pid', 'bell.json']) try { fs.unlinkSync(path.join(dir, f)); } catch {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await ready;
  let watcher;
  try {
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
    const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: '程式開發', name: '測PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.token'), ai.token);
    let n = 0;
    const ping = () => call(liu.token, '/api/messages', 'POST', { project: '平台', requestId: 'p' + (++n), text: '請看 ' + n, recipientIds: [ai.participantId] });
    const ackAll = async () => { const items = (await call(ai.token, '/api/notifications?status=pending&limit=50')).body.items; if (items.length) await call(ai.token, '/api/notifications/ack', 'POST', { notificationIds: items.map(x => x.notificationId) }); };

    // 設定缺少、Token 錯
    let r = await runWait([], { AIGILE_BASE: '' });
    assert.equal(r.last, 'CONFIG_ERROR'); assert.equal(r.code, 40);
    // Token 檔錯 → UNAUTHORIZED（Token 以檔案為準：10/20 起舊的 AIGILE_TOKEN 環境變數不能蓋掉檔案）
    const badTok = path.join(dir, 'bad.token'); fs.writeFileSync(badTok, 'bad-token');
    r = await runWait([], { AIGILE_TOKEN_FILE: badTok });
    assert.equal(r.last, 'UNAUTHORIZED'); assert.equal(r.code, 20, 'Token 錯：UNAUTHORIZED 結束碼 20');
    r = await runWait(['--max-min=0.02'], { AIGILE_TOKEN: 'bad-token' });
    assert.notEqual(r.last, 'UNAUTHORIZED', '環境變數是舊的、檔案是對的 → 用檔案');

    // 啟動時就有待處理
    await ping();
    r = await runWait();
    assert.equal(r.last, 'PENDING 1'); assert.equal(r.code, 0, '啟動時查一次');
    await ackAll();

    // watcher 在、沒事：時間到 TIMEOUT，不印 WARN、不連平台
    alive(); writeBell(5, 0);
    r = await runWait(['--max-min=0.05']);
    assert.equal(r.last, 'TIMEOUT'); assert.equal(r.code, 10);
    assert.ok(!r.lines.some(l => l.includes('WARN')), 'watcher 在就不改備援');

    // 門鈴響：馬上醒
    alive(); writeBell(5, 0);
    const p1 = runWait(['--max-min=0.5', '--look-sec=1']);
    await sleep(1200); writeBell(6, 2);
    r = await p1;
    assert.equal(r.last, 'PENDING 2', '門鈴檔 seq 增加就醒'); assert.ok(r.ms < 6000, `門鈴後很快醒（${r.ms}ms）`);

    // watcher 不在：印 WARN，改備援輪詢
    noWatcher();
    const p2 = runWait(['--max-min=0.5', '--poll-sec=1']);
    await sleep(1500); await ping();
    r = await p2;
    assert.ok(r.lines.some(l => l.includes('WARN watcher 不在')), '沒有 watcher 印 WARN');
    assert.equal(r.last, 'PENDING 1', '備援輪詢抓到');
    await ackAll();

    // 門鈴檔心跳太舊也算 watcher 不在
    alive(); writeBell(7, 0, 31 * 60_000);
    r = await runWait(['--max-min=0.03', '--poll-sec=60']);
    assert.ok(r.lines.some(l => l.includes('WARN watcher 不在')), '心跳超過 30 分鐘＝不在');

    // 連不上：備援連續 3 次失敗 NETWORK_ERROR
    noWatcher();
    r = await runWait(['--max-min=0.5', '--poll-sec=1'], { AIGILE_BASE: 'http://127.0.0.1:9' });
    assert.equal(r.last, 'NETWORK_ERROR'); assert.equal(r.code, 30);

    // 真的 watcher（只記錄模式＋門鈴檔）＋等待腳本：有人 @ 就醒
    noWatcher();
    watcher = spawn(process.execPath, [WATCHER], { cwd: work, stdio: 'pipe', env: { ...process.env, AIGILE_BASE: BASE, AIGILE_ME: ai.participantId, AIGILE_TOKEN_FILE: path.join(dir, '.token'),
      WATCH_ONLY: '1', BELL_FILE: path.join(dir, 'bell.json'), PID_FILE: path.join(dir, 'watcher.pid'), HEARTBEAT_MIN: '0.03', SUPABASE_URL: '', SUPABASE_KEY: '' } });
    let wlog = ''; watcher.stdout.on('data', d => { wlog += d; });
    for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, 'bell.json')); i++) await sleep(100);
    assert.equal(fs.readFileSync(path.join(dir, 'watcher.pid'), 'utf8').trim(), String(watcher.pid), 'watcher 自己寫 pid 檔');
    const p3 = runWait(['--max-min=0.5', '--look-sec=1']);
    await sleep(1000); await ping();
    r = await p3;
    assert.equal(r.last, 'PENDING 1', 'watcher 寫門鈴 → 等待腳本醒');
    assert.ok(!r.lines.some(l => l.includes('WARN')), '有 watcher 不走備援');
    assert.ok(wlog.includes('已寫門鈴檔'), 'watcher 日誌記錄門鈴');
    console.log('wait-test：全部通過');
  } catch (e) {
    console.error('wait-test 失敗：', e.message);
    process.exitCode = 1;
  } finally {
    watcher?.kill();
    server.kill();
    setTimeout(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); } catch {} process.exit(); }, 300);
  }
})();
