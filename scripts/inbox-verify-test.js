// C-304 重現測試（真的瀏覽器）：收件匣「等你驗收」按「驗收通過」後留在原位、該列原地淡出、數字立刻更新
// 修正前：按下去整頁直接重畫，該列沒有淡出（昱志 10/19 14:19：畫面跳到最上面，要重找下一張）
// 需要本機有 Chrome 或 Edge（用無頭模式＋DevTools 協定，不裝套件）；找不到就略過
// 用法：node scripts/inbox-verify-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const BROWSERS = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const exe = BROWSERS.find(p => fs.existsSync(p));
if (!exe) { console.log('inbox-verify-test：略過（找不到 Chrome／Edge）'); process.exit(0); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-inbox-'));
const PORT = 39000 + Math.floor(Math.random() * 500), DBG = PORT + 600, BASE = `http://127.0.0.1:${PORT}`;
const kids = [];
const run = (cmd, args, env = {}) => { const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'ignore' }); kids.push(p); return p; };
const until = async (fn, ms = 15000, label = '') => { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() > end) throw new Error('等太久：' + label); await sleep(150); } };
const call = async (t, p, m = 'GET', b) => { const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

try {
  run(process.execPath, [new URL('../server.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], { PORT: String(PORT), DATA_DIR: path.join(dir, 'data'), RATE_LIMIT_PER_MIN: '10000' });
  await until(() => fetch(BASE + '/api/health').then(r => r.ok), 15000, '本機伺服器');

  // 資料：一位人類、一個 AI；AI 交 8 張卡給他驗收，上面 3 則要你回覆、下面 20 則給你知道的（跟昱志的畫面一樣），頁面夠長
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const L = liu.participant.participantId;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: '程式開發', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const sdb = new DatabaseSync(path.join(dir, 'data', 'switch.db'));
  const aiTok = sdb.prepare('SELECT token FROM participants WHERE id = ?').get(ai.participantId).token; sdb.close();
  for (let i = 1; i <= 8; i++) {
    const c = (await call(aiTok, '/api/cards', 'POST', { requestId: 'v' + i, project: '平台', title: `第 ${i} 張等驗收`, ownerId: ai.participantId, status: '進行中' })).body;
    assert.equal((await call(aiTok, `/api/cards/${c.cardId}`, 'PATCH', { status: '待確認', waitForId: L, version: c.version })).status, 200);
  }
  for (let i = 1; i <= 3; i++) await call(aiTok, '/api/messages', 'POST', { requestId: 'a' + i, project: '平台', text: `第 ${i} 個要你回覆的問題`, recipientIds: [L] });
  for (let i = 1; i <= 20; i++) await call(aiTok, '/api/messages', 'POST', { requestId: 'n' + i, project: '平台', text: `[通知] 第 ${i} 則進度`, recipientIds: [L], replyFrom: [] });

  // 無頭瀏覽器
  run(exe, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${path.join(dir, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--window-size=1400,700', 'about:blank']);
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json()).find(t => t.type === 'page'), 15000, '瀏覽器');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let seq = 0; const wait = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const cdp = (method, params = {}) => new Promise(r => { const id = ++seq; wait.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const js = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'JS 錯誤'); return r.result?.result?.value; };

  await cdp('Page.navigate', { url: BASE + '/' });
  await until(() => js('document.readyState === "complete"'), 15000, '首頁');
  await js(`localStorage.setItem('aigile-switch-token', ${JSON.stringify(liu.token)}); true`);
  // 電腦與手機各按一次（手機用裝置模擬：390×844）
  const check = { ok: (v, m) => assert.ok(v, label + '：' + m), equal: (a, b, m) => assert.equal(a, b, label + '：' + m) };
  let label = '';
  async function scenario(name, n0) {
    label = name;
    await cdp('Page.navigate', { url: BASE + '/p/platform/inbox' });
    await until(() => js(`document.querySelectorAll('[data-ver-ok]').length === ${n0} && document.querySelectorAll('.ask-row-item').length === 3 && document.querySelectorAll('.fyi-row').length >= 20`), 20000, '收件匣三區都載入');
    await sleep(800);

    // 捲到第 5 張附近，記下位置與數字，按「驗收通過」
    const before = await js(`(async () => {
      const pw = document.querySelector('#page-work');
      const rows = [...document.querySelectorAll('[data-ver-row]')], row = rows[4], next = rows[5];
      pw.scrollTop += row.getBoundingClientRect().top - 250;
      await new Promise(r => setTimeout(r, 200));
      window.__seen = []; new MutationObserver(() => { if (document.querySelector('[data-ver-row].fading')) window.__seen.push('fading'); }).observe(pw, { subtree: true, attributes: true, attributeFilter: ['class'] });
      window.__tops = []; pw.addEventListener('scroll', () => window.__tops.push(pw.scrollTop), { passive: true });
      return { id: row.dataset.verRow, nextId: next.dataset.verRow, asks: document.querySelectorAll('.ask-row-item').length, top: pw.scrollTop, title: document.title, rowY: Math.round(row.getBoundingClientRect().top) };
    })()`);
    check.ok(before.top > 100, '測試前要先捲下去（頁面要夠長）：' + before.top);
    await js(`document.querySelector('[data-ver-ok="${before.id}"]').click(); true`);
    await until(() => js(`!document.querySelector('[data-ver-row="${before.id}"]')`), 10000, '該列移走');
    await sleep(1500); // 背景更新（loadTeam）跑完
    const after = await js(`({ top: document.querySelector('#page-work').scrollTop, title: document.title, n: document.querySelectorAll('[data-ver-ok]').length,
      asks: document.querySelectorAll('.ask-row-item').length,
      nextY: Math.round(document.querySelector('[data-ver-row="' + ${JSON.stringify(before.nextId)} + '"]')?.getBoundingClientRect().top ?? -1), seen: window.__seen.length, tops: window.__tops })`);

    check.ok(after.seen > 0, '該列要先原地淡出再移走（修正前直接重畫，沒有淡出）');
    check.ok(Math.abs(after.top - before.top) <= 2, `留在原本的捲動位置：前 ${before.top}、後 ${after.top}（中途 ${after.tops.join(',')}）`);
    check.ok(after.tops.every(t => t > 100), '中途也不能跳到最上面：' + after.tops.join(','));
    check.equal(after.n, n0 - 1, '少一張');
    check.equal(after.asks, before.asks, '驗收完，這張卡的通知不能冒到上面「要你回覆」把整頁往下推（修正前會多一則）');
    check.ok(Math.abs(after.nextY - before.rowY) <= 4, `下一張補到原位置：${before.rowY} → ${after.nextY}`);
    const num = t => Number((/^\((\d+)\)/.exec(t) || [])[1] || 0);
    check.equal(num(after.title), num(before.title) - 1, `分頁標題數字立刻少 1：${before.title} → ${after.title}`);
  }
  await scenario('電腦', 8);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await scenario('手機', 7);
  ws.close();
  console.log('inbox-verify-test：全部通過');
} catch (e) {
  console.error('inbox-verify-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  for (const k of kids) { try { k.kill(); } catch {} }
  await sleep(500);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
