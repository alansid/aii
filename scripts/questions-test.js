// C-297 重現測試：[需確認] 選項按鈕解析放寬＋格式錯時回提醒
// 修正前：「問題N：」下面直接列 A./B.（漏「選項：」）、「選項：」寫在「問題N：」前面，都不會變按鈕（10/19 三則）
// 用法：node scripts/questions-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { parseQuestions as serverParse, optionWarnings } from '../src/questions.js';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

// 網頁那份：從 app.js 抓出來跑，要跟伺服器一致
const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const s = src.indexOf('  const OPT_LETTER = '), e = src.indexOf('  function quickHtml(m) {');
const webParse = new Function(`${src.slice(s, e)}; return parseQuestions;`)();
const shape = qs => qs.map(q => `${q.named ? '問題' + q.no : '單題'}:${q.opts.map(o => o.key).join('')}`).join(' | ');

const CASES = [
  // 第 2487 則（PO）：問題1 下面直接列 A./B./C.，漏「選項：」
  ['[需確認] 【血汗勞工平台】公開前我先掃了 GitHub 上 159 筆提交。\n- 公開幾乎收不回來\n問題1：怎麼做？\nA. 不公開，你在 GitHub 網頁打他信箱邀請（我建議）\nB. 公開，先拿掉名字再公開\nC. 先不開', '問題1:ABC', 0],
  // 第 2499 則（UX）：「選項：」寫在「問題 1：」前面，問題 2 沒有「選項：」
  ['[需確認] 整體排版重整的設計好了，請選兩題。\n\n選項：\n問題 1：風格？\nA. 清爽專業（我建議）\nB. 深色側欄\nC. 溫暖柔和\n問題 2：頂欄要不要加搜尋？\nA. 要（我建議）\nB. 先不要', '問題1:ABC | 問題2:AB', 0],
  // PO 漏「選項：」又沒寫「問題1：」：不出按鈕，回提醒
  ['[需確認] 要不要把預覽站開起來？\nA. 開\nB. 先不要', '', 1],
  // 規格 3.9.1 的正確寫法：照舊
  ['[需確認] C-121 產品接受度\n\n剩餘風險：\n①正式建置被既有樣式預算擋住\n②案件保存重載要等服務\n\n問題1：要不要另開一張卡處理樣式預算？\n選項：\nA. 另開卡\nB. 不另開，先記在 C-121\n\n問題2：接受先這樣部分接受嗎？\n選項：\nA. 接受，維持待驗收\nB. 不接受，等全部完成', '問題1:AB | 問題2:AB', 0],
  // 題目下面先列 ①② 說明、再寫「選項：」：以「選項：」底下那組為準
  ['[需確認] 部署方式\n問題1：要不要先上預覽站？\n①多 10 分鐘\n②比較穩\n選項：\nA. 要\nB. 不要', '問題1:AB', 0],
  // 單題、照規格（沒寫問題1）
  ['[需確認] 要開新帳號嗎？\n選項：\nA. 開\nB. 先不要', '單題:AB', 0],
  // 沒有任何選項提示的條列只是文字，也不提醒
  ['[需確認] 先跟你說明一下風險：\n①一\n②二\n同意就照辦', '', 0],
  // 兩題但第二題沒列選項：提醒第 2 題
  ['[需確認] 兩件事\n問題1：做 A 嗎？\n選項：\nA. 做\nB. 不做\n問題2：什麼時候？\n今天或明天都可以\n補充：A. 今天也行', '問題1:AB', 1],
];

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-q-'));
try {
  for (const [text, want, warn] of CASES) {
    assert.equal(shape(serverParse(text)), want, `伺服器解析：${text.slice(0, 30)}`);
    assert.equal(shape(webParse(text)), want, `網頁解析：${text.slice(0, 30)}`);
    assert.equal(optionWarnings(text).length, warn, `提醒：${text.slice(0, 30)}`);
  }
  assert.equal(optionWarnings('[進度] 選一個\nA. x\nB. y').length, 0, '不是 [需確認] 不提醒');

  // API：AI 發 [需確認] 格式錯，回應帶 warnings；正確就沒有
  const db = openNodeDb(path.join(dataDir, 'x.db'));
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000' } });
  const call = async (token, p, method = 'GET', body) => { const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost'); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PO', role: '產品負責', name: 'claude-PO', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  let r = await call(ai.token, '/api/messages', 'POST', { requestId: 'q1', project: '平台', recipientIds: [liu.participant.participantId], text: CASES[2][0] });
  assert.equal(r.status, 201); assert.ok(r.body.warnings?.some(w => /沒有變成按鈕/.test(w)), 'AI 發錯格式：回應帶提醒');
  r = await call(ai.token, '/api/messages', 'POST', { requestId: 'q2', project: '平台', recipientIds: [liu.participant.participantId], text: CASES[0][0] });
  assert.ok(!r.body.warnings?.length, '放寬後認得的寫法：不提醒');
  console.log('questions-test：全部通過');
} catch (err) {
  console.error('questions-test 失敗：', err.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
