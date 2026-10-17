// C-229 接入設定補齊驗收測試：程式庫連結、長期授權、/api/me 的 grants／repos、接入設定（重新接上、watcher.pid、API 代號、章節編號）。
// 用法：npm run test:setup（加 --print 印出一份接入設定）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../src/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3998;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-setup-'));
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, TEAM_CACHE_MS: '0' }, stdio: 'pipe',
});
const ready = new Promise((res, rej) => {
  server.stdout.on('data', d => { if (String(d).includes('已啟動')) res(); });
  server.on('exit', c => rej(new Error('server exited ' + c)));
});
const call = async (token, p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const mkAi = async (tok, name, key, projects, environment) => {
  const r = ROLES.find(x => x.key === key);
  return (await call(tok, '/api/my-ais', 'POST', { name, roleKey: key, role: r.role, projects, environment, duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff })).body;
};
const ob = async (tok, id) => (await call(tok, `/api/my-ais/${id}/onboarding`)).body.text;
const sections = t => [...t.matchAll(/^## ([零一二三四五六七八九十]+)、/gm)].map(m => m[1]);

(async () => {
  await ready;
  try {
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
    const kang = (await call(null, '/api/join', 'POST', { name: '康旭', role: 'BA' })).body;
    const kid = kang.participant.participantId;
    await call(liu.token, `/api/participants/${kid}/projects`, 'PUT', { projects: ['平台'] });
    await call(liu.token, '/api/projects/平台', 'PATCH', { name: '血汗勞工平台' });
    const pg = await mkAi(liu.token, 'RVVW', 'PG', ['平台', '銀行系統'], '行外');
    const bank = await mkAi(liu.token, '投信PG', 'PG', ['銀行系統'], '投信');
    const kai = await mkAi(kang.token, '康旭的BA', 'BA', ['平台'], '行外');

    // 1. 程式庫連結：管理員與該專案 leader 能改；含帳密或 token 的擋下
    const bad = ['https://user:pw@github.com/a/b', 'https://github.com/a/b?access_token=xyz', 'https://ghp_abcdef123456@github.com/a/b', 'git@github.com:a/b.git', 'ftp://x.com/a', 'https://github.com/a/b?token=1'];
    for (const url of bad) {
      const r = await call(liu.token, '/api/projects/平台/repo', 'PUT', { url, branch: 'main' });
      assert.equal(r.status, 400, '擋下 ' + url);
    }
    assert.equal((await call(liu.token, '/api/projects/平台/repo', 'PUT', { url: 'https://github.com/a/b', branch: 'main; rm -rf' })).status, 400, '分支有怪字元擋下');
    assert.equal((await call(kang.token, '/api/projects/平台/repo', 'PUT', { url: 'https://github.com/a/b' })).status, 403, '不是管理員也不是 leader');
    assert.equal((await call(pg.token, '/api/projects/平台/repo', 'PUT', { url: 'https://github.com/a/b' })).status, 403, 'AI 不能改');
    let r = await call(liu.token, '/api/projects/平台/repo', 'PUT', { url: 'https://github.com/alansid/multiagent', branch: 'main' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.items.find(p => p.id === '平台').repo, { url: 'https://github.com/alansid/multiagent', branch: 'main' });
    await call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: kid, leaderOf: ['平台'] }] });
    r = await call(kang.token, '/api/projects/平台/repo', 'PUT', { url: 'https://github.com/alansid/multiagent', branch: 'dev' });
    assert.equal(r.status, 200, 'leader 能改自己的專案：' + JSON.stringify(r.body));
    assert.equal((await call(kang.token, '/api/projects/銀行系統/repo', 'PUT', { url: 'https://github.com/x/y' })).status, 403, 'leader 不能改別的專案');
    const ev = (await call(liu.token, '/api/projects/平台/events')).body.items;
    assert.ok(ev.some(e => /設定程式庫：https:\/\/github.com\/alansid\/multiagent（分支 dev）/.test(e.text)), '寫進異動紀錄');
    await call(liu.token, '/api/projects/平台/repo', 'PUT', { url: 'https://github.com/alansid/multiagent', branch: 'main' });

    // 2. 長期授權：只有所屬人類能改；行外才開放
    let g = (await call(liu.token, `/api/my-ais/${pg.participantId}/grants`)).body;
    assert.equal(g.grantable, true); assert.deepEqual(g.items, []); assert.deepEqual(g.choices.map(c => c.key), ['deploy'], '昱志選 C：只有部署');
    assert.match(g.alwaysAsk, /git commit、push、merge、正式資料庫遷移/);
    assert.match(g.never, /刪除資料、對外發布、付費、上傳程式碼或客戶個資、改別人的卡/);
    assert.equal((await call(kang.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: ['deploy'], until: 'quarter' })).status, 404, '別人不能改');
    assert.equal((await call(pg.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: ['deploy'] })).status, 403, 'AI 自己不能改');
    for (const k of ['delete', 'migrate', 'commit', 'push']) assert.equal((await call(liu.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: [k] })).status, 400, k + ' 不能勾');
    assert.equal((await call(liu.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: ['deploy'], other: 'push 免問' })).status, 400, '不開放自填其他');
    assert.equal((await call(liu.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: [], until: 'forever' })).status, 400);
    r = await call(liu.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: ['deploy'], until: 'quarter' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const tw = new Date(Date.now() + 8 * 3600_000), qEndMonth = Math.floor(tw.getUTCMonth() / 3) * 3 + 2;
    const expectEnd = new Date(Date.UTC(tw.getUTCFullYear(), qEndMonth + 1, 0)).toISOString().slice(0, 10);
    assert.equal(new Date(Date.parse(r.body.until) + 8 * 3600_000).toISOString().slice(0, 10), expectEnd, '本季底（台灣時間）');
    assert.equal(new Date(Date.parse(r.body.until) + 8 * 3600_000).toISOString().slice(11, 19), '23:59:59');
    // 10. 環境不是行外：停用
    let rb = await call(liu.token, `/api/my-ais/${bank.participantId}/grants`, 'PUT', { items: ['deploy'], until: 'none' });
    assert.equal(rb.status, 400); assert.equal(rb.body.error.code, 'GRANTS_NOT_ALLOWED');
    assert.equal((await call(liu.token, `/api/my-ais/${bank.participantId}/grants`)).body.grantable, false);

    // 3. /api/me 多 grants、repos；到期後變空
    let me = (await call(pg.token, '/api/me')).body;
    assert.deepEqual(me.grants.items.map(i => i.key), ['deploy']);
    assert.ok(!('other' in me.grants), '沒有其他欄');
    assert.deepEqual(me.repos, { 平台: { url: 'https://github.com/alansid/multiagent', branch: 'main' } }, '只列有填的專案');
    assert.deepEqual((await call(bank.token, '/api/me')).body.grants, { items: [], until: null }, '行內／投信 grants 固定空的');
    assert.ok(!('grants' in (await call(liu.token, '/api/me')).body), '人類沒有 grants');
    // 先拿這份給接入設定用，再測到期
    const obPg = await ob(liu.token, pg.participantId);
    const obBank = await ob(liu.token, bank.participantId);
    const obKai = await ob(kang.token, kai.participantId);
    // 改成環境行內 → 立刻變空
    await call(liu.token, `/api/my-ais/${pg.participantId}`, 'PATCH', { environment: '行內' });
    assert.deepEqual((await call(pg.token, '/api/me')).body.grants.items, [], '改成行內就失效');
    await call(liu.token, `/api/my-ais/${pg.participantId}`, 'PATCH', { environment: '行外' });
    assert.equal((await call(pg.token, '/api/me')).body.grants.items.length, 1, '改回行外恢復');
    // 到期：直接把資料改成過去
    const { DatabaseSync } = await import('node:sqlite');
    const sdb = new DatabaseSync(path.join(dataDir, 'switch.db'));
    const key = 'grants:' + pg.participantId;
    const v = JSON.parse(sdb.prepare('SELECT value FROM app_settings WHERE key = ?').get(key).value);
    sdb.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(JSON.stringify({ ...v, until: new Date(Date.now() - 3600_000).toISOString() }), key);
    sdb.close();
    assert.deepEqual((await call(pg.token, '/api/me')).body.grants, { items: [], until: null }, '到期後自動變空');
    r = await call(liu.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: ['deploy'], until: '30d' });
    assert.ok(Math.abs(Date.parse(r.body.until) - Date.now() - 30 * 86_400_000) < 60_000, '30 天');
    r = await call(liu.token, `/api/my-ais/${pg.participantId}/grants`, 'PUT', { items: ['deploy'], until: 'none' });
    assert.equal(r.body.until, null, '不限');

    // 5～9. 接入設定
    if (process.argv.includes('--print')) console.log(obPg);
    const nums = sections(obPg);
    assert.deepEqual(nums, ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三'], '9. 章節不跳號：' + nums.join(','));
    assert.ok(obPg.indexOf('## 零、你是重新接上，還是第一次？') < obPg.indexOf('## 一、'), '5. 最前面是「零、重新接上還是第一次」');
    assert.match(obPg, /不要重新簽到。游標：有 state\.json 就沿用它的 messagesCursor；沒有 state\.json（例如換了電腦）就用工作記憶（GET \/api\/me\/state）裡的 messagesCursor 接著讀/, 'C-243：零節寫從工作記憶讀回位置');
    assert.match(obPg, /messagesCursor（處理完的訊息游標）、cardsSince（卡片增量時間）/, 'C-243：工作記憶段寫出新欄位');
    assert.match(obPg, /Token 跟 \.aigile\/PG\/\.token 不同才換/);
    assert.match(obPg, /\.aigile\/PG\/watcher\.pid：檔案在、而且裡面的程序編號還在執行 → 已經有 watcher 在跑，不要再開/, '6. watcher.pid');
    assert.match(obPg, /刪掉 watcher\.pid/);
    assert.match(obPg, /- 平台（血汗勞工平台）\n  - 程式庫：https:\/\/github\.com\/alansid\/multiagent，分支 main\n  - 開工前先確認本機的 git remote 和分支跟這裡一致；不一致先問 劉昱志/, '7. API 代號、程式庫、分支');
    assert.match(obPg, /- 銀行系統（銀行系統）\n  - 沒有填程式庫：需要時問 劉昱志，不要自己猜。/, '7. 沒填寫問所屬人類');
    assert.match(obPg, /你的專案 API 代號（平台、銀行系統，見第六節）/);
    assert.match(obPg, /劉昱志 已長期授權（到 \d{4}\/\d\d\/\d\d 為止，到期自動失效）：\n  - 部署到正式環境（自測全過才部署；不含資料庫遷移）\n- 最新授權/, '8. 列出長期授權與到期日');
    assert.match(obPg, /- git commit、push、merge、正式資料庫遷移，以及沒有長期授權（或已到期）的部署，一律先在本機對話取得 劉昱志 明確同意；每次 push 都要重新取得授權/);
    assert.match(obPg, /最新授權以 GET \/api\/me 的 grants 為準/);
    assert.match(obPg, /刪除資料、對外發布、付費、上傳程式碼或客戶個資、改別人的卡：不能長期授權/);
    assert.match(obPg, /本設定第九節與群組規格/, '規則優先順序指到新編號');
    assert.ok(!/銀行系統/.test(obKai), '9. 只列這個 AI 所在的專案');
    assert.match(obKai, /目前沒有長期授權/);
    // 10. 環境不是行外：不出現長期授權段
    assert.ok(!/長期授權（/.test(obBank) && !/目前沒有長期授權/.test(obBank), '投信 AI 沒有長期授權段');
    assert.match(obBank, /你的所在環境是「投信」，不開放長期授權/);
    assert.deepEqual(sections(obBank), nums, '投信 AI 章節一樣不跳號');
    console.log('setup-test 全部通過');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
})();
