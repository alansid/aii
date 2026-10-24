// 畫面測試共用：開本機伺服器（暫存資料夾）＋無頭 Chrome／Edge（DevTools 協定，不裝套件）
// 用法見 inbox-verify-test.js、settings-tabs-test.js；找不到瀏覽器時 findBrowser() 回 null，測試自行略過
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const until = async (fn, ms = 15000, label = '') => {
  const end = Date.now() + ms;
  for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() > end) throw new Error('等太久：' + label); await sleep(150); }
};
export function findBrowser() {
  return [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find(p => fs.existsSync(p)) || null;
}

export async function startKit(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aigile-${name}-`));
  const PORT = 39000 + Math.floor(Math.random() * 500), DBG = PORT + 600, BASE = `http://127.0.0.1:${PORT}`;
  const kids = [];
  const run = (cmd, args, env = {}) => { const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'ignore' }); kids.push(p); return p; };
  const serverJs = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'server.js');
  run(process.execPath, [serverJs], { PORT: String(PORT), DATA_DIR: path.join(dir, 'data'), RATE_LIMIT_PER_MIN: '10000' });
  await until(() => fetch(BASE + '/api/health').then(r => r.ok), 15000, '本機伺服器');
  const call = async (t, p, m = 'GET', b) => { const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const sql = (q, ...v) => { const d = new DatabaseSync(path.join(dir, 'data', 'switch.db')); try { return d.prepare(q).run(...v); } finally { d.close(); } }; // 測試直接改本機暫存庫（例如讓 Token 過期）
  const aiToken = id => { const d = new DatabaseSync(path.join(dir, 'data', 'switch.db')); try { return d.prepare('SELECT token FROM participants WHERE id = ?').get(id).token; } finally { d.close(); } };

  let ws = null;
  async function browser(width = 1400, height = 700) {
    run(findBrowser(), ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${path.join(dir, 'chrome')}`, '--no-first-run', '--no-default-browser-check', `--window-size=${width},${height}`, 'about:blank']);
    const target = await until(async () => (await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json()).find(t => t.type === 'page'), 15000, '瀏覽器');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
    let seq = 0; const wait = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
    const cdp = (method, params = {}) => new Promise(r => { const id = ++seq; wait.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const js = async expr => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'JS 錯誤'); return r.result?.result?.value; };
    const login = async (token, page = '/') => {
      await cdp('Page.navigate', { url: BASE + '/' });
      await until(() => js('document.readyState === "complete"'), 15000, '首頁');
      await js(`localStorage.setItem('aigile-switch-token', ${JSON.stringify(token)}); true`);
      await cdp('Page.navigate', { url: BASE + page });
      await until(() => js("!!document.querySelector('.av-btn') && document.querySelector('#join')?.hidden !== false"), 20000, '登入完成');
    };
    const key = async (k, code = k) => { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: { ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, Tab: 9, Enter: 13 }[k] || 0 }); };
    return { cdp, js, login, key };
  }
  async function stop() {
    try { ws?.close(); } catch {}
    for (const k of kids) { try { k.kill(); } catch {} }
    await sleep(500);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  return { BASE, call, aiToken, sql, browser, stop };
}
