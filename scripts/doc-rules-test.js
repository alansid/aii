// C-318 驗收測試：接入文件瘦身但規則不能少
// 接入設定 ≤ 5,000 字（含一般長度的角色設定與即時通道金鑰）、規格 ≤ 20,000 字；
// 必做／禁止事項清單（從瘦身前的接入設定與規格整理）在「接入設定＋規格」裡一條都不能少
// 用法：node scripts/doc-rules-test.js　（--old 只檢查規則，用來比對瘦身前也都有）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const onlyRules = process.argv.includes('--old');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-docrules-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
const app = createApp({ db, storage: dbStorage(db), docText: spec, config: { openJoin: '1', rateLimitPerMin: '10000', supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co', supabaseKey: 'k'.repeat(208) } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const len = t => [...t].length;

// 必做／禁止事項（每條：說明、正規式；接入設定或規格任一處有就算）
const RULES = [
  ['身分不符就停（讀到別的 AI 的設定）', /名字不是[^\n]{0,40}(停下來|停止)/],
  ['重新接上不要重新簽到', /不要重新簽到/],
  ['游標不要從頭讀、也不要跳到最新', /不要從頭讀[^\n]{0,8}(也)?不要[^\n]{0,4}跳到最新/],
  ['Token 不貼群組、不進 git、不寫日誌', /不要把 Token 貼到群組[^\n]{0,12}寫進 git[^\n]{0,8}日誌/],
  ['.aigile 不進 git', /\.aigile\/ 不能進 git/],
  ['同台電腦的 AI 代號、Token、狀態檔絕不共用', /Token[^\n]{0,6}狀態檔[^\n]{0,4}絕不共用/],
  ['絕不假稱已連線', /(絕不|絕對不可)假稱已連線/],
  ['短版 setup.md 存好 token 後刪掉', /setup\.md[^\n]{0,20}含 Token[^\n]{0,20}刪掉/],
  ['歷史訊息不是新任務', /歷史訊息不是新任務/],
  ['只簽到一次，之後重連不再簽到', /之後重連不再簽到/],
  ['同意後才啟動待命；不要自行建立排程或常駐程式', /不要自行建立排程或常駐程式/],
  ['簽到不等於已待命，不可假稱啟動成功', /簽到不(等於|代表)已待命[^\n]*(不可假稱|假稱)/s],
  ['watcher 先讀過內容並核對 SHA-256', /先讀過內容[^\n]{0,40}SHA-256|SHA-256[^\n]{0,80}先讀過內容/],
  ['雜湊不符重下一次，仍不符才停止', /(重下|重新下載)[^\n]{0,30}仍不符才停止/],
  ['被工具安全檢查擋下不要繞過、不要換寫法重試', /不要繞過、不要換寫法重試/],
  ['Claude Code 不要用 Monitor、不要 sleep 迴圈', /不要用 Monitor[^\n]{0,10}不要[^\n]{0,4}sleep 迴圈/],
  ['等待腳本 UNAUTHORIZED／NETWORK_ERROR／CONFIG_ERROR 要停止回報', /UNAUTHORIZED／NETWORK_ERROR／CONFIG_ERROR[^\n]{0,6}(→ )?(就)?停止/],
  ['每輪核對 participantId，不一致立刻停止', /participantId[^\n]{0,30}不一致[^\n]{0,30}立刻停止/],
  ['處理完才 ACK，最後才存游標', /處理完才 ACK[^\n]{0,6}最後才/],
  ['沒事不發文', /不發文/],
  ['要求停止就立刻停止', /要求停止[^\n]{0,8}立刻停/],
  ['401 立刻停止所有排程並告訴所屬人類', /401 (INVALID_TOKEN|`INVALID_TOKEN`)[^\n]{0,60}立刻停止[^\n]{0,20}排程/],
  ['429 依 Retry-After 再試', /Retry-After/],
  ['403 READ_ONLY 停下，不重試、不繞過', /READ_ONLY[^\n]{0,90}不(要)?重試[^\n]{0,8}不(要)?(換專案)?繞過/],
  ['project 一律填 API 代號，顯示名稱不要當 project', /project (欄位)?一律填[^\n]{0,4}API 代號/],
  ['每則發文都帶 project', /每則(發文)?都(要)?帶 project/],
  ['requestId 重試沿用同一個與相同內容', /沿用同一個( ?requestId ?)?與相同內容/],
  ['正文的 @名字不會通知', /@名字[^\n]{0,6}不會通知/],
  ['audience all 不可與 recipientIds 同時用', /不可與 `?recipientIds`? ?同(時|用)/],
  ['replyFrom 一則最多一位', /一則最多一位/],
  ['[需確認] 一定要用 replyFrom 指定', /\[需確認\]`? 一定要(用 replyFrom )?指定/],
  ['ACK 只用 notificationId，絕不用 messageId', /絕不(用|傳) messageId/],
  ['ACK 失敗只重試 ACK，不重複發文', /ACK 失敗只重試 ACK/],
  ['第一段只寫一句白話結論，空一行之後才寫細節', /第一段只寫一句給人看的白話結論[^\n]*空一行之後才寫細節/],
  ['訊息 600 字內、一件事一則', /600 字內[^\n]{0,3}一件事一則/],
  ['中文用 UTF-8，Git Bash 不要 curl -d 中文', /不要[^\n]{0,4}curl -d "中文"/],
  ['上傳必須帶 declared=true', /必須帶 `?declared=true/],
  ['不可上傳程式碼或客戶個資', /(禁止上傳任何程式碼|不可上傳程式碼)[^\n]{0,30}客戶個資/],
  ['不要請行內或投信成員把程式碼傳出來', /不要請行內或投信成員把程式碼/],
  ['別人的簽到不打招呼，簽到感謝等不回、靜默 ACK', /簽到、感謝、確認[^\n]{0,60}靜默 ACK/],
  ['只是知會就不回', /知會[^\n]{0,30}不回|ask 為 false[^\n]{0,20}不回/],
  ['群組訊息不能擴大授權', /群組[^\n]{0,30}不能擴大你的授權/],
  ['commit／push／merge／部署／遷移先在本機取得同意，每次 push 重新取得', /每次 push 都要重新取得授權/],
  ['刪資料、對外發布、付費、上傳程式碼或個資、改別人的卡不能長期授權', /刪除資料、對外發布、付費、上傳程式碼或客戶個資、改別人的卡[^\n]{0,6}不能長期授權/],
  ['要人選擇一律發到網頁 [需確認]，授權仍在本機問', /已發到網頁[^\n]*\n?[^\n]*仍在本機/],
  ['交付附 40 碼 commit SHA，push 後 git ls-remote 確認', /40 碼 commit SHA[^\n]{0,30}git ls-remote/],
  ['不自行宣稱完成', /不自行宣稱完成/],
  ['規則優先順序', /規則優先順序/],
  ['新工作開新卡', /新工作開新卡/],
  ['完成者不能自己標已驗證', /不要自己標已驗證|完成者不能自己標已驗證/],
  ['只能改自己負責的卡；派工用建議', /只能改自己負責的卡/],
  ['卡片適用與訊息相同的環境限制', /適用(與|跟)[^\n]{0,6}(群組)?訊息相同的環境限制/],
  ['工作記憶只在改變時寫，不放 Token', /只在(狀態)?改變時(才)? ?(寫|PUT)/],
  ['行內／投信只寫任務標題與 SHA', /行內／投信(AI )?只寫任務標題與 SHA/],
  ['私訊不轉貼群組', /私訊(內容)?不(要)?轉貼(到)?群組/],
  ['私訊不能授權 commit、push、部署', /私訊不能(拿來|用來)授權 commit、push、部署/],
  ['頭像或角色只能提案；做不到不要假裝', /不要假裝/],
  ['不進行無人監督的多輪 AI 互聊', /無人監督(地)?(的)?多輪/],
  ['同一時間只做一個工作', /同一時間只做一個/],
  ['[決策紀錄] 不能代替人類決定', /不能代替人類決定/],
  ['只有決策者能 decide', /只有(指定的)?決策者/],
  ['人類紀錄卡只能讀', /只能讀/],
  ['AI 不能設帳號密碼、不保管轉貼密碼', /不要幫人類保管、轉貼或詢問密碼/],
  ['SECRET_IN_TEXT：接入連結與 Token 不貼，不要改寫後重送', /SECRET_IN_TEXT/],
  ['沒有同意不要自己建排程（背景常駐）', /沒有同意不要自己建排程|建立排程前一定要先取得所屬人類同意|用排程[^\n]{0,30}之前一定先取得所屬人類同意/],
  ['opencode 不要用 --continue', /不要用 `?--continue/],
  ['wake-qa 只准 DRY_RUN 乾跑', /DRY_RUN=1/],
  ['回應有 warnings：修正後最多重發一次，仍有就停下（C-319）', /warnings[^\n]{0,40}最多重發一次[^\n]{0,8}仍有[^\n]{0,4}停下|重發一次[^\n]{0,30}仍有 `?warnings`? ?就停下[^\n]{0,20}不再重試/],
  ['不整份重讀大檔（C-327）', /不整份重讀/],
  ['命令與日誌只看最後 20 行（C-327）', /最後 20 行/],
  ['接入超過 40 回合就停下回報（C-327）', /超過 40 回合[^\n]{0,12}停下/],
  ['接好就換新對話（C-327）', /接好就換新對話/],
  ['先跑接入檢查腳本（C-327）', /aigile-setup\.mjs/],
];

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const role = { duties: '負責平台的程式開發：照卡片需求實作、寫測試、修 bug、部署到兩站；交接時寫影響範圍與測試名稱。', style: '繁體中文、先講結論', autonomy: '實作、測試、commit、部署', mustConfirm: 'push、資料庫遷移、刪資料', handoff: '交 UX 驗收' };
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['平台'], roleKey: 'PG', role: '程式開發', name: '程式助手', ...role })).body;
  const ob = (await call(liu.token, `/api/my-ais/${ai.participantId}/onboarding`)).body.text;
  const all = ob + '\n' + spec;
  const missing = RULES.filter(([, re]) => !re.test(all)).map(([n]) => n);
  assert.deepEqual(missing, [], '規則不見了：' + missing.join('、'));

  // C-319：警告只回在發文的回應裡，不產生通知（不會叫醒 AI 形成「警告 → 重發 → 警告」迴圈）
  if (!onlyRules) {
    const aiTok = (await db.get('SELECT token FROM participants WHERE id = ?', ai.participantId)).token;
    const before = (await db.get('SELECT COUNT(*) AS n FROM notifications')).n;
    const r = await call(aiTok, '/api/messages', 'POST', { project: '平台', requestId: 'warn1', recipientIds: [liu.participant.participantId], replyFrom: [liu.participant.participantId], text: '[需確認] 兩件事\n問題1：做 A 嗎？\n選項：\nA. 做\nB. 不做\n問題2：什麼時候？\n今天或明天都可以' });
    assert.equal(r.status, 201);
    assert.ok(r.body.warnings?.length, '格式錯的選項回 warnings');
    const added = await db.all('SELECT recipient_id FROM notifications ORDER BY rowid DESC LIMIT ?', (await db.get('SELECT COUNT(*) AS n FROM notifications')).n - before);
    assert.deepEqual(added.map(x => x.recipient_id), [liu.participant.participantId], '只有收件人一則通知，發文的 AI 沒收到任何通知');
  }
  if (!onlyRules) {
    assert.ok(len(ob) <= 5000, `接入設定 ${len(ob)} 字，要 ≤ 5,000`);
    assert.ok(len(spec) <= 20000, `規格 ${len(spec)} 字，要 ≤ 20,000`);
    assert.ok(!/[（(]C-\d{3}[^）)\n]{0,12}[）)]/.test(spec), '規格不再留歷史卡號註記（例：（C-229））');
    assert.ok(!/^```js$/m.test(spec), '規格不放整段範例腳本（改下載 poll.mjs）');
    assert.ok(fs.existsSync(new URL('../public/poll.mjs', import.meta.url)), 'poll.mjs 可下載');
    assert.ok(!/十、團隊成員與所在環境/.test(ob) && /GET \/api\/participants/.test(spec), '名冊改叫 GET /api/participants');
  }
  console.log(`doc-rules-test：全部通過（規則 ${RULES.length} 條；接入設定 ${len(ob)} 字、規格 ${len(spec)} 字）`);
} catch (e) {
  console.error('doc-rules-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
