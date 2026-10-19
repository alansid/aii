// Aigile-Switch 網頁端
(() => {
  const $ = sel => document.querySelector(sel);
  const APP_VERSION = '0.73.3'; // C-281：回報時自動帶；要跟 package.json 一樣（feedback-test 會檢查）
  const TOKEN_KEY = 'aigile-switch-token';
  const THEME_KEY = 'aigile-switch-theme';
  const FILTER_KEY = 'aigile-switch-only-mine';
  const MSG_VIEW_KEY = 'aigile-switch-view'; // C-215：訊息顯示「精簡／完整」，記在這台裝置
  const ALL = { participantId: '__all__', name: '所有人', role: '通知全體成員', memberType: 'all', isOnline: true };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  const state = {
    token: null,
    me: null,
    participants: new Map(),
    messages: [],
    byId: new Map(),
    nextCursor: null,
    olderCursor: null,
    replyTo: null,
    onlyMine: store.get(FILTER_KEY) === '1',
    filter: { scope: store.get(FILTER_KEY) === '1' ? 'related' : 'all', member: '', tag: '' },
    expanded: new Set(),  // 已展開全文的長訊息
    collapsed: new Set(), // 已收合回覆的訊息
    open: new Set(),      // C-215：從一行／精簡點開的訊息
    grpOpen: new Set(),   // C-262 B：展開了較早訊息的卡片組
    flowOpen: new Set(),  // C-215：已展開的「N 則流程訊息」（以第一則的 id 記）
    groupOf: new Map(),   // C-215：訊息 id → 所在流程訊息群組的第一則 id（收起時）
    events: null,
    roles: null,
    team: null,
    unansweredByMsg: new Map(),
  };

  // ---------- 共用 ----------
  async function api(path, { method = 'GET', body, timeoutMs = 0 } = {}) {
    // C-163：輪詢要設逾時，否則網路卡住時 fetch 可能永遠不回來，整個輪詢跟著停
    const ctl = timeoutMs ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), timeoutMs);
    let r;
    try {
      r = await fetch(path, {
        method, signal: ctl?.signal,
        headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      const err = new Error(ctl?.signal.aborted ? '連線逾時' : '連線失敗');
      err.code = ctl?.signal.aborted ? 'TIMEOUT' : 'NETWORK';
      throw err;
    } finally { clearTimeout(timer); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data?.error?.message || `HTTP ${r.status}`);
      err.code = data?.error?.code;
      state.lastErr = { code: err.code || `HTTP ${r.status}`, at: Date.now() }; // C-281
      if (state.me && (err.code === 'INVALID_TOKEN' || err.code === 'TOKEN_EXPIRED')) logout(false);
      throw err;
    }
    return data;
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const fmtTime = iso => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const shortId = id => '#' + String(id).slice(-6);
  const newRequestId = () => 'req_web_' + (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`);

  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
  }
  // C-226：提示＋一顆按鈕（例如「已建立 C-12 · 打開」），預設 6 秒消失
  function actionToast(text, label, onClick, ms = 6000) {
    const t = $('#toast');
    t.innerHTML = `${esc(text)} <button type="button" class="link toast-undo" id="toast-act">${esc(label)}</button>`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
    t.querySelector('#toast-act').onclick = () => { t.hidden = true; clearTimeout(toastTimer); onClick(); };
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
  applyTheme(store.get(THEME_KEY));

  // 文字頭像：AI 用角色代碼（PO、PG…），自訂角色取角色名前兩字；人類取名字第一個字
  // 自訂頭像文字優先，否則用預設
  function avatarText(p) {
    if (p.avatar) return p.avatar;
    if (p.memberType === 'ai') return p.roleKey && p.roleKey !== 'custom' ? p.roleKey : [...(p.role || 'AI')].slice(0, 2).join('');
    if (p.memberType === 'system') return '系';
    return [...(p.name || '人')][0];
  }
  // 有圖片頭像時先顯示文字，圖片載入後由 hydrateAvatars 補上
  const avatar = p => {
    const shape = p.memberType === 'ai' ? 'ai' : 'human';
    if (p.imgUrl) return `<span class="avatar ${shape} img-on" style="background-image:url(&quot;${esc(p.imgUrl)}&quot;)" aria-hidden="true"></span>`;
    const img = p.avatarImg && p.participantId ? ` data-avimg="${esc(p.participantId)}" data-v="${esc(p.avatarImg)}"` : '';
    return `<span class="avatar ${shape}"${img} aria-hidden="true">${esc(avatarText(p))}</span>`;
  };
  const envTag = p => p?.environment ? `<span class="tag env" title="所在環境">📍${esc(p.environment)}</span>` : '';
  const memberTag = p => p.memberType === 'ai'
    ? `<span class="tag ai">AI | 所屬: ${esc(p.ownerName || '?')}</span>`
    : p.memberType === 'system' ? '<span class="tag sys">[系統]</span>'
    : '<span class="tag human">[人類]</span>';

  // ---------- 登入（C-202）：邀請連結加入、6 位數配對、登入碼（長期保留） ----------
  async function useDevice(token) {
    state.token = token;
    store.set(TOKEN_KEY, token);
    await start();
  }
  const authLogin = async (method, body) => useDevice((await api('/api/auth/' + method, { method: 'POST', body })).token);

  async function showJoin() {
    $('#boot').hidden = true;
    $('#app').hidden = true;
    $('#invite').hidden = true;
    $('#join').hidden = false;
    if ($('#token-error').textContent) setLoginTab('code', false); // 登入碼出錯就停在登入碼分頁
    try {
      const h = await api('/api/health');
      $('#join-form').hidden = !h.setup; // 群組還沒有人：建立群組
      $('#login-main').hidden = !!h.setup;
      $('#join-title').textContent = h.setup ? '建立群組' : '歡迎回來';
      $('#join-admin').textContent = h.adminName || '管理員';
      $('#room-code-field').hidden = !h.roomCodeRequired;
    } catch {}
  }

  // 建立群組（第一位）：建好後同樣換成這台裝置的登入
  $('#join-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('#join-error').textContent = '';
    try {
      const r = await api('/api/join', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      await authLogin('code', { code: r.token });
    } catch (err) {
      $('#join-error').textContent = err.message;
    }
  });

  $('#pair-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('#pair-error').textContent = '';
    const code = String(new FormData(e.target).get('code') || '').replace(/\D/g, '');
    if (code.length !== 6) { $('#pair-error').textContent = '請輸入 6 位數字'; return; }
    try { await authLogin('pair', { code }); rememberLoginTab('pair'); } catch (err) { state.token = null; $('#pair-error').textContent = err.message; }
  });
  // 配對碼：只留數字，打到 6 碼自動送出
  $('#pair-form .pair-input').addEventListener('input', e => {
    const v = e.target.value.replace(/\D/g, '').slice(0, 6);
    if (e.target.value !== v) e.target.value = v;
    if (v.length === 6) $('#pair-form').requestSubmit();
  });

  // ---------- C-238 登入方式分頁：帳號密碼｜配對裝置｜登入碼；記住這台裝置上次成功用的分頁 ----------
  const LOGIN_TAB_KEY = 'aigile-switch-login-tab';
  const LOGIN_TABS = { pwd: 'pwd-form', pair: 'pair-form', code: 'token-form' };
  function setLoginTab(k, focus = true) {
    if (!LOGIN_TABS[k]) k = 'pwd';
    for (const [t, panel] of Object.entries(LOGIN_TABS)) {
      const on = t === k, tab = document.querySelector(`[data-lt="${t}"]`);
      tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1;
      $('#' + panel).hidden = !on;
    }
    if (focus) document.querySelector(`#${LOGIN_TABS[k]} input`)?.focus();
  }
  const rememberLoginTab = k => store.set(LOGIN_TAB_KEY, k);
  setLoginTab(store.get(LOGIN_TAB_KEY) || 'pwd', false); // 第一次預設帳號密碼
  document.querySelector('.login-tabs').addEventListener('click', e => { const t = e.target.closest('[data-lt]'); if (t) setLoginTab(t.dataset.lt); });
  document.querySelector('.login-tabs').addEventListener('keydown', e => {
    const keys = Object.keys(LOGIN_TABS), cur = keys.indexOf(document.activeElement?.dataset?.lt);
    if (cur < 0) return;
    const next = e.key === 'ArrowRight' ? (cur + 1) % keys.length : e.key === 'ArrowLeft' ? (cur + keys.length - 1) % keys.length : e.key === 'Home' ? 0 : e.key === 'End' ? keys.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setLoginTab(keys[next], false);
    document.querySelector(`[data-lt="${keys[next]}"]`).focus();
  });
  $('#pwd-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('#pwd-error').textContent = '';
    const f = new FormData(e.target), btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try { await authLogin('password', { username: String(f.get('username')).trim(), password: f.get('password') }); rememberLoginTab('pwd'); }
    catch (err) { state.token = null; $('#pwd-error').textContent = err.message; e.target.password.select(); }
    finally { btn.disabled = false; }
  });
  // 密碼欄的「顯示／隱藏」
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-eye]');
    if (!b) return;
    const inp = b.parentElement.querySelector('input');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    b.textContent = show ? '隱藏' : '顯示';
    b.setAttribute('aria-pressed', String(show));
  });

  $('#token-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('#token-error').textContent = '';
    const code = new FormData(e.target).get('token').trim();
    try { await authLogin('code', { code }); rememberLoginTab('code'); } catch (err) { state.token = null; $('#token-error').textContent = err.message; }
  });

  // 被邀請頁：/invite/<連結>。連結先收進這個分頁，網址列只留 /invite，重新整理也還在
  const INVITE_KEY = 'aigile-switch-invite';
  const ss = { get: k => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} }, del: k => { try { sessionStorage.removeItem(k); } catch {} } };
  let inviteTimer = null;
  async function showInvite() {
    let tok = decodeURIComponent(location.pathname.replace(/^\/invite\/?/, ''));
    if (tok) { ss.set(INVITE_KEY, tok); history.replaceState(null, '', '/invite'); } else tok = ss.get(INVITE_KEY) || '';
    $('#boot').hidden = true; $('#app').hidden = true; $('#join').hidden = true; $('#invite').hidden = false;
    const card = $('#invite-card');
    card.innerHTML = '<p class="muted">讀取邀請中…</p>';
    let d;
    try { d = await api('/api/auth/invite/peek', { method: 'POST', body: { token: tok } }); } catch { d = { valid: false }; }
    if (!d.valid) return inviteGone(d.adminName);
    const reset = d.kind === 'reset';
    card.innerHTML = `<p class="inv-from"><b>${esc(d.inviterName || '')}</b> 邀請你加入</p>
      <h1 class="inv-group">${esc(d.groupName)}</h1>
      <dl class="inv-meta"><dt>專案</dt><dd>${d.projects.length ? d.projects.map(p => esc(p.name)).join('、') : '<span class="muted">還沒有（加入後由管理員指派）</span>'}</dd>
        <dt>角色</dt><dd>${esc(d.role || '—')}</dd></dl>
      <form id="inv-form" class="join-pane">
        <label>你的名字<input name="name" value="${esc(d.name)}" maxlength="40" required autocomplete="nickname" ${reset ? 'readonly' : ''}></label>
        <p class="muted small">${reset ? '這是重設登入的連結：按「加入」後，這台裝置會以你原本的身分登入。' : '確認名字沒錯就按「加入」，這台裝置會記住你。'}</p>
        <fieldset class="inv-pwd"><legend>設帳號密碼（選填）</legend>
          <p class="muted small">設了以後換裝置、清掉瀏覽器也能自己登入。</p>
          <label>帳號<input name="username" maxlength="30" autocomplete="username" autocapitalize="none" spellcheck="false"></label>
          <label>密碼（至少 8 碼）<span class="pwd-wrap"><input name="password" type="password" maxlength="128" autocomplete="new-password"><button type="button" class="pwd-eye" data-eye aria-pressed="false" aria-label="顯示密碼">顯示</button></span></label>
          <label>再輸入一次<input name="passwordAgain" type="password" maxlength="128" autocomplete="new-password"></label>
        </fieldset>
        <p id="inv-error" class="error" role="alert"></p>
        <button class="btn primary" type="submit">加入</button>
      </form>
      <p class="muted small inv-left">這個連結 <b id="inv-cd"></b> 後失效，只能用一次。</p>`;
    const end = Date.parse(d.expiresAt);
    const tick = () => {
      const left = end - Date.now();
      if (!$('#inv-cd')) return clearInterval(inviteTimer);
      if (left <= 0) { clearInterval(inviteTimer); return inviteGone(d.adminName || d.inviterName); }
      $('#inv-cd').textContent = mmss(left);
    };
    clearInterval(inviteTimer); inviteTimer = setInterval(tick, 1000); tick();
    $('#inv-form').addEventListener('submit', async e => {
      e.preventDefault();
      $('#inv-error').textContent = '';
      const btn = e.target.querySelector('button[type=submit]');
      const fd = new FormData(e.target);
      const cred = { username: String(fd.get('username') || '').trim(), password: fd.get('password') || '', passwordAgain: fd.get('passwordAgain') || '' };
      const anyCred = Object.values(cred).some(Boolean); // 三格都空＝不設
      if (anyCred) {
        const bad = credError(cred.username, cred.password, cred.passwordAgain);
        if (bad) { $('#inv-error').textContent = bad; return; }
      }
      btn.disabled = true;
      try {
        const r = await api('/api/auth/invite', { method: 'POST', body: { token: tok, name: fd.get('name').trim(), ...(anyCred ? cred : {}) } });
        clearInterval(inviteTimer);
        ss.del(INVITE_KEY);
        history.replaceState(null, '', '/');
        $('#invite').hidden = true;
        $('#boot').hidden = false;
        await useDevice(r.token);
      } catch (err) {
        btn.disabled = false;
        if (err.code === 'INVITE_INVALID') return inviteGone(d.adminName || d.inviterName);
        $('#inv-error').textContent = err.message;
      }
    });
  }
  // C-223：帳號密碼的前端檢查（伺服器也會再檢查）
  function credError(username, password, again) {
    if (!/^[a-z0-9._-]{4,30}$/i.test(username)) return '帳號需為 4～30 字，只能用英文、數字、. _ -';
    if (password.length < 8) return '密碼至少 8 碼';
    if (password !== again) return '兩次輸入的密碼不一樣';
    return '';
  }
  // C-223 主機救援連結：/rescue/<連結>，按「登入」才用掉（避免連結預覽先把它用掉）
  const RESCUE_KEY = 'aigile-switch-rescue';
  function showRescue() {
    let tok = decodeURIComponent(location.pathname.replace(/^\/rescue\/?/, ''));
    if (tok) { ss.set(RESCUE_KEY, tok); history.replaceState(null, '', '/rescue'); } else tok = ss.get(RESCUE_KEY) || '';
    $('#boot').hidden = true; $('#app').hidden = true; $('#join').hidden = true; $('#invite').hidden = false;
    const card = $('#invite-card');
    card.innerHTML = `<h1 data-group-name>${esc(BASE_TITLE)}</h1>
      <p class="inv-from">主機救援登入</p>
      <p>用這個一次性連結，以<b>管理員</b>身分登入這台裝置。連結 15 分鐘內有效、只能用一次；登入後管理員的收件匣會收到安全通知。</p>
      <p id="rsc-error" class="error" role="alert"></p>
      <button class="btn primary" type="button" id="rsc-go">登入</button>
      <p><a href="/" class="link" id="rsc-home">回登入頁</a></p>`;
    if (!tok) { $('#rsc-error').textContent = '這個救援連結已失效（15 分鐘、只能用一次）。請聯絡管理員。'; $('#rsc-go').hidden = true; }
    $('#rsc-go').onclick = async () => {
      $('#rsc-error').textContent = '';
      $('#rsc-go').disabled = true;
      try {
        const r = await api('/api/auth/rescue', { method: 'POST', body: { token: tok } });
        ss.del(RESCUE_KEY);
        history.replaceState(null, '', '/');
        $('#invite').hidden = true; $('#boot').hidden = false;
        await useDevice(r.token);
      } catch (err) {
        $('#rsc-go').disabled = false;
        $('#rsc-error').textContent = err.message;
        if (err.code === 'RESCUE_INVALID') { ss.del(RESCUE_KEY); $('#rsc-go').hidden = true; }
      }
    };
    $('#rsc-home').onclick = e => { e.preventDefault(); ss.del(RESCUE_KEY); history.replaceState(null, '', '/'); showJoin(); };
  }
  function inviteGone(adminName) {
    clearInterval(inviteTimer);
    ss.del(INVITE_KEY);
    $('#invite-card').innerHTML = `<h1 data-group-name>${esc(BASE_TITLE)}</h1>
      <p class="inv-gone">這個邀請連結已失效，請${esc(adminName || '管理員')}重新傳一個給你。</p>
      <p><a href="/" class="link" id="inv-pair">已經加入過？用原本的裝置配對</a></p>`;
    $('#inv-pair').onclick = e => { e.preventDefault(); history.replaceState(null, '', '/'); showJoin().then(() => $('#pair-form .pair-input').focus()); };
  }
  const mmss = ms => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

  async function logout(confirmFirst = true) {
    if (confirmFirst && !await confirmDialog({ title: '登出這台裝置？', confirmText: '登出', message: '登出後，這台裝置要重新配對（在其他已登入的裝置點頭像 ▸「我的裝置」▸「＋配對新裝置」）或用登入碼才能再登入。其他裝置不受影響。' })) return;
    const tok = state.token;
    state.me = null; // 先清掉，避免登出請求失敗時又觸發登出
    if (tok) fetch('/api/auth/logout', { method: 'POST', keepalive: true, headers: { Authorization: `Bearer ${tok}` } }).catch(() => {});
    store.del(TOKEN_KEY);
    state.token = null;
    clearTimeout(pollTimer);
    location.replace('/');
  }
  document.querySelectorAll('.logout-btn').forEach(b => b.addEventListener('click', () => logout(true)));

  function drawMe() {
    const meCard = `<button type="button" class="me-avatar-btn" data-change-avatar title="更換頭像" aria-label="更換頭像">${avatar(state.me)}<span class="pen" aria-hidden="true">✎</span></button><div class="me-info"><b>${esc(state.me.name)}</b><span class="muted small">${esc(state.me.role || '未設定角色')} · 本人</span></div>`;
    $('#sheet-me').innerHTML = meCard;
  }

  document.addEventListener('click', e => { if (e.target.closest('[data-change-avatar]')) { closeSheet(false); changeMyAvatar(); } });

  // ---------- C-182 右上頭像選單（每個畫面都有）：我的 AI、成員與權限（管理員）、個人設定、API 資訊與登入碼、登出 ----------
  const isAdmin = () => !!state.projMeta.adminId && state.projMeta.adminId === state.me?.participantId;
  // C-183：專案 leader（每個專案可多位、只能人類）
  const leadersOf = pj => state.projMeta.leaders?.[pj] || [];
  const myLeadProjects = () => (state.me ? PROJECTS.filter(pj => leadersOf(pj).includes(state.me.participantId)) : []);
  const leaderTag = (id, pj) => (leadersOf(pj).includes(id) ? '<span class="lead-tag" title="專案 leader">★ leader</span>' : '');
  state.myAiCount = null;
  function drawAvatarMenu() {
    if (!state.me) return;
    document.querySelectorAll('.av-btn:not(.me-more)').forEach(b => { b.innerHTML = avatar(state.me); b.setAttribute('aria-label', `${state.me.name} 的個人選單`); });
    $('#av-menu').innerHTML = `<div class="av-head">${avatar(state.me)}<span class="av-head-txt"><b>${esc(state.me.name)}</b><span class="muted small">${esc([roleIn(state.me, projectView()) || '未設定角色', isAdmin() ? '管理員' : '', '本人'].filter(Boolean).join(' · '))}</span></span></div>
      <button type="button" role="menuitem" data-av="avatar">更換頭像</button>
      <button type="button" role="menuitem" data-av="myai">我的 AI${state.myAiCount != null ? `<span class="av-n">${state.myAiCount}</span>` : ''}</button>
      ${isAdmin() || myLeadProjects().length ? `<button type="button" role="menuitem" data-av="perm">成員與權限<span class="muted small">${isAdmin() ? '管理員' : 'leader'}</span></button>` : ''}
      <button type="button" role="menuitem" data-av="wishes">✨ 許願池</button>
      <button type="button" role="menuitem" data-av="releases">版本紀錄<span class="muted small">v${APP_VERSION}</span></button>
      <button type="button" role="menuitem" data-av="settings">個人設定</button>
      <button type="button" role="menuitem" data-av="devices">我的裝置</button>
      <button type="button" role="menuitem" data-av="api">API 資訊與登入碼</button>
      <div class="av-sep" role="separator"></div>
      <button type="button" role="menuitem" class="av-out" data-av="logout">登出</button>`;
  }
  const refreshMyAiCount = () => api('/api/my-ais').then(d => { state.myAiCount = d.items.filter(a => a.status !== 'deleted').length; drawAvatarMenu(); }).catch(() => {});
  function avOpen(open, from) {
    const m = $('#av-menu');
    m.hidden = !open;
    document.querySelectorAll('.av-btn').forEach(b => b.setAttribute('aria-expanded', String(open && b === from)));
    if (open) {
      const r = from.getBoundingClientRect(), h = m.offsetHeight, w = m.offsetWidth;
      m.style.top = `${Math.round(r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6)}px`; // C-244：側欄最下面的「⋯」往上開
      if (r.left < innerWidth / 2) { m.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - w - 8)))}px`; m.style.right = 'auto'; }
      else { m.style.left = 'auto'; m.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`; }
      m.querySelector('button')?.focus();
    }
  }
  function goTop(page) { closeSheet(false); if (hasHub()) setProjectView('hub', page); else showPage(page); }
  document.addEventListener('click', e => {
    const b = e.target.closest('.av-btn');
    if (b) return avOpen($('#av-menu').hidden, b);
    if (!e.target.closest('#av-menu')) { if (!$('#av-menu').hidden) avOpen(false); return; }
    const it = e.target.closest('[data-av]');
    if (!it) return;
    avOpen(false);
    const k = it.dataset.av;
    if (k === 'myai' || k === 'perm') goTop(k);
    else if (k === 'settings') openSettings();
    else if (k === 'avatar') changeMyAvatar();
    else if (k === 'wishes') openWishes(); // C-290
    else if (k === 'releases') openReleases(); // C-291
    else if (k === 'api') openApi();
    else if (k === 'devices') openDevices();
    else if (k === 'logout') logout(true);
  });
  document.addEventListener('keydown', e => {
    if ($('#av-menu').hidden || !e.target.closest?.('#av-menu')) return;
    const items = [...$('#av-menu').querySelectorAll('button')], i = items.indexOf(e.target);
    if (e.key === 'Escape') { e.preventDefault(); avOpen(false); document.querySelector('.av-btn[aria-expanded="false"]')?.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
  });

  // C-237：彈窗內容捲動時，標題列下緣出現陰影（看得出內容捲到標題列底下）
  document.addEventListener('scroll', e => { const t = e.target; if (t?.classList?.contains('modal-body')) t.classList.toggle('scrolled', t.scrollTop > 0); }, true);

  // ---------- 啟動 ----------
  async function start() {
    state.me = await api('/api/me');
    if (state.me.memberType !== 'human') {
      store.del(TOKEN_KEY);
      state.token = null;
      state.me = null;
      $('#token-error').textContent = '這是 AI 助手的 Token，只能透過 API 存取，不能登入網頁。';
      return showJoin();
    }
    // C-202：舊的登入方式（瀏覽器存著登入碼、或掃 QR Code 進來）自動換成「這台裝置」的登入，之後可在「我的裝置」管理
    if (state.me.authKind === 'code') {
      try {
        const r = await api('/api/auth/code', { method: 'POST', body: { code: state.token } });
        state.token = r.token;
        store.set(TOKEN_KEY, r.token);
        state.me = await api('/api/me');
      } catch {}
    }
    $('#join').hidden = true; // C-195：主畫面等資料載完才顯示（先留在「載入中」）
    drawMe();
    // C-240：專案、成員、訊息同時抓（原本一支等一支，每支都要等資料庫）
    const winP = api(windowUrl());
    winP.catch(() => {});
    await Promise.all([loadProjectList().catch(() => {}), loadParticipants()]);
    const route = parseRoute();
    state.view = route.view || 'hub';
    drawProjSwitch();
    drawAvatarMenu(); refreshMyAiCount();
    await loadWindow(winP);
    refreshInboxCount();
    loadTeam();
    loadCards().then(() => { renderMessages(false); if (state.page === 'work' || state.page === 'hub') renderWork(); }).catch(() => {});
    connectEvents();
    // C-169：網址帶專案與頁面；多專案成員打開 / 先到第一層「我的專案」，只屬一個專案的人直接進自己的專案
    const savedPage = store.get(PAGE_KEY);
    await showPage(route.page || (projectView() === 'hub' ? 'hub' : ['work', 'inbox', 'team', 'files'].includes(savedPage) ? savedPage : 'messages'), { replace: true });
    $('#boot').hidden = true;
    $('#app').hidden = false;
    if (state.page === 'messages') scrollBottom();
  }

  async function loadParticipants() {
    const d = await api('/api/participants');
    state.participants = new Map(d.items.map(p => [p.participantId, p]));
    const online = d.items.filter(p => p.isOnline).length;
    document.querySelectorAll('.presence-text').forEach(el => { el.textContent = `${d.items.length} 人在群 · 近期活躍 ${online}`; el.dataset.short = `${online} 人在線`; });
    document.querySelectorAll('.sb-presence-text').forEach(el => { el.textContent = `${d.items.length} 人 · ${online} 人活躍`; }); // C-244
    drawTokenAlert(d.items);
    syncFilterBar();
    return d.items;
  }

  // Token 到期提醒：只給所屬人類看，到期前 24 小時、2 小時兩段標示
  function tokenLevel(expiresAt, now = Date.now()) {
    const left = Date.parse(expiresAt) - now;
    if (!(left > 0)) return 'expired';
    if (left <= 2 * 3600_000) return '2h';
    if (left <= 24 * 3600_000) return '24h';
    return null;
  }
  function drawTokenAlert(items) {
    const box = $('#token-alert');
    if (!box || state.me?.memberType !== 'human') return;
    const mine = items.filter(p => p.memberType === 'ai' && p.ownerParticipantId === state.me.participantId && p.status === 'active')
      .map(p => ({ p, level: tokenLevel(p.expiresAt) })).filter(x => x.level);
    box.hidden = !mine.length;
    if (!mine.length) return;
    const critical = mine.filter(x => x.level === 'expired' || x.level === '2h')
      .sort((a, b) => Date.parse(a.p.expiresAt) - Date.parse(b.p.expiresAt)); // 已過期的排最前面，其次是最快到期的
    if (critical.length) {
      // 緊急：深紅底白字兩行，不可關閉，處理後才消失；多位同時發生只顯示最急的一位並標「共 N 位」
      const c = critical[0], left = Date.parse(c.p.expiresAt) - Date.now();
      const line1 = c.level === 'expired' ? `${esc(c.p.name)} 的 Token 已過期，請重發`
        : `${esc(c.p.name)} 的 Token 剩 ${Math.floor(left / 3600_000)} 小時 ${Math.floor((left % 3600_000) / 60_000)} 分到期`;
      box.className = 'token-alert critical';
      box.dataset.open = '';
      box.innerHTML = `<div class="token-alert-text"><div class="ta-line1">${line1}</div><div class="ta-line2">${c.level === 'expired' ? 'AI 已停止連線' : '到期後 AI 會停止連線'}${critical.length > 1 ? ' · 共 ' + critical.length + ' 位' : ''}</div></div>
        <button type="button" class="btn alert-btn">重發 Token</button>`;
      box.querySelector('.alert-btn').onclick = () => openMyAi();
      return;
    }
    // 一般（24 小時內到期）：一行＋「處理 ›」，點開看全文與動作，可按「稍後」收起
    const key = mine.map(x => x.p.participantId + x.level).join();
    if (state.tokenAlertDismissed === key) { box.hidden = true; return; }
    const text = `你的 AI ${mine.map(x => `「${esc(x.p.name)}」Token 24 小時內到期（${fmtTime(x.p.expiresAt)}）`).join('、')}，到期後 AI 會停止連線。`;
    box.className = 'token-alert';
    const open = box.dataset.open === 'all';
    box.innerHTML = open
      ? `<div class="ta-card"><div>${text}</div><div class="ta-actions"><button type="button" class="btn alert-btn primary">重發 Token</button><button type="button" class="btn alert-later">稍後</button></div></div>`
      : `<button type="button" class="ta-one"><span class="token-alert-text">${text}</span><span class="ta-go">處理 ›</span></button>`;
    if (open) {
      box.querySelector('.alert-btn').onclick = () => openMyAi();
      box.querySelector('.alert-later').onclick = () => { state.tokenAlertDismissed = key; box.dataset.open = ''; box.hidden = true; };
    } else {
      box.querySelector('.ta-one').onclick = () => { box.dataset.open = 'all'; drawTokenAlert(items); };
    }
  }

  // 輪詢：前景每 3 秒拉新訊息，背景分頁放慢到 15 秒；成員與通知數每 15 秒更新
  let pollTimer = null;
  let lastSlowPoll = 0;
  let lastTeamPoll = 0;
  let pollGen = 0; // 每次重新連線換一代，舊的計時鏈自動結束，不會越疊越多
  function connectEvents(immediate = false) {
    clearTimeout(pollTimer);
    const gen = ++pollGen;
    const tick = async () => {
      if (!state.token || gen !== pollGen) return;
      let ok = true;
      try {
      ok = await catchUp();
      if (!document.hidden && Date.now() - lastSlowPoll > 30_000) {
        lastSlowPoll = Date.now();
        loadParticipants().catch(() => {});
        refreshInboxCount();
      }
      if (!document.hidden && work.loaded && Date.now() - work.lastSync > (state.page === 'work' ? 30_000 : 90_000)) syncCards().catch(() => {});
      if (!document.hidden && Date.now() - lastTeamPoll > 60_000) {
        lastTeamPoll = Date.now();
        loadTeam();
      }
      } catch {} finally {
        // 失敗（或背景分頁）也一定排下一輪；失敗時 5 秒後重試
        if (gen === pollGen) pollTimer = setTimeout(tick, !ok ? 5_000 : document.hidden ? 60_000 : 5_000);
      }
    };
    pollTimer = setTimeout(tick, immediate ? 0 : 5_000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.me) connectEvents(true); }); // 回到前景立刻補抓
  window.addEventListener('online', () => { if (state.me) connectEvents(true); });

  // 抓取中旗標記開始時間：超過 20 秒還沒結束就當作卡住，允許重抓（C-163）
  let catching = 0, connFails = 0;
  async function catchUp() {
    if (!state.token || !state.nextCursor) return true;
    if (catching && Date.now() - catching < 20_000) return true;
    const mine = catching = Date.now();
    try {
      for (let i = 0; i < 5; i++) {
        const d = await api(`/api/messages?limit=100&after=${encodeURIComponent(state.nextCursor)}`, { timeoutMs: 8_000 });
        d.items.forEach(onNewMessage);
        if (d.items.length) state.newMsgAt = Date.now(); // C-245：收件匣據此決定要不要重抓通知
        state.nextCursor = d.nextCursor;
        if (!d.hasMore) break;
      }
      connFails = 0; setConnBanner(false);
      return true;
    } catch {
      if (++connFails >= 2) setConnBanner(true); // 連續失敗 2 次（約 10 秒）才提示，網路小抖動不閃（UX 第 1071 則）
      return false;
    } finally { if (catching === mine) catching = 0; }
  }
  // 抓取失敗時頂端提示，恢復後自動收起
  function setConnBanner(down) { const b = $('#conn-banner'); if (b) b.hidden = !down; }

  // ---------- 訊息 ----------
  let BASE_TITLE = document.title;
  // C-193：群組名稱由管理員在網頁設定；登入頁、側欄、分頁標題都讀它
  function applyGroupName(name) {
    if (!name) return;
    document.querySelectorAll('[data-group-name]').forEach(el => { el.textContent = name; });
    document.title = document.title.replace(BASE_TITLE, name);
    BASE_TITLE = name;
    document.documentElement.classList.add('gn-ready');
    store.set(GN_KEY, name);
  }
  // 群組名閃一下的修正：先用這台裝置記住的名稱，還沒拿到之前不顯示（CSS 藏起），拿到再換成伺服器的
  const GN_KEY = 'aigile-switch-group-name';
  { const cached = store.get(GN_KEY); if (cached) applyGroupName(cached); }
  fetch('/api/group').then(r => r.json()).then(d => applyGroupName(d.name)).catch(() => {}).finally(() => document.documentElement.classList.add('gn-ready'));
  const meId = () => state.me.participantId;
  const isToMe = m => m.recipients.some(r => r.participantId === meId());
  const isReplyToMe = m => {
    const parent = m.replyToMessageId && state.byId.get(m.replyToMessageId);
    return !!parent && parent.author.participantId === meId();
  };
  const isMine = m => m.author.participantId === meId();
  // C-259：這則對我是「要回覆」（true）、「知會」（false），或沒標（undefined，舊訊息照舊）
  const myAsk = m => m.recipients.find(r => r.participantId === meId())?.ask;
  // 指定我名下 AI 的訊息（@所有人除外），讓人類知道自己的 AI 被交辦了什麼
  const toMyAi = m => {
    if (m.audience === 'all' || isMine(m)) return false;
    const mine = myAiIds();
    return !mine.has(m.author.participantId) && m.recipients.some(r => mine.has(r.participantId));
  };
  const myAiIds = () => new Set([...state.participants.values()].filter(p => p.ownerParticipantId === meId()).map(p => p.participantId));

  function renderText(text, withLead = false) {
    let lead = '';
    if (withLead) {
      const t = String(text).match(/^\s*\[([^\]\n]{1,40})\]\s?/);
      if (t) { lead = leadPill(t[1]); text = text.slice(t[0].length); }
    }
    let html = esc(text);
    const names = [...state.participants.values()].map(p => p.name).concat(ALL.name).sort((a, b) => b.length - a.length);
    for (const n of names) html = html.split('@' + esc(n)).join(`\u0000@${esc(n)}\u0001`);
    html = html.replace(/\u0000/g, '<span class="mention">').replace(/\u0001/g, '</span>');
    // 網址轉連結；網址以外的 40 碼 SHA 只顯示前 7 碼，點一下複製完整值
    return lead + html.split(/(\bhttps?:\/\/[^\s<]+)/).map((part, i) => i % 2
      ? `<a href="${part}" target="_blank" rel="noopener">${part}</a>`
      : part.replace(/\b[0-9a-f]{40}\b/g, h => `<button type="button" class="sha" data-sha="${h}" title="${h}（點一下複製）">${h.slice(0, 7)}</button>`)
        .replace(/\bC-\d{3,}\b/g, capsuleHtml)).join('');
  }
  // 訊息內的 C-xxx 轉成膠囊：卡號＋狀態文字（不只靠顏色）；清單載入後找不到的卡號灰字不可點
  function capsuleHtml(id) {
    const c = work.cards.get(id);
    if (!c) return work.loaded ? `<button type="button" class="cap cap-miss" data-cap="${id}" title="點一下查看">${id}</button>` : id; // C-181：點了再問伺服器（別專案／已封存／不存在）
    return `<button type="button" class="cap" data-cap="${id}" data-st="${esc(c.status)}">${id}<i class="cdot" aria-hidden="true"></i>${esc(c.status)}</button>`;
  }

  // 第二行：AI 寫成「角色 · AI · 所屬人 · 所在環境」
  function subLine(a, pj) {
    if (a.memberType === 'ai') return [a.role, 'AI', a.ownerName, a.environment].filter(Boolean).join(' · ');
    if (a.memberType === 'system') return '系統';
    const r = pj === undefined ? a.role || '' : roleIn(a, pj); // C-219：依那則訊息的專案；跨專案頻道（pj＝null）不顯示
    return [r, a.environment].filter(Boolean).join(' · ') || '人類';
  }
  function statusTags(m, toMe, replyMe) {
    const tags = [
      m.audience === 'all' ? '<span class="tag all">全體通知</span>' : '',
      toMe && m.audience !== 'all' && !isMine(m) && !m.replyFrom ? '<span class="tag me">指定給我</span>' : '',
      replyMe && !isMine(m) ? '<span class="tag reply">回覆我</span>' : '',
      toMyAi(m) ? '<span class="tag my-ai">給我的 AI</span>' : '',
      unansweredTag(m),
    ].filter(Boolean);
    return tags.length ? `<div class="msg-tags">${tags.join('')}</div>` : '';
  }
  // 訊息開頭的 [接單]、[完成]… 改成彩色小標籤
  function leadPill(tag) {
    const kind = /受阻/.test(tag) ? 'red' : /需確認|需協助/.test(tag) ? 'orange' : /決策紀錄/.test(tag) ? 'grey'
      : /完成|已部署|已 ?push/.test(tag) ? 'green' : /接單/.test(tag) ? 'indigo' : /進度/.test(tag) ? 'blue' : /交接/.test(tag) ? 'purple' : 'light';
    return `<span class="lead lead-${kind}">${esc(tag)}</span>`;
  }

  // ---------- C-215 手機好滑 ----------
  // 流程訊息（接單／交接／通知／進度）收成一行灰字；手機寬度（或選「精簡」）其他 AI 訊息只露第一句。
  // 需確認、人類發的、提到我／回覆我的、附檔案的永遠照常顯示。
  const FLOW_TAGS = ['接單', '交接', '通知', '進度'];
  const narrowMq = matchMedia('(max-width: 640px)');
  const slimMode = () => { const v = store.get(MSG_VIEW_KEY); return v ? v === 'slim' : narrowMq.matches; };
  const authorKind = m => (state.participants.get(m.author.participantId) || m.author).memberType;
  const mentionsMe = m => !isMine(m) && myAsk(m) !== false && ((isToMe(m) && m.audience !== 'all') || isReplyToMe(m)); // C-259：知會我的不算
  const keepFull = m => !!m.file || /^\s*\[需確認\]/.test(m.text) || authorKind(m) === 'human' || mentionsMe(m);
  const isFlowLine = m => !state.open.has(m.messageId) && FLOW_TAGS.includes(tagOf(m.text)) && !keepFull(m);
  const isSlim = m => !state.open.has(m.messageId) && slimMode() && !keepFull(m) && !FLOW_TAGS.includes(tagOf(m.text));
  // 提到我／回覆我、我還沒回的（需確認有人類回過也算處理了）
  const needReply = m => mentionsMe(m) && !repliesOf(m.messageId).some(isMine) && !work.answered?.has(m.messageId);
  const cardIdOf = t => String(t).match(/\bC-\d{3,}\b/)?.[0] || '';
  // 第一句：去掉開頭的 [標籤] 和【專案名】，取第一行到第一個句號為止
  function firstSentence(t) {
    const lines = String(t).replace(/^\s*\[[^\]\n]{1,40}\]\s*/, '').replace(/^\s*【[^】\n]{1,20}】\s*/, '').split('\n').map(x => x.trim()).filter(Boolean);
    const line = lines[0] || '';
    const cut = line.search(/[。！？!?]/);
    return cut > 0 ? line.slice(0, cut + 1) : line;
  }
  function flowLineHtml(m) {
    const tag = tagOf(m.text), card = cardIdOf(m.text);
    const to = tag === '交接' ? (m.audience === 'all' ? '所有人' : m.recipients.map(r => r.name).join('、')) : '';
    const desc = [tag, card, to ? '給 ' + to : ''].filter(Boolean).join(' ');
    return `<button type="button" class="flow-line" id="msg-${esc(m.messageId)}" data-open-msg="${esc(m.messageId)}" aria-expanded="false" aria-label="${esc(`${m.author.name} ${desc}，${fmtTime(m.createdAt)}，展開`)}"><span class="fl-icon" aria-hidden="true">⇢</span><span class="fl-text"><b>${esc(m.author.name)}</b> ${esc(desc)} · <time datetime="${esc(m.createdAt)}">${fmtTime(m.createdAt)}</time></span></button>`;
  }
  function slimHtml(m) {
    const tag = tagOf(m.text), card = cardIdOf(m.text), need = needReply(m);
    return `<article class="msg slim${need ? ' need-me' : ''}" id="msg-${esc(m.messageId)}"><button type="button" class="slim-btn" data-open-msg="${esc(m.messageId)}" aria-expanded="false">
      <span class="slim-head"><span class="msg-author">${esc(m.author.name)}</span>${tag ? leadPill(tag) : ''}${card ? `<span class="slim-card">${card}</span>` : ''}${m.replyFrom ? myAskPill(m) : ''}<time class="msg-time" datetime="${esc(m.createdAt)}">${fmtTime(m.createdAt)}</time></span>
      <span class="slim-text">${esc(firstSentence(m.text))}</span><span class="sr-only">，展開全文</span></button></article>`;
  }
  function flowGroupHtml(run) {
    const tags = [...new Set(run.map(m => tagOf(m.text)))].join('、');
    const t1 = fmtTime(run[0].createdAt), t2 = fmtTime(run[run.length - 1].createdAt);
    return `<button type="button" class="flow-line flow-group" data-flow-group="${esc(run[0].messageId)}" aria-expanded="false" aria-label="${esc(`${run.length} 則流程訊息（${tags}），${t1} 到 ${t2}，展開`)}"><span class="fl-icon" aria-hidden="true">⇢</span><span class="fl-text">${run.length} 則流程訊息（${esc(tags)}）· ${t1 === t2 ? t1 : t1 + '–' + t2}</span><span aria-hidden="true">▸</span></button>`;
  }
  // 整串清單：連續 3 則以上的一行流程訊息合成一列
  function listHtml(list) {
    state.groupOf = new Map();
    state.grpHidden = new Map();
    state.lastCard = '';
    markKids(list);
    const out = [];
    for (let i = 0; i < list.length;) {
      const cid = effCard(list[i]);
      if (cid) { // C-262 B
        let k = i;
        while (k < list.length && effCard(list[k]) === cid) k++;
        out.push(cardGroupHtml(cid, list.slice(i, k)));
        i = k; continue;
      }
      let j = i;
      while (j < list.length && isFlowLine(list[j]) && !effCard(list[j])) j++;
      const run = list.slice(i, j);
      if (run.length >= 3 && !state.flowOpen.has(run[0].messageId)) {
        for (const m of run) state.groupOf.set(m.messageId, run[0].messageId);
        out.push(flowGroupHtml(run));
        i = j; continue;
      }
      // UX 第 1530 則：展開過的合併列可以再收起
      if (run.length >= 3) out.push(`<button type="button" class="flow-line flow-fold" data-flow-fold="${esc(run[0].messageId)}" aria-label="收起這 ${run.length} 則流程訊息"><span class="fl-icon" aria-hidden="true">▴</span><span class="fl-text">收起這 ${run.length} 則流程訊息</span></button>`);
      if (run.length) { out.push(...run.map(messageHtml)); i = j; continue; }
      out.push(messageHtml(list[i])); i++;
    }
    return out.join('');
  }
  // C-217：往上滑離開最底下（超過約一屏）才出現「回到最新 ↓」；有新訊息時用新訊息膠囊，兩個不同時出現
  function drawLatestBtn() {
    const b = $('#latest-btn'), box = $('#messages');
    if (!b || !box) return;
    const far = box.scrollHeight - box.scrollTop - box.clientHeight > box.clientHeight;
    b.hidden = !(far && !state.newCount && !state.ctx);
  }
  // 讓某則訊息出現在畫面上（在收起的流程群組、一行或精簡裡就打開）
  function revealMsg(id) {
    const m = state.byId.get(id);
    if (!m) return null;
    if (state.grpHidden?.has(id)) { state.grpOpen.add(state.grpHidden.get(id)); const box = $('#messages'), top = box.scrollTop; renderMessages(false); box.scrollTop = top; }
    if (state.groupOf.has(id) || isFlowLine(m) || isSlim(m)) { state.open.add(id); const box = $('#messages'), top = box.scrollTop; renderMessages(false); box.scrollTop = top; }
    return document.getElementById('msg-' + id);
  }
  // C-216：只捲訊息清單本身，把某則放到清單中間；不用 scrollIntoView（它會連 html/body 一起捲）
  function scrollMsgTo(el, smooth = true) {
    const box = $('#messages');
    if (!el || !box.contains(el)) return;
    const top = box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - Math.max(0, (box.clientHeight - el.offsetHeight) / 2);
    box.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }
  function setView(v) {
    store.set(MSG_VIEW_KEY, v);
    syncFilterBar();
    const box = $('#messages'), top = box.scrollTop;
    renderMessages(false); box.scrollTop = top;
  }

  function messageHtml(m) {
    const prevCard = state.lastCard;
    state.lastCard = ''; // 一行／精簡沒有卡片列，下一則同卡要完整顯示
    if (isFlowLine(m)) return flowLineHtml(m);
    if (isSlim(m)) return slimHtml(m);
    const ai = aiParts(m);
    if (ai && !ai.head && !ai.rest && tagOf(m.text) === '交接') return flowLineHtml(m); // C-260：只有格式字的系統交接通知縮成一行
    state.lastCard = msgCardOf(m);
    const toMe = isToMe(m);
    const replyMe = isReplyToMe(m);
    const parent = m.replyToMessageId ? state.byId.get(m.replyToMessageId) : null;
    const a = m.author;
    const kid = isKid(m); // C-271
    const cls = ['msg', isMine(m) ? 'mine' : '', (toMe || replyMe) && !isMine(m) && myAsk(m) !== false ? 'to-me' : '', needReply(m) ? 'need-me' : '', kid ? 'kid' : ''].join(' '); // C-259：知會我的不上底色
    const recipients = m.replyFrom ? askPillsHtml(m) : m.audience === 'all'
      ? '<span class="mention">@所有人</span>'
      : m.recipients.map(r => `<span class="mention">@${esc(r.name)}</span>`).join(' ');
    return `
      <article class="${cls}" id="msg-${esc(m.messageId)}">
        <div class="msg-head">
          ${avatar(state.participants.get(a.participantId) || a)}
          <div class="msg-who">
            <div class="msg-line1"><span class="msg-author">${esc(a.name)}</span><time class="msg-time" datetime="${esc(m.createdAt)}" title="seq ${m.sequence}">${fmtTime(m.createdAt)}</time>${m.project === projectView() ? '' : projTag(m.project)}</div>
            <div class="msg-line2">${esc(subLine(a, m.project || null))}</div>
          </div>
        </div>
        ${statusTags(m, toMe, replyMe)}
        ${recipients ? `<div class="recipients"><span class="muted">給</span> ${recipients}</div>` : ''}
        ${cardRefHtml(m, prevCard)}
        ${kid ? kidSr(m) : m.replyToMessageId ? `<button class="quote" type="button" data-jump="${esc(m.replyToMessageId)}">回覆 ${parent ? `<b>${esc(parent.author.name)}</b>：${esc(parent.text.slice(0, 80))}` : `較早的訊息（${esc(shortId(m.replyToMessageId))}）`}</button>` : ''}
        ${m.file ? fileNoteHtml(m.text) + fileCardHtml(m.file) : ai ? aiTextHtml(m, ai) : textHtml(m)}
        ${authHtml(m)}
        <div class="msg-foot">
          <button class="reply-btn" type="button" data-reply="${esc(m.messageId)}">回覆</button>
          ${m.file ? '' : `<button class="reply-btn newcard" type="button" data-newcard="${esc(m.messageId)}">＋建卡</button>`}
          ${linkedCapsules(m)}
          ${state.open.has(m.messageId) ? `<button type="button" class="link more" data-fold="${esc(m.messageId)}">收合 ▴</button>` : !m.file && !ai && isLong(m.text) ? `<button type="button" class="link more" data-more="${esc(m.messageId)}">${state.expanded.has(m.messageId) ? '收合' : '展開全文'}</button>` : ''}
          ${threadToggle(m)}
        </div>
      </article>`;
  }

  // ---------- C-259 要回覆／知會 ----------
  // 黃＝要回覆、灰＝知會；輪到我的那顆加外框、寫「要你回覆／知會你」；@所有人一律知會
  function askPillsHtml(m) {
    const pill = (ask, me, name) => `<span class="apill ${ask ? 'ask' : 'fyi'}${me ? ' me' : ''}">${ask ? (me ? '要你回覆' : '要回覆') : (me ? '知會你' : '知會')} · ${esc(name)}</span>`;
    if (m.audience === 'all') return pill(false, isToMe(m) && !isMine(m), '所有人');
    return [...m.recipients].sort((a, b) => (b.ask ? 1 : 0) - (a.ask ? 1 : 0)).map(r => pill(r.ask, r.participantId === meId(), r.name)).join(' ');
  }
  const myAskPill = m => { const a = myAsk(m); return a === undefined || isMine(m) ? '' : `<span class="apill ${a ? 'ask' : 'fyi'} me">${a ? '要你回覆' : '知會你'}</span>`; };
  // ---------- C-271 回覆縮排接在原訊息下 ----------
  // 原訊息就在上面（中間只隔同一串的回覆）才縮排；回覆的回覆不再往右（最多一層）；卡片組內外各自算；不搬順序
  function markKids(list) {
    state.kids = new Set();
    let box = null, ids = new Set();
    for (const m of list) {
      const c = effCard(m);
      if (c !== box) { box = c; ids = new Set(); }
      if (m.replyToMessageId && ids.has(m.replyToMessageId)) state.kids.add(m.messageId); else ids = new Set();
      ids.add(m.messageId);
    }
  }
  const isKid = m => !!state.kids?.has(m.messageId);
  const kidSr = m => { const p = state.byId.get(m.replyToMessageId); return `<span class="sr-only">回覆 ${esc(p?.author.name || '')}：</span>`; };
  // ---------- C-262 B：同一張卡的連續訊息收成一組 ----------
  // 訊息的卡：自己的（cardId 或內文第一個卡號），沒有就沿用被回覆那則的卡
  const effCard = m => { let x = m, guard = 0; while (x && guard++ < 4) { const c = msgCardOf(x); if (c) return c; x = x.replyToMessageId ? state.byId.get(x.replyToMessageId) : null; } return ''; };
  const ST_DOT = { 待處理: 'todo', 進行中: 'run', 受阻: 'bad', 待確認: 'ok', 已完成: 'ok', 已封存: 'todo', 待整理: 'todo' };
  function cardGroupHtml(cid, msgs) {
    const c = work.cards.get(cid), key = msgs[0].messageId;
    const ids = new Set(msgs.map(m => m.messageId));
    const many = msgs.length > 4 && !state.grpOpen.has(key);
    const shown = many ? msgs.slice(-3) : msgs;
    if (many) for (const m of msgs.slice(0, -3)) state.grpHidden.set(m.messageId, key);
    for (const m of shown) if (state.grpHidden.has(m.replyToMessageId)) state.kids?.delete(m.messageId); // C-271：原訊息被收起的回覆不縮排（不然像接在組標題下）
    const title = c ? cardTitle(c) : '';
    return `<section class="cgrp" aria-label="${esc(`卡片 ${cid}${title ? ' ' + title : ''}，${msgs.length} 則訊息`)}">
      <button type="button" class="cg-head" data-cap="${cid}"><span class="cg-dot ${c ? ST_DOT[c.status] || 'todo' : 'todo'}" aria-hidden="true"></span><b>${cid}</b><span class="cg-title">${esc(title)}</span><span class="cg-meta">${c ? esc(c.status) + ' · ' : ''}${msgs.length} 則 ›</span></button>
      ${many ? `<button type="button" class="cg-more" data-grp-open="${esc(key)}">展開較早 ${msgs.length - 3} 則</button>` : ''}
      ${shown.map(m => groupMsgHtml(m, ids)).join('')}
      <button type="button" class="cg-reply" data-grp-reply="${esc(msgs[msgs.length - 1].messageId)}">回覆這張卡…</button>
    </section>`;
  }
  // 組內每則精簡：小頭像、名字、標籤、時間、要你回覆；AI 結論＋細節照 C-260；不顯示角色行、卡片列、底部卡號
  function groupMsgHtml(m, ids) {
    const a = m.author, tag = tagOf(m.text), parent = m.replyToMessageId ? state.byId.get(m.replyToMessageId) : null;
    const ai = aiParts(m);
    const re = !m.replyToMessageId ? '' : isKid(m) ? kidSr(m) : parent && ids.has(parent.messageId)
      ? `<button type="button" class="gm-re" data-jump="${esc(parent.messageId)}">↩ ${esc(shortOf(parent.author.name))}</button>`
      : `<button class="quote" type="button" data-jump="${esc(m.replyToMessageId)}">回覆 ${parent ? `<b>${esc(parent.author.name)}</b>：${esc(parent.text.slice(0, 80))}` : `較早的訊息（${esc(shortId(m.replyToMessageId))}）`}</button>`;
    const cls = ['msg', 'gmsg', isMine(m) ? 'mine' : '', needReply(m) ? 'need-me' : '', isKid(m) ? 'kid' : ''].join(' ');
    const ask = m.replyFrom ? myAskPill(m) : isToMe(m) && m.audience !== 'all' && !isMine(m) ? '<span class="tag me">指定給我</span>' : '';
    const body = m.file ? fileNoteHtml(m.text) + fileCardHtml(m.file) : ai ? aiTextHtml(m, { ...ai, tag: '' }) : textHtml(m);
    return `<article class="${cls}" id="msg-${esc(m.messageId)}">
      <div class="gm-head">${avatar(state.participants.get(a.participantId) || a)}<b class="msg-author nm-cut" title="${esc(a.name)}">${esc(a.name)}</b>${tag ? leadPill(tag) : ''}<time class="msg-time" datetime="${esc(m.createdAt)}">${fmtTime(m.createdAt)}</time>${ask}${unansweredTag(m)}</div>
      ${re}
      ${body}
      ${authHtml(m)}
      <div class="msg-foot">
        <button class="reply-btn" type="button" data-reply="${esc(m.messageId)}">回覆</button>
        ${state.open.has(m.messageId) ? `<button type="button" class="link more" data-fold="${esc(m.messageId)}">收合 ▴</button>` : !m.file && !ai && isLong(m.text) ? `<button type="button" class="link more" data-more="${esc(m.messageId)}">${state.expanded.has(m.messageId) ? '收合' : '展開全文'}</button>` : ''}
        ${threadToggle(m)}
      </div>
    </article>`;
  }
  // ---------- C-262 看得出在回哪張卡 ----------
  // 訊息的卡：用 cardId 關聯的卡，沒有就用內文第一個卡號
  const msgCardOf = m => [...(state.msgCards.get(m.messageId) || [])][0] || cardIdOf(m.text);
  function cardRefHtml(m, prevCard) {
    const own = msgCardOf(m);
    const parent = m.replyToMessageId ? state.byId.get(m.replyToMessageId) : null;
    const id = own || (parent && msgCardOf(parent));
    if (!id) return '';
    const c = work.cards.get(id); // 卡名從已載入的卡片清單拿，不多查伺服器；沒載到只顯示卡號
    const title = c ? `<span class="cr-title">${esc(c.title)}</span>` : '';
    if (!own) return `<button type="button" class="cardref cr-reply" data-cap="${id}" aria-label="${esc(`回覆 ${id} ${c?.title || ''}，打開卡片`)}"><span aria-hidden="true">↳</span> 回覆 <b>${id}</b>${title}</button>`;
    if (own === prevCard) return `<button type="button" class="cardref cr-same" data-cap="${id}" aria-label="${esc(`同一張卡 ${id}，打開卡片`)}">${id}</button>`; // 連續同一張卡只第一則完整
    return `<button type="button" class="cardref" data-cap="${id}" aria-label="${esc(`${id} ${c?.title || ''} ${c?.status || ''}，打開卡片`)}"><span aria-hidden="true">🗂</span><b>${id}</b>${title}${c ? `<span class="cr-st">${esc(c.status)} ›</span>` : ''}</button>`;
  }
  // ---------- C-260 AI 訊息：白話結論在前、細節收合 ----------
  // 去掉開頭的 [標籤]、【專案名】、交接的「C-xxx 卡名 → @誰：」；第一段（第一個空行前）當結論，沒有空行就前兩行
  function aiParts(m) {
    if (m.file || authorKind(m) !== 'ai') return null;
    const tag = tagOf(m.text);
    let t = String(m.text).replace(/^\s*\[[^\]\n]{1,40}\]\s*/, '').replace(/^\s*【[^】\n]{1,20}】\s*/, '');
    t = t.replace(/^C-\d{3,}[^\n]{0,120}?→\s*@[^：:\n]{1,40}[：:]\s*/, '');
    let head, rest;
    const gap = t.search(/\n[ \t]*\n/);
    if (gap >= 0) { head = t.slice(0, gap); rest = t.slice(gap).replace(/^\s+/, ''); }
    else { const ls = t.split('\n'); head = ls.slice(0, 2).join('\n'); rest = ls.slice(2).join('\n'); }
    return { tag, head: head.trim(), rest: rest.trim(), keep: /需確認|受阻/.test(tag) }; // 需確認的選項、受阻的原因不收
  }
  function aiTextHtml(m, p) {
    const lead = (p.tag ? leadPill(p.tag) : '') + renderText(p.head);
    if (!p.rest) return `<div class="msg-text ai-text"><div class="msg-lead plain">${lead}</div></div>`; // 只有一段：不必加粗
    if (p.keep || state.open.has(m.messageId)) return `<div class="msg-text ai-text"><div class="msg-lead">${lead}</div><div class="msg-rest">${renderText(p.rest)}</div></div>`;
    return `<div class="msg-text ai-text"><div class="msg-lead">${lead}</div><details class="msg-detail" data-detail="${esc(m.messageId)}"${state.expanded.has(m.messageId) ? ' open' : ''}><summary>細節</summary><div class="msg-rest">${renderText(p.rest)}</div></details></div>`;
  }
  // 長訊息預設折疊（超過 6 行或 400 字）
  const isLong = t => t.split('\n').length > 6 || t.length > 400;
  function textHtml(m) {
    const clamp = isLong(m.text) && !state.expanded.has(m.messageId) && !state.open.has(m.messageId);
    return `<div class="msg-text${clamp ? ' clamp' : ''}">${renderText(m.text, true)}</div>`;
  }
  // 回覆串：已載入的直接回覆數，可收合
  const repliesOf = id => state.messages.filter(x => x.replyToMessageId === id);
  function threadToggle(m) {
    const n = repliesOf(m.messageId).length;
    if (!n) return '';
    const closed = state.collapsed.has(m.messageId);
    return `<button type="button" class="link thread" data-thread="${esc(m.messageId)}">${closed ? '▸' : '▾'} ${n} 則回覆${closed ? '（已收合）' : ''}</button>`;
  }
  // 祖先訊息被收合時，整串回覆都不顯示
  function hiddenByThread(m) {
    let p = m.replyToMessageId, guard = 0;
    while (p && guard++ < 50) {
      if (state.collapsed.has(p)) return true;
      p = state.byId.get(p)?.replyToMessageId;
    }
    return false;
  }
  const tagOf = t => String(t).trimStart().match(/^\[([^\]\n]{1,40})\]/)?.[1] || '';
  function related(m) {
    const mine = myAiIds();
    return isMine(m) || isToMe(m) || isReplyToMe(m) || mine.has(m.author.participantId)
      || m.recipients.some(r => mine.has(r.participantId));
  }
  // ---------- 專案（C-111）：平台／銀行系統 ----------
  // 專案清單來自伺服器（可新增、改名、封存）；PROJECTS 是未封存專案的 id，專案顯示名稱用 projName
  const PROJECTS = [];
  state.projectList = [];
  state.projMeta = { adminId: null, adminName: '', crossRoleIds: [], leaders: {} };
  const projName = id => state.projectList.find(p => p.id === id)?.name || id;
  // ---------- C-219 每個專案各自的人類角色 ----------
  const ROLE_CHOICES = ['PO', 'PG', 'UX', 'QA', 'BA', 'SM', 'Sponsor', 'BU'];
  // 某人在某專案的角色：人類看 projectRoles（不在任何專案的畫面＝不顯示）；AI 照舊
  const roleIn = (p, pj) => {
    if (!p) return '';
    const q = state.participants.get(p.participantId) || p;
    if (q.memberType !== 'human' || !q.projectRoles) return q.role || '';
    return PROJECTS.includes(pj) ? q.projectRoles[pj] || '' : '';
  };
  function roleSelectHtml(value, attrs, { changed = false, label = '角色', pj = '', ai = true } = {}) {
    const pr = pj ? projRoleDefs(pj).map(d => d.role).filter(r => !ROLE_CHOICES.includes(r)) : []; // C-280 本專案角色
    const custom = value && !ROLE_CHOICES.includes(value) && !pr.includes(value);
    const tail = pj && ai ? (canMakeRole(pj) ? '<option value="__ai">＋ 跟 AI 討論新角色…</option>' : '<option value="__ai_no" disabled>新角色請 leader 建立</option>') : '';
    return `<select class="role-sel${value ? '' : ' empty'}${changed ? ' chg' : ''}" ${attrs}${pj ? ` data-role-pj="${esc(pj)}"` : ''} aria-label="${esc(label)}">
      <option value="" ${value ? '' : 'selected'}>未設定</option>${ROLE_CHOICES.map(r => `<option ${value === r ? 'selected' : ''}>${r}</option>`).join('')}
      ${pr.length ? `<optgroup label="本專案角色">${pr.map(r => `<option ${value === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</optgroup>` : ''}
      ${custom ? `<option value="${esc(value)}" selected>${esc(value)}</option>` : ''}<option value="__other">其他（自己打）…</option>${tail}</select>`;
  }
  // C-280：本專案角色（跟著專案清單一起拿，不另外查）；leader／管理員才能跟 AI 討論新角色
  const projRoleDefs = (pj, all = false) => (state.projectList?.find(p => p.id === pj)?.roles || []).filter(d => all || d.status !== 'disabled');
  const canMakeRole = pj => isAdmin() || myLeadProjects().includes(pj);
  function askRoleAi(pj) {
    const mine = [...state.participants.values()].filter(p => isMyAi(p) && p.status !== 'disabled' && (p.projects || []).includes(pj));
    if (!mine.length) return toast(`你在「${projName(pj)}」沒有自己的 AI；先到「我的 AI」新增一個，再跟它討論新角色。`);
    return askAvatar(mine, '我想要一個新角色：', pj);
  }
  // 「其他」：跳一格輸入框，最多 10 字；只存在這個人這個專案
  function askOtherRole(cur = '') {
    return new Promise(resolve => {
      const host = document.createElement('div');
      host.className = 'confirm-root';
      host.innerHTML = modalFrame({ title: '其他角色', size: 'narrow', body: `<label class="field"><span class="field-label">角色名稱（最多 10 字）</span><input id="or-input" maxlength="10" value="${esc(ROLE_CHOICES.includes(cur) ? '' : cur)}"></label>`,
        foot: '<button class="btn" type="button" data-or="0">取消</button><button class="btn primary" type="button" data-or="1">確定</button>' });
      document.body.appendChild(host);
      const input = host.querySelector('#or-input');
      input.focus();
      const done = ok => { const v = input.value.trim().slice(0, 10); host.remove(); resolve(ok && v ? v : null); };
      host.addEventListener('click', e => { const b = e.target.closest('[data-or]'); if (b) done(b.dataset.or === '1'); else if (e.target.closest('[data-close]')) done(false); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) done(true); if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
    });
  }
  // 選了「其他」就問名字；取消時把下拉還原
  async function pickRole(sel, cur) {
    if (sel.value === '__ai') { sel.value = cur || ''; askRoleAi(sel.dataset.rolePj); return null; } // C-280
    if (sel.value !== '__other') return sel.value;
    const v = await askOtherRole(cur);
    if (v === null) { sel.value = cur || ''; return null; }
    return v;
  }
  async function loadProjectList() {
    const d = await api('/api/projects');
    state.projectList = d.items;
    state.projMeta = { adminId: d.adminId, adminName: d.adminName || '', crossRoleIds: d.crossRoleIds || [], leaders: d.leaders || {} };
    document.querySelectorAll('[data-admin-only]').forEach(b => { b.hidden = !d.adminId || d.adminId !== state.me?.participantId; });
    if (typeof drawAvatarMenu === 'function') drawAvatarMenu();
    PROJECTS.length = 0;
    PROJECTS.push(...state.projectList.filter(p => !p.archived).map(p => p.id));
  }
  const myProjects = () => (state.me?.projects || []).filter(p => PROJECTS.includes(p));
  const singleProject = () => myProjects().length === 1;
  // 目前檢視（C-169 兩層導覽）：hub＝第一層「我的專案」、專案 id＝第二層專案內、cross＝跨專案頻道。
  // C-185：每個人都有第一層（只屬一個專案、還沒有專案的人也一樣，至少有跨專案頻道卡）；所在位置記在網址（/p/平台/訊息、/cross/訊息）
  state.view = 'hub';
  const hasHub = () => true;
  function projectView() {
    const v = state.view;
    return myProjects().includes(v) || v === 'cross' ? v : 'hub';
  }
  const projTag = p => (p ? `<span class="ptag" data-p="${esc(p)}">${esc(projName(p))}</span>` : '');
  // 卡片標題（C-146 A）：不再手打「[平台]」，舊卡的前綴顯示時去掉，改看專案標籤
  // C-181：開頭【X】一律不顯示；[X] 是專案名時不顯示（[需確認] 這類保留）
  const cardTitle = c => {
    const t = c.title || '';
    const m = /^\s*【[^】\n]{1,20}】\s*/.exec(t) || /^\s*\[([^\]\n]{1,20})\]\s*/.exec(t);
    const strip = m && (m[0].includes('【') || state.projectList.some(p => p.id === m[1] || p.name === m[1]));
    return strip ? t.slice(m[0].length) || t : t;
  };
  // 卡片的專案標籤：專案內整頁都是同一專案，不顯示；第一層、跨專案頻道才顯示
  const cardPTag = c => (myProjects().includes(projectView()) ? '' : projTag(c.project));
  // 訊息：跨專案頻道只看「全部專案」的訊息；專案內只看該專案（單一專案成員沒有第一層，另外看得到跨專案頻道）
  const msgInView = p => { const v = projectView(); return v === 'hub' || (v === 'cross' ? !p : p === v); };
  const cardInView = c => { const v = projectView(); return v === 'hub' || (v !== 'cross' && c.project === v); };
  const inView = p => { const v = projectView(); return v === 'hub' || (v === 'cross' ? !p : p === v); }; // 收件匣、文件用
  const viewLabel = v => (v === 'hub' ? '我的專案' : v === 'cross' ? '跨專案頻道' : projName(v));
  // 各檢視「要你做的」件數：等你決定（決策卡、[需確認]）＋待審核的 AI 建議；hub＝全部
  const askTodo = () => [...askNoteRaw(), ...(work.notes || []).filter(n => n.dm)].map(n => ({ project: n.project ?? null })); // C-268：跟收件匣列表同一個來源；C-270 私訊也算
  function todoByView() {
    const items = [...(state.team ? myDecisions(state.team) : []), ...(work.sugg || []), ...[...(work.cards?.values() || [])].filter(verifyingMe), // C-242：等你驗收也算
      ...askTodo()]; // C-259：要你回覆（[需確認] 已算在等你決定，不重複）
    const n = { hub: items.length, cross: items.filter(x => !x.project).length };
    for (const p of myProjects()) n[p] = items.filter(x => x.project === p).length;
    return n;
  }
  const PAGE_NAME = { messages: '訊息', inbox: '收件匣', work: '工作', team: '團隊', files: '文件', myai: '我的 AI', perm: '成員與權限', dm: '私訊', wishes: '許願池', releases: '版本紀錄' }; // C-270：私訊整頁
  const TOP_PAGES = { myai: '/my-ai', perm: '/members', wishes: '/wishes', releases: '/releases' }; // C-182：第一層頁面（不分專案）；C-281 許願池；C-291 版本紀錄
  const isTop = p => p === 'myai' || p === 'wishes' || p === 'releases' || (p === 'perm' && (isAdmin() || myLeadProjects().length > 0));
  const PROJ_COLORS = ['#0b6e8a', '#92400e', '#6d28d9', '#047857', '#be185d', '#1d4ed8'];
  const projColor = p => (p === 'cross' ? '#4b5563' : PROJ_COLORS[Math.max(0, state.projectList.findIndex(x => x.id === p)) % PROJ_COLORS.length]);
  const projIcon = (p, size = 36) => `<span class="pico" style="--pc:${projColor(p)};--psz:${size}px" aria-hidden="true">${p === 'cross' ? '#' : esc([...projName(p)][0] || '?')}</span>`;
  const projMembers = p => [...state.participants.values()].filter(x => x.status !== 'disabled' && (x.projects || []).includes(p)).length;
  // 側欄頂端：「‹ 我的專案」＋專案名＋⇅（不必先回第一層就能切到別的專案）；只屬一個專案的人沒有「‹ 我的專案」與 ⇅
  function drawProjSwitch() {
    const v = projectView(), counts = todoByView();
    document.querySelectorAll('[data-proj-only]').forEach(b => { b.hidden = v === 'hub'; });
    document.querySelectorAll('[data-no-cross]').forEach(b => { b.hidden = v === 'hub' || v === 'cross'; });
    const opts = [...myProjects(), 'cross'];
    const badge = k => (counts[k] ? `<span class="ps-count" aria-label="要你做的 ${counts[k]} 件">${counts[k]}</span>` : '');
    document.querySelectorAll('.proj-switch').forEach((el, i) => {
      // C-204：第一層時卡片可點，從「成員與權限」「我的 AI」回「我的專案」頁（與麵包屑一致）
      if (v === 'hub') { el.innerHTML = `<button type="button" class="ph-card is-hub" data-proj="hub" aria-label="我的專案，${myProjects().length} 個專案＋跨專案頻道"><span class="ph-name"><b>我的專案</b><span class="small">${myProjects().length} 個專案＋跨專案頻道</span></span>${badge('hub')}</button>`; return; }
      const sub = v === 'cross' ? '所有專案都看得到' : `成員 ${projMembers(v)}`;
      el.innerHTML = `
        <div class="ph-card">${projIcon(v)}<span class="ph-name">${hasHub() ? '<button type="button" class="ph-back in-card" data-proj="hub">‹ 我的專案</button>' : ''}<b>${esc(viewLabel(v))}</b>${hasHub() ? '' : `<span class="small">${esc(sub)}</span>`}</span>
          ${hasHub() ? `<button type="button" class="ps-btn ph-swap" aria-haspopup="listbox" aria-expanded="false" aria-controls="ps-list-${i}" aria-label="切換專案" title="切換專案">⇅</button>
          <ul class="ps-list" id="ps-list-${i}" role="listbox" aria-label="切換專案" hidden>${opts.map(k => `<li role="option" tabindex="-1" data-proj="${esc(k)}" aria-selected="${k === v}"><span>${esc(viewLabel(k))}</span>${badge(k)}</li>`).join('')}</ul>` : ''}</div>`;
    });
    drawChrome();
  }
  // C-219：剛被加進某專案、角色還沒設：進那個專案時頂端一行提示，按掉不再出現
  function drawRoleBanner() {
    const b = $('#role-banner');
    if (!b) return;
    const pj = projectView(), me = state.me;
    const show = !!me && me.memberType === 'human' && myProjects().includes(pj) && !!me.projectRoles && !(me.projectRoles[pj]) && !store.get(`aigile-role-hint:${me.participantId}:${pj}`);
    b.hidden = !show;
    b.innerHTML = show ? `<span>你在 <b>${esc(projName(pj))}</b> 還沒設角色</span><button type="button" class="link" data-role-set>設定</button><button type="button" class="icon-btn" data-role-dismiss="${esc(pj)}" aria-label="不再提醒">×</button>` : '';
  }
  document.getElementById('role-banner')?.addEventListener('click', e => {
    if (e.target.closest('[data-role-set]')) return openSettings({ focusRoles: true });
    const d = e.target.closest('[data-role-dismiss]');
    if (d) { store.set(`aigile-role-hint:${meId()}:${d.dataset.roleDismiss}`, '1'); drawRoleBanner(); }
  });
  // 頂端麵包屑「我的專案 ▸ 平台 ▸ 訊息」、手機頂欄「‹」與標題、第一層的「要你處理 N」、輸入框的「發到」
  function drawChrome() {
    drawRoleBanner();
    const v = projectView(), page = PAGE_NAME[state.page] || '訊息', top = !!TOP_PAGES[state.page];
    const home = !hasHub() ? '' : v === 'hub' && !top ? '<b aria-current="page">我的專案</b>' : '<button type="button" class="crumb-link" data-proj="hub">我的專案</button>';
    const parts = top ? [home, `<b aria-current="page">${page}</b>`] : v === 'hub' ? [home] : [home, `<b>${esc(viewLabel(v))}</b>`, `<span aria-current="page">${page}</span>`];
    $('#crumbs').innerHTML = parts.filter(Boolean).join('<span class="crumb-sep" aria-hidden="true">▸</span>');
    $('#m-back').hidden = !hasHub() || (v === 'hub' && !top);
    $('#m-title').textContent = top ? page : v === 'hub' ? '我的專案' : `${viewLabel(v)} · ${page}`;
    const counts = todoByView(), here = counts[v] || 0; // 收件匣徽章＝所在專案的件數，切專案就跟著變
    document.querySelectorAll('.inbox-badge').forEach(b => { b.hidden = !here; b.textContent = here > 99 ? '99+' : here; });
    const todo = $('#m-todo'), n = counts.hub, nb = todo.querySelector('.m-todo-n');
    todo.hidden = v !== 'hub' || top;
    nb.hidden = !n; nb.textContent = n > 99 ? '99+' : n;
    drawSendTo();
  }
  // 發訊息的專案（C-169）：固定是目前所在的專案，不能選；跨專案頻道發的是全部專案；回覆時跟著被回覆的訊息
  function sendTarget() {
    if (state.replyTo) return state.replyTo.project || 'all'; // 回覆跟著被回覆的訊息（C-185 起專案內只看得到該專案的訊息）
    const v = projectView();
    return v === 'cross' || v === 'hub' ? 'all' : v;
  }
  function drawSendTo() {
    const el = $('#send-to');
    if (!el) return;
    drawMentionWarn();
    const t = sendTarget();
    const v = projectView(), base = v === 'cross' || v === 'hub' ? 'all' : v;
    // C-231：同一列的小字「發到 X」，太長省略，完整說明放 title
    const name = t === 'all' ? '跨專案頻道' : projName(t);
    const note = [t === 'all' ? '所有專案都看得到' : '', state.replyTo && t !== base ? '跟著被回覆的訊息' : ''].filter(Boolean).join('，');
    el.innerHTML = `發到 <b>${esc(name)}</b>${note ? `<span class="st-note">（${esc(note)}）</span>` : ''}`;
    el.title = `發到 ${name}${note ? `（${note}）` : ''}`;
  }
  // 網址（C-169）：/p/<專案代號>/<頁面>、/cross/<頁面>、/＝第一層；重新整理停在原處、可加書籤
  // C-282：頁面用英文、專案用 API 代號（改名不壞、貼到 LINE／Slack 不會變一長串 %E…）；舊的中文頁名、專案名稱網址照樣能開，打開後換成新網址
  const PAGE_BY_NAME = Object.fromEntries(Object.entries(PAGE_NAME).map(([k, t]) => [t, k]));
  const PAGE_SLUG = { messages: 'messages', inbox: 'inbox', work: 'work', team: 'team', files: 'files' };
  function parseRoute() {
    const seg = location.pathname.split('/').filter(Boolean).map(x => { try { return decodeURIComponent(x); } catch { return x; } });
    const page = x => (PAGE_SLUG[x] || x === 'dm' ? x : PAGE_BY_NAME[x] || null);
    if (seg[0] === 'p' && seg[1]) { const p = state.projectList.find(x => x.slug === seg[1]) || state.projectList.find(x => x.id === seg[1]) || state.projectList.find(x => x.name === seg[1]); if (p && page(seg[2]) === 'dm') { state.dmAi = seg[3] || null; state.dmOpenOnBoot = true; } return { view: p ? p.id : null, page: p ? page(seg[2]) : null }; }
    if (seg[0] === 'cross') return { view: 'cross', page: page(seg[1]) };
    if (seg[0] === 'my-ai') return { view: null, page: 'myai' };
    if (seg[0] === 'members') return { view: null, page: 'perm' };
    if (seg[0] === 'wishes') return { view: null, page: 'wishes' };
    if (seg[0] === 'releases') return { view: null, page: 'releases' };
    return { view: null, page: null };
  }
  function routePath() {
    if (TOP_PAGES[state.page]) return TOP_PAGES[state.page];
    const v = projectView();
    if (v === 'hub') return '/';
    return `${v === 'cross' ? '/cross' : '/p/' + encodeURIComponent(state.projectList.find(p => p.id === v)?.slug || v)}/${PAGE_SLUG[state.page] || 'messages'}`; // C-285 網址英文名
  }
  function syncUrl(replace) {
    const u = routePath();
    let cur = location.pathname;
    try { cur = decodeURIComponent(cur); } catch {}
    if (cur === decodeURIComponent(u)) return;
    history[replace ? 'replaceState' : 'pushState'](null, '', u);
  }
  // 切換所在：k＝hub／專案 id／cross；切專案時留在同一頁（工作頁在跨專案頻道沒有，改到訊息）
  function setProjectView(k, page) {
    if (state.page === 'perm' && page !== 'perm' && permDirty()) return permLeave(() => { perm.draft.clear(); setProjectView(k, page); });
    state.view = k;
    if (state.replyTo) setReply(null);
    drawProjSwitch();
    syncFilterBar();
    renderMessages(true);
    const v = projectView();
    return showPage(page || (v === 'hub' ? 'hub' : state.page === 'hub' ? 'messages' : state.page));
  }
  window.addEventListener('popstate', () => {
    if (!state.me) return;
    const r = parseRoute();
    state.view = r.view || 'hub';
    if (state.replyTo) setReply(null);
    drawProjSwitch(); syncFilterBar(); renderMessages(true);
    showPage(r.page || (projectView() === 'hub' ? 'hub' : 'messages'), { noHistory: true });
  });
  window.addEventListener('beforeunload', e => { if (state.page === 'perm' && permDirty()) { e.preventDefault(); e.returnValue = ''; } });
  function psOpen(btn, open) {
    const list = btn.parentElement.querySelector('.ps-list');
    btn.setAttribute('aria-expanded', String(open));
    list.hidden = !open;
    if (open) (list.querySelector('[aria-selected="true"]') || list.firstElementChild).focus();
  }
  document.addEventListener('click', e => {
    const btn = e.target.closest('.ps-btn');
    if (btn) return psOpen(btn, btn.getAttribute('aria-expanded') !== 'true');
    const b = e.target.closest('[data-proj]');
    document.querySelectorAll('.ps-btn[aria-expanded="true"]').forEach(x => psOpen(x, false));
    if (b) { closeSheet(false); setProjectView(b.dataset.proj); }
  });
  document.addEventListener('keydown', e => {
    const li = e.target.closest?.('.ps-list [data-proj]');
    const btn = e.target.closest?.('.ps-btn');
    if (btn && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); psOpen(btn, true); return; }
    if (!li) return;
    const list = li.parentElement, items = [...list.children], i = items.indexOf(li);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const host = li.closest('.proj-switch'); setProjectView(li.dataset.proj); host?.querySelector('.ps-btn')?.focus(); } // 重畫後原本的清單已不在，從外框找新按鈕
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const b = list.parentElement.querySelector('.ps-btn'); psOpen(b, false); b.focus(); }
    else if (e.key === 'Tab') psOpen(list.parentElement.querySelector('.ps-btn'), false);
  });

  function visible(m) {
    const f = state.filter;
    if (!msgInView(m.project)) return false;
    if (f.scope === 'mine' && !(!isMine(m) && (isToMe(m) || isReplyToMe(m)))) return false;
    if (f.scope === 'related' && !related(m)) return false;
    if (f.member && m.author.participantId !== f.member) return false;
    if (f.tag && !tagOf(m.text).includes(f.tag)) return false;
    return !hiddenByThread(m);
  }
  const filtering = () => state.filter.scope !== 'all' || state.filter.member || state.filter.tag;
  function syncFilterBar() {
    const f = state.filter;
    document.querySelectorAll('[data-scope]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scope === f.scope)));
    document.querySelectorAll('[data-msg-view]').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.msgView === 'slim') === slimMode())));
    $('#f-tag').value = f.tag;
    const sel = $('#f-member');
    if (f.member && !inViewPerson(f.member)) f.member = ''; // C-188：換專案時，篩選的成員不在這個專案就清掉
    const people = [...state.participants.values()].filter(p => p.status !== 'disabled' && inViewPerson(p.participantId)).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    sel.innerHTML = '<option value="">所有成員</option>' + people.map(p => `<option value="${esc(p.participantId)}">${esc(p.name)}</option>`).join('');
    sel.value = f.member;
    $('#f-clear').hidden = !filtering();
    const fo = $('#f-open'); if (fo) { const n = filterCount(); fo.textContent = n ? `篩選 · ${n}` : '篩選 ▾'; }
    const an = $('#f-ainow'); if (an) an.checked = aiNowOn();
    drawAiNow();
  }
  // C-215：範圍「全部／與我相關」已在手機頂部兩顆，篩選按鈕只算成員、標籤（「給我的」不在兩顆裡，仍算一個）
  const filterCount = () => (state.filter.scope === 'mine' ? 1 : 0) + (state.filter.member ? 1 : 0) + (state.filter.tag ? 1 : 0);
  function setFilter(patch) {
    Object.assign(state.filter, patch);
    state.onlyMine = state.filter.scope === 'related';
    store.set(FILTER_KEY, state.onlyMine ? '1' : '0');
    syncFilterBar();
    renderMessages(true);
  }
  // 手機版：把範圍、成員、標籤合成一個「篩選」底部面板
  function filterSummary() {
    const f = state.filter, p = f.member ? state.participants.get(f.member)?.name : '';
    return [f.scope === 'mine' ? '給我的' : '', p || '', f.tag || ''].filter(Boolean).join(' · ');
  }
  function openFilterSheet() {
    const f = state.filter;
    const people = [...state.participants.values()].filter(p => p.status !== 'disabled' && inViewPerson(p.participantId)).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    const tags = ['需確認', '決策紀錄', '接單', '進度', '完成', '受阻', '交接', '回覆'];
    const draft = { scope: f.scope, member: f.member, tag: f.tag, view: slimMode() ? 'slim' : 'full' };
    const body = openModal('篩選', `
      <div class="stack">
        <div class="field"><span class="field-label" id="fs-scope">範圍</span>
          <div class="seg-scope full" role="group" aria-labelledby="fs-scope" id="fs-scope-g"></div></div>
        <label>成員<select id="fs-member"><option value="">所有成員</option>${people.map(p => `<option value="${esc(p.participantId)}">${esc(p.name)}</option>`).join('')}</select></label>
        <label>訊息類型<select id="fs-tag"><option value="">所有類型</option>${tags.map(t => `<option>${t}</option>`).join('')}</select></label>
        <div class="field"><span class="field-label" id="fs-view">顯示</span>
          <div class="seg-scope full" role="group" aria-labelledby="fs-view" id="fs-view-g"></div>
          <span class="muted small">精簡：AI 訊息只露第一句，點了看全文。記在這台裝置。</span></div>
        <label class="chk"><input type="checkbox" id="fs-ainow" ${aiNowOn() ? 'checked' : ''}> 顯示「AI 現況」（記在這台裝置）</label>
      </div>`, { size: 'narrow', foot: '<button class="btn" type="button" id="fs-clear">清除</button><button class="btn primary grow" type="button" id="fs-apply">套用</button>' });
    const draw = () => {
      body.querySelector('#fs-scope-g').innerHTML = [['all', '全部'], ['mine', '給我的'], ['related', '與我相關']].map(([k, t]) => `<button type="button" data-fs-scope="${k}" aria-pressed="${draft.scope === k}">${t}</button>`).join('');
      body.querySelector('#fs-view-g').innerHTML = [['slim', '精簡'], ['full', '完整']].map(([k, t]) => `<button type="button" data-fs-view="${k}" aria-pressed="${draft.view === k}">${t}</button>`).join('');
      body.querySelector('#fs-member').value = draft.member;
      body.querySelector('#fs-tag').value = draft.tag;
    };
    draw();
    body.addEventListener('click', e => {
      const sc = e.target.closest('[data-fs-scope]'); if (sc) { draft.scope = sc.dataset.fsScope; draw(); }
      const vw = e.target.closest('[data-fs-view]'); if (vw) { draft.view = vw.dataset.fsView; draw(); }
    });
    body.querySelector('#fs-member').onchange = e => { draft.member = e.target.value; };
    body.querySelector('#fs-tag').onchange = e => { draft.tag = e.target.value; };
    body.modal.querySelector('#fs-clear').onclick = () => { Object.assign(draft, { scope: 'all', member: '', tag: '' }); draw(); };
    body.modal.querySelector('#fs-apply').onclick = () => {
      closeModal();
      if (draft.view !== (slimMode() ? 'slim' : 'full')) store.set(MSG_VIEW_KEY, draft.view);
      setFilter({ scope: draft.scope, member: draft.member, tag: draft.tag });
    };
  }
  $('#f-open').onclick = openFilterSheet;
  document.querySelectorAll('[data-scope]').forEach(b => { b.onclick = () => setFilter({ scope: b.dataset.scope }); });
  document.querySelectorAll('[data-msg-view]').forEach(b => { b.onclick = () => setView(b.dataset.msgView); });
  $('#f-member').onchange = e => setFilter({ member: e.target.value });
  $('#f-tag').onchange = e => setFilter({ tag: e.target.value });
  $('#f-clear').onclick = () => setFilter({ scope: 'all', member: '', tag: '' });

  const nearBottom = () => { const el = $('#messages'); return el.scrollHeight - el.scrollTop - el.clientHeight < 120; };
  const scrollBottom = () => { const el = $('#messages'); el.scrollTop = el.scrollHeight; };

  // C-164：訊息頁只放最近 12 小時（不足 20 則補到 20），往上可「載入更早」；跳到很舊的訊息時進入「前後文」模式
  const WIN_H = 12, WIN_MIN = 20, WIN_MAX = 300, OLDER_HOLD_MS = 10 * 60_000;
  const MOBILE_N = 10; // C-217：手機打開訊息頁只放最新 10 則
  const curOf = seq => 'cur_' + btoa(JSON.stringify({ s: seq })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hm = iso => { const d = new Date(iso); return `${mmdd(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  Object.assign(state, { hasOlder: false, winFrom: null, winExpanded: false, lastOlderAt: 0, ctx: null, newCount: 0, newMention: 0, firstNewId: null });
  function setMessages(items) {
    state.messages = items;
    for (const m of items) state.byId.set(m.messageId, m);
  }
  const windowUrl = () => (narrowMq.matches ? `/api/messages?limit=${MOBILE_N}` : `/api/messages?limit=${WIN_MAX}&span=${WIN_H}&min=${WIN_MIN}`);
  async function loadWindow(pre) {
    const mobile = narrowMq.matches;
    const d = await (pre || api(windowUrl())); // C-240：開頁時先發出去的請求
    state.mobileWin = mobile;
    state.byId = state.byId || new Map();
    setMessages(d.items);
    state.nextCursor = state.nextCursor && !state.ctx ? state.nextCursor : d.nextCursor;
    Object.assign(state, { hasOlder: d.hasMore, winFrom: d.from, winExpanded: false, winTruncated: d.hasMore && d.items.length >= WIN_MAX, ctx: null, newCount: 0, newMention: 0, firstNewId: null });
    renderMessages(true); drawNewPill();
  }
  function headHtml(list) {
    if (state.ctx) {
      const c = state.ctx;
      return `<div class="ctx-bar" role="status"><span>正在看 ${esc(hm(c.at))} 前後的訊息</span>
        ${c.hasOlder ? '<button type="button" class="link small" id="ctx-older">再往前</button>' : '<span class="muted small">這是最早的訊息</span>'}
        <button type="button" class="link small" id="ctx-latest">回到最新 ↓${c.pending ? `（${c.pending} 則新訊息）` : ''}</button></div>`;
    }
    const first = state.messages[0];
    const top = state.hasOlder && first ? `<button type="button" class="load-older" id="load-older">${state.mobileWin ? `↑ 載入更早 ${MOBILE_N} 則` : `↑ 載入更早的訊息（${esc(hm(first.createdAt))} 以前）`}</button>`
      : state.messages.length ? '<div class="msg-start muted small">這是最早的訊息</div>' : '';
    const since = !first ? '' : state.mobileWin ? `從 ${hm(first.createdAt)} 起` : state.winExpanded || !state.winFrom ? `從 ${hm(first.createdAt)} 起`
      : first.createdAt < state.winFrom ? `從 ${hm(first.createdAt)} 起（最近 ${WIN_H} 小時不足 ${WIN_MIN} 則，往前補）`
      : state.winTruncated ? `從 ${hm(first.createdAt)} 起（最近 ${WIN_H} 小時還有更早的）`
      : `最近 ${WIN_H} 小時 · 從 ${hm(first.createdAt)}`;
    return top + (state.messages.length ? `<div class="win-divider"><span>${esc(since)} · ${list.length} 則</span></div>` : '');
  }
  function renderMessages(toBottom) {
    const list = state.messages.filter(visible);
    $('#f-count').textContent = filtering() ? `符合 ${list.length} 則` : '';
    const empty = filtering()
      ? `${state.ctx ? '這段沒有符合篩選條件的訊息。' : `最近 ${WIN_H} 小時沒有符合的訊息`}${!state.ctx && state.hasOlder ? ' · <button type="button" class="link" id="load-older-empty">載入更早</button>' : ''}`
      : '還沒有訊息。打個招呼，或到「我的 AI」新增助手。';
    const tail = state.ctx && state.ctx.hasNewer ? '<button type="button" class="load-older" id="ctx-newer">再往後</button>' : '';
    $('#messages').innerHTML = headHtml(list) + (list.length ? listHtml(list) : `<div class="empty">${empty}</div>`) + tail;
    const nl = state.firstNewId && document.getElementById('msg-' + state.firstNewId);
    if (nl && state.newCount) nl.insertAdjacentHTML('beforebegin', `<div class="new-line" id="new-line"><span>以下 ${state.newCount} 則是新的</span></div>`);
    syncScrollbar();
    if (toBottom) scrollBottom();
    drawLatestBtn();
  }

  // 載入更早：一次往前 12 小時、最多 100 則；那段沒訊息就自動往更早找；保留捲動位置
  async function loadOlder() {
    const box = $('#messages'), first = state.messages[0];
    if (!first) return;
    const prevHeight = box.scrollHeight, prevTop = box.scrollTop;
    const d = await api(state.mobileWin ? `/api/messages?limit=${MOBILE_N}&before=${encodeURIComponent(curOf(first.sequence))}` : `/api/messages?limit=100&span=${WIN_H}&beforeId=${encodeURIComponent(first.messageId)}`);
    const fresh = d.items.filter(m => !state.messages.some(x => x.messageId === m.messageId));
    setMessages(fresh.concat(state.messages));
    Object.assign(state, { hasOlder: d.hasMore, winExpanded: true, winTruncated: false, lastOlderAt: Date.now() });
    renderMessages(false);
    box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
  }
  // 自動收起：只在人在最底下、且 10 分鐘內沒按過「載入更早」時，才移掉超過 12 小時的；最多保留 300 則。往上看時絕不刪
  function trimWindow() {
    if (state.ctx || !nearBottom() || Date.now() - state.lastOlderAt < OLDER_HOLD_MS) return;
    const cutoff = new Date(Date.now() - WIN_H * 3600_000).toISOString();
    let keep = state.messages.filter(m => m.createdAt >= cutoff);
    if (keep.length < WIN_MIN) keep = state.messages.slice(-WIN_MIN);
    if (state.mobileWin) keep = state.messages.slice(-MOBILE_N); // 手機在最底下時收回最新 10 則
    if (keep.length > WIN_MAX) keep = keep.slice(-WIN_MAX);
    if (keep.length === state.messages.length) return;
    state.messages = keep;
    Object.assign(state, { hasOlder: true, winExpanded: false, winFrom: cutoff });
    renderMessages(true);
  }
  // 跳到不在畫面上的舊訊息：載入那則前後各 20 則並標黃
  async function enterContext(id) {
    const d = await api(`/api/messages/${encodeURIComponent(id)}/around?n=20`);
    const target = d.items.find(m => m.messageId === id);
    state.ctx = { id, at: target?.createdAt, olderCursor: d.olderCursor, hasOlder: d.hasOlder, newerCursor: d.newerCursor, hasNewer: d.hasNewer, pending: 0 };
    setMessages(d.items);
    Object.assign(state, { newCount: 0, newMention: 0, firstNewId: null });
    if (filtering() || state.collapsed.size) { state.collapsed.clear(); Object.assign(state.filter, { scope: 'all', member: '', tag: '' }); state.onlyMine = false; syncFilterBar(); }
    renderMessages(false); drawNewPill();
    const el = document.getElementById('msg-' + id);
    if (el) { el.classList.add('target'); scrollMsgTo(el, false); }
  }
  async function ctxMore(dir) {
    const c = state.ctx, box = $('#messages');
    if (!c) return;
    if (dir === 'older') {
      const prevHeight = box.scrollHeight, prevTop = box.scrollTop;
      const d = await api(`/api/messages?limit=20&before=${encodeURIComponent(c.olderCursor)}`);
      setMessages(d.items.concat(state.messages));
      Object.assign(c, { olderCursor: d.olderCursor, hasOlder: d.hasMore });
      renderMessages(false);
      box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
    } else {
      const d = await api(`/api/messages?limit=20&after=${encodeURIComponent(c.newerCursor)}`);
      setMessages(state.messages.concat(d.items.filter(m => !state.messages.some(x => x.messageId === m.messageId))));
      Object.assign(c, { newerCursor: d.nextCursor, hasNewer: d.hasMore });
      const top = box.scrollTop; renderMessages(false); box.scrollTop = top;
    }
    const el = document.getElementById('msg-' + c.id); if (el) el.classList.add('target');
  }
  // 有新訊息但人不在底部：藍色膠囊「有 N 則新訊息 ↓」；到底自動消失
  function drawNewPill() {
    const p = $('#new-pill');
    if (!p) return;
    p.hidden = !state.newCount || !!state.ctx;
    p.innerHTML = `<span class="np-long">有 ${state.newCount} 則新訊息${state.newMention ? `（${state.newMention} 則提到你）` : ''} ↓</span><span class="np-short" aria-hidden="true">↓${state.newCount}</span>`;
    p.setAttribute('aria-label', `有 ${state.newCount} 則新訊息${state.newMention ? `，${state.newMention} 則提到你` : ''}，跳到最新`);
    drawLatestBtn();
  }
  function clearNew() { if (!state.newCount) return; Object.assign(state, { newCount: 0, newMention: 0, firstNewId: null }); $('#new-line')?.remove(); drawNewPill(); }

  function onNewMessage(m) {
    if (state.byId.has(m.messageId) && (state.ctx || state.messages.some(x => x.messageId === m.messageId))) return;
    if (state.ctx) { // 正在看舊訊息的前後文：新訊息先記數，回到最新時一起看
      state.byId.set(m.messageId, m);
      if (!isMine(m)) { state.ctx.pending++; const b = $('#ctx-latest'); if (b) b.textContent = `回到最新 ↓（${state.ctx.pending} 則新訊息）`; }
      if (!isMine(m) && (isToMe(m) || isReplyToMe(m))) refreshInboxCount();
      return;
    }
    const stick = nearBottom() || isMine(m);
    const parent = m.replyToMessageId && state.byId.get(m.replyToMessageId);
    if (parent && /^\s*\[需確認\]/.test(parent.text) && (state.participants.get(m.author.participantId) || m.author).memberType === 'human') {
      work.answered?.add(parent.messageId); updateTodoBadge(); if (state.page === 'inbox') setTimeout(renderWork, 1500); // C-195：先看到「已回覆」，再從收件匣移走
      loadTeam().then(() => { updateTodoBadge(); if (state.page === 'inbox' || state.page === 'hub') renderWork(); }).catch(() => {}); // C-173：回覆後收件匣移除
    }
    state.messages.push(m);
    state.byId.set(m.messageId, m);
    if (state.page === 'hub' && work.loaded) renderWork();
    if (!stick && visible(m)) {
      if (!state.newCount) state.firstNewId = m.messageId;
      state.newCount++;
      if (isToMe(m) || isReplyToMe(m)) state.newMention++;
    }
    if ((m.replyToMessageId && state.byId.has(m.replyToMessageId)) || (visible(m) && (isFlowLine(m) || effCard(m)))) {
      const box = $('#messages'), top = box.scrollTop;
      renderMessages(stick);
      if (stick) trimWindow(); else box.scrollTop = top;
      drawNewPill();
      if (!isMine(m) && (isToMe(m) || isReplyToMe(m))) refreshInboxCount();
      return;
    }
    if (!visible(m)) return;
    const box = $('#messages');
    box.querySelector('.empty')?.remove();
    if (!stick && state.firstNewId === m.messageId) box.insertAdjacentHTML('beforeend', `<div class="new-line" id="new-line"><span>以下 ${state.newCount} 則是新的</span></div>`);
    else if (!stick) { const nl = $('#new-line'); if (nl) nl.firstElementChild.textContent = `以下 ${state.newCount} 則是新的`; }
    box.insertAdjacentHTML('beforeend', messageHtml(m));
    if (stick) { scrollBottom(); trimWindow(); }
    drawNewPill();
    if (!isMine(m) && (isToMe(m) || isReplyToMe(m))) refreshInboxCount();
  }
  // 膠囊貼在輸入框上方：跟著輸入框高度
  new ResizeObserver(() => document.documentElement.style.setProperty('--composer-h', (document.querySelector('.composer')?.offsetHeight || 110) + 'px')).observe(document.querySelector('.composer'));
  // 捲到最底下：膠囊消失
  $('#messages').addEventListener('scroll', () => { if (nearBottom()) clearNew(); }, { passive: true });

  $('#messages').addEventListener('input', e => { const t = e.target.closest?.('[data-q-text]'); if (!t) return; quickState(t.dataset.qText).text = t.value; const sb = t.closest('[data-q-root]')?.querySelector('[data-q-send]'); if (sb && cardOfConfirm({ messageId: t.dataset.qText })) sb.disabled = !t.value.trim(); else if (sb) { const m = state.byId.get(t.dataset.qText), qs = m ? parseQuestions(m.text) : [], q = quickState(t.dataset.qText); if (qs.length === 1 && !q.sels[0]) { sb.disabled = !t.value.trim(); sb.textContent = t.value.trim() ? '送出想法' : '先選一個選項'; } } });
  $('#page-work').addEventListener('click', e => { if (state.page === 'inbox') authClick(e); });
  $('#page-work').addEventListener('input', e => { const t = state.page === 'inbox' && e.target.closest?.('[data-q-text]'); if (t) { quickState(t.dataset.qText).text = t.value; const sb = t.closest('[data-q-root]')?.querySelector('[data-q-send]'); if (sb) { const m = state.byId.get(t.dataset.qText), qs = m ? parseQuestions(m.text) : [], q = quickState(t.dataset.qText); if (qs.length === 1 && !q.sels[0]) { sb.disabled = !t.value.trim(); sb.textContent = t.value.trim() ? '送出想法' : '先選一個選項'; } } } });
  $('#page-work').addEventListener('keydown', e => {
    if (state.page !== 'inbox' || e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || !e.target.matches?.('[data-q-text]')) return;
    e.preventDefault(); const b = e.target.closest('.quick')?.querySelector('[data-q-send]'); if (b && !b.disabled) b.click();
  });
  $('#messages').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || !e.target.matches?.('[data-q-text]')) return;
    e.preventDefault(); const b = e.target.closest('.quick')?.querySelector('[data-q-send]'); if (b && !b.disabled) b.click();
  });
  // C-260：記住哪些「細節」打開了，重畫後維持
  $('#messages').addEventListener('toggle', e => {
    const d = e.target.closest?.('details[data-detail]');
    if (!d) return;
    if (d.open) state.expanded.add(d.dataset.detail); else state.expanded.delete(d.dataset.detail);
  }, true);
  $('#messages').addEventListener('click', e => {
    const go = e.target.closest?.('[data-grp-open]');
    if (go) { state.grpOpen.add(go.dataset.grpOpen); const box = $('#messages'), top = box.scrollTop; renderMessages(false); box.scrollTop = top; return; }
    const gr = e.target.closest?.('[data-grp-reply]');
    if (gr) { const m = state.byId.get(gr.dataset.grpReply); if (m) { setReply(m); input.focus(); } return; }
    if (e.target.closest('#load-older, #load-older-empty')) return loadOlder().catch(err => toast(err.message));
    if (e.target.closest('#ctx-older')) return ctxMore('older').catch(err => toast(err.message));
    if (e.target.closest('#ctx-newer')) return ctxMore('newer').catch(err => toast(err.message));
    if (e.target.closest('#ctx-latest')) return loadWindow().catch(err => toast(err.message));
    const r = e.target.closest('[data-reply]');
    if (r) return setReply(state.byId.get(r.dataset.reply));
    const j = e.target.closest('[data-jump]');
    if (j) return jumpTo(j.dataset.jump);
    const cap = e.target.closest('[data-cap]');
    if (cap) return openCard(cap.dataset.cap, cap);
    const nc = e.target.closest('[data-newcard]');
    if (nc) return openNewCard(null, state.byId.get(nc.dataset.newcard));
    if (authClick(e)) return;
    const sha = e.target.closest('[data-sha]');
    if (sha) return copyText(sha.dataset.sha).then(ok => toast(ok ? '已複製完整 SHA' : '複製失敗'));
    const op = e.target.closest('[data-open-msg]');
    if (op) {
      const id = op.dataset.openMsg, box = $('#messages'), top = box.scrollTop;
      state.open.add(id); renderMessages(false); box.scrollTop = top;
      document.getElementById('msg-' + id)?.querySelector('[data-fold]')?.focus({ preventScroll: true });
      return;
    }
    const fold = e.target.closest('[data-fold]');
    if (fold) {
      const id = fold.dataset.fold, box = $('#messages'), top = box.scrollTop;
      state.open.delete(id); renderMessages(false); box.scrollTop = top;
      const el = document.getElementById('msg-' + id);
      (el?.matches('button') ? el : el?.querySelector('button'))?.focus({ preventScroll: true });
      return;
    }
    const ff = e.target.closest('[data-flow-fold]');
    if (ff) {
      const id = ff.dataset.flowFold, box = $('#messages'), top = box.scrollTop;
      state.flowOpen.delete(id); renderMessages(false); box.scrollTop = top;
      document.querySelector(`[data-flow-group="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
      return;
    }
    const fg = e.target.closest('[data-flow-group]');
    if (fg) {
      const id = fg.dataset.flowGroup, box = $('#messages'), top = box.scrollTop;
      state.flowOpen.add(id); renderMessages(false); box.scrollTop = top;
      document.getElementById('msg-' + id)?.focus({ preventScroll: true });
      return;
    }
    const more = e.target.closest('[data-more]');
    if (more) {
      const id = more.dataset.more;
      if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
      const el = document.getElementById('msg-' + id);
      if (el) el.outerHTML = messageHtml(state.byId.get(id));
      return;
    }
    const th = e.target.closest('[data-thread]');
    if (th) {
      const id = th.dataset.thread;
      if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
      const box = $('#messages'), top = box.scrollTop;
      renderMessages(false);
      box.scrollTop = top;
    }
  });

  document.getElementById('new-pill')?.addEventListener('click', () => { scrollBottom(); clearNew(); });
  document.getElementById('latest-btn')?.addEventListener('click', () => { const box = $('#messages'); box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }); $('#latest-btn').hidden = true; clearNew(); });
  let latestRaf = 0;
  $('#messages').addEventListener('scroll', () => { if (!latestRaf) latestRaf = requestAnimationFrame(() => { latestRaf = 0; drawLatestBtn(); }); }, { passive: true });
  // C-216：App 畫面整頁固定不捲，只有訊息清單、卡片抽屜等內容區會捲；整頁被捲走就拉回來
  // UX 第 1551 則：打字時（輸入框有焦點、鍵盤開著）iPhone Safari 會自己把整頁往上推讓輸入框露出來，這時不拉回，否則輸入框會被鍵盤蓋住；收起鍵盤或離開輸入框才拉回
  const typingField = () => document.activeElement?.matches?.('input, textarea, select, [contenteditable="true"]');
  const keyboardOpen = () => !!window.visualViewport && visualViewport.height < window.innerHeight * 0.85;
  const pinPage = (force = false) => {
    if ($('#app').hidden || !(window.scrollY || document.documentElement.scrollTop || document.body.scrollTop)) return;
    if (!force && typingField() && keyboardOpen()) return;
    window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0;
  };
  window.addEventListener('scroll', () => pinPage(), { passive: true });
  window.visualViewport?.addEventListener('resize', () => setTimeout(() => { if (!keyboardOpen()) pinPage(true); }, 80));
  document.addEventListener('focusout', () => setTimeout(() => { if (!typingField()) pinPage(true); }, 150));
  if (window.visualViewport) { // C-215：手機鍵盤高度，給固定在底部的卡片回覆框用
    const kb = () => document.documentElement.style.setProperty('--kb', Math.max(0, Math.round(window.innerHeight - visualViewport.height - visualViewport.offsetTop)) + 'px');
    visualViewport.addEventListener('resize', kb); visualViewport.addEventListener('scroll', kb);
    // C-230：觸控裝置上 App 的高度與位置跟著 iPhone 回報的可見區走（--vvh／--vvt），鍵盤開時整個 App 縮到鍵盤上方，輸入框與送出鈕不會被蓋住；電腦不變
    if (matchMedia('(pointer: coarse)').matches) {
      const root = document.documentElement;
      root.classList.add('vv-on');
      let last = '';
      const vv = () => {
        const h = Math.round(visualViewport.height), t = Math.round(visualViewport.offsetTop), key = h + ',' + t;
        if (key === last) return;
        const grew = last && h < Number(last.split(',')[0]);
        last = key;
        root.style.setProperty('--vvh', h + 'px');
        root.style.setProperty('--vvt', t + 'px');
        // 鍵盤剛打開：把正在打字的框捲進它所在的清單可見處
        if (grew && typingField()) { const el = document.activeElement; if (el.closest('#app')) requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' })); }
      };
      visualViewport.addEventListener('resize', vv); visualViewport.addEventListener('scroll', vv); vv();
    }
  }
  narrowMq.addEventListener?.('change', () => { if (!store.get(MSG_VIEW_KEY) && state.me) { const box = $('#messages'), top = box.scrollTop; renderMessages(false); box.scrollTop = top; syncFilterBar(); } });
  async function jumpTo(id) {
    const m0 = state.byId.get(id);
    if (m0 && !msgInView(m0.project) && hasHub()) await setProjectView(m0.project && myProjects().includes(m0.project) ? m0.project : 'cross', 'messages');
    let el = document.getElementById('msg-' + id);
    if (state.byId.has(id) && (!el || el.matches('.flow-line, .slim'))) el = revealMsg(id) || el;
    if (!el && state.byId.has(id) && (filtering() || state.collapsed.size)) {
      state.collapsed.clear();
      Object.assign(state.filter, { scope: 'all', member: '', tag: '' });
      state.onlyMine = false; store.set(FILTER_KEY, '0');
      syncFilterBar(); renderMessages(false);
      el = document.getElementById('msg-' + id);
    }
    if (!el) {
      try { await enterContext(id); } catch { toast('找不到原訊息'); }
      return;
    }
    scrollMsgTo(el);
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }

  function setReply(m) {
    state.replyTo = m || null;
    $('#reply-bar').hidden = !m;
    if (m) {
      $('#reply-to-name').textContent = m.author.name;
      $('#reply-to-preview').textContent = m.text.slice(0, 60);
      $('#input').focus();
    }
    drawSendTo();
  }
  $('#reply-cancel').addEventListener('click', () => setReply(null));

  // ---------- 輸入與 @提及 ----------
  // @ 選單候選（C-150）：不截斷，清單可捲動；所有人在最前，再來是跟我同專案的成員
  // C-174：專案內只列該專案的成員（跨專案角色本來就屬於每個專案），「所有人」寫成「所有人（平台）」；跨專案頻道列全部
  const mentionScope = () => { const t = sendTarget(); return t === 'all' ? null : t; };
  const inScope = (p, scope) => !scope || (p.projects || []).includes(scope);
  function mentionCandidates(raw) {
    const q = raw.toLowerCase(), scope = mentionScope();
    const mine = myProjects();
    const near = p => (p.projects?.length ? p.projects : PROJECTS).some(x => mine.includes(x));
    const people = [...state.participants.values()]
      .filter(p => p.participantId !== meId() && p.status !== 'disabled' && inScope(p, scope) && (!q || p.name.toLowerCase().includes(q) || (p.role || '').toLowerCase().includes(q)));
    const all = scope ? { ...ALL, label: `${ALL.name}（${projName(scope)}）`, role: `通知${projName(scope)}的所有成員` } : ALL;
    return [...(!q || ALL.name.includes(q) || all.role.includes(q) ? [all] : []), ...people.filter(near), ...people.filter(p => !near(p))];
  }
  // 手打 @ 了不在這個專案的人：輸入框下方先提示，不用等送出才被擋
  function outsideMentions(text, scope = mentionScope()) {
    if (!scope) return [];
    let scan = text;
    const out = [];
    for (const p of [...state.participants.values()].sort((a, b) => b.name.length - a.name.length)) {
      const tag = '@' + p.name;
      if (!scan.includes(tag)) continue;
      if (p.participantId !== meId() && !inScope(p, scope)) out.push(p.name);
      scan = scan.split(tag).join(' ');
    }
    return out;
  }
  const outsideText = (names, scope = mentionScope()) => (names.length ? `${names.join('、')} 不在${projName(scope)}專案，請到跨專案頻道找對方` : '');
  function drawMentionWarn() {
    const el = $('#mention-warn');
    if (!el) return;
    const t = outsideText(outsideMentions($('#input')?.value || ''));
    el.textContent = t; el.hidden = !t;
  }
  // 鍵盤上下移動時，讓選中的那一列留在可視範圍
  const scrollPicked = list => list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  const input = $('#input');
  const sendBtn = $('#send');
  const mentionList = $('#mention-list');
  let mentionState = null;

  // 訊息區有捲軸時，輸入區右邊多留同寬度，兩者左右邊界才會對齊
  const syncScrollbar = () => { const m = $('#messages'); document.documentElement.style.setProperty('--sbw', (m.offsetWidth - m.clientWidth) + 'px'); };
  new ResizeObserver(syncScrollbar).observe($('#messages')); window.addEventListener('resize', syncScrollbar);
  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.max(44, Math.min(input.scrollHeight + 2, window.innerHeight * 0.4)) + 'px';
  }

  function updateMention() {
    const pos = input.selectionStart;
    const m = input.value.slice(0, pos).match(/@([^\s@]*)$/);
    if (!m) return closeMention();
    const items = mentionCandidates(m[1]);
    if (!items.length) return closeMention();
    mentionState = { start: pos - m[0].length, end: pos, items, index: 0 };
    renderMention();
  }
  function renderMention() {
    mentionList.innerHTML = mentionState.items.map((p, i) => `
      <li role="option" data-i="${i}" aria-selected="${i === mentionState.index}">
        <span class="dot ${p.isOnline ? 'on' : ''}"></span><b>${esc(p.label || p.name)}</b>
        <span class="muted small">${esc(p.memberType === 'all' ? p.role || '' : roleIn(p, mentionScope() || projectView()))}</span>${p.memberType === 'ai' ? '<span class="tag ai">AI</span>' : ''}
      </li>`).join('');
    mentionList.hidden = false;
    scrollPicked(mentionList);
  }
  function closeMention() { mentionState = null; mentionList.hidden = true; }
  function pickMention(i) {
    const p = mentionState.items[i];
    const insert = '@' + p.name + ' ';
    input.value = input.value.slice(0, mentionState.start) + insert + input.value.slice(mentionState.end);
    const caret = mentionState.start + insert.length;
    input.setSelectionRange(caret, caret);
    closeMention();
    input.focus();
    onInput();
  }
  mentionList.addEventListener('mousedown', e => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); pickMention(Number(li.dataset.i)); }
  });

  // C-231：類型小膠囊顯示目前選的類型；一般＝灰框，選了別的才變藍
  function drawTagChip() {
    const cur = leadTagOf(input.value) || '';
    const b = $('#tag-btn');
    b.textContent = `類型：${cur || '一般'} ▾`;
    b.classList.toggle('on', !!cur);
    b.setAttribute('aria-label', `訊息類型：${cur || '一般'}`);
  }
  function onInput() {
    sendBtn.disabled = !input.value.trim();
    drawTagChip();
    autoGrow();
    updateMention();
    drawMentionWarn();
    drawAskRow();
  }
  input.addEventListener('input', onInput);
  input.addEventListener('click', updateMention);
  input.addEventListener('blur', () => setTimeout(closeMention, 150));

  const isDesktop = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
  input.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return; // 中文組字中，不處理
    if (mentionState) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = mentionState.items.length;
        mentionState.index = (mentionState.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        return renderMention();
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pickMention(mentionState.index); }
      if (e.key === 'Escape') { e.preventDefault(); return closeMention(); }
    }
    if (e.key === 'Enter' && !e.shiftKey && isDesktop()) { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener('click', send);

  // 正文中的 @名字 → 收件人（依出現順序）；@所有人 → audience: all
  function mentionedIds(text) {
    const hits = [];
    let scan = text;
    const people = [...state.participants.values()].sort((a, b) => b.name.length - a.name.length);
    for (const p of people) {
      const tag = '@' + p.name, at = scan.indexOf(tag);
      if (at >= 0) {
        if (p.participantId !== meId()) hits.push([at, p.participantId]);
        scan = scan.split(tag).join(' '.repeat(tag.length)); // 保留長度，位置才準
      }
    }
    return hits.sort((a, b) => a[0] - b[0]).map(h => h[1]);
  }
  const askPick = new Map(); // C-259：使用者點過的「要回覆／知會」
  const askOfId = (id, i) => (askPick.has(id) ? askPick.get(id) : i === 0);
  // C-277：回覆時，被回覆的人自動算收件人、排第一（預設要回覆）
  const replyTarget = () => { const a = state.replyTo?.author?.participantId; return a && a !== meId() ? a : null; };
  const withReply = ids => { const r = replyTarget(); return r ? [r, ...ids.filter(x => x !== r)] : ids; };
  function resolveRecipients(text) {
    if (text.includes('@' + ALL.name)) return { audience: 'all' };
    const ids = withReply(mentionedIds(text));
    if (!ids.length) return {};
    return ids.length > 1 ? { recipientIds: ids, replyFrom: ids.filter(askOfId) } : { recipientIds: ids };
  }
  function drawAskRow() {
    const row = $('#ask-row');
    if (!row) return;
    const text = input.value;
    const ids = text.includes('@' + ALL.name) ? [] : withReply(mentionedIds(text));
    for (const id of [...askPick.keys()]) if (!ids.includes(id)) askPick.delete(id);
    row.hidden = ids.length < 2;
    if (row.hidden) { row.innerHTML = ''; return; }
    row.innerHTML = `<span class="muted small">誰要回覆：</span>${ids.map((id, i) => { const on = askOfId(id, i), name = state.participants.get(id)?.name || id;
      return `<button type="button" class="ask-chip ${on ? 'ask' : 'fyi'}" data-ask-toggle="${esc(id)}" aria-pressed="${on}" aria-label="${esc(`${name}：${on ? '要回覆' : '知會'}，點一下切換`)}">${esc(name)} <b>${on ? '要回覆' : '知會'}</b></button>`; }).join('')}`;
  }
  $('#ask-row')?.addEventListener('click', e => {
    const b = e.target.closest('[data-ask-toggle]');
    if (!b) return;
    const ids = withReply(mentionedIds(input.value)), id = b.dataset.askToggle;
    askPick.set(id, !askOfId(id, ids.indexOf(id)));
    drawAskRow();
  });

  // 沒動過專案選單：回覆時不帶（繼承），否則帶目前檢視的專案；動過就照選的
  const sendProject = () => ({ project: sendTarget() });
  // C-172：收件匣、卡片抽屜的行內回覆也明確帶專案（兩邊成員沒帶會被伺服器擋下）：卡片的專案＞被回覆訊息的專案＞所在專案
  async function msgProject(body) {
    if (body.project) return body.project;
    const card = body.cardId && work.cards.get(body.cardId);
    if (card?.project) return card.project;
    if (body.replyToMessageId) {
      const m = state.byId.get(body.replyToMessageId) || await api(`/api/messages/${encodeURIComponent(body.replyToMessageId)}`).catch(() => null);
      return m?.project || 'all';
    }
    const v = projectView();
    return v === 'cross' || v === 'hub' ? 'all' : v;
  }
  const postMsg = async body => api('/api/messages', { method: 'POST', body: { ...body, project: await msgProject(body) } });
  let sending = false;
  let pendingRequestId = null; // 失敗重送時沿用同一個 requestId，避免重複發文
  async function send() {
    const text = input.value.trim();
    if (!text || sending) return;
    if (text.length > 2000) return toast(`訊息上限 2000 字（目前 ${text.length} 字）`);
    sending = true; sendBtn.disabled = true;
    pendingRequestId = pendingRequestId || newRequestId();
    try {
      const m = await api('/api/messages', {
        method: 'POST',
        body: { text, requestId: pendingRequestId, replyToMessageId: state.replyTo?.messageId, ...resolveRecipients(text), ...sendProject() },
      });
      pendingRequestId = null;
      onNewMessage(m);
      askPick.clear();
      input.value = '';
      setReply(null);
      onInput();
    } catch (err) {
      if (err.code === 'IDEMPOTENCY_CONFLICT' || err.code === 'INVALID_REQUEST' || err.code === 'INVALID_ENCODING') pendingRequestId = null;
      // C-155：亂碼被擋時草稿留在輸入框，原因直接寫在框下（UX 第 994 則）
      if (err.code === 'INVALID_ENCODING') { const e = $('#composer-error'); e.textContent = '訊息含亂碼字元（�），請確認編碼或刪掉那個字元後再送。'; e.hidden = false; }
      else toast('送出失敗：' + err.message);
    } finally {
      sending = false;
      sendBtn.disabled = !input.value.trim();
    }
  }
  input.addEventListener('input', () => { pendingRequestId = null; $('#composer-error').hidden = true; });
  // 手機版：打字時收起頂欄大小、警示與篩選列，鍵盤出現時訊息區才有空間
  const typingMq = matchMedia('(max-width: 600px)');
  input.addEventListener('focus', () => { if (typingMq.matches) document.body.classList.add('typing'); });
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) document.body.classList.remove('typing'); }, 120));

  // ---------- 對話框 ----------
  // 共用外框：桌面置中、手機從底部滑出。size：''（560）、'wide'（760）、'form'（640）、'narrow'（440）
  // actions：標頭 × 左邊的動作鈕；foot：底部按鈕（只有要做決定的彈窗才給）
  let modalReturnFocus = null;
  // C-205：點灰底不關彈窗，也不讓焦點跑出彈窗（否則之後按 Esc 收不到）
  const holdBackdrop = overlay => overlay.addEventListener('mousedown', e => { if (e.target === overlay) e.preventDefault(); });
  function modalFrame({ title, sub = '', size = '', actions = '', foot = '', body = '' }) {
    return `
      <div class="overlay">
        <div class="modal ${size}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div class="modal-head">
            <div class="modal-titles"><h2 id="modal-title">${title}</h2>${sub ? `<p class="modal-sub">${sub}</p>` : ''}</div>
            ${actions ? `<div class="modal-actions">${actions}</div>` : ''}
            <button class="icon-btn modal-x" type="button" data-close aria-label="關閉">×</button>
          </div>
          <div class="modal-body">${body}</div>
          ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
        </div>
      </div>`;
  }
  // 在「團隊」頁時，團隊狀態／成員名單／我的 AI 這三個畫面直接畫在頁面的分頁區，不再跳對話框（C-134 第二版）
  const TEAM_PANES = ['團隊狀態', '成員名單', '我的 AI'];
  function openModal(title, bodyHtml, opts = {}) {
    const pane = (state.page === 'team' && TEAM_PANES.includes(title) && $('#team-pane')) || (state.page === 'myai' && title === '我的 AI' && $('#myai-pane')) || (state.page === 'files' && title === '文件' && $('#files-pane')) || null;
    if (pane) {
      const sc = $('#page-work'), top = sc.scrollTop;
      pane.innerHTML = modalFrame({ title, body: bodyHtml, ...opts });
      sc.scrollTop = top;
      const inner = pane.querySelector('.modal'), inBody = pane.querySelector('.modal-body');
      inBody.modal = inner;
      return inBody;
    }
    const root = $('#modal-root');
    if (!root.firstElementChild) modalReturnFocus = document.activeElement;
    root.innerHTML = modalFrame({ title, body: bodyHtml, ...opts });
    const overlay = root.firstElementChild;
    holdBackdrop(overlay);
    overlay.addEventListener('click', e => {
      if (e.target.closest('[data-close]')) closeModal(); // C-205：點灰底不關，只能按 × 或 Esc
    });
    const modal = overlay.querySelector('.modal');
    (modal.querySelector('.modal-body input:not([type=checkbox]), .modal-body select, .modal-body textarea') || modal.querySelector('.modal-x')).focus();
    const body = overlay.querySelector('.modal-body');
    body.modal = modal; // 給呼叫端取用標頭與底部按鈕
    return body;
  }
  function closeModal() {
    $('#modal-root').innerHTML = '';
    if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
    modalReturnFocus = null;
  }
  // 確認彈窗：疊在目前彈窗上；回傳 true／false
  function confirmDialog({ title, message, confirmText = '確認', cancelText = '取消', danger = false, expectText = '' }) {
    return new Promise(resolve => {
      const prev = document.activeElement;
      const host = document.createElement('div');
      host.className = 'confirm-root';
      host.innerHTML = modalFrame({
        title, size: 'narrow',
        body: `<div class="confirm-msg${danger ? ' danger' : ''}">${message}</div>${expectText ? `<label class="field">請輸入「${esc(expectText)}」確認<input type="text" data-expect autocomplete="off"></label>` : ''}`,
        foot: `<button class="btn" type="button" data-close>${esc(cancelText)}</button>
               <button class="btn ${danger ? 'danger' : 'primary'}" type="button" data-ok ${expectText ? 'disabled' : ''}>${esc(confirmText)}</button>`,
      });
      document.body.append(host);
      const overlay = host.firstElementChild;
      const done = ok => { host.remove(); if (prev?.isConnected) prev.focus(); resolve(ok); };
      holdBackdrop(overlay);
      overlay.addEventListener('click', e => {
        if (e.target.closest('[data-ok]')) return done(true);
        if (e.target.closest('[data-close]')) done(false);
      });
      overlay.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
      const ex = overlay.querySelector('[data-expect]');
      if (ex) { ex.addEventListener('input', () => { overlay.querySelector('[data-ok]').disabled = ex.value.trim() !== expectText; }); ex.focus(); } else overlay.querySelector('[data-ok]').focus();
    });
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.querySelector('.confirm-root') && $('#modal-root').firstElementChild) closeModal();
  });
  // 彈窗內 Tab 不跑出去
  document.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const modal = document.querySelector('.confirm-root .modal') || $('#modal-root .modal');
    if (!modal) return;
    const f = [...modal.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  });

  // ---------- 頭像 ----------
  // 圖片頭像：以版本號快取 blob URL，畫面上有 data-avimg 的頭像會自動補上圖片
  const avatarUrls = new Map();
  function avatarUrl(id, v) {
    const key = `${id}:${v}`;
    if (!avatarUrls.has(key)) {
      avatarUrls.set(key, fetch(`/api/avatars/${encodeURIComponent(id)}?v=${v}`, { headers: { Authorization: `Bearer ${state.token}` } })
        .then(r => (r.ok ? r.blob() : null)).then(b => (b ? URL.createObjectURL(b) : null)).catch(() => null));
    }
    return avatarUrls.get(key);
  }
  function hydrateAvatars(root = document) {
    root.querySelectorAll?.('[data-avimg]:not([data-avdone])').forEach(el => {
      el.setAttribute('data-avdone', '');
      avatarUrl(el.dataset.avimg, el.dataset.v).then(url => {
        if (url) { el.style.backgroundImage = `url("${url}")`; el.classList.add('img-on'); }
      });
    });
  }
  new MutationObserver(muts => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) { hydrateAvatars(n.parentElement || n); } })
    .observe(document.body, { childList: true, subtree: true });

  // 更換頭像彈窗（疊在目前彈窗上）：上傳圖片並裁切，或用文字／表情符號
  // cur：{ imgUrl, text }；回傳 { kind: 'img', blob } | { kind: 'text', text, removeImg } | null（取消）
  // aiRow：{ askLabel, prevPath }（C-272 退回①②）；按了回傳 { kind: 'ask' } 或 { kind: 'revert' }
  function avatarDialog({ title, isAi, fallback, cur, aiRow }) {
    return new Promise(resolve => {
      const prev = document.activeElement;
      const host = document.createElement('div');
      host.className = 'confirm-root';
      const shape = isAi ? 'ai' : 'human';
      host.innerHTML = modalFrame({
        title, size: 'narrow',
        body: `
          <div class="av-previews">
            <span class="av-prev big ${shape}" id="av-big"></span>
            <div class="av-small"><span class="av-prev s32 ${shape}"></span><span class="muted small">訊息</span></div>
            <div class="av-small"><span class="av-prev s24 ${shape}"></span><span class="muted small">清單</span></div>
          </div>
          ${aiRow ? `<div class="av-ai-row">${aiRow.askLabel ? `<button type="button" class="btn small" data-av-ask>🖼 ${esc(aiRow.askLabel)}</button>` : ''}<button type="button" class="link small" data-av-revert hidden>換回上一張</button></div>` : ''}
          <div class="seg-scope full" role="group" aria-label="頭像類型">
            <button type="button" data-mode="img">上傳圖片</button>
            <button type="button" data-mode="text">文字／表情符號</button>
          </div>
          <div id="av-img-pane">
            <input type="file" id="av-file" accept="image/png,image/jpeg,image/webp" hidden>
            <button type="button" class="av-drop" id="av-drop">
              <b>拖曳圖片到這裡，或點一下選擇檔案</b>
              <span class="muted small">png、jpg、webp · 5 MB 以內 · 至少 128 × 128 px</span>
            </button>
            <div class="av-crop-wrap" id="av-crop-wrap" hidden>
              <div class="av-crop" id="av-crop"><img id="av-img" alt="" draggable="false"><span class="av-mask ${shape}"></span></div>
              <span class="muted small">拖曳圖片調整位置</span>
              <label class="av-zoom">縮放<input type="range" id="av-zoom" min="1" max="3" step="0.01" value="1"></label>
              <button type="button" class="btn small" id="av-repick">重新選擇</button>
            </div>
            <div class="warn-box red" id="av-err" role="alert" hidden></div>
            <button type="button" class="link danger-text" id="av-remove" hidden>移除圖片，改回文字頭像</button>
          </div>
          <label id="av-text-pane" hidden>頭像文字
            <input id="av-text" maxlength="16" placeholder="留白＝${esc(fallback)}" value="${esc(cur.text || '')}">
            <span class="field-hint">最多 2 個字，可用表情符號。</span>
          </label>
          <p class="muted small">頭像會裁成正方形、縮成 256 × 256 px 後儲存，不會在 1 小時後刪除。請勿使用含客戶個資的圖片。</p>`,
        foot: `<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="button" data-ok>儲存</button>`,
      });
      document.body.append(host);
      const $ = s => host.querySelector(s);
      if (aiRow?.prevPath) api(aiRow.prevPath).then(d => { const b = $('[data-av-revert]'); if (b) b.hidden = !d.hasPrev; }).catch(() => {});
      const st = { mode: cur.imgUrl || !cur.text ? 'img' : 'text', img: null, w: 0, h: 0, zoom: 1, ox: 0, oy: 0, removed: false };
      const D = 200, BOX = 240;
      const geom = () => {
        const sc = D / Math.min(st.w, st.h) * st.zoom, W = st.w * sc, H = st.h * sc;
        const mx = (W - D) / 2, my = (H - D) / 2;
        st.ox = Math.max(-mx, Math.min(mx, st.ox)); st.oy = Math.max(-my, Math.min(my, st.oy));
        return { sc, W, H, left: BOX / 2 - W / 2 + st.ox, top: BOX / 2 - H / 2 + st.oy };
      };
      const crop = type => {
        const g = geom(), c = document.createElement('canvas');
        c.width = c.height = 256;
        const sx = (g.W / 2 - st.ox - D / 2) / g.sc, sy = (g.H / 2 - st.oy - D / 2) / g.sc, ss = D / g.sc;
        c.getContext('2d').drawImage(st.img, sx, sy, ss, ss, 0, 0, 256, 256);
        return type === 'url' ? c.toDataURL('image/webp', 0.9) : new Promise(r => c.toBlob(b => r(b), 'image/webp', 0.9));
      };
      // 合併同一輪的多次重畫（不用 requestAnimationFrame：背景分頁不會觸發）
      let pending = 0;
      const draw = () => {
        clearTimeout(pending);
        pending = setTimeout(() => {
          host.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === st.mode)));
          $('#av-img-pane').hidden = st.mode !== 'img';
          $('#av-text-pane').hidden = st.mode !== 'text';
          $('#av-drop').hidden = !!st.img;
          $('#av-crop-wrap').hidden = !st.img;
          $('#av-remove').hidden = !(st.mode === 'img' && cur.imgUrl && !st.removed && !st.img);
          if (st.img) {
            const g = geom(), im = $('#av-img');
            Object.assign(im.style, { width: g.W + 'px', height: g.H + 'px', left: g.left + 'px', top: g.top + 'px' });
          }
          const url = st.mode === 'img' ? (st.img ? crop('url') : (!st.removed && cur.imgUrl) || '') : '';
          const text = [...($('#av-text').value.trim() || fallback)].slice(0, 2).join('');
          host.querySelectorAll('.av-prev').forEach(el => {
            el.textContent = url ? '' : text;
            el.style.backgroundImage = url ? `url("${url}")` : '';
            el.classList.toggle('img-on', !!url);
          });
          $('[data-ok]').disabled = st.mode === 'img' && !st.img && (!cur.imgUrl || st.removed);
        });
      };
      const err = msg => { $('#av-err').hidden = !msg; $('#av-err').textContent = msg || ''; };
      const load = file => {
        if (!file) return;
        if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return err(`不支援「${file.name.split('.').pop()}」格式，請改用 png、jpg 或 webp。`);
        if (file.size > 5 * 1024 * 1024) return err(`檔案 ${(file.size / 1048576).toFixed(1)} MB，超過 5 MB 上限。`);
        const url = URL.createObjectURL(file), img = new Image();
        img.onload = () => {
          if (img.width < 128 || img.height < 128) { URL.revokeObjectURL(url); return err(`圖片只有 ${img.width} × ${img.height} px，至少需要 128 × 128 px。`); }
          Object.assign(st, { img, w: img.width, h: img.height, zoom: 1, ox: 0, oy: 0 });
          $('#av-img').src = url; $('#av-zoom').value = 1;
          err(''); draw();
        };
        img.onerror = () => err('圖片無法讀取，檔案可能已損毀。');
        img.src = url;
      };
      host.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { st.mode = b.dataset.mode; err(''); draw(); }));
      $('#av-drop').addEventListener('click', () => $('#av-file').click());
      $('#av-repick').addEventListener('click', () => $('#av-file').click());
      $('#av-file').addEventListener('change', e => { load(e.target.files[0]); e.target.value = ''; });
      const drop = $('#av-drop');
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); load(e.dataTransfer.files[0]); });
      const area = $('#av-crop');
      let drag = null;
      area.addEventListener('pointerdown', e => { area.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, ox: st.ox, oy: st.oy }; });
      area.addEventListener('pointermove', e => { if (!drag) return; st.ox = drag.ox + e.clientX - drag.x; st.oy = drag.oy + e.clientY - drag.y; draw(); });
      const up = () => { drag = null; };
      area.addEventListener('pointerup', up); area.addEventListener('pointercancel', up);
      $('#av-zoom').addEventListener('input', e => { st.zoom = parseFloat(e.target.value); draw(); });
      $('#av-text').addEventListener('input', draw);
      $('#av-remove').addEventListener('click', () => { st.removed = true; st.mode = 'text'; draw(); });
      const done = v => { host.remove(); if (prev?.isConnected) prev.focus(); resolve(v); };
      const overlay = host.firstElementChild;
      holdBackdrop(overlay);
      overlay.addEventListener('click', async e => {
        if (e.target.closest('[data-ok]')) {
          const text = $('#av-text').value.trim();
          if (st.mode === 'img' && st.img) return done({ kind: 'img', blob: await crop('blob'), url: crop('url'), text: cur.text || '' });
          if (st.mode === 'img') return done({ kind: 'keep' });
          return done({ kind: 'text', text, removeImg: !!cur.imgUrl });
        }
        if (e.target.closest('[data-av-ask]')) return done({ kind: 'ask' });
        if (e.target.closest('[data-av-revert]')) return done({ kind: 'revert' });
        if (e.target.closest('[data-close]')) done(null);
      });
      overlay.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
      draw();
      host.querySelector(`[data-mode="${st.mode}"]`).focus();
    });
  }

  // 套用到自己
  async function changeMyAvatar() {
    const cur = { text: state.me.avatar || '', imgUrl: state.me.avatarImg ? await avatarUrl(meId(), state.me.avatarImg) : null };
    const human = state.me.memberType === 'human';
    const aiRow = human ? { askLabel: myAisForAvatar().length ? '請我的 AI 幫我做' : '', prevPath: '/api/me/avatar/prev' } : null;
    const r = await avatarDialog({ title: '更換頭像', isAi: state.me.memberType === 'ai', fallback: [...(state.me.name || '人')][0], cur, aiRow });
    if (!r || r.kind === 'keep') return;
    if (r.kind === 'ask') return askAvatar(myAisForAvatar(), '幫我做一個頭像：');
    if (r.kind === 'revert') { try { await afterAvatar(await api('/api/me/avatar/revert', { method: 'POST' })); toast('已換回上一張頭像'); } catch (err) { toast(err.message); } return; }
    try {
      let me;
      if (r.kind === 'img') {
        const res = await fetch('/api/me/avatar', { method: 'PUT', headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': r.blob.type }, body: r.blob });
        me = await res.json();
        if (!res.ok) throw new Error(me?.error?.message || `HTTP ${res.status}`);
      } else {
        if (r.removeImg) await api('/api/me/avatar', { method: 'DELETE' });
        me = await api('/api/me', { method: 'PATCH', body: { avatar: r.text } });
      }
      await afterAvatar(me);
      toast('頭像已更新');
    } catch (err) { toast(err.message); }
  }
  async function afterAvatar(me) {
    Object.assign(state.me, { avatar: me.avatar, avatarImg: me.avatarImg });
    drawMe();
    await loadParticipants();
    renderMessages(false);
    document.querySelectorAll('#set-avatar').forEach(el => { el.innerHTML = avatar(state.me); });
  }

  // ---------- 工作卡片（第一階段） ----------
  const CARD_ST = ['待整理', '待處理', '進行中', '待確認', '受阻', '已完成', '已封存'];
  const PAGE_KEY = 'aigile-switch-page';
  const VIEW_KEY = 'aigile-switch-work-view';
  const work = {
    cards: new Map(), since: null, loaded: false, lastSync: 0,
    view: store.get(VIEW_KEY) === 'B' ? 'B' : 'A', sel: new Set(), q: '', owner: '', type: '', filter: 'open', mCol: '進行中',
    showArchived: false, openId: null, detail: null, editing: false, dragId: null,
  };
  const isMeRef = r => r && r.participantId === meId();
  const closedSt = s => s === '已完成' || s === '已封存';
  const stPill = s => `<span class="cst" data-st="${esc(s)}">${esc(s)}</span>`;
  const NOTE = '人類紀錄'; // C-218：人類記內容，AI 不主動看到（給卡號才讀）
  const typeTag = c => (c.type !== '工作' && c.type !== NOTE ? `<span class="ctype" data-ty="${esc(c.type)}">${esc(c.type)}</span>` : '');
  const cidHtml = c => `<span class="cid">${c.type === NOTE ? '<span aria-label="人類紀錄">🔒</span> ' : ''}${esc(c.cardId)}</span>`;
  const mergedHtml = c => (c.mergedInto ? `<button type="button" class="merged-into" data-card="${esc(c.mergedInto)}">已整理 · 已整理到 ${esc(c.mergedInto)}</button>` : '');
  // C-226：人類紀錄只有「收集中」「已整理」兩種狀態
  const noteStText = c => (c.status === '已完成' ? '已整理' : c.status === '已封存' ? '已封存' : '收集中');
  const noteStPill = c => `<span class="cst" data-st="${esc(c.status)}">${noteStText(c)}</span>`;
  const waitText = c => (c.waitFor ? `等 ${isMeRef(c.waitFor) ? '你' : c.waitFor.name}${c.blocker ? '：' + c.blocker : ''}` : c.blocker || '');
  const staleTag = c => (c.staleHint ? `<span class="cmark stale" title="最後更新 ${esc(shortTime(c.staleHint.lastUpdatedAt))} · 最新相關訊息 ${esc(shortTime(c.staleHint.latestMessageAt))}">可能過時</span>` : '');
  const doneTitle = c => [c.done ? `完成：${c.done.by?.name || ''} ${shortTime(c.done.at)}` : '', c.verified ? `驗收：${c.verified.by?.name || ''} ${shortTime(c.verified.at)}` : ''].filter(Boolean).join(' · ');
  const markHtml = c => (c.verified ? `<span class="cmark ok" title="${esc(doneTitle(c))}">✓ 已驗收</span>` : c.done ? `<span class="cmark wait" title="${esc(doneTitle(c))}">待驗收</span>` : '') + staleTag(c);
  // C-161 卡片瘦身：已完成＋已驗證滿 7 天由伺服器自動封存；未驗證不封存，超過 7 天標紅
  const ARCHIVE_DAYS = 7, DAY_MS = 86400_000;
  const archiveLeftMs = c => new Date(c.verified?.at || c.done?.at || c.updatedAt).getTime() + ARCHIVE_DAYS * DAY_MS - Date.now();
  const pendingDays = c => Math.floor((Date.now() - new Date(c.done?.at || c.updatedAt).getTime()) / DAY_MS);
  const mmdd = iso => { const d = new Date(iso); return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`; };
  const doneTag = c => (c.status !== '已完成' ? '' : !c.verified
    ? (pendingDays(c) > ARCHIVE_DAYS ? `<span class="pill-tag red">待驗證 ${pendingDays(c)} 天</span>` : '<span class="pill-tag yellow">待驗證</span>')
    : archiveLeftMs(c) < DAY_MS ? '<span class="pill-tag grey">明天收起</span>' : '');
  const archTag = c => (c.status === '已封存' ? `<span class="pill-tag grey">已封存 ${mmdd(c.updatedAt)}</span>` : '');
  // 已封存的卡不預先載入：按「已封存」才分頁拿（每次 50 張）；數字來自伺服器 counts
  work.archived = { count: 0, loaded: 0, hasMore: false, fetched: false, loading: false };
  work.archSearch = { q: '', items: [], open: false, timer: null };
  async function loadArchived(more = false) {
    const a = work.archived;
    if (a.loading) return;
    a.loading = true;
    try {
      const d = await api(`/api/cards?status=${encodeURIComponent('已封存')}&limit=50&offset=${more ? a.loaded : 0}`);
      for (const c of d.items) work.cards.set(c.cardId, c);
      a.loaded = (more ? a.loaded : 0) + d.items.length; a.hasMore = d.hasMore; a.fetched = true;
    } finally { a.loading = false; }
  }
  const refreshArchivedCount = () => api('/api/cards?limit=1&counts=1').then(d => { work.archived.count = d.counts?.archived ?? work.archived.count; }).catch(() => {});
  // 搜尋有字時一併搜已封存（另一組、預設收合）
  function searchArchived() {
    const q = work.q.trim(), sa = work.archSearch;
    clearTimeout(sa.timer);
    if (!q) { sa.q = ''; sa.items = []; return; }
    sa.timer = setTimeout(async () => {
      try {
        const d = await api(`/api/cards?status=${encodeURIComponent('已封存')}&q=${encodeURIComponent(q)}&limit=50`);
        if (work.q.trim() !== q) return;
        sa.q = q; sa.items = d.items.filter(cardInView);
        renderWork();
      } catch {}
    }, 300);
  }
  const shortTime = iso => fmtTime(iso).replace(/^\d{4}\//, '').replace(/(\d\d:\d\d):\d\d$/, '$1');
  function ownerHtml(c) {
    if (!c.owner) return '<span class="cowner none">未指派</span>';
    const p = state.participants.get(c.owner.participantId) || c.owner;
    return `<span class="cowner">${avatar(p)}<span>${esc(c.owner.name)}</span></span>`;
  }

  const optionsOf = c => (c.decision?.options?.length ? c.decision.options : ['同意']);
  // 這張決策卡現在是在等「我」做決定
  const decidingMe = c => c.type === '決策' && c.status === '待確認' && !c.decision?.result && c.decision?.decider?.participantId === meId() && isMeRef(c.waitFor);
  // C-242：「待確認」分兩種——決策卡＝等決定（黃）；AI 交給人類的卡＝等驗收（綠）
  const verifyingMe = c => c.status === '待確認' && c.type !== '決策' && c.type !== NOTE && state.me?.memberType === 'human' && (isMeRef(c.waitFor) || (!c.waitFor && c.owner?.participantId === meId()));
  function confirmPill(c) {
    if (c.status !== '待確認' || c.type === NOTE) return '';
    const dec = c.type === '決策', who = dec ? (c.decision?.decider || c.waitFor) : (c.waitFor || c.owner);
    const mine = who?.participantId === meId(), act = dec ? '決定' : '驗收';
    return `<span class="cfm-pill ${dec ? 'dec' : 'ver'}">${mine ? `等你${act}` : `等${who?.name ? ' ' + esc(who.name) + ' ' : ''}${act}`}</span>`;
  }
  // 驗收通過＝標已完成（人類完成即驗收）；退回＝填原因，卡回到交過來的 AI
  async function acceptCard(id) { const r = await patchCard(id, { status: '已完成' }); if (r) { toast(`${id} 驗收通過`); loadTeam().then(() => { updateTodoBadge(); if (state.page === 'inbox') renderWork(); }).catch(() => {}); } }
  async function rejectCard(id) {
    const c = work.cards.get(id);
    const reason = await promptReason(`退回 ${id}？`, '退回原因（會回覆到交接訊息，交過來的 AI 會收到）');
    if (!reason) return;
    try {
      const r = await api(`/api/cards/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { reason, version: c?.version } });
      work.cards.set(id, r);
      renderWork();
      if (work.openId === id) openCard(id);
      toast(`已退回給 ${r.owner?.name || 'AI'}`);
      updateTodoBadge();
    } catch (err) { toast(err.message); }
  }
  function promptReason(title, label) {
    return new Promise(resolve => {
      const host = document.createElement('div');
      host.className = 'confirm-root';
      host.innerHTML = modalFrame({ title, size: 'narrow', body: `<label class="field"><span class="field-label">${esc(label)}</span><textarea autocomplete="off" autocorrect="on" id="rj-input" rows="3" maxlength="500"></textarea></label><p class="error" id="rj-err" role="alert"></p>`,
        foot: '<button class="btn" type="button" data-rj="0">取消</button><button class="btn primary" type="button" data-rj="1">退回</button>' });
      document.body.appendChild(host);
      const input = host.querySelector('#rj-input');
      input.focus();
      const done = ok => { const v = input.value.trim(); if (ok && !v) { host.querySelector('#rj-err').textContent = '請寫退回原因'; return input.focus(); } host.remove(); resolve(ok ? v : null); };
      holdBackdrop(host.firstElementChild);
      host.addEventListener('click', e => { const b = e.target.closest('[data-rj]'); if (b) done(b.dataset.rj === '1'); else if (e.target.closest('[data-close]')) done(false); });
      host.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
    });
  }
  // [需確認] 訊息裡提到「正在等我決定的決策卡」→ 以決策卡為準，訊息不再單獨列出（C-139）
  const cardOfConfirm = d => {
    const text = state.byId.get(d.messageId)?.text || d.title || '';
    for (const id of text.match(/C-\d+/g) || []) { const c = work.cards.get(id); if (c && (decidingMe(c) || (c.decision?.deferred && c.decision.decider?.participantId === meId()))) return c; }
    return null;
  };
  work.note = null; // { id, kind: '不同意' | '要求補充', text }
  // ---------- C-130 行內輸入：待你處理清單與卡片抽屜共用同一個元件 ----------
  // key 前綴：m:訊息編號（[需確認] 訊息）、c:卡號（決策卡）、s:建議編號、k:卡號（一般卡片）
  work.drafts = {};      // key → 草稿，切換項目不遺失
  work.openInl = null;   // 手機一次只展開一項
  const narrowInl = () => matchMedia('(max-width: 600px)').matches;
  const inlBtn = (key, act, label, { cls = '', need = false, primary = false, result = '' } = {}) =>
    `<button type="button" class="btn small ${cls}" data-inl-act="${act}" data-inl="${esc(key)}" ${result ? `data-result="${esc(result)}"` : ''} data-need="${need ? 1 : 0}" ${primary ? 'data-primary="1"' : ''} ${need && !(work.drafts[key] || '').trim() ? 'disabled' : ''}>${label}</button>`;
  function inlineHtml(key, kind, c) {
    if (narrowInl() && work.openInl !== key) return `<button type="button" class="btn small inl-open" data-inl-open="${esc(key)}">回覆…</button>`;
    let btns = '', hint = '想說什麼都可以寫在這裡（Ctrl+Enter 送出）';
    if (kind === 'confirm') btns = inlBtn(key, 'send', '送出', { cls: 'primary', need: true, primary: true });
    else if (kind === 'card') { const n = cardRecipients(key, c).length; btns = inlBtn(key, 'send', cardSendLabel(n), { cls: n ? 'primary' : 'quiet', need: true, primary: true }) + `<button type="button" class="btn small" data-inl-at="${esc(key)}">＠ 加人</button>`; }
    else if (kind === 'sugg') {
      hint = '想說明或留言給提案的 AI（Ctrl+Enter 留言）';
      btns = inlBtn(key, 'sugg-note', '只留言', { need: true, primary: true }) + inlBtn(key, 'sugg-skip', '略過並附原因', { need: true });
    } else if (kind === 'decision') {
      hint = '說明可選填；不同意或要求補充一定要寫；先擱著可寫原因（Ctrl+Enter 只留言）';
      btns = optionsOf(c).map((o, i) => inlBtn(key, 'decide', `決定「${esc(o)}」`, { cls: i === 0 ? 'ok' : '', result: o })).join('')
        + inlBtn(key, 'opinion', '只留言，不決定', { need: true, primary: true })
        + inlBtn(key, 'decide', '不同意', { need: true, result: '不同意' })
        + inlBtn(key, 'decide', '要求補充', { need: true, result: '要求補充' })
        + inlBtn(key, 'defer', '先擱著（暫緩）');
    }
    return `<div class="inl" data-inl-root="${esc(key)}">
      <div class="inl-field"><textarea autocomplete="off" autocorrect="on" class="inl-text" rows="2" maxlength="1500" data-inl-text="${esc(key)}" placeholder="${kind === 'card' ? '想說什麼都可以寫在這裡，打 @ 可以指定人（Ctrl+Enter 送出）' : hint}" aria-label="輸入想法">${esc(work.drafts[key] || '')}</textarea>
        ${kind === 'card' ? '<ul class="mention-list" role="listbox" aria-label="選擇成員" hidden></ul>' : ''}</div>
      ${kind === 'card' ? cardToHtml(key, c) : ''}
      <div class="inl-actions">${btns}</div>
      ${kind === 'decision' ? '<p class="muted small inl-note">留言會通知提案人；先擱著會移出收件匣，之後可在工作頁恢復。</p>' : ''}
      <p class="error small" data-inl-err="${esc(key)}" role="alert"></p></div>`;
  }
  const decisionActions = c => inlineHtml('c:' + c.cardId, 'decision', c);
  // C-162：卡片回覆的收件人
  work.inlRm = {}; // key → 使用者按 × 移除的成員
  const cardMembers = c => [...state.participants.values()].filter(p => p.status !== 'disabled' && (p.projects || []).includes(c.project));
  const cardMentionCandidates = c => raw => { const q = raw.toLowerCase(); return cardMembers(c).map(p => ({ ...p, role: roleIn(p, c.project) })).filter(p => p.participantId !== meId() && (!q || p.name.toLowerCase().includes(q) || (p.role || '').toLowerCase().includes(q))); };
  function cardRecipients(key, c) {
    const text = work.drafts[key] || '', out = new Map();
    const add = (id, why) => { if (id && id !== meId() && !out.has(id)) out.set(id, why); };
    const members = cardMembers(c);
    for (const tok of text.match(/@[^\s@]+/g) || []) {
      const name = tok.slice(1).replace(/[，。、,.!?！？：:；;）)」]+$/, '');
      const p = members.find(x => x.name === name);
      if (p) add(p.participantId, '你 @ 的');
    }
    add(c.owner?.participantId, '負責人');
    add(c.waitFor?.participantId, '等誰');
    if (!c.owner) add(c.createdBy?.participantId, '建卡人');
    const rm = work.inlRm[key] || new Set();
    return [...out].filter(([id]) => !rm.has(id)).map(([id, why]) => ({ id, why, name: state.participants.get(id)?.name || '?' }));
  }
  function cardToHtml(key, c) {
    const to = cardRecipients(key, c);
    return `<div class="inl-to" data-inl-to="${esc(key)}"><span class="muted small">會通知：</span>${to.length
      ? to.map(r => `<span class="to-chip"><b>${esc(r.name)}</b><span class="muted small">${esc(r.why)}</span><button type="button" class="to-x" data-inl-rm="${esc(r.id)}" data-inl="${esc(key)}" aria-label="不通知 ${esc(r.name)}">×</button></span>`).join('')
      : `<span class="muted small">沒有人（${isMeRef(c.owner) ? '你是負責人' : c.owner ? '負責人已移除' : '沒有負責人'}，${c.waitFor ? '等誰已移除' : '也沒有等誰'}）</span>`}</div>`;
  }
  const cardSendLabel = n => (n ? `送出並通知 ${n} 人` : '只留紀錄，不通知');
  function refreshCardTo(key) {
    const c = work.cards.get(key.slice(2)), root = document.querySelector(`[data-inl-root="${CSS.escape(key)}"]`);
    if (!c || !root) return;
    root.querySelector('[data-inl-to]').outerHTML = cardToHtml(key, c);
    const b = root.querySelector('[data-inl-act="send"]'), n = cardRecipients(key, c).length;
    if (b && !b.textContent.includes('送出中')) { b.textContent = cardSendLabel(n); b.classList.toggle('primary', !!n); b.classList.toggle('quiet', !n); }
  }

  function inlineInput(e) {
    const ta = e.target.closest?.('[data-inl-text]');
    if (!ta) return false;
    work.drafts[ta.dataset.inlText] = ta.value;
    const root = ta.closest('.inl');
    root.querySelectorAll('[data-need="1"]').forEach(b => { b.disabled = !ta.value.trim(); });
    if (ta.dataset.inlText.startsWith('k:')) refreshCardTo(ta.dataset.inlText);
    return true;
  }
  function inlineKey(e) {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || !e.target.matches?.('[data-inl-text]')) return;
    e.preventDefault();
    const b = e.target.closest('.inl')?.querySelector('[data-primary="1"]');
    if (b && !b.disabled) b.click();
  }
  function inlineClick(e) {
    const open = e.target.closest?.('[data-inl-open]');
    if (open) {
      work.openInl = open.dataset.inlOpen;
      renderWork(); if (work.openId) renderDrawer(false);
      const ta = document.querySelector(`[data-inl-text="${CSS.escape(work.openInl)}"]`);
      if (ta) { ta.focus(); ta.scrollIntoView({ block: 'center' }); }
      return true;
    }
    const rmb = e.target.closest?.('[data-inl-rm]');
    if (rmb) { const k = rmb.dataset.inl; (work.inlRm[k] ||= new Set()).add(rmb.dataset.inlRm); refreshCardTo(k); return true; }
    const at = e.target.closest?.('[data-inl-at]');
    if (at) {
      const ta = document.querySelector(`[data-inl-text="${CSS.escape(at.dataset.inlAt)}"]`);
      if (ta) { const p = ta.selectionStart ?? ta.value.length, pre = ta.value.slice(0, p), sep = pre && !/\s$/.test(pre) ? ' ' : ''; ta.value = pre + sep + '@' + ta.value.slice(p); ta.focus(); const c2 = p + sep.length + 1; ta.setSelectionRange(c2, c2); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.openMention?.(); }
      return true;
    }
    const b = e.target.closest?.('[data-inl-act]');
    if (!b) return false;
    if (!b.disabled) inlineAct(b);
    return true;
  }
  async function inlineAct(btn) {
    const key = btn.dataset.inl, act = btn.dataset.inlAct, id = key.slice(2), root = btn.closest('.inl');
    const text = (work.drafts[key] || '').trim();
    const errEl = root.querySelector('[data-inl-err]');
    const label = btn.textContent;
    errEl.textContent = '';
    root.querySelectorAll('button, textarea').forEach(x => { x.disabled = true; });
    btn.textContent = '送出中…';
    const post = body => postMsg({ requestId: newRequestId(), ...body });
    const others = ids => [...new Set(ids)].filter(x => x && x !== meId());
    try {
      if (act === 'send' && key.startsWith('m:')) {
        let m = state.byId.get(id); if (!m) m = await api(`/api/messages/${encodeURIComponent(id)}`);
        await post({ text: `[回覆] ${text}`, replyToMessageId: id, recipientIds: others([m.author.participantId]) });
      } else if (act === 'send') { // 一般卡片（C-162）：照「會通知」名單——@ 的人＋負責人＋等誰（沒負責人改建卡人），可移除
        const c = work.cards.get(id), to = c ? cardRecipients(key, c) : [];
        await post({ text: `[回覆] ${id}：${text}`, cardId: id, recipientIds: to.map(r => r.id) });
        delete work.inlRm[key];
        work.sentTo = to.length ? `已送出，通知 ${to.map(r => r.name).join('、')}` : '已送出（只留紀錄，沒有通知任何人）';
      } else if (act === 'opinion') { // 決策卡只送意見：給提案人，卡片狀態不變
        const c = work.cards.get(id);
        await post({ text: `[回覆] ${id}（決策意見）：${text}`, cardId: id, recipientIds: others([c?.decision?.proposer?.participantId]) });
      } else if (act === 'decide') {
        const c = work.cards.get(id), result = btn.dataset.result;
        if (['不同意', '要求補充'].includes(result) && !text) throw new Error('請先寫說明');
        const r = await api(`/api/cards/${encodeURIComponent(id)}/decide`, { method: 'POST', body: { result, note: text, version: c?.version } });
        work.cards.set(id, r);
        toast(result === '要求補充' ? `已請 ${r.waitFor?.name || '提案人'} 補充` : `已記錄決定：${result}`);
      } else if (act === 'defer') {
        const c = work.cards.get(id);
        work.cards.set(id, await api(`/api/cards/${encodeURIComponent(id)}/defer`, { method: 'POST', body: { reason: text, version: c?.version } }));
        toast('已暫緩，會從收件匣移出；要繼續請到「工作」按「恢復」');
      } else if (act === 'sugg-note' || act === 'sugg-skip') {
        const g = (work.sugg || []).find(x => x.suggestionId === id);
        if (!g) throw new Error('這則建議已經被處理過了');
        const what = g.kind === 'create' ? `建立卡片「${g.create.title}」` : `${g.card?.cardId || ''} 狀態改為「${g.to}」`;
        if (act === 'sugg-skip') await api(`/api/suggestions/${encodeURIComponent(id)}/skip`, { method: 'POST', body: {} });
        await post({ text: `[回覆] ${act === 'sugg-skip' ? '略過了你的建議' : '關於你的建議'}（${what}）：${text}`, ...(g.card?.cardId ? { cardId: g.card.cardId } : {}), recipientIds: others([g.from?.participantId]) });
      }
      delete work.drafts[key]; work.openInl = null;
      if (act !== 'decide' && act !== 'defer') toast(work.sentTo || '已送出');
      work.sentTo = null;
      await Promise.all([loadTeam().catch(() => {}), syncCards().catch(() => {})]);
      updateTodoBadge(); renderWork();
      if (work.openId) openCard(work.openId);
    } catch (err) {
      root.querySelectorAll('button, textarea').forEach(x => { x.disabled = false; });
      root.querySelectorAll('[data-need="1"]').forEach(x => { x.disabled = !(work.drafts[key] || '').trim(); });
      btn.textContent = label;
      errEl.textContent = '送出失敗：' + err.message + '（內容還在，可以再試一次）';
    }
  }
  function decisionBox(c) {
    const d = c.decision;
    return `<div class="dbox"><span class="small muted strong">建議方案</span><span>${esc(d.recommendation || '未提供')}</span></div>
      <dl class="dfields compact"><dt>提案人</dt><dd>${esc(d.proposer?.name || '—')}</dd><dt>決策者</dt><dd>${esc(d.decider?.name || '—')}</dd>
        <dt>影響</dt><dd>${esc(d.impact || '—')}</dd><dt>決定後</dt><dd>${esc(d.afterNext || '—')}</dd></dl>`;
  }
  function decisionStatus(c) {
    const d = c.decision;
    if (d.result) return `<div class="dresult"><b>決定：${esc(d.result)}</b><span class="muted small">${esc(d.by?.name || '')} · ${shortTime(d.at)}${d.note ? ' · ' + esc(d.note) : ''}</span></div>`;
    if (d.deferred) {
      const mine = [d.decider?.participantId, d.proposer?.participantId].includes(meId());
      return `<div class="dresult"><b>暫緩中</b><span class="muted small">${esc(c.blocker)}</span>${mine ? `<button type="button" class="btn small primary" data-resume="${esc(c.cardId)}">恢復</button>` : ''}</div>`;
    }
    if (decidingMe(c)) return decisionActions(c);
    if (c.status !== '待確認') return '';
    const who = c.waitFor?.name || d.decider?.name;
    return `<p class="muted small">${c.waitFor && c.waitFor.participantId !== d.decider?.participantId ? `已請 ${esc(who)} 補充後，再回到 ${esc(d.decider?.name || '決策者')} 決定。` : `等 ${esc(who)} 決定。`}</p>`;
  }

  async function loadCards() {
    const d = await api('/api/cards?limit=200&counts=1'); // C-161：預設不載入已封存
    work.cards = new Map(d.items.map(c => [c.cardId, c]));
    work.archived = { count: d.counts?.archived ?? 0, loaded: 0, hasMore: false, fetched: false, loading: false };
    work.since = d.nextSince;
    work.loaded = true;
    work.lastSync = Date.now();
    drawAiNow(); // C-256：卡片到了，「在做」才準
    await loadSuggestions();
  }
  async function loadSuggestions() {
    work.sugg = (await api('/api/suggestions?state=pending')).items;
    updateTodoBadge();
  }
  // 增量同步：只讀上次之後有變動的卡片
  async function syncCards() {
    if (!work.loaded) return;
    work.lastSync = Date.now();
    const [d, sg] = await Promise.all([api('/api/cards?since=' + encodeURIComponent(work.since || '')), api('/api/suggestions?state=pending')]);
    const suggChanged = JSON.stringify(sg.items.map(x => x.suggestionId)) !== JSON.stringify((work.sugg || []).map(x => x.suggestionId));
    work.sugg = sg.items;
    updateTodoBadge();
    if (!d.items.length && !suggChanged) return;
    const archMoved = d.items.some(c => c.status === '已封存' || work.cards.get(c.cardId)?.status === '已封存');
    for (const c of d.items) work.cards.set(c.cardId, c);
    if (d.items.length) { work.since = d.nextSince; drawAiNow(); }
    if (archMoved) await refreshArchivedCount(); // 有卡被封存或重新打開，已封存數字跟著更新
    renderWork();
    if (state.page === 'messages' && d.items.length) { const box = $('#messages'), top = box.scrollTop; renderMessages(false); box.scrollTop = top; }
    if (work.openId && d.items.some(c => c.cardId === work.openId) && !work.editing) openCard(work.openId);
  }

  // AI 建議區塊
  function suggHtml(batch = false) {
    const list = (work.sugg || []).filter(x => inView(x.project));
    if (!list.length) return '';
    for (const id of [...work.sel]) if (!list.some(g => g.suggestionId === id)) work.sel.delete(id);
    const batchBar = batch ? `<div class="batch-bar" role="group" aria-label="批次處理"><span class="small">已選 <b>${work.sel.size}</b> 則</span><button type="button" class="btn small primary" data-batch="apply" ${work.sel.size ? '' : 'disabled'}>批次採用</button><button type="button" class="btn small" data-batch="skip" ${work.sel.size ? '' : 'disabled'}>批次略過</button><span class="muted small">逐則勾選後才能批次處理，不提供一鍵全部採用</span></div>` : '';
    const what = g => (g.kind === 'create'
      ? `建立${g.create.type}卡片「${esc(g.create.title)}」，負責人 ${esc(g.create.owner?.name || '未指派')}`
      : `${esc(g.card?.cardId || '')} ${esc(g.card?.title || '')} 狀態改為「${esc(g.to)}」${g.waitFor ? `，等 ${esc(g.waitFor.name)}` : ''}`);
    return `<section class="wsugg"><div class="wsugg-head"><span class="wdot sg"></span><h3>AI 建議</h3><span class="wcount pur">${list.length}</span><span class="muted small">由你採用後才會建立或更新卡片</span></div>
      ${batchBar}
      ${list.map(g => `<div class="sugg-row${g.expired ? ' expired' : ''}" data-sugg-row="${esc(g.suggestionId)}">
        ${batch ? `<label class="sugg-check"><input type="checkbox" data-sugg-check="${esc(g.suggestionId)}" ${work.sel.has(g.suggestionId) ? 'checked' : ''} aria-label="勾選這則建議"></label>` : ''}
        <div class="sugg-main"><div class="sugg-top"><span class="sgk">${g.kind === 'create' ? '建立卡片' : '更新狀態'}</span>${g.expired ? '<span class="cmark stale" title="這張卡在建議之後已有變動，只能略過">已過期</span>' : ''}<span class="muted small">${esc(g.from?.name || '')}</span></div>
          <b>${what(g)}</b><span class="small">${esc(g.why)}</span>
          ${g.basisMessageId ? `<button type="button" class="link small" data-sugg-basis="${esc(g.basisMessageId)}">看依據訊息</button>` : ''}</div>
        <div class="sugg-actions">
          ${g.expired ? '' : `<button type="button" class="btn small primary" data-sugg-apply="${esc(g.suggestionId)}">採用</button>`}
          ${g.kind === 'create' ? `<button type="button" class="btn small" data-sugg-edit="${esc(g.suggestionId)}">編輯後採用</button>` : ''}
          <button type="button" class="link small" data-sugg-skip="${esc(g.suggestionId)}">略過</button></div>
        ${inlineHtml('s:' + g.suggestionId, 'sugg', g)}
      </div>`).join('')}</section>`;
  }
  async function suggAction(id, action, body) {
    try {
      const r = await api(`/api/suggestions/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: body || {} });
      if (action === 'apply') { work.cards.set(r.cardId, r); toast(`已採用，${r.cardId} ${r.status}`); }
      else toast('已略過建議');
      await loadSuggestions();
      renderWork();
      return r;
    } catch (err) {
      toast(err.message);
      if (err.code === 'NOT_PENDING') { await loadSuggestions().catch(() => {}); renderWork(); }
      return null;
    }
  }

  work.teamTab = 'status';
  function renderTeamPage() {
    const box = $('#page-work');
    // C-157：看板會在共用容器加 is-board（桌面版 overflow:hidden），切到團隊頁要清掉，否則滾輪捲不動
    box.classList.remove('is-board');
    // 同一個分頁重畫（例如切專案）時保留捲動位置，不跳回頂端
    const keep = work.teamScrollTab === work.teamTab ? box.scrollTop : 0;
    work.teamScrollTab = work.teamTab;
    if (work.teamTab === 'ai') work.teamTab = 'status'; // C-182：我的 AI 移到頭像選單
    const tabs = [['status', '團隊狀態'], ['memory', 'AI 工作記憶'], ['members', '成員名單']];
    box.innerHTML = `<div class="work-head"><div class="work-title"><h2>團隊</h2></div>
      <div class="seg-scope" role="group" aria-label="團隊分頁">${tabs.map(([k, t]) => `<button type="button" data-team-tab="${k}" aria-pressed="${work.teamTab === k}">${t}</button>`).join('')}</div></div>
      <div id="team-pane" class="inline-pane"></div>`;
    const done = ({ status: openTeam, memory: openTeamMemory, members: openMembers })[work.teamTab]();
    if (keep) Promise.resolve(done).then(() => { box.scrollTop = keep; });
    syncTeamNav();
  }
  // AI 工作記憶（獨立一個子項目）
  async function openTeamMemory() {
    await loadTeam();
    const t = state.team;
    if (!t) return toast('無法取得團隊狀態');
    openModal('團隊狀態', `${aiStateHtml(t) || '<p class="muted">還沒有 AI。</p>'}`, { sub: 'AI 自己回報的目前任務與待辦，只在狀態改變時更新；依專案可見。' });
    const pane = $('#team-pane'); if (pane) pane.querySelectorAll('.modal-head h2').forEach(h => { h.textContent = 'AI 工作記憶'; });
  }
  // 側欄與手機選單的「團隊」兩層選單：展開狀態記在瀏覽器，目前所在子項目有選取標示
  const TEAM_NAV_KEY = 'aigile-switch-team-nav';
  function syncTeamNav() {
    const open = store.get(TEAM_NAV_KEY) === '1' || state.page === 'team';
    document.querySelectorAll('[data-team-group]').forEach(g => {
      g.querySelector('[data-team-toggle]').setAttribute('aria-expanded', String(open));
      g.querySelector('.chev').textContent = open ? '▾' : '▸';
      g.querySelector('.nav-sub').hidden = !open;
      g.querySelector('[data-team-toggle]').toggleAttribute('data-current', state.page === 'team');
      g.querySelectorAll('[data-team-go]').forEach(b => { if (state.page === 'team' && b.dataset.teamGo === work.teamTab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    });
  }
  // 鍵盤：在子項目上用 ↑↓ 移動
  document.addEventListener('keydown', e => {
    if (!['ArrowUp', 'ArrowDown'].includes(e.key) || !e.target.closest?.('.nav-sub')) return;
    e.preventDefault();
    const items = [...e.target.closest('.nav-sub').querySelectorAll('button')], i = items.indexOf(e.target);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  });
  // 側欄與手機選單的「設定」兩層選單（C-141）：進階設定／API 資訊／QR Code／登出，展開狀態記在瀏覽器
  const SET_NAV_KEY = 'aigile-switch-set-nav';
  function syncSetNav(open) {
    document.querySelectorAll('[data-set-group]').forEach(g => {
      g.querySelector('[data-set-toggle]').setAttribute('aria-expanded', String(open));
      g.querySelector('.chev').textContent = open ? '▾' : '▸';
      g.querySelector('.nav-sub').hidden = !open;
    });
  }
  syncSetNav(store.get(SET_NAV_KEY) === '1');
  document.addEventListener('click', e => {
    const st = e.target.closest('[data-set-toggle]');
    if (st) { const open = st.getAttribute('aria-expanded') !== 'true'; store.set(SET_NAV_KEY, open ? '1' : '0'); syncSetNav(open); }
  });
  document.addEventListener('click', e => {
    const tg = e.target.closest('[data-team-toggle]');
    if (tg) { const open = tg.getAttribute('aria-expanded') === 'true'; store.set(TEAM_NAV_KEY, open ? '0' : '1'); document.querySelectorAll('[data-team-group]').forEach(g => { g.querySelector('.nav-sub').hidden = open; g.querySelector('[data-team-toggle]').setAttribute('aria-expanded', String(!open)); g.querySelector('.chev').textContent = open ? '▸' : '▾'; }); return; }
    const go = e.target.closest('[data-team-go]');
    if (go) { closeSheet(false); if (go.dataset.teamGo === 'ai') return goTop('myai'); work.teamTab = go.dataset.teamGo; store.set(TEAM_NAV_KEY, '1'); if (state.page === 'team') renderTeamPage(); else showPage('team'); }
  });
  function openTodoPage() { closeSheet(false); showPage('inbox'); }
  document.addEventListener('click', e => { if (e.target.closest('[data-todo]')) openTodoPage(); });
  function showPage(page, { replace = false, noHistory = false } = {}) {
    if (state.page === 'perm' && page !== 'perm' && permDirty()) return permLeave(() => { perm.draft.clear(); showPage(page, { replace, noHistory }); }); // C-182：有未儲存的變更先提醒
    if (work.openId) closeCard();
    const v = projectView();
    if (page === 'dm') { page = 'messages'; setTimeout(() => dmPanel(true), 0); } // C-270 A A：私訊改面板，舊網址照樣打開
    state.page = isTop(page) ? page : v === 'hub' ? 'hub' : ['work', 'inbox', 'team', 'files'].includes(page) && !(v === 'cross' && page === 'work') ? page : 'messages';
    if (state.page !== 'team') work.teamScrollTab = null; // C-157：離開團隊頁就不再保留捲動位置（UX 第 1010 則），回來從頂端開始
    if (state.page !== 'hub' && !TOP_PAGES[state.page]) store.set(PAGE_KEY, state.page);
    if (!noHistory) syncUrl(replace);
    drawChrome();
    document.body.classList.toggle('at-hub', state.page === 'hub');
    $('#page-messages').hidden = state.page !== 'messages';
    $('#page-work').hidden = state.page === 'messages'; // 收件匣與工作共用同一個容器
    document.querySelectorAll('[data-nav]').forEach(b => {
      if (b.dataset.nav === state.page) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    syncTeamNav();
    if (state.page === 'work') {
      return (work.loaded ? Promise.resolve() : loadCards()).then(renderWork).catch(err => toast(err.message));
    } else if (state.page === 'team') {
      renderTeamPage();
    } else if (state.page === 'hub') {
      return Promise.all([work.loaded ? null : loadCards(), loadTeam().catch(() => {})]).then(renderWork).catch(err => toast(err.message));
    } else if (state.page === 'files') {
      const box = $('#page-work'); box.classList.remove('is-board');
      box.innerHTML = '<div id="files-pane" class="inline-pane"></div>';
      return openFiles(); // C-195：文件改成頁面，不再用彈窗擋住左側選單
    } else if (state.page === 'myai') {
      return renderMyAiPage();
    } else if (state.page === 'wishes') {
      return renderWishesPage();
    } else if (state.page === 'releases') {
      return renderReleasesPage();
    } else if (state.page === 'perm') {
      return renderPermPage();
    } else if (state.page === 'inbox') {
      return Promise.all([work.loaded ? null : loadCards(), loadNotes(), loadTeam().catch(() => {})]).then(loadConfirmMsgs).then(() => { updateTodoBadge(); renderWork(); }).catch(err => toast(err.message));
    } else scrollBottom();
    return Promise.resolve();
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-nav]');
    if (!b) return;
    closeSheet(false);
    showPage(b.dataset.nav);
    if (b.dataset.nav === 'messages') $('#input').focus();
  });

  function visibleCards() {
    const q = work.q.trim().toLowerCase();
    return [...work.cards.values()].filter(c =>
      cardInView(c)
      && (!work.type || c.type === work.type)
      && (!work.owner || c.owner?.participantId === work.owner)
      && (!q || [c.title, c.next, c.cardId].some(v => (v || '').toLowerCase().includes(q))))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // C-195：看板放不下時顯示「還有 N 欄」；C-237：左右兩邊都有，點了捲到那一邊的底，捲到底就收起
  function boardMore() {
    const board = $('#page-work .board');
    if (!board || !wide()) return;
    const mk = side => { const b = document.createElement('button'); b.type = 'button'; b.className = 'board-more' + (side === 'left' ? ' left' : ''); return b; };
    const rightBtn = mk('right'), leftBtn = mk('left');
    board.parentElement.style.position = 'relative';
    board.after(rightBtn, leftBtn);
    const update = () => {
      const cols = [...board.querySelectorAll('.bcol')], r = board.getBoundingClientRect();
      const hiddenR = cols.filter(c => c.getBoundingClientRect().right > r.right + 2).length; // 被切到一部分也算
      const hiddenL = cols.filter(c => c.getBoundingClientRect().left < r.left - 2).length;
      rightBtn.hidden = board.scrollLeft + board.clientWidth >= board.scrollWidth - 4;
      leftBtn.hidden = board.scrollLeft <= 4;
      rightBtn.textContent = hiddenR ? `還有 ${hiddenR} 欄 →` : '→';
      leftBtn.textContent = hiddenL ? `← 還有 ${hiddenL} 欄` : '←';
      board.classList.toggle('has-more', !rightBtn.hidden);
      board.classList.toggle('has-less', !leftBtn.hidden);
      rightBtn.setAttribute('aria-label', '看板往右捲，看其他欄位');
      leftBtn.setAttribute('aria-label', '看板往左捲，看其他欄位');
    };
    rightBtn.onclick = () => board.scrollTo({ left: board.scrollWidth, behavior: 'smooth' });
    leftBtn.onclick = () => board.scrollTo({ left: 0, behavior: 'smooth' });
    board.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    requestAnimationFrame(update);
  }
  // C-195：從「我的專案」點進來的那一項，重畫後仍標著並捲到它
  function applyFocusItem() {
    const f = work.focusItem;
    if (!f || Date.now() > f.until || state.page !== 'inbox') return false;
    const el = document.querySelector('#page-work ' + f.sel);
    if (!el) return false;
    el.classList.add('focus-item');
    if (!f.scrolled) { f.scrolled = true; el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); }
    return true;
  }
  function renderWork() {
    const box = $('#page-work');
    if (state.page === 'perm') return drawPerm();
    if (!['work', 'inbox', 'hub'].includes(state.page) || !work.loaded) return;
    box.classList.remove('is-board');
    if (state.page === 'inbox') { box.innerHTML = inboxHtml(); applyFocusItem(); return; }
    if (state.page === 'hub') { box.innerHTML = hubHtml(); return; }
    const all = visibleCards();
    const people = projPeople(projectView() === 'hub' || projectView() === 'cross' ? '' : projectView()); // C-180
    const keep = document.activeElement?.id;
    box.innerHTML = `
      <div class="work-head">
        <div class="work-title"><h2>工作</h2><span class="muted small">${all.filter(c => !closedSt(c.status)).length} 張未完成</span></div>
        <div class="seg-scope" role="group" aria-label="檢視方式">
          <button type="button" data-view="A" aria-pressed="${work.view === 'A'}">工作總覽</button>
          <button type="button" data-view="B" aria-pressed="${work.view === 'B'}">看板</button>
        </div>
        <button class="btn primary" type="button" id="card-new">＋ 新增卡片</button>
      </div>
      <div class="work-filters">
        <input id="card-q" type="search" placeholder="搜尋標題、下一步或編號" aria-label="搜尋卡片" value="${esc(work.q)}">
        <select id="card-owner" aria-label="負責人"><option value="">所有負責人</option>${people.map(p => `<option value="${esc(p.participantId)}" ${work.owner === p.participantId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <select id="card-type" aria-label="類型"><option value="">所有類型</option>${['工作', '阻塞', '決策', NOTE].map(t => `<option ${work.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </div>
      ${work.type === NOTE && all.some(c => c.type === NOTE && !closedSt(c.status)) ? (() => { const ns = all.filter(c => c.type === NOTE && !closedSt(c.status)); return `<div class="note-ask"><span class="muted small">AI 不會主動看到人類紀錄；收集夠了可以一次請 AI 讀完整理。</span><button type="button" class="btn primary small" data-ask-ai="${esc(ns.map(c => c.cardId).join(','))}">請 AI 整理這 ${ns.length} 張</button></div>`; })() : ''}
      ${reportsHtml()}
      ${work.view === 'B' ? boardHtml(all) : overviewHtml(all)}`;
    if (fbTeamView() && (!fb.repAt || Date.now() - fb.repAt > 60_000)) loadReports(); // 打開工作頁才讀，不輪詢
    box.classList.toggle('is-board', work.view === 'B'); // 看板：高度＝頁面剩餘高度，欄內各自捲動（C-142）
    if (work.view === 'B') boardMore();
    if (keep === 'card-q') { const q = $('#card-q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }

  function overviewHtml(all) {
    const decideMe = all.filter(decidingMe);
    const waitMe = all.filter(c => isMeRef(c.waitFor) && !closedSt(c.status) && !decidingMe(c));
    const blocked = all.filter(c => c.status === '受阻');
    const done = all.filter(c => c.status === '已完成');
    const panel = (title, cls, list, empty, meta, extra = '') => `
      <section class="wpanel ${cls}${list.length ? ' has' : ''}">
        <div class="wpanel-head"><span class="wdot"></span><b>${title}</b><span class="wcount">${list.length}</span></div>
        ${list.length ? list.slice(0, 3).map(c => `<button type="button" class="wpanel-item" data-card="${esc(c.cardId)}"><span>${cardPTag(c)} ${esc(cardTitle(c))}</span><span class="muted small">${esc(meta(c))}</span></button>`).join('')
          : `<p class="muted small">${empty}</p>`}
        ${list.length > 3 ? `<button type="button" class="link small" data-filter="${cls === 'done' ? '已完成' : cls === 'blocked' ? '受阻' : 'open'}">查看全部 ${list.length} 張</button>` : ''}
        ${extra}
      </section>`;
    const chips = [['open', '未完成', all.filter(c => !closedSt(c.status)).length], ...CARD_ST.map(s => [s, s === '已完成' ? '已完成（7 天）' : s, s === '已封存' ? work.archived.count : all.filter(c => c.status === s).length])];
    const listed = all.filter(c => (work.filter === 'open' ? !closedSt(c.status) : c.status === work.filter));
    const archMore = work.filter === '已封存' && work.archived.hasMore ? `<button type="button" class="btn small" data-arch-more ${work.archived.loading ? 'disabled' : ''}>再載入 50 張</button>` : '';
    const sa = work.archSearch, archHits = work.q.trim() && sa.q === work.q.trim() && work.filter !== '已封存' ? sa.items.filter(c => !listed.some(x => x.cardId === c.cardId)) : [];
    const archGroup = archHits.length ? `<div class="arch-group"><button type="button" class="arch-group-head" data-arch-toggle aria-expanded="${sa.open}">已封存 ${archHits.length}（${sa.open ? '點一下收合' : '收合中，點開'}）${sa.open ? '▴' : '▾'}</button>
        ${sa.open ? archHits.map(c => `<button type="button" class="crow arch" data-card="${esc(c.cardId)}"><span class="cid">${esc(c.cardId)}</span><span class="crow-main"><span class="crow-title">${cardPTag(c)} ${esc(cardTitle(c))}</span></span><span class="crow-st">${archTag(c)}</span></button>`).join('') : ''}</div>` : '';
    const decSection = decisionSectionHtml(decideMe);
    return `
      ${decSection}
      ${suggHtml()}
      <div class="wpanels">
        ${panel('等你處理', 'mine', waitMe, '目前沒有等你處理的卡片。', c => `${c.status} · ${c.owner?.name || '未指派'}`)}
        ${panel('受阻', 'blocked', blocked, '沒有受阻的卡片。', c => waitText(c) || '未填寫阻塞原因')}
        ${panel('最近完成（7 天）', 'done', done, '最近 7 天沒有完成的卡片。', c => `${c.verified ? (archiveLeftMs(c) < DAY_MS ? '已驗證 · 明天收起' : '已驗證') : pendingDays(c) > ARCHIVE_DAYS ? `待驗證 ${pendingDays(c)} 天` : '待驗證'} · ${c.done?.by?.name || ''} · ${shortTime(c.done?.at || c.updatedAt)}`,
          work.archived.count ? `<button type="button" class="link small" data-filter="已封存">更早的 ${work.archived.count} 張已封存</button>` : '')}
      </div>
      <div class="wchips" role="group" aria-label="依狀態篩選">
        ${chips.map(([v, label, n]) => `<button type="button" data-filter="${esc(v)}" aria-pressed="${work.filter === v}"${v === '已封存' ? ' class="dashed"' : ''}>${label}<span>${n}</span></button>`).join('')}
      </div>
      ${work.q.trim() ? '<p class="muted small">搜尋時一併找已封存</p>' : ''}
      <div class="crows">
        ${listed.length ? listed.map(c => `
          <button type="button" class="crow${isMeRef(c.waitFor) ? ' me' : ''}${c.type === NOTE ? ' note' : ''}" data-card="${esc(c.cardId)}">
            ${cidHtml(c)}
            <span class="crow-main"><span class="crow-title">${typeTag(c)}${cardPTag(c)} ${esc(cardTitle(c))}</span><span class="muted small">${c.next ? '下一步：' + esc(c.next) : c.status === '待整理' ? '尚未整理下一步' : '—'}</span></span>
            <span class="crow-st">${c.type === NOTE ? noteStPill(c) : c.status === '待確認' ? confirmPill(c) : stPill(c.status)}${ownerHtml(c)}</span>
            <span class="crow-wait small ${isMeRef(c.waitFor) ? 'me' : c.status === '受阻' ? 'bad' : ''}">${esc(waitText(c) || '—')}</span>
            <span class="crow-time muted small">${shortTime(c.updatedAt)}${c.status === '已封存' ? archTag(c) : doneTag(c) || markHtml(c)}</span>
          </button>`).join('') : `<p class="muted">${work.filter === '已封存' && work.archived.loading ? '載入中…' : '沒有符合條件的卡片。'}</p>`}
        ${archMore}
      </div>
      ${archGroup}`;
  }

  // 決策卡區塊（總覽與「待你處理」共用）
  function decisionSectionHtml(decideMe) {
    return decideMe.length ? `
      <section class="wdecisions"><div class="wdec-head"><h3>等你決定</h3><span class="wcount ora">${decideMe.length}</span></div>
        <div class="dgrid">${decideMe.map(c => `
          <article class="dcard" data-dcard="${esc(c.cardId)}">
            <div class="dcard-top"><span class="ctype" data-ty="決策">決策</span><span class="cid">${esc(c.cardId)}</span><span class="grow"></span>
              <button type="button" class="link small" data-card="${esc(c.cardId)}">查看詳情</button></div>
            <h4>${esc(c.decision.question)}</h4>
            ${decisionBox(c)}
            ${decisionActions(c)}
          </article>`).join('')}</div></section>` : '';
  }
  document.addEventListener('click', e => { // C-242：收件匣「等你驗收」
    const ok = e.target.closest?.('[data-ver-ok]'), no = e.target.closest?.('[data-ver-no]');
    if (ok) acceptCard(ok.dataset.verOk); else if (no) rejectCard(no.dataset.verNo);
  });
  // ---------- 收件匣（C-134）：要你做的＋給你知道的 ----------
  work.notes = [];
  async function loadNotes() {
    work.notesAt = Date.now();
    const [a, b] = await Promise.all([api('/api/notifications?status=pending&limit=50&order=desc'), api('/api/me/notices').catch(() => ({ items: [] }))]);
    const dmBefore = (work.notes || []).filter(n => n.dm).map(n => n.notificationId).join();
    work.notes = a.items; work.sec = b.items;
    if (dmVisible() && work.notes.filter(n => n.dm).map(n => n.notificationId).join() !== dmBefore) loadDmSummary(); // C-270：有私訊通知才更新清單
    work.notesMore = a.hasMore ? Math.max(0, (a.total || 0) - a.items.length) : 0; // 只顯示最新 50 則，其餘寫數字
  }
  // C-223：安全通知（新裝置用帳密登入、主機救援）只存在本人帳號，不是群組訊息
  work.sec = [];
  const secDev = d => String(d || '').replace(/^[^·]+·\s*/, '');
  function secHtml(n) {
    const when = fmtDate(n.createdAt);
    const [text, hint] = n.kind === 'password_login' ? [`有新裝置用你的帳號密碼登入：${secDev(n.detail)} · ${when}。`, '不是你？到「我的裝置」登出它並改密碼。']
      : n.kind === 'rescue_login' ? [`有裝置用主機救援連結登入你的帳號：${secDev(n.detail)} · ${when}。`, '不是你？到「我的裝置」登出它，並檢查誰有主機部署權限。']
      : [`主機產生了一次性救援登入連結（${n.detail}）· ${when}，15 分鐘內有效。`, '不是你或你的團隊？請檢查誰有主機部署權限。'];
    return `<div class="sec-note" id="sec-${esc(n.id)}"><span class="sec-ico" aria-hidden="true">🔐</span>
      <div class="sec-main"><span>${esc(text)}</span><span class="small">${esc(hint)}</span></div>
      <div class="sec-acts">${n.kind === 'rescue_link' ? '' : '<button type="button" class="btn small" data-sec-devices>我的裝置</button>'}<button type="button" class="btn small" data-sec-read="${esc(n.id)}" aria-label="${esc(text)} 知道了">知道了</button></div></div>`;
  }
  document.addEventListener('click', async e => {
    if (!e.target.closest?.('#page-work')) return;
    if (e.target.closest('[data-sec-devices]')) return openDevices();
    const r = e.target.closest('[data-sec-read]');
    if (!r) return;
    const id = r.dataset.secRead, backup = work.sec;
    work.sec = work.sec.filter(n => n.id !== id);
    renderWork();
    try { await api('/api/me/notices/read', { method: 'POST', body: { ids: [id] } }); } catch (err) { work.sec = backup; renderWork(); toast(err.message); }
  });
  const ackNotes = ids => api('/api/notifications/ack', { method: 'POST', body: { notificationIds: ids } });
  // C-191：按下畫面立即移除、背景一次送出（每 100 則一批、並行），失敗才還原
  async function ackNotesNow(ids, msg) {
    if (!ids.length) return;
    const gone = new Set(ids), backup = work.notes;
    work.notes = work.notes.filter(n => !gone.has(n.notificationId));
    renderWork(); updateTodoBadge();
    if (msg) toast(msg);
    try {
      const chunks = [];
      for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
      await Promise.all(chunks.map(ackNotes));
    } catch (err) { work.notes = backup; renderWork(); toast('沒有標成已讀：' + err.message); }
  }
  // 「給你知道的」：同一則已經出現在「要你做的」的 [需確認]，不重複顯示
  // C-259／C-268：「要你回覆」只看通知（跟徽章同一個來源）；[需確認]、交接、等你驗收／決定的卡已在別區，不重複
  const askNoteRaw = () => { const dup = new Set(legacyConfirms().map(d => d.messageId));
    return (work.notes || []).filter(n => !n.dm && n.ask === true && !work.answered.has(n.messageId) && !dup.has(n.messageId) && !/^\s*\[(需確認|交接)\]/.test(n.preview || '') && !cardOfConfirm({ messageId: n.messageId, title: n.preview }) && !askCardElsewhere(n)); };
  const askCardElsewhere = n => [...(state.msgCards.get(n.messageId) || []), cardIdOf(n.preview || '')].filter(Boolean).some(id => { const c = work.cards.get(id); return c && (verifyingMe(c) || decidingMe(c)); });
  const askNotes = () => askNoteRaw().filter(n => msgInView(n.project ?? null));
  const dmNotes = () => (work.notes || []).filter(n => n.dm && msgInView(n.project ?? null)); // C-270
  const noteList = () => { const dup = new Set(legacyConfirms().map(d => d.messageId)); return work.notes.filter(n => !n.dm && n.ask !== true && msgInView(n.project ?? null) && !dup.has(n.messageId) && !cardOfConfirm({ messageId: n.messageId, title: n.preview }) && !decidedCardNote(n)); };
  // C-181：講已經決定完的決策卡的通知，不再列在「給你知道的」
  const decidedCardNote = n => ((state.byId.get(n.messageId)?.text || n.preview || '').match(/C-\d+/g) || []).some(id => { const c = work.cards.get(id); return c?.type === '決策' && (!!c.decision?.result || closedSt(c.status)); });
  function notesHtml() {
    const list = noteList();
    const reason = { mention: '<span class="tag me">指定給我</span>', reply: '<span class="tag reply">回覆我</span>', all: '<span class="tag all">全體通知</span>' };
    const sec = work.sec || [];
    return `<section class="wsugg"><div class="wsugg-head"><span class="wdot"></span><h3>給你知道的</h3><span class="wcount">${list.length + sec.length}</span><span class="grow"></span>
        ${list.length ? '<button type="button" class="btn small" data-note-ackall>全部標為已讀</button>' : ''}</div>
      ${sec.map(secHtml).join('')}
      ${list.length || sec.length ? list.map(n => {
        const who = state.participants.get(n.sender.participantId) || { ...n.sender, memberType: 'human' };
        return `<div class="sugg-row fyi-row" id="fyi-${esc(n.notificationId)}"><span class="ndot" aria-hidden="true"></span>${avatar(who)}
          <button type="button" class="fyi-main" data-note-goto="${esc(n.messageId)}" data-n="${esc(n.notificationId)}" aria-label="${esc(`未讀，${n.sender.name}，${fmtTime(n.createdAt)}：${n.preview}。查看`)}">
            <span class="fyi-top"><b>${esc(n.sender.name)}</b>${n.ask === false ? '<span class="apill fyi me">知會你</span>' : n.reasons.map(r => reason[r] || '').join('')}<span class="msg-time">${fmtTime(n.createdAt)}</span></span>
            <span class="fyi-text">${esc(n.preview.replace(/\s+/g, ' '))}</span></button>
          <button type="button" class="fyi-read" data-note-ack="${esc(n.notificationId)}" aria-label="${esc(n.sender.name)} 這則標為已讀">已讀</button></div>`;
      }).join('') : '<p class="muted small">沒有需要你知道的新通知。</p>'}
      ${work.notesMore ? `<p class="muted small notes-more">只顯示最新 50 則，還有 ${work.notesMore} 則較舊的通知。</p>` : ''}</section>`;
  }
  // 第一層「我的專案」（C-169，取代今日總覽）：每個專案一張卡＋跨專案頻道卡；右欄「要你處理」依專案分組，只列不決定
  function projStats(p) {
    const today = new Date().toDateString();
    const cs = [...work.cards.values()].filter(c => c.project === p);
    return { done: cs.filter(c => c.status === '已完成' && c.done?.at && new Date(c.done.at).toDateString() === today).length, doing: cs.filter(c => c.status === '進行中').length,
      blocked: cs.filter(c => c.status === '受阻').length, verify: cs.filter(c => c.status === '已完成' && !c.verified).length };
  }
  const lastMsgOf = p => { for (let i = state.messages.length - 1; i >= 0; i--) if ((state.messages[i].project || null) === p) return state.messages[i]; return null; };
  const whenText = iso => { const d = new Date(iso); return d.toDateString() === new Date().toDateString() ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : hm(iso); };
  const oneLine = (t, n) => { const x = t.replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n) + '…' : x; };
  function hubHtml() {
    const counts = todoByView();
    const cards = myProjects().map(p => {
      const n = projStats(p), m = lastMsgOf(p);
      const st = (label, v, cls) => `<span class="hs${v && cls ? ' ' + cls : ''}">${label}<b>${v}</b></span>`;
      return `<button type="button" class="hub-card" data-proj="${esc(p)}" aria-label="進入 ${esc(projName(p))}">
        <span class="hc-head">${projIcon(p, 44)}<span class="hc-name"><b>${esc(projName(p))}</b><span class="small">成員 ${projMembers(p)} · 最後動態 ${m ? whenText(m.createdAt) : '—'}${leadersOf(p).length ? ` · ★ leader：${esc(leadersOf(p).map(id => state.participants.get(id)?.name).filter(Boolean).join('、'))}` : ''}</span></span>${counts[p] ? `<span class="hc-todo">要你做 ${counts[p]}</span>` : ''}</span>
        <span class="hc-stats">${st('今日完成', n.done)}${st('進行中', n.doing)}${st('受阻', n.blocked, 'bad')}${st('待驗收', n.verify, 'warn')}</span>
        <span class="hc-last">${m ? `最新：${esc(m.author.name)}「${esc(oneLine(m.text, 50))}」` : '最近 12 小時沒有新訊息'}</span>
        <span class="hc-go">進入 ›</span></button>`;
    }).join('');
    const cm = lastMsgOf(null);
    return `<div class="hub"><section class="hub-main">
        <div class="work-head"><div class="work-title"><h2>我的專案</h2><span class="muted small">${esc(new Date().toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short' }))}</span></div></div>
        <div class="hub-grid">${cards || '<p class="muted hub-empty">你還沒有加入任何專案，請群組管理員把你加入專案；在那之前可以先到跨專案頻道。</p>'}</div>
        <button type="button" class="hub-card hub-cross" data-proj="cross" aria-label="進入跨專案頻道">${projIcon('cross', 44)}<span class="hc-name"><b>跨專案頻道</b><span class="small">規則公告、跨團隊協調。${cm ? `最新：${esc(cm.author.name)} ${whenText(cm.createdAt)}「${esc(oneLine(cm.text, 40))}」` : '最近 12 小時沒有新訊息'}</span></span><span class="hc-go">進入 ›</span></button>
      </section>
      <aside class="hub-todo" aria-label="要你處理">${hubTodoHtml()}</aside></div>`;
  }
  function hubTodoItems() {
    const items = [];
    for (const d of state.team ? myDecisions(state.team) : []) items.push({ p: d.project || null, kind: d.cardId ? '決策' : '需確認', title: d.title || '（無標題）', key: d.cardId ? 'c:' + d.cardId : 'm:' + d.messageId });
    for (const g of work.sugg || []) items.push({ p: g.project || null, kind: '建議', title: g.kind === 'create' ? `建立卡片「${g.create?.title || ''}」` : `${g.card?.cardId || ''} 改為「${g.to}」`, key: 's:' + g.suggestionId });
    return items.filter(x => !x.p || myProjects().includes(x.p));
  }
  function hubTodoHtml(inModal = false) {
    const items = hubTodoItems();
    const groups = [...myProjects(), null].map(p => [p, items.filter(x => x.p === p)]).filter(([, l]) => l.length);
    const cls = { 決策: 'dec', 需確認: 'ask', 建議: 'sg' };
    return `${inModal ? '' : `<div class="ht-head"><h3>要你處理</h3>${items.length ? `<span class="ps-count">${items.length}</span>` : ''}<span class="grow"></span><span class="muted small">各專案彙總</span></div>`}
      ${groups.length ? groups.map(([p, l]) => `<div class="ht-group">${esc(p ? projName(p) : '跨專案頻道')}</div>
        ${l.map(x => `<button type="button" class="ht-row" data-hub-todo="${esc(x.key)}" data-hub-proj="${esc(p || 'cross')}"><span class="ht-tag ${cls[x.kind]}">${x.kind}</span><span class="ht-title">${esc(x.title)}</span><span class="ht-go" aria-hidden="true">›</span></button>`).join('')}`).join('')
        : '<p class="muted small ht-empty">目前沒有要你處理的事。</p>'}
      <p class="muted small ht-note">點一項＝進那個專案的收件匣並打開那一項；選項、回覆都在專案裡做，這裡只列、不在這裡決定。</p>`;
  }
  // 點一項：進那個專案的收件匣，捲到那一項並閃一下（決策卡不在收件匣時直接打開卡片）
  document.addEventListener('click', async e => {
    const r = e.target.closest('[data-hub-todo]');
    if (!r) return;
    if (r.closest('.modal')) closeModal();
    const key = r.dataset.hubTodo, id = key.slice(2);
    await setProjectView(r.dataset.hubProj, 'inbox');
    work.focusItem = { sel: `[${{ c: 'data-dcard', m: 'data-conf-row', s: 'data-sugg-row' }[key[0]]}="${CSS.escape(id)}"]`, until: Date.now() + 5000, scrolled: false };
    if (!applyFocusItem() && key[0] === 'c') openCard(id);
  });
  $('#m-todo').addEventListener('click', () => openModal('要你處理', hubTodoHtml(true), { size: 'narrow', sub: '各專案彙總；點一項進到該專案處理' }));
  function inboxHtml() {
    const all = [...work.cards.values()].filter(cardInView);
    const open = todoByView()[projectView()] || 0;
    return `<div class="work-head"><div class="work-title"><h2>收件匣</h2><span class="muted small">${open ? `${open} 件要你做` : '沒有要你做的事'}</span></div></div>
      <div class="inbox-block-title">要你做的</div>
      ${todoHtml(all)}
      ${noteList().length || work.sec?.length ? `<div class="inbox-block-title">給你知道的</div>
      ${notesHtml()}` : ''}`;
  }

  // 「待你處理」：決策卡、舊式 [需確認] 訊息、待審核的 AI 建議（C-107）
  const legacyConfirms = () => (state.team?.decisions || []).filter(d => !d.cardId && !cardOfConfirm(d) && inView(d.project) && !work.answered.has(d.messageId));
  function updateTodoBadge() {
    drawDmSide();
    const counts = todoByView(), n = counts[projectView()] || 0, total = counts.hub; // 收件匣徽章＝所在專案；分頁標題＝全部
    document.querySelectorAll('.inbox-badge').forEach(b => { b.hidden = !n; b.textContent = n > 99 ? '99+' : n; });
    if (document.querySelector('.ps-btn[aria-expanded="false"]') || !document.querySelector('.ps-btn')) drawProjSwitch(); // 下拉的件數跟著更新（開著時不重畫）
    document.title = (total ? `(${total > 99 ? '99+' : total}) ` : '') + BASE_TITLE;
    if (state.page === 'hub' && work.loaded) renderWork();
  }
  function todoHtml(all) {
    const decideMe = all.filter(decidingMe);
    const confirms = legacyConfirms();
    const sg = (work.sugg || []).filter(x => inView(x.project));
    const verifyMe = all.filter(verifyingMe); // C-242
    const asks = askNotes(), dms = dmNotes();
    if (!decideMe.length && !confirms.length && !sg.length && !verifyMe.length && !asks.length && !dms.length) return '<section class="wpanel"><p class="muted">目前沒有要你做的事。</p></section>';
    const askSection = asks.length ? `
      <section class="wsugg"><div class="wsugg-head"><span class="wdot"></span><h3>要你回覆</h3><span class="wcount ora">${asks.length}</span><span class="muted small">別人指定要你回覆的訊息；回覆了或按「不用回」就移走</span></div>
        ${asks.map(n => `<div class="sugg-row ask-row-item" id="fyi-${esc(n.notificationId)}">
          <div class="sugg-main"><b><span class="apill ask me">要你回覆</span> ${esc(n.sender.name)}</b><span class="muted small">${esc(oneLine(n.preview, 80))} · ${agoText(n.createdAt)}</span></div>
          <div class="sugg-actions"><button type="button" class="btn small primary" data-note-goto="${esc(n.messageId)}" data-n="${esc(n.notificationId)}">到訊息回覆</button>
            <button type="button" class="link small" data-note-ack="${esc(n.notificationId)}">不用回</button></div>
        </div>`).join('')}</section>` : '';
    const verSection = verifyMe.length ? `
      <section class="wsugg wverify"><div class="wsugg-head"><span class="wdot ok"></span><h3>等你驗收</h3><span class="wcount ok">${verifyMe.length}</span><span class="muted small">AI 做完交給你的卡：看過沒問題按「驗收通過」，要改按「退回」</span></div>
        ${verifyMe.map(c => `<div class="sugg-row ver-row" data-ver-row="${esc(c.cardId)}">
          <div class="sugg-main"><b>${cidHtml(c)} ${cardPTag(c)} ${esc(cardTitle(c))}</b><span class="muted small">${c.next ? '下一步：' + esc(c.next) + ' · ' : ''}${agoText(c.updatedAt)}交來</span></div>
          <div class="sugg-actions"><button type="button" class="btn small primary" data-ver-ok="${esc(c.cardId)}">驗收通過</button><button type="button" class="btn small" data-ver-no="${esc(c.cardId)}">退回…</button><button type="button" class="link small" data-card="${esc(c.cardId)}">查看詳情</button></div>
        </div>`).join('')}</section>` : '';
    const confSection = confirms.length ? `
      <section class="wsugg"><div class="wsugg-head"><span class="wdot"></span><h3>[需確認] 訊息</h3><span class="wcount ora">${confirms.length}</span><span class="muted small">AI 等你回答的問題，可以直接在這裡選；要看前後文按「到訊息處理」</span></div>
        ${confirms.map(d => { const cm = state.byId.get(d.messageId), quick = cm ? authHtml(cm, { inbox: true }) : ''; return `<div class="sugg-row conf-row" data-conf-row="${esc(d.messageId)}">
          <div class="sugg-main"><b>${esc(d.title || '（無標題）')}</b><span class="muted small">${esc(d.author?.name || '')} · ${agoText(d.createdAt)}${d.replyCount ? ` · 後續回覆 ${d.replyCount} 則` : ''}</span></div>
          <div class="sugg-actions"><button type="button" class="btn small primary" data-todo-jump="${esc(d.messageId)}">到訊息處理</button>
            <button type="button" class="link small" data-todo-resolve="${esc(d.messageId)}" title="已經決定了，從這裡移出">已處理</button></div>
          ${cm ? `<div class="conf-text">${esc(cm.text.replace(/^\s*\[需確認\]\s*/, ''))}</div>` : ''}
          ${quick || inlineHtml('m:' + d.messageId, 'confirm', d)}
        </div>`; }).join('')}</section>` : '';
    const dmSection = dms.length ? `
      <section class="wsugg"><div class="wsugg-head"><span class="wdot"></span><h3>🔒 私訊</h3><span class="wcount ora">${dms.length}</span><span class="muted small">只有你看得到</span></div>
        ${dms.map(n => `<div class="sugg-row"><div class="sugg-main"><b>${esc(n.sender.name)} 回你了</b><span class="muted small">${esc(oneLine(String(n.preview).replace(/^\[頭像提案 [^\]]+\]\s*/, '🖼 頭像提案：'), 80))} · ${agoText(n.createdAt)}</span></div>
          <div class="sugg-actions"><button type="button" class="btn small primary" data-dm-open="${esc(n.sender.participantId)}">打開私訊</button></div></div>`).join('')}</section>` : '';
    return dmSection + askSection + decisionSectionHtml(decideMe) + verSection + confSection + suggHtml(true);
  }

  const wide = () => matchMedia('(min-width: 900px)').matches;
  function boardHtml(all) {
    const BOARD_ORDER = ['待整理', '待處理', '進行中', '受阻', '待確認', '已完成', '已封存']; // C-195：受阻提前到第三欄（待整理有卡才顯示）
    const cols = wide() ? BOARD_ORDER.filter(s => (s !== '已封存' || work.showArchived) && (s !== '待整理' || all.some(c => c.status === '待整理'))) : [work.mCol];
    const tile = c => `
      <div class="ctile${isMeRef(c.waitFor) ? ' me' : ''}${c.type === NOTE ? ' note' : ''}" role="button" tabindex="0" data-card="${esc(c.cardId)}" draggable="${wide()}">
        <div class="ctile-top">${cidHtml(c)}${typeTag(c)}${confirmPill(c)}${c.type === NOTE ? (c.mergedInto ? '' : noteStPill(c)) : c.status === '已完成' ? doneTag(c) : c.status === '已封存' ? archTag(c) : markHtml(c)}</div>
        <b class="ctile-title">${cardPTag(c)} ${esc(cardTitle(c))}</b>
        ${c.next ? `<span class="muted small">下一步：${esc(c.next)}</span>` : ''}
        ${waitText(c) ? `<span class="cwait ${isMeRef(c.waitFor) ? 'me' : c.status === '受阻' ? 'bad' : ''}">${esc(waitText(c))}</span>` : ''}
        <div class="ctile-foot">${ownerHtml(c)}<span class="muted small">${shortTime(c.updatedAt).split(' ')[0]}</span></div>
        ${mergedHtml(c)}
      </div>`;
    const mini = c => `<button type="button" class="cmini" data-card="${esc(c.cardId)}" draggable="${wide()}"><span class="cid">${esc(c.cardId)}</span><span class="cmini-t">${cardPTag(c)} ${esc(cardTitle(c))}</span><span class="muted small">${esc(mmdd(c.verified?.at || c.done?.at || c.updatedAt))}</span>${doneTag(c)}</button>`;
    const archFoot = work.archived.count ? `<button type="button" class="bfoot" data-show-archived>更早完成的 ${work.archived.count} 張已收進「已封存」· 查看</button>` : '';
    const colBody = (st, list) => {
      if (st === '已完成') {
        const pend = list.filter(c => !c.verified), ver = list.filter(c => c.verified);
        return `${pend.length ? `<div class="bsub warn">待驗證 ${pend.length}（不會自動收起）</div>${pend.map(tile).join('')}` : ''}
          ${ver.length ? `<div class="bsub ok">已驗證 ${ver.length}（精簡一行，點開看詳情）</div>${ver.map(mini).join('')}` : ''}
          ${!pend.length && !ver.length ? '<p class="muted small bempty">最近 7 天沒有完成的卡</p>' : ''}${archFoot}`;
      }
      if (st === '已封存') return (list.length ? list.map(tile).join('') : `<p class="muted small bempty">${work.archived.loading ? '載入中…' : '沒有已封存的卡片'}</p>`)
        + (work.archived.hasMore ? `<button type="button" class="bfoot" data-arch-more>再載入 50 張</button>` : '');
      return list.length ? list.map(tile).join('') : `<p class="muted small bempty">${wide() ? '拖曳卡片到這裡' : '這個狀態沒有卡片'}</p>`;
    };
    const mLabel = st => (st === '已完成' ? '已完成（7 天）' : st);
    return `
      ${wide() ? `<div class="board-tools"><span class="muted small">拖曳卡片到其他欄可以改狀態</span><span class="grow"></span><span class="muted small">已封存 ${work.archived.count} 張（完成滿 7 天自動收起）</span><button type="button" class="link small" id="toggle-archived">${work.showArchived ? '隱藏已封存' : '顯示已封存'}</button></div>`
        : `<div class="wchips" role="group" aria-label="狀態">${BOARD_ORDER.map(st => `<button type="button" data-mcol="${esc(st)}" aria-pressed="${work.mCol === st}"${st === '已封存' ? ' class="dashed"' : ''}>${mLabel(st)}<span>${st === '已封存' ? work.archived.count : all.filter(c => c.status === st).length}</span></button>`).join('')}</div>`}
      <div class="board">
        ${cols.map(s => {
          const list = all.filter(c => c.status === s);
          return `<section class="bcol" data-col="${esc(s)}" aria-label="${esc(s)}">
            <div class="bcol-head"><span class="wdot" data-st="${esc(s)}"></span><b>${esc(s)}</b>${s === '已完成' ? '<span class="small ok-text">最近 7 天</span>' : ''}<span class="wcount${s === '受阻' && list.length ? ' bad' : ''}">${s === '已封存' ? work.archived.count : list.length}</span></div>
            <div class="bcol-list">${colBody(s, list)}</div>
          </section>`;
        }).join('')}
      </div>`;
  }

  // 互動
  const workBox = $('#page-work');
  workBox.addEventListener('input', decisionInput);
  workBox.addEventListener('keydown', inlineKey);
  workBox.addEventListener('click', async e => {
    if (decisionClick(e)) return;
    const t = e.target;
    const v = t.closest('[data-view]');
    if (v) { work.view = v.dataset.view; store.set(VIEW_KEY, work.view); return renderWork(); }
    const f = t.closest('[data-filter]');
    if (f) {
      work.filter = f.dataset.filter; work.view = 'A';
      if (work.filter === '已封存' && !work.archived.fetched) { renderWork(); await loadArchived().catch(err => toast(err.message)); }
      return renderWork();
    }
    if (t.closest('[data-arch-more]')) { await loadArchived(true).catch(err => toast(err.message)); return renderWork(); }
    if (t.closest('[data-arch-toggle]')) { work.archSearch.open = !work.archSearch.open; return renderWork(); }
    if (t.closest('[data-show-archived]')) {
      if (wide()) work.showArchived = true; else work.mCol = '已封存';
      if (!work.archived.fetched) { renderWork(); await loadArchived().catch(err => toast(err.message)); }
      renderWork();
      return workBox.querySelector('[data-col="已封存"]')?.scrollIntoView({ inline: 'end', block: 'nearest' });
    }
    if (t.closest('[data-goto-inbox]')) { showPage('inbox'); return; }
    const tt = t.closest('[data-team-tab]');
    if (tt) { work.teamTab = tt.dataset.teamTab; renderTeamPage(); return; }
    const ng = t.closest('[data-note-goto]');
    if (ng) { try { await ackNotes([ng.dataset.n]); } catch (err) { return toast(err.message); } showPage('messages'); return jumpTo(ng.dataset.noteGoto); }
    const na = t.closest('[data-note-ack]');
    if (na) { // C-215：點了這列先淡出再移除
      const row = document.getElementById('fyi-' + na.dataset.noteAck);
      if (row) { row.classList.add('fading'); setTimeout(() => ackNotesNow([na.dataset.noteAck]), 220); return; }
      return ackNotesNow([na.dataset.noteAck]);
    }
    if (t.closest('[data-note-ackall]')) return ackNotesNow(noteList().map(n => n.notificationId), '已全部標為已讀');
    const tj = t.closest('[data-todo-jump]');
    if (tj) { showPage('messages'); return jumpTo(tj.dataset.todoJump); }
    const tr = t.closest('[data-todo-resolve]');
    if (tr) {
      try { await api(`/api/decisions/${encodeURIComponent(tr.dataset.todoResolve)}/resolve`, { method: 'POST' }); toast('已從收件匣移出'); await loadTeam(); updateTodoBadge(); renderWork(); } catch (err) { toast(err.message); }
      return;
    }
    const bt = t.closest('[data-batch]');
    if (bt && work.sel.size) {
      const ids = [...work.sel], action = bt.dataset.batch;
      const ok = await confirmDialog({ title: action === 'apply' ? '批次採用' : '批次略過', message: action === 'apply' ? `確定採用已勾選的 ${ids.length} 則 AI 建議？卡片會依建議建立或更新，提案的 AI 會收到一則合併通知。` : `確定略過已勾選的 ${ids.length} 則 AI 建議？`, confirmText: action === 'apply' ? '採用' : '略過' });
      if (!ok) return;
      try {
        const r = await api('/api/suggestions/batch', { method: 'POST', body: { ids, action } });
        work.sel.clear();
        const nExp = r.results.filter(x => x.error === 'EXPIRED').length;
        toast(`已${action === 'apply' ? '採用' : '略過'} ${r.done} 則${nExp ? `，${nExp} 則已過期（卡片有變動）被跳過，請改為略過` : ''}${r.failed - nExp > 0 ? `，${r.failed - nExp} 則失敗（可能已被處理）` : ''}`);
        await loadCards(); renderWork();
      } catch (err) { toast(err.message); }
      return;
    }
    const sa = t.closest('[data-sugg-apply]');
    if (sa) return void suggAction(sa.dataset.suggApply, 'apply');
    const ss = t.closest('[data-sugg-skip]');
    if (ss) return void suggAction(ss.dataset.suggSkip, 'skip');
    const se = t.closest('[data-sugg-edit]');
    if (se) return openNewCard((work.sugg || []).find(x => x.suggestionId === se.dataset.suggEdit));
    const sb = t.closest('[data-sugg-basis]');
    if (sb) { const id = sb.dataset.suggBasis; showPage('messages'); return void jumpTo(id); }
    const mc = t.closest('[data-mcol]');
    if (mc) {
      work.mCol = mc.dataset.mcol;
      if (work.mCol === '已封存' && !work.archived.fetched) { renderWork(); await loadArchived().catch(err => toast(err.message)); }
      return renderWork();
    }
    if (t.closest('#toggle-archived')) {
      work.showArchived = !work.showArchived;
      if (work.showArchived && !work.archived.fetched) { renderWork(); await loadArchived().catch(err => toast(err.message)); }
      return renderWork();
    }
    if (t.closest('#card-new')) return openNewCard();
    const ask = t.closest('[data-ask-ai]');
    if (ask) {
      const ids = ask.dataset.askAi.split(',');
      const pj = work.cards.get(ids[0])?.project;
      if (pj && projectView() !== pj && myProjects().includes(pj)) await setProjectView(pj, 'messages'); else showPage('messages');
      const inp = $('#input');
      inp.value = `@ 請整理以下人類紀錄：${ids.join('、')}。內容相近的整理成一張新卡並回覆我；原本的卡標已完成，並註明已整理到哪張。`;
      inp.focus(); inp.setSelectionRange(1, 1);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return toast('選一個 AI，確認內容後送出');
    }
    const c = t.closest('[data-card]');
    if (c) openCard(c.dataset.card);
  });
  workBox.addEventListener('keydown', e => {
    const c = e.target.closest?.('.ctile');
    if (c && e.key === 'Enter') openCard(c.dataset.card);
  });
  workBox.addEventListener('input', e => { if (e.target.id === 'card-q') { work.q = e.target.value; searchArchived(); renderWork(); } });
  workBox.addEventListener('change', e => {
    if (e.target.id === 'card-owner') { work.owner = e.target.value; renderWork(); }
    if (e.target.id === 'card-type') { work.type = e.target.value; renderWork(); }
  });
  workBox.addEventListener('change', e => {
    const c = e.target.closest?.('[data-sugg-check]');
    if (!c) return;
    if (c.checked) work.sel.add(c.dataset.suggCheck); else work.sel.delete(c.dataset.suggCheck);
    renderWork();
  });
  // 看板拖曳（桌面）
  workBox.addEventListener('dragstart', e => {
    const c = e.target.closest?.('.ctile, .cmini');
    if (!c) return;
    work.dragId = c.dataset.card;
    e.dataTransfer.setData('text/plain', c.dataset.card);
    e.dataTransfer.effectAllowed = 'move';
    c.classList.add('dragging');
  });
  workBox.addEventListener('dragend', () => { work.dragId = null; workBox.querySelectorAll('.bcol.over').forEach(x => x.classList.remove('over')); });
  // 拖卡片時靠近看板（或頁面）邊緣自動捲動，才拖得到畫面外的欄位
  function dragAutoScroll(e) {
    const board = workBox.querySelector('.board');
    if (board) {
      const r = board.getBoundingClientRect(), edge = 80;
      if (e.clientX < r.left + edge) board.scrollLeft -= 24;
      else if (e.clientX > r.right - edge) board.scrollLeft += 24;
      if (e.clientY < r.top + 50) board.scrollTop -= 16;
      else if (e.clientY > r.bottom - 50) board.scrollTop += 16;
    }
    const w = workBox.getBoundingClientRect();
    if (e.clientY < w.top + 40) workBox.scrollTop -= 16;
    else if (e.clientY > w.bottom - 40) workBox.scrollTop += 16;
  }
  workBox.addEventListener('dragover', e => {
    if (work.dragId) dragAutoScroll(e);
    const col = e.target.closest?.('.bcol');
    if (!col || !work.dragId) return;
    e.preventDefault();
    workBox.querySelectorAll('.bcol.over').forEach(x => x !== col && x.classList.remove('over'));
    col.classList.add('over');
  });
  workBox.addEventListener('drop', e => {
    const col = e.target.closest?.('.bcol');
    if (!col) return;
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    col.classList.remove('over');
    const c = work.cards.get(id);
    if (c && c.status !== col.dataset.col) patchCard(id, { status: col.dataset.col });
  });

  async function decideCard(id, result, note) {
    const c = work.cards.get(id);
    try {
      const r = await api(`/api/cards/${encodeURIComponent(id)}/decide`, { method: 'POST', body: { result, note, version: c?.version } });
      work.cards.set(id, r);
      work.note = null;
      renderWork();
      if (work.openId === id) openCard(id);
      toast(result === '要求補充' ? `已請 ${r.waitFor?.name || '提案人'} 補充` : `已記錄決定：${result}`);
    } catch (err) {
      toast(err.message);
      if (err.code === 'CONFLICT') { await syncCards().catch(() => {}); }
    }
  }
  function decisionClick(e) {
    if (inlineClick(e)) return true;
    const t = e.target;
    const dc = t.closest('[data-decide]');
    if (dc) { decideCard(dc.dataset.decide, dc.dataset.result, ''); return true; }
    const rsm = t.closest('[data-resume]');
    if (rsm) {
      const id = rsm.dataset.resume; rsm.disabled = true;
      api(`/api/cards/${encodeURIComponent(id)}/resume`, { method: 'POST', body: {} }).then(async r => { work.cards.set(id, r); toast('已恢復，回到待確認'); await Promise.all([loadTeam().catch(() => {}), syncCards().catch(() => {})]); updateTodoBadge(); renderWork(); if (work.openId) openCard(work.openId); }).catch(err => { rsm.disabled = false; toast(err.message); });
      return true;
    }
    const open = t.closest('[data-note-open]');
    if (open) { work.note = { id: open.dataset.noteOpen, kind: open.dataset.kind, text: '' }; refreshDecisionUi(); return true; }
    if (t.closest('[data-note-cancel]')) { work.note = null; refreshDecisionUi(); return true; }
    const sub = t.closest('[data-note-submit]');
    if (sub && work.note?.text.trim()) { decideCard(sub.dataset.noteSubmit, work.note.kind, work.note.text.trim()); return true; }
    return false;
  }
  function decisionInput(e) {
    if (inlineInput(e)) return;
    if (!e.target.matches?.('[data-note-text]') || !work.note) return;
    work.note.text = e.target.value;
    const btn = e.target.closest('.dcard, .drawer')?.querySelector('[data-note-submit]');
    if (btn) btn.disabled = !work.note.text.trim();
  }
  function refreshDecisionUi() {
    renderWork();
    if (work.openId && work.detail) renderDrawer(false);
    const ta = document.querySelector('[data-note-text]');
    if (ta) { ta.focus(); }
  }
  async function patchCard(id, body) {
    const c = work.cards.get(id);
    try {
      const r = await api(`/api/cards/${encodeURIComponent(id)}`, { method: 'PATCH', body: { ...body, version: c?.version } });
      work.cards.set(id, r);
      renderWork();
      if (work.openId === id) openCard(id);
      return r;
    } catch (err) {
      toast(err.message);
      if (err.code === 'CONFLICT') { await syncCards().catch(() => {}); if (work.openId === id) openCard(id); }
      return null;
    }
  }

  // 卡片詳情（桌面右側抽屜、手機底部滑出）
  async function openCard(id, trigger) {
    let d;
    try { d = await api(`/api/cards/${encodeURIComponent(id)}`); } catch (err) { return toast(err.code === 'CARD_FORBIDDEN' ? `${id} 屬於其他專案，你沒有權限查看` : err.code === 'NOT_FOUND' ? `找不到 ${id}，可能輸入錯誤或已刪除` : err.message); }
    if (trigger) work.returnFocus = trigger;
    rememberLinks(d);
    // C-189：相關訊息不在目前載入範圍的先抓回來，抽屜才看得到內容（不插進訊息串）
    const missMsgs = (d.messageIds || []).filter(mid => !state.byId.has(mid)).slice(0, 20);
    if (missMsgs.length) await Promise.all(missMsgs.map(mid => api(`/api/messages/${encodeURIComponent(mid)}`).then(m => { state.byId.set(mid, m); }).catch(() => {})));
    work.cards.set(id, { ...d, log: undefined, messageIds: undefined });
    const reopen = work.openId === id && $('#card-drawer');
    work.openId = id; work.detail = d;
    if (!reopen) work.editing = false;
    renderDrawer(!reopen);
  }
  const canHandover = d => d.type !== '決策' && !closedSt(d.status) && d.owner && (state.me.memberType === 'human' || d.owner.participantId === meId());
  // 交接歷程：從紀錄裡「交接 A → B：說明」整理成 PO → UX → PG
  // ---------- C-261 卡片動作看得懂 ----------
  // 最近一次交接是誰交來的（紀錄新的在前）
  const prevHandName = d => { for (const l of d.log || []) { const m = /^交接 (.+?) → (.+?)：/.exec(l.text); if (m) return m[1]; } return ''; };
  // 短名：名字很長的 AI 用代號（RVVW），其他照原名
  const shortOf = name => name; // C-269：一律顯示名字、不顯示代碼；太長的由 CSS 截斷加…，滑過看全名
  const actBtn = (act, label, desc, pri = false) => `<button type="button" class="act-btn${pri ? ' pri' : ''}" data-act="${act}"><b>${label}</b><span>${esc(desc)}</span></button>`;
  // 「現在要你做的」：依情況只露 1～2 顆大按鈕；不是你的卡不顯示
  function nowActsHtml(d) {
    const prev = prevHandName(d);
    let acts = '';
    if (verifyingMe(d)) acts = actBtn('ver-ok', '驗收通過', '確認做好了，這張卡結案', true) + actBtn('ver-no', '退回…', `有問題，寫原因退回給 ${prev ? shortOf(prev) : '上一棒'}`);
    else if (ownsOpen(d)) acts = actBtn('done', '標為已完成', '你自己做完了', true) + (canHandover(d) ? actBtn('handover', '交接…', '換人負責') : '');
    return acts ? `<section class="now-acts" aria-label="現在要你做的"><b class="now-title">現在要你做的</b>${acts}</section>` : '';
  }
  const ownsOpen = d => d.type !== '決策' && isMeRef(d.owner) && !closedSt(d.status) && d.status !== '待確認';
  // 「⋯ 其他動作」：每項一句說明；人類畫面不再有「標為已驗證」（人類按驗收通過就同時完成＋驗證）
  function moreActsHtml(d, mine) {
    const items = [];
    const own = !verifyingMe(d) && ownsOpen(d);
    if (!own && !verifyingMe(d) && !closedSt(d.status) && d.type !== '決策') items.push(actBtn('done', '標為已完成', '你自己做完了'));
    if (!own && canHandover(d)) items.push(actBtn('handover', '交接…', '換人負責（例如交給 PG 做、交給 UX 驗）'));
    if (d.status === '已完成' && !d.verified && !mine && state.me?.memberType === 'human') items.push(actBtn('verify', '驗收通過', '確認做好了，這張卡結案'));
    if (d.status === '已完成') items.push(actBtn('reopen', '重新打開', '還沒好，改回待處理再做'));
    if (!work.editing) items.push(actBtn('edit', '編輯', '改標題、原因、完成條件'));
    items.push(`<label class="act-btn act-sel"><b>改狀態</b><span>直接改成其他狀態</span><select id="d-status">${CARD_ST.map(s => `<option ${s === d.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>`);
    items.push(actBtn('copy-id', '複製卡號', '貼到訊息裡'));
    if (state.page === 'messages') items.push(actBtn('open-work', '在工作頁開啟', '在看板上看這張卡'));
    return `<details class="more-acts"><summary>⋯ 其他動作</summary><div class="more-list">${items.join('')}</div></details>`;
  }
  // 「今天 14:46」「昨天 09:10」「10/16 14:46」
  function dayTime(iso) {
    const t = new Date(iso), now = new Date(), hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    return t.toDateString() === now.toDateString() ? '今天 ' + hm : t.toDateString() === y.toDateString() ? '昨天 ' + hm : `${t.getMonth() + 1}/${t.getDate()} ${hm}`;
  }
  // 「發生了什麼」：同人同秒的多筆合成一句；交接寫成「A 把這張交給 B 驗收／做」，備註收合、版號抽出放小字
  function happenedHtml(d) {
    const groups = [];
    for (const l of d.log || []) {
      const k = (l.by?.participantId || l.by?.name || '') + '|' + String(l.at).slice(0, 19);
      const g = groups[groups.length - 1];
      if (g && g.k === k && !/^建立卡片/.test(l.text) && !g.items.some(t => /^建立卡片/.test(t))) g.items.push(l.text); else groups.push({ k, by: l.by, at: l.at, items: [l.text] }); // 建卡永遠單獨一句
    }
    const line = g => {
      const ho = g.items.map(t => /^交接 (.+?) → (.+?)：([\s\S]*)$/.exec(t)).find(Boolean);
      let icon = '•', cls = '', body, note = '', ver = '';
      if (g.items.some(t => /人類完成即驗收|驗收通過/.test(t))) { icon = '✓'; cls = 'ok'; body = '驗收通過，這張卡結案了'; }
      else if (ho) {
        icon = '⇢'; cls = 'ho';
        note = ho[3].replace(/（狀態[^（）]*）\s*$/, '').trim();
        ver = (note.match(/v\d+\.\d+\.\d+/) || [''])[0];
        body = `把這張交給 <b>${esc(shortOf(ho[2]))}</b> ${/等 .+ 驗收/.test(ho[3]) ? '驗收' : '做'}`;
      }
      else if (g.items.some(t => /^建立卡片/.test(t))) { icon = '＋'; body = '建了這張卡'; }
      else if (g.items.some(t => /^退回/.test(t))) { icon = '↩'; cls = 'bad'; body = esc(g.items.find(t => /^退回/.test(t))); }
      else if (g.items.some(t => /^標為已完成/.test(t))) { icon = '✓'; body = '標為已完成'; }
      else body = g.items.map(t => esc(t.replace(/^狀態 (.+?) → (.+)$/, '把狀態從「$1」改成「$2」').replace(/^.+? 認領了這張卡片$/, '認領了這張卡'))).join('，');
      const who = g.by ? shortOf(g.by.name || '') : '系統';
      return `<li class="lg ${cls}"><span class="lg-ic" aria-hidden="true">${icon}</span><div class="lg-main"><span><b>${esc(who)}</b> ${body}</span><span class="muted small">${dayTime(g.at)}${ver ? ' · ' + esc(ver) : ''}</span>${note ? `<details class="lg-note"><summary>看交接說明</summary><p>${esc(note)}</p></details>` : ''}</div></li>`;
    };
    const all = work.logAll, list = all ? groups : groups.slice(0, 5);
    return `<div class="group-title">發生了什麼</div><ol class="happened">${list.map(line).join('')}</ol>${groups.length > 5 ? `<button type="button" class="link small" data-act="log-all">${all ? '只看最近 5 句' : `看全部 ${groups.length} 筆`}</button>` : ''}`;
  }
  function handoverChain(d) {
    const hs = [...(d.log || [])].reverse().map(l => /^交接 (.+?) → (.+?)：/.exec(l.text)).filter(Boolean);
    if (!hs.length) return '';
    const names = [hs[0][1], ...hs.map(m => m[2])];
    return `<div class="handover-chain"><span class="muted small">交接歷程</span> ${names.map(n => `<b>${esc(shortOf(n))}</b>`).join(' → ')}</div>`;
  }
  function openHandover() {
    const d = work.detail;
    const people = [...state.participants.values()].filter(p => p.status !== 'disabled' && p.participantId !== d.owner?.participantId && (p.projects || []).includes(d.project));
    const body = openModal('交接卡片', `
      <form id="handover-form" class="stack">
        <div class="info-box">${esc(d.cardId)} ${esc(cardTitle(d))}<br>交接後負責人換成對方，狀態不變，並在群組 @ 對方通知。</div>
        <label>交給誰<select name="toId" required>${people.map(p => `<option value="${esc(p.participantId)}">${esc(p.name)}${roleIn(p, d.project) ? '（' + esc(roleIn(p, d.project)) + '）' : ''}</option>`).join('')}</select></label>
        <label>交接說明（必填）<textarea autocomplete="off" autocorrect="on" name="note" rows="3" required maxlength="300" placeholder="我做完了什麼、希望對方接著做什麼"></textarea></label>
        <p class="muted small">說明會公開在群組，請勿填入內部路徑、程式碼或客戶個資。</p>
        <p class="error" id="handover-error" role="alert"></p>
      </form>`, { size: 'form', foot: '<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit" form="handover-form">確認交接</button>' });
    body.querySelector('#handover-form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      try {
        const c = await api(`/api/cards/${encodeURIComponent(d.cardId)}/handover`, { method: 'POST', body: { toId: f.toId.value, note: f.note.value.trim(), version: d.version } });
        work.cards.set(c.cardId, { ...c, log: undefined, messageIds: undefined });
        closeModal();
        toast(`已交接給 ${c.owner?.name}`);
        renderWork();
        openCard(c.cardId);
      } catch (err) { body.querySelector('#handover-error').textContent = err.message; }
    });
  }
  // 「可能過時」：抽屜裡一鍵跳到最新相關訊息（抽屜不在工作頁容器內，所以掛在 document）
  document.addEventListener('click', e => {
    const sj = e.target.closest?.('[data-stale-jump]');
    if (sj) { const id = sj.dataset.staleJump; closeCard(); showPage('messages'); jumpTo(id); }
  });
  function closeCard() {
    $('#card-drawer')?.remove();
    document.body.classList.remove('drawer-docked');
    work.openId = null; work.detail = null; work.editing = false;
    const back = work.returnFocus; work.returnFocus = null;
    if (back?.isConnected) back.focus(); // 回到原本點的膠囊
  }
  // C-180：負責人、等誰只列該專案的成員（決策者不限）；目前值不在專案內也保留，才看得出原本是誰
  const projPeople = project => [...state.participants.values()].filter(p => p.status !== 'disabled' && (!project || (p.projects || []).includes(project)));
  function peopleOpts(project, cur, none) {
    const list = projPeople(project), extra = cur && !list.some(p => p.participantId === cur) && state.participants.get(cur);
    return `<option value="">${none}</option>` + [...list, ...(extra ? [extra] : [])].map(p => `<option value="${esc(p.participantId)}" ${cur === p.participantId ? 'selected' : ''}>${esc(p.name)}${roleIn(p, project) ? '（' + esc(roleIn(p, project)) + '）' : ''}${p === extra ? '（不在此專案）' : ''}</option>`).join('');
  }
  // 卡片表單換專案時，負責人、等誰跟著換清單；原本選的人不在新專案就清掉
  document.addEventListener('change', e => {
    const sel = e.target;
    if (sel.name !== 'project' || !sel.form?.ownerId) return;
    for (const [n, none] of [['ownerId', '未指派'], ['waitForId', '不用等人']]) {
      const s = sel.form[n];
      if (!s) continue;
      const cur = s.value, keep = projPeople(sel.value).some(p => p.participantId === cur);
      s.innerHTML = peopleOpts(sel.value, keep ? cur : '', none);
    }
  });
  // 在訊息頁的桌面版，抽屜與訊息並排（不遮住訊息）；手機與工作頁維持原本的遮罩／底部面板
  const dockedMode = () => state.page === 'messages' && matchMedia('(min-width: 900px)').matches;
  function renderDrawer(focus) {
    const d = work.detail;
    const people = [...state.participants.values()].filter(p => p.status !== 'disabled');
    const opts = (cur, none) => `<option value="">${none}</option>` + people.map(p => `<option value="${esc(p.participantId)}" ${cur === p.participantId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    const mine = d.done && isMeRef(d.done.by);
    const msgs = (d.messageIds || []).map(mid => {
      const m = state.byId.get(mid);
      if (!m) return `<div class="dmsg"><span class="muted small">訊息載入中…</span></div>`;
      const open = work.openMsgs?.has(mid), long = m.text.length > 120;
      return `<div class="dmsg${open ? ' open' : ''}"><button type="button" class="dmsg-main" data-dmsg-toggle="${esc(mid)}" aria-expanded="${!!open}"><b>${esc(m.author.name)}</b> <span class="muted small">${shortTime(m.createdAt)}</span><span class="dmsg-text">${esc(open || !long ? m.text : m.text.slice(0, 120) + '…')}</span></button><button type="button" class="link small dmsg-go" data-jump-msg="${esc(mid)}">到訊息</button></div>`;
    }).join('');
    let host = $('#card-drawer');
    if (!host) {
      host = document.createElement('div');
      host.id = 'card-drawer';
      host.className = 'drawer-root';
      document.body.append(host);
      host.addEventListener('click', e => { if (!decisionClick(e)) drawerClick(e); });
      host.addEventListener('input', decisionInput);
      host.addEventListener('keydown', inlineKey);
      host.addEventListener('change', e => { if (e.target.id === 'd-status') patchCard(work.openId, { status: e.target.value }); });
      host.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal-root').firstElementChild && !document.querySelector('.confirm-root')) { e.stopPropagation(); closeCard(); } });
    }
    const docked = dockedMode();
    host.classList.toggle('docked', docked);
    document.body.classList.toggle('drawer-docked', docked);
    host.innerHTML = `
      ${docked ? '' : '<div class="drawer-overlay" data-close-drawer></div>'}
      <aside class="drawer" role="dialog" aria-modal="${docked ? 'false' : 'true'}" aria-labelledby="drawer-title">
        <div class="drawer-head">
          <div class="drawer-titles">${cidHtml(d)}${typeTag(d)}${confirmPill(d)}${d.type === NOTE ? '<span class="ctype note-tag">🔒 人類紀錄</span>' : ''}${cardPTag(d)}<h2 id="drawer-title">${esc(cardTitle(d))}</h2>
            <span class="muted small">建立 ${shortTime(d.createdAt)} · ${esc(d.createdBy?.name || '')}</span></div>
          <button class="icon-btn modal-x" type="button" data-close-drawer aria-label="關閉">×</button>
        </div>
        <div class="drawer-body">
          ${d.type === NOTE ? `${d.mergedInto ? `<div class="merged-line">${mergedHtml(d)}</div>` : ''}<div class="lockbar"><span aria-hidden="true">🔒</span><span>AI 不會主動看到這張卡。下面的紀錄只存在卡片上，<b>不會發到群組</b>；你給 AI 卡號，它才讀得到卡片和紀錄。</span></div>` : ''}
          ${d.mergedFrom?.length ? `<div class="merged-line">整理自 ${d.mergedFrom.map(x => `<button type="button" class="merged-into" data-card="${esc(x)}">🔒${esc(x)}</button>`).join('、')}</div>` : ''}
          <div class="drawer-status">
            ${d.type === NOTE ? `<span class="dst" id="note-st-l">狀態</span><div class="seg-scope note-st" role="group" aria-labelledby="note-st-l">${[['進行中', '收集中'], ['已完成', '已整理']].map(([v, t]) => `<button type="button" data-act="note-st" data-st="${v}" aria-pressed="${(d.status === '已完成') === (v === '已完成')}">${t}</button>`).join('')}</div>` : `
            <span class="cst-pill" data-st="${esc(d.status)}">${esc(verifyingMe(d) ? '等你驗收' : d.status)}</span><span class="muted small">負責：${esc(d.owner?.name || '未指派')}${prevHandName(d) ? ` · ${esc(shortOf(prevHandName(d)))} 交來` : ''}</span>`}
            ${d.type === NOTE && canHandover(d) ? '<button class="btn small" type="button" data-act="handover">交接</button>' : ''}
          </div>
          ${d.type === NOTE ? '' : `<div class="rel-line" data-rel-card="${esc(d.cardId)}"></div>`}
          ${d.type === NOTE ? '' : nowActsHtml(d) + moreActsHtml(d, mine)}
          ${d.status === '已封存' ? (() => {
            const sys = (d.log || []).find(l => /^系統自動封存/.test(l.text));
            const why = sys ? `${mmdd(sys.at)} 系統自動封存（${mmdd(d.verified?.at || d.done?.at || sys.at)} 驗證完成，滿 ${ARCHIVE_DAYS} 天）。` : `${mmdd(d.updatedAt)} 已封存。`;
            return `<div class="arch-note" role="status">${why}內容和紀錄都還在，只是不在看板與 AI 預設查詢裡。
              <div class="row"><button class="btn small" type="button" data-act="reopen">重新打開（改回待處理）</button></div>
              <span class="muted small">重新打開後照一般卡片流程；再次完成＋驗證後重新計 ${ARCHIVE_DAYS} 天。</span></div>`;
          })() : ''}
          ${d.status === '已完成' && doneTag(d) && d.verified ? `<div class="dmarks">${doneTag(d)}<span class="muted small">${d.verified ? '已驗證：明天會自動收進已封存' : pendingDays(d) > ARCHIVE_DAYS ? '超過 7 天沒驗證，請驗證或退回' : '待驗證的卡不會自動收起'}</span></div>` : ''}
          ${(d.done || d.verified) && d.type !== NOTE ? `<div class="dmarks">
            ${d.verified ? `<span class="cmark ok-bg" title="${esc(doneTitle(d))}">✓ 已完成</span><span class="muted small">${esc(doneTitle(d))}</span>` : d.done ? `<span class="cmark wait" title="${esc(doneTitle(d))}">已完成 · 待驗收</span><span class="muted small">${esc(doneTitle(d))}</span>` : ''}
            ${mine && !d.verified ? '<span class="muted small">你是完成者，需由其他人或其他 AI 驗證。</span>' : ''}
          </div>` : ''}
          ${d.staleHint ? `<div class="stale-note" role="status"><b>可能過時</b><span class="small">卡片最後更新 ${esc(shortTime(d.staleHint.lastUpdatedAt))}，但之後 ${esc(shortTime(d.staleHint.latestMessageAt))} 有新的相關訊息。</span>${d.staleHint.latestMessageId ? `<button type="button" class="link small" data-stale-jump="${esc(d.staleHint.latestMessageId)}">看最新訊息</button>` : ''}</div>` : ''}
          ${d.type === NOTE ? handoverChain(d) : ''}
          ${d.type === '決策' && d.decision ? `<section class="ddecision"><h3>決策</h3><p class="dq">${esc(d.decision.question)}</p>${decisionBox(d)}${decisionStatus(d)}</section>` : ''}
          ${work.editing ? `
          <form id="card-edit" class="stack">
            <label>標題<input name="title" required maxlength="100" value="${esc(d.title)}"></label>
            ${d.type === '決策' ? '' : `<label>類型<select name="type">${['工作', '阻塞', NOTE].map(t => `<option ${d.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`}
            ${d.type === '決策' && !d.decision?.result ? `
            <label>決策問題<input name="question" required maxlength="200" value="${esc(d.decision.question)}"></label>
            <label>建議方案<textarea autocomplete="off" autocorrect="on" name="recommendation" rows="2" maxlength="500">${esc(d.decision.recommendation)}</textarea></label>
            <label>選項<textarea autocomplete="off" autocorrect="on" name="options" rows="2" placeholder="每行一個，最多 4 個；留白＝「同意」">${esc((d.decision.options || []).join('\n'))}</textarea></label>
            <label>影響<input name="impact" maxlength="200" value="${esc(d.decision.impact)}"></label>
            <label>決定後<input name="afterNext" maxlength="300" value="${esc(d.decision.afterNext)}"></label>
            <label>決策者<select name="deciderId">${[...state.participants.values()].filter(p => p.memberType === 'human' && p.status !== 'disabled').map(p => `<option value="${esc(p.participantId)}" ${d.decision.decider?.participantId === p.participantId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>` : ''}
            <label>專案<select name="project">${PROJECTS.map(p => `<option value="${esc(p)}" ${d.project === p ? 'selected' : ''}>${esc(projName(p))}</option>`).join('')}</select></label>
            <label>${d.type === NOTE ? '內容' : '原因'}<textarea autocomplete="off" autocorrect="on" name="reason" rows="2" maxlength="500">${esc(d.reason)}</textarea></label>
            <label>負責人<select name="ownerId">${peopleOpts(d.project, d.owner?.participantId, '未指派')}</select></label>
            <label>下一步<textarea autocomplete="off" autocorrect="on" name="next" rows="2" maxlength="300">${esc(d.next)}</textarea></label>
            <label>阻塞<input name="blocker" maxlength="300" value="${esc(d.blocker)}"></label>
            <label>等誰<select name="waitForId">${peopleOpts(d.project, d.waitFor?.participantId, '不用等人')}</select></label>
            <label>完成條件<textarea autocomplete="off" autocorrect="on" name="criteria" rows="2" maxlength="500">${esc(d.criteria)}</textarea></label>
            <div class="row end"><button class="btn" type="button" data-act="cancel-edit">取消</button><button class="btn primary" type="submit">儲存</button></div>
          </form>` : `
          <dl class="dfields">
            <dt>專案</dt><dd>${esc(projName(d.project) || '')}</dd>
            <dt>${d.type === NOTE ? '內容' : '原因'}</dt><dd class="${d.reason ? '' : 'muted'}">${esc(d.reason || '未填寫')}</dd>
            <dt>負責人</dt><dd>${ownerHtml(d)}</dd>
            <dt>下一步</dt><dd class="${d.next ? '' : 'muted'}">${esc(d.next || '未填寫')}</dd>
            <dt>阻塞與等誰</dt><dd class="${waitText(d) ? '' : 'muted'}">${esc(waitText(d) || '沒有阻塞')}</dd>
            <dt>完成條件</dt><dd class="${d.criteria ? '' : 'muted'}">${esc(d.criteria || '未填寫')}</dd>
          </dl>
          ${d.type === NOTE ? '<div><button class="btn small" type="button" data-act="edit">編輯</button></div>' : ''}`}
          <div class="group-title">相關訊息 · ${(d.messageIds || []).length}</div>
          ${msgs || '<p class="muted small">還沒有關聯訊息。</p>'}
          ${d.type === NOTE ? `<div class="group-title">紀錄 · ${(d.notes || []).length}</div>
            <div class="note-list">${(d.notes || []).map(n => `<div class="note-entry"><b>${esc(n.by?.name || '')}</b> <span class="muted small">${esc(shortTime(n.at))}</span><div>${esc(n.text)}</div></div>`).join('') || '<p class="muted small">還沒有紀錄。</p>'}</div>
            <div class="note-add"><textarea autocomplete="off" autocorrect="on" id="note-text" rows="2" maxlength="1000" placeholder="寫一筆紀錄（只存卡上，不發群組）" aria-label="寫一筆紀錄"></textarea><button type="button" class="btn primary" data-act="add-note">記下</button></div>`
          : !narrowMq.matches && !(d.type === '決策' && decidingMe(d) && !d.decision?.result) ? `<div class="group-title">想法與回覆</div>${inlineHtml('k:' + d.cardId, 'card', d)}` : ''}
          ${d.type === NOTE ? `<div class="group-title">變更紀錄</div>
          <ol class="dlog">${d.log.map(l => `<li><span class="ldot ${l.via === 'API' ? 'api' : ''}"></span><div><span>${esc(l.text)}</span><span class="muted small">${esc(l.by?.name || '')} · ${shortTime(l.at)} · ${esc(l.via)}</span></div></li>`).join('')}</ol>` : happenedHtml(d)}
        </div>
        ${state.page === 'messages' && d.type === NOTE ? `<div class="drawer-foot"><button class="btn primary" type="button" data-act="open-work">在工作頁開啟</button><button class="btn" type="button" data-act="copy-id">複製卡號</button></div>` : ''}
        ${narrowMq.matches && d.type !== NOTE && !(d.type === '決策' && decidingMe(d) && !d.decision?.result) ? `<div class="drawer-compose" aria-label="想法與回覆">${inlineHtml('k:' + d.cardId, 'card', d)}</div>` : ''}
      </aside>`;
    const humanOnlySel = isNote => host.querySelectorAll('#card-edit select[name="ownerId"], #card-edit select[name="waitForId"]').forEach(sel => { for (const o of sel.options) { const ai = state.participants.get(o.value)?.memberType === 'ai'; o.hidden = isNote && ai && !o.selected; } });
    humanOnlySel(d.type === NOTE);
    host.querySelector('#card-edit select[name="type"]')?.addEventListener('change', ev => humanOnlySel(ev.target.value === NOTE));
    host.querySelector('#card-edit')?.addEventListener('submit', async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target));
      for (const k of Object.keys(data)) data[k] = data[k].trim();
      const d0 = work.detail;
      if (data.type && d0 && data.type !== d0.type) { // C-218：改類型要確認
        const isAi = id => id && state.participants.get(id)?.memberType === 'ai';
        if (data.type === NOTE) {
          const who = [data.ownerId, data.waitForId].find(isAi);
          if (who) return toast(`${state.participants.get(who).name} 是 AI：請先改成人類負責人（等誰也是），才能改成人類紀錄。`);
          if (!await confirmDialog({ title: '改成人類紀錄？', confirmText: '改成人類紀錄', message: '改成人類紀錄後，AI 不會再主動看到這張卡。<br><span class="warn-text">但之前發到群組的相關訊息還在，AI 看過的收不回來。</span>' })) return;
        } else if (d0.type === NOTE) {
          let pub = true;
          const onChg = ev => { if (ev.target.id === 'pub-notes') pub = ev.target.checked; };
          document.addEventListener('change', onChg);
          const ok = await confirmDialog({ title: `改成${data.type}卡？`, confirmText: `改成${data.type}卡`, message: `改成${data.type}卡後，<b>AI 會主動看到、也會收到通知</b>：標題、內容、狀態，以及 ${(d0.notes || []).length} 筆紀錄。確定嗎？<label class="chk pub-notes"><input type="checkbox" id="pub-notes" checked> 紀錄一起公開（不勾＝紀錄刪掉，只公開卡片本身）</label>` });
          document.removeEventListener('change', onChg);
          if (!ok) return;
          data.publishNotes = pub;
        }
      }
      if (await patchCard(work.openId, data)) { work.editing = false; openCard(work.openId); toast('已儲存'); }
    });
    host.querySelectorAll('[data-inl-text^="k:"]').forEach(ta => { const c = work.cards.get(ta.dataset.inlText.slice(2)); const list = ta.parentElement.querySelector('.mention-list'); if (c && list) attachMention(ta, list, { candidates: cardMentionCandidates(c) }); });
    if (focus) host.querySelector('.modal-x').focus();
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && work.openId && document.body.classList.contains('drawer-docked') && !$('#modal-root').firstElementChild && !document.querySelector('.confirm-root') && !document.querySelector('#tag-menu:not([hidden])')) closeCard();
  });
  async function drawerClick(e) {
    if (e.target.closest('[data-close-drawer]')) return closeCard();
    const mg = e.target.closest('.merged-into[data-card]'); // C-218：已整理到／整理自 的卡號
    if (mg) return openCard(mg.dataset.card);
    const tg = e.target.closest('[data-dmsg-toggle]');
    if (tg) { work.openMsgs = work.openMsgs || new Set(); const id = tg.dataset.dmsgToggle; if (work.openMsgs.has(id)) work.openMsgs.delete(id); else work.openMsgs.add(id); return renderDrawer(false); }
    const j = e.target.closest('[data-jump-msg]');
    if (j) { const id = j.dataset.jumpMsg; if (!(state.page === 'messages' && dockedMode())) { closeCard(); showPage('messages'); } return jumpTo(id); }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const id = work.openId;
    if (a.dataset.act === 'open-work') { work.returnFocus = null; closeCard(); showPage('work'); return openCard(id); }
    if (a.dataset.act === 'copy-id') return copyText(id).then(ok => toast(ok ? `已複製 ${id}` : '複製失敗'));
    if (a.dataset.act === 'handover') return openHandover();
    if (a.dataset.act === 'log-all') { work.logAll = !work.logAll; return renderDrawer(false); }
    if (a.dataset.act === 'add-note') {
      const ta = $('#note-text'), t = ta?.value.trim();
      if (!t) return ta?.focus();
      try { const r = await api(`/api/cards/${encodeURIComponent(id)}/notes`, { method: 'POST', body: { text: t } }); work.detail.notes = r.notes; renderDrawer(false); $('#note-text')?.focus(); toast('已記下（只存卡上）'); } catch (err) { toast(err.message); }
      return;
    }
    if (a.dataset.act === 'edit') { work.editing = true; renderDrawer(false); work.detail && $('#card-edit [name=title]')?.focus(); }
    else if (a.dataset.act === 'cancel-edit') { work.editing = false; renderDrawer(false); }
    else if (a.dataset.act === 'done') patchCard(id, { status: '已完成' });
    else if (a.dataset.act === 'ver-ok') acceptCard(id); // C-242
    else if (a.dataset.act === 'ver-no') rejectCard(id);
    else if (a.dataset.act === 'note-st') { if (a.getAttribute('aria-pressed') !== 'true') await patchCard(id, { status: a.dataset.st }); } // C-226：已整理不必填去處
    else if (a.dataset.act === 'reopen') { await patchCard(id, { status: '待處理' }); refreshArchivedCount().then(renderWork); }
    else if (a.dataset.act === 'verify') {
      try {
        work.cards.set(id, await api(`/api/cards/${encodeURIComponent(id)}/verify`, { method: 'POST' }));
        renderWork(); openCard(id); toast('已標為已驗證');
      } catch (err) { toast(err.message); }
    }
  }

  // 新增卡片
  function openNewCard(sg, srcMsg) {
    const people = [...state.participants.values()].filter(p => p.status !== 'disabled');
    const p0 = singleProject() ? myProjects()[0] : [sg?.project, srcMsg?.project, projectView()].find(x => myProjects().includes(x)) || '';
    const opts = none => (p0 ? peopleOpts(p0, '', none) : `<option value="">${none}</option>`); // C-180：先選專案才列人
    const inProjNew = !!p0 && myProjects().includes(projectView()) && (!srcMsg?.project || srcMsg.project === projectView()) && (!sg?.project || sg.project === projectView()); // C-195：在專案內建卡，專案就是本專案
    const body = openModal(sg ? '編輯後採用建議' : srcMsg ? '從訊息建立卡片' : '新增卡片', `
      <form id="card-new-form" class="stack">
        ${srcMsg ? `<div class="info-box">來源訊息「${esc(srcMsg.author.name)} · ${shortTime(srcMsg.createdAt)}」會自動關聯到這張卡，無法移除。</div>` : ''}
        ${sg ? `<div class="warn-box">${esc(sg.from?.name || 'AI')} 的建議：${esc(sg.why)}</div>` : ''}
        <label>標題<input name="title" required maxlength="100" placeholder="一句話說明要做什麼"></label>
        ${inProjNew ? `<p class="muted small nc-proj">建在「${esc(projName(p0))}」</p>` : ''}
        <label ${inProjNew ? 'hidden' : ''}>專案（必填）<select name="project" required ${singleProject() ? 'disabled' : ''}>${singleProject() ? '' : '<option value="">請選擇專案</option>'}${myProjects().map(p => `<option value="${esc(p)}" ${(inProjNew ? p0 : srcMsg?.project || projectView()) === p ? 'selected' : ''}>${esc(projName(p))}</option>`).join('')}</select></label>
        <label>負責人<select name="ownerId">${opts('未指派')}</select></label>
        <div class="field"><span class="field-label" id="nt-label">類型</span>
          <div class="seg-scope full" role="group" aria-labelledby="nt-label">
            <button type="button" data-nt="工作" aria-pressed="true">工作</button><button type="button" data-nt="阻塞" aria-pressed="false">阻塞</button><button type="button" data-nt="決策" aria-pressed="false">決策</button><button type="button" data-nt="人類紀錄" aria-pressed="false">🔒 人類紀錄</button>
          </div><input type="hidden" name="type" value="工作"></div>
        <div class="lockbar" id="nc-note" hidden><span aria-hidden="true">🔒</span><span><b>AI 不會主動看到</b>：不出現在 AI 的看板、卡片清單、團隊狀態，也不發通知或群組訊息。你在訊息裡給 AI 卡號叫它看，它才讀得到（只能讀、不能改）。</span></div>
        <details id="nc-more" ${sg || srcMsg || store.get('aigile-switch-nc-more') === '1' ? 'open' : ''}><summary>更多欄位 ▾（原因、狀態、下一步、完成條件、等誰）</summary><div class="stack nc-more-body">
        <div id="nc-decision" class="stack" hidden>
          <label>決策問題<input name="question" maxlength="200" placeholder="留白＝同標題"></label>
          <label>建議方案<textarea autocomplete="off" autocorrect="on" name="recommendation" rows="2" maxlength="500" placeholder="你建議怎麼做、為什麼"></textarea></label>
          <label>選項<textarea autocomplete="off" autocorrect="on" name="options" rows="2" placeholder="每行一個，最多 4 個；留白＝「同意」"></textarea>
            <span class="field-hint">決策者另外一定能選「不同意」「要求補充」。</span></label>
          <div class="two-col">
            <label>影響<input name="impact" maxlength="200" placeholder="例如：UX、PG"></label>
            <label>決策者<select name="deciderId">${people.filter(p => p.memberType === 'human').map(p => `<option value="${esc(p.participantId)}" ${p.participantId === meId() ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
          </div>
          <label>決定後<input name="afterNext" maxlength="300" placeholder="決定後下一步是什麼"></label>
        </div>
        <label><span class="nc-reason-l">原因</span><textarea autocomplete="off" autocorrect="on" name="reason" rows="2" maxlength="500" placeholder="為什麼要做"></textarea></label>
        <label>狀態<select name="status">${['待整理', '待處理', '進行中'].map(s => `<option>${s}</option>`).join('')}</select></label>
        <label>下一步<textarea autocomplete="off" autocorrect="on" name="next" rows="2" maxlength="300"></textarea></label>
        <label>完成條件<textarea autocomplete="off" autocorrect="on" name="criteria" rows="2" maxlength="500"></textarea></label>
        <label>等誰<select name="waitForId">${opts('不用等人')}</select></label>
        </div></details>
        <p class="muted small">卡片內容所有成員都看得到，請勿填入內部路徑、程式碼或客戶個資。</p>
        <p class="error" id="card-new-error" role="alert"></p>
      </form>`, {
      size: 'form',
      foot: '<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit" form="card-new-form">建立卡片</button>',
    });
    const form = body.querySelector('#card-new-form');
    body.querySelector('#nc-more').addEventListener('toggle', e => store.set('aigile-switch-nc-more', e.target.open ? '1' : '0')); // C-195：展開狀態記在瀏覽器
    body.querySelectorAll('[data-nt]').forEach(b => b.addEventListener('click', () => {
      form.type.value = b.dataset.nt;
      body.querySelectorAll('[data-nt]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      const t = b.dataset.nt;
      form.status.disabled = t !== '工作' && t !== NOTE; // 阻塞固定為受阻、決策固定為待確認
      // C-218：人類紀錄——「原因」改叫「內容」並展開；負責人、等誰只列人類；預設進行中
      const isNote = t === NOTE;
      body.querySelector('#nc-note').hidden = !isNote;
      body.querySelector('.nc-reason-l').textContent = isNote ? '內容' : '原因';
      if (isNote) { body.querySelector('#nc-more').open = true; form.status.value = '進行中'; }
      form.status.closest('label').hidden = isNote; // C-226：人類紀錄建立時一律「收集中」
      for (const sel of [form.ownerId, form.waitForId]) { for (const o of sel.options) { const ai = state.participants.get(o.value)?.memberType === 'ai'; o.hidden = isNote && ai; o.disabled = isNote && ai; } if (sel.selectedOptions[0]?.disabled) sel.value = ''; }
      body.modal.querySelector('button[type="submit"]').textContent = isNote ? '建立人類紀錄' : '建立卡片';
      body.querySelector('#nc-decision').hidden = t !== '決策';
      if (t === '決策') body.querySelector('#nc-more').open = true; // 選「決策」自動展開決策欄位
      form.waitForId.closest('label').hidden = t === '決策'; // 決策卡固定等決策者
      for (const k of ['next', 'criteria']) form[k].closest('label').hidden = t === '決策';
    }));
    if (sg) { // 預填建議內容；決策類型與狀態不適用
      const c = sg.create;
      body.querySelector('[data-nt="決策"]').hidden = true;
      form.title.value = c.title; form.reason.value = c.reason || ''; form.next.value = c.next || ''; form.criteria.value = c.criteria || '';
      if (c.owner) form.ownerId.value = c.owner.participantId;
      if (c.waitFor) form.waitForId.value = c.waitFor.participantId;
      form.status.closest('label').hidden = true; form.status.disabled = true;
      if (c.type === '阻塞') body.querySelector('[data-nt="阻塞"]').click();
    }
    if (srcMsg) {
      const plain = srcMsg.text.replace(/^\s*\[[^\]\n]{1,40}\]\s?/, '').trim();
      form.title.value = plain.split('\n')[0].slice(0, 100);
      form.reason.value = plain.slice(0, 500);
    }
    const requestId = 'web_' + (crypto.randomUUID?.() || Date.now() + Math.random());
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      for (const k of Object.keys(data)) data[k] = data[k].trim();
      data.project = form.project.value; // 單一專案成員的欄位是 disabled，FormData 不會帶
      if (form.status.disabled) delete data.status;
      if (data.type !== '決策') for (const k of ['question', 'recommendation', 'options', 'impact', 'deciderId', 'afterNext']) delete data[k];
      else { delete data.waitForId; if (!data.options) data.options = []; else data.options = data.options.split('\n'); }
      if (!data.ownerId) delete data.ownerId;
      if (!data.waitForId) delete data.waitForId;
      try {
        const c = sg ? await api(`/api/suggestions/${encodeURIComponent(sg.suggestionId)}/apply`, { method: 'POST', body: { title: data.title, reason: data.reason, ownerId: data.ownerId ?? null, next: data.next, criteria: data.criteria, type: data.type, project: data.project, waitForId: data.waitForId ?? null } })
          : await api('/api/cards', { method: 'POST', body: { ...data, requestId, ...(srcMsg ? { messageIds: [srcMsg.messageId] } : {}) } });
        if (sg) await loadSuggestions();
        work.cards.set(c.cardId, c);
        closeModal();
        if (srcMsg) rememberLinks({ cardId: c.cardId, messageIds: [srcMsg.messageId] });
        renderWork();
        if (srcMsg) { const box = $('#messages'), top = box.scrollTop; renderMessages(false); box.scrollTop = top; }
        actionToast(`已建立 ${c.cardId} ·`, '打開', () => openCard(c.cardId));
        flashCard(c.cardId);
      } catch (err) { body.querySelector('#card-new-error').textContent = err.message; }
    });
  }

  // C-226：新卡捲到看得到的地方並閃一下（看板、工作總覽、清單）
  function flashCard(id) {
    requestAnimationFrame(() => {
      const el = [...document.querySelectorAll(`#page-work [data-card="${CSS.escape(id)}"]`)].find(x => x.offsetParent && x.matches('.ctile, .crow, .cmini, .wpanel-item'));
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    });
  }

  // ---------- 訊息上的授權列（C-105）：只給該 AI 的所屬人類；純前端判斷，送出的就是一般的 [回覆] 訊息 ----------
  const SHA40 = /\b[0-9a-f]{40}\b/g;
  const authPending = new Map(); // messageId → { text, requestId, busy, error }
  const poRole = r => ((state.participants.get(r.author.participantId) || r.author).roleKey) === 'PO';
  const myAiMsg = m => state.me?.memberType === 'human' && !m.file && (() => {
    const a = state.participants.get(m.author.participantId);
    return !!a && a.memberType === 'ai' && a.ownerParticipantId === meId();
  })();
  function authText(m, kind, sha) {
    if (kind === 'push') return `[回覆] 同意 push：${sha}`;
    if (kind === 'commit') return `[回覆] 同意 commit（針對第 ${m.sequence} 則），請附完整 40 碼 SHA`;
    return kind === 'ok' ? '[回覆] 同意照辦' : '[回覆] 暫緩處理';
  }
  const authBtn = (m, kind, label, sha, plain) => `<button type="button" class="btn auth-btn${plain ? ' plain' : ''}" data-auth="${kind}" data-asha="${sha || ''}" data-amsg="${esc(m.messageId)}">${label}</button>`;
  function authConfirm(m, p) {
    return `<div class="auth-confirm" role="group" aria-label="確認送出">
      <b>你將以自己的名義送出：</b>
      <div class="auth-text">${esc(p.text)}<span class="muted small">回覆 ${esc(m.author.name)} 那則；收件人 ${esc(m.author.name)}</span></div>
      ${p.text.includes('push') ? '<span class="muted small">授權只綁這個 SHA 與這一次；下次 push 需重新授權。</span>' : ''}
      ${p.error ? `<p class="error" role="alert">送出失敗：${esc(p.error)}　可按「重試」。</p>` : ''}
      <div class="row"><button type="button" class="btn primary" data-auth-send="${esc(m.messageId)}" ${p.busy ? 'disabled' : ''}>${p.error ? '重試' : '確認送出'}</button>
      <button type="button" class="btn" data-auth-cancel="${esc(m.messageId)}" ${p.busy ? 'disabled' : ''}>取消</button></div></div>`;
  }
  // ---------- C-132：[需確認] 快捷列——選項按鈕＋想法輸入框 ----------
  const quickMap = new Map(); // 訊息編號 → { sel, text, noOpts, busy, error }
  const quickState = id => { if (!quickMap.has(id)) quickMap.set(id, { sels: {}, text: '', busy: false, error: '' }); return quickMap.get(id); };
  const OPT_LETTER = /^\s*(?:[（(]([A-F])[）)]|([A-F])\s*[.、:：）)])\s*(\S.*)$/;
  const OPT_CIRCLE = /^\s*([①②③④⑤⑥])\s*(\S.*)$/;
  // C-148：只有「選項：」那一行之後緊接的 2～6 行 A.～F.／①～⑥ 才是選項；其他地方的 ①②③、1. 2. 都只是文字。
  // 每題用「問題N：」開頭（只有一題可省略），回傳 [{ no, title, opts: [{ key, label }] }]
  const OPT_HEAD = /^\s*選項\s*[:：]\s*$/;
  const Q_HEAD = /^\s*問題\s*(\d+)\s*[:：]\s*(.*)$/;
  function parseQuestions(text) {
    const lines = String(text).split('\n'), out = [];
    let lastQ = null, lastEnd = -1;
    for (let i = 0; i < lines.length; i++) {
      const qh = Q_HEAD.exec(lines[i]);
      if (qh) { lastQ = { no: Number(qh[1]), title: qh[2].trim(), at: i }; continue; }
      if (!OPT_HEAD.test(lines[i])) continue;
      const opts = [];
      let j = i + 1;
      for (; j < lines.length && opts.length < 7; j++) {
        const a = OPT_LETTER.exec(lines[j]), c = OPT_CIRCLE.exec(lines[j]);
        if (a) opts.push({ key: a[1] || a[2], label: a[3].trim() });
        else if (c) opts.push({ key: c[1], label: c[2].trim() });
        else break;
      }
      const keys = opts.map(o => o.key);
      if (opts.length >= 2 && opts.length <= 6 && new Set(keys).size === keys.length) {
        const q = lastQ && lastQ.at > lastEnd ? lastQ : null;
        out.push({ no: q ? q.no : out.length + 1, title: q ? q.title : '', opts, named: !!q });
        lastEnd = j - 1;
      }
      i = j - 1;
    }
    return out;
  }
  function quickHtml(m) {
    const q = quickState(m.messageId);
    const dcard = cardOfConfirm({ messageId: m.messageId });
    if (dcard?.decision.deferred) return `<div class="auth-row quick" data-q-root="${esc(m.messageId)}"><p class="small muted">決策卡 ${esc(dcard.cardId)} 暫緩中。要繼續請到「工作」打開決策卡按「恢復」。</p></div>`;
    if (dcard) { // 這則在講一張等我決定的決策卡：只送意見，或暫緩；選項與「同意」到決策卡上按
      const id = esc(m.messageId);
      return `<div class="auth-row quick" data-q-root="${id}"><p class="small muted">這是決策卡 ${esc(dcard.cardId)} 的說明；要決定請到<button type="button" class="link small" data-card="${esc(dcard.cardId)}">決策卡</button>。</p>
      <textarea autocomplete="off" autocorrect="on" class="inl-text" rows="2" maxlength="1500" data-q-text="${id}" placeholder="想說什麼都可以寫在這裡（Ctrl+Enter 只留言）" aria-label="輸入想法">${esc(q.text)}</textarea>
      <div class="inl-actions"><button type="button" class="btn small primary" data-q-send data-qm="${id}" ${q.busy || !q.text.trim() ? 'disabled' : ''}>${q.busy ? '送出中…' : '只留言，不決定'}</button>
        <button type="button" class="btn small" data-q-hold data-qm="${id}" ${q.busy ? 'disabled' : ''}>先擱著（暫緩）</button></div>
      <p class="muted small inl-note">留言會通知提案人；先擱著會移出收件匣，之後可在工作頁恢復。</p>
      ${q.error ? `<p class="error small" role="alert">送出失敗：${esc(q.error)}（內容還在，可以再試一次）</p>` : ''}</div>`;
    }
    const qs = parseQuestions(m.text);
    const id = esc(m.messageId);
    const missing = qs.filter((_, i) => !q.sels[i]).length, picked = qs.length - missing;
    const textOnly = qs.length === 1 && missing && q.text.trim(); // C-173：只有一題時，不選選項也能直接送出想法
    const sendLabel = !qs.length ? '同意照辦' : textOnly ? '送出想法' : missing ? (qs.length === 1 ? '先選一個選項' : `還有 ${missing} 題未選`) : qs.length > 1 ? `送出 ${qs.length} 題回覆` : `選 ${esc(q.sels[0])} 並送出`;
    const qBlock = (qq, i) => {
      const long = qq.opts.some(o => o.label.length > 16);
      const head = qs.length > 1 || qq.named ? `<div class="q-title" id="qt-${id}-${i}">問題${qq.no}${qq.title ? '　' + esc(qq.title) : ''}${picked && !q.sels[i] ? ' <span class="pill-tag yellow">未選</span>' : ''}</div>` : '';
      return `<div class="q-group" role="radiogroup" ${head ? `aria-labelledby="qt-${id}-${i}"` : 'aria-label="選項"'}>${head}
        <div class="q-opts${long ? ' vertical' : ''}">${qq.opts.map(o => `<button type="button" class="btn q-opt" role="radio" aria-checked="${q.sels[i] === o.key}" data-q-opt="${esc(o.key)}" data-qi="${i}" data-qm="${id}"><b>${esc(o.key)}</b><span>${esc(o.label)}</span></button>`).join('')}</div></div>`;
    };
    return `<div class="auth-row quick" data-q-root="${id}">
      ${qs.map(qBlock).join('')}
      <textarea autocomplete="off" autocorrect="on" class="inl-text" rows="2" maxlength="1500" data-q-text="${id}" placeholder="想說什麼都可以寫在這裡（Ctrl+Enter 送出）" aria-label="輸入想法">${esc(q.text)}</textarea>
      <div class="inl-actions">
        <button type="button" class="btn small primary" data-q-send data-qm="${id}" ${q.busy || (missing && !textOnly) ? 'disabled' : ''}>${q.busy ? '送出中…' : sendLabel}</button>
        <button type="button" class="btn small" data-q-hold data-qm="${id}" ${q.busy ? 'disabled' : ''}>暫緩處理</button>
      </div>
      ${q.error ? `<p class="error small" role="alert">送出失敗：${esc(q.error)}（內容還在，可以再試一次）</p>` : ''}</div>`;
  }
  async function quickSend(id, kind) {
    const m = state.byId.get(id), q = quickState(id);
    if (!m || q.busy) return;
    const dcard = cardOfConfirm({ messageId: id });
    if (dcard) {
      if (kind === 'send' && !q.text.trim()) return;
      q.busy = true; q.error = ''; refreshMsg(id);
      try {
        if (kind === 'hold') work.cards.set(dcard.cardId, await api(`/api/cards/${encodeURIComponent(dcard.cardId)}/defer`, { method: 'POST', body: { reason: q.text.trim(), version: dcard.version } }));
        else onNewMessage(await postMsg({ text: `[回覆] ${dcard.cardId}（決策意見）：${q.text.trim()}`, requestId: newRequestId(), replyToMessageId: id, cardId: dcard.cardId, recipientIds: [m.author.participantId] }));
        quickMap.delete(id); refreshMsg(id);
        toast(kind === 'hold' ? '已暫緩，決策卡已移出收件匣' : '已送出');
        await Promise.all([loadTeam().catch(() => {}), syncCards().catch(() => {})]); updateTodoBadge();
      } catch (err) { q.busy = false; q.error = err.message; refreshMsg(id); }
      return;
    }
    const qs = parseQuestions(m.text);
    const textOnly = kind === 'send' && qs.length === 1 && !q.sels[0] && q.text.trim();
    if (kind === 'send' && !textOnly && qs.some((_, i) => !q.sels[i])) return;
    const picks = qs.length === 1 && !qs[0].named ? `選 ${q.sels[0]}` : qs.map((qq, i) => `問題${qq.no} 選 ${q.sels[i]}`).join('；');
    const head = kind === 'hold' ? '暫緩處理' : qs.length ? picks : '同意照辦';
    const text = textOnly ? `[回覆] ${q.text.trim()}` : `[回覆] ${head}${q.text.trim() ? '。' + q.text.trim() : ''}`;
    q.busy = true; q.error = ''; refreshMsg(id);
    try {
      const r = await postMsg({ text, requestId: newRequestId(), replyToMessageId: id, recipientIds: [m.author.participantId] });
      quickMap.delete(id);
      if (state.page === 'inbox') { // C-195：收件匣裡回答：該項立刻淡出移走
        work.answered.add(id);
        const row = document.querySelector(`#page-work [data-conf-row="${CSS.escape(id)}"]`);
        if (row) row.classList.add('fading');
        setTimeout(() => { renderWork(); updateTodoBadge(); }, 250);
        onNewMessage(r);
        const t = $('#toast');
        t.innerHTML = '已回覆 <button type="button" class="link toast-undo" id="toast-go">到訊息看</button>';
        t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
        t.querySelector('#toast-go').onclick = () => { t.hidden = true; showPage('messages'); jumpTo(r.messageId); };
      } else { onNewMessage(r); refreshMsg(id); toast('已送出'); }
      loadTeam().then(() => { updateTodoBadge(); if (state.page === 'inbox') renderWork(); }).catch(() => {});
    } catch (err) {
      q.busy = false; q.error = err.message; refreshMsg(id);
    }
  }
  function quickClick(e) {
    const t = e.target;
    const opt = t.closest?.('[data-q-opt]');
    if (opt) { const q = quickState(opt.dataset.qm), i = Number(opt.dataset.qi); q.sels[i] = q.sels[i] === opt.dataset.qOpt ? undefined : opt.dataset.qOpt; refreshMsg(opt.dataset.qm); return true; }
    const send = t.closest?.('[data-q-send]');
    if (send) { if (!send.disabled) quickSend(send.dataset.qm, 'send'); return true; }
    const hold = t.closest?.('[data-q-hold]');
    if (hold) { if (!hold.disabled) quickSend(hold.dataset.qm, 'hold'); return true; }
    return false;
  }

  function authHtml(m, { inbox = false } = {}) {
    const owner = myAiMsg(m);
    const aiAuthor = (state.participants.get(m.author.participantId) || m.author).memberType === 'ai';
    if (!owner && !(state.me?.memberType === 'human' && !m.file && aiAuthor && (inbox || isToMe(m)) && /^\s*\[需確認\]/.test(m.text))) return '';
    const text = m.text, mineR = repliesOf(m.messageId).filter(isMine);
    const pend = authPending.get(m.messageId);
    const rows = [];
    // Push 授權列只給「程式開發（PG）AI 發的 [需確認]」；[完成]／[進度]／[通知] 就算含完整 SHA 也不顯示（C-140：事後會被誤按成再授權一次）
    const authorPG = (state.participants.get(m.author.participantId) || m.author).roleKey === 'PG';
    const pushAsk = owner && authorPG && /^\s*\[需確認\]/.test(text);
    const shas = pushAsk ? [...new Set(text.match(SHA40) || [])] : [];
    for (const sha of shas) {
      const sent = mineR.find(r => r.text.includes('同意 push：' + sha));
      if (sent) rows.push(`<div class="auth-row sent"><b>已授權 Push · ${shortTime(sent.createdAt)}</b><span class="muted small">僅限 ${sha.slice(0, 7)}…${sha.slice(-4)}</span></div>`);
      else if (pend && pend.key === 'push:' + sha) rows.push(authConfirm(m, pend));
      else rows.push(`<div class="auth-row"><span class="auth-title">授權此 SHA（${sha.slice(0, 7)}…${sha.slice(-4)}）</span>${authBtn(m, 'push', '同意 Push', sha)}</div>`);
    }
    if (pushAsk && !shas.length && /push/i.test(text) &&/\b(?=[0-9a-f]*\d)[0-9a-f]{7,39}\b/.test(text) && !mineR.some(r => /同意 push/.test(r.text))) {
      rows.push('<div class="auth-row hint">訊息沒有完整 40 碼 SHA，無法一鍵授權 push。請要求 AI 補上，或手動回覆。</div>');
    }
    if (!shas.length && /^\s*\[需確認\]/.test(text)) {
      // C-173：任何人類回覆都算已處理（和伺服器收件匣規則一致），選項區收起；自己的回覆優先顯示
      const humanR = repliesOf(m.messageId).filter(r => (state.participants.get(r.author.participantId) || r.author).memberType === 'human');
      const sent = humanR.find(isMine) || humanR[0];
      const answered = sent || repliesOf(m.messageId).some(r => !isMine(r) && poRole(r));
      const isPG = (state.participants.get(m.author.participantId) || m.author).roleKey === 'PG'; // Commit 授權只給程式開發 AI 的 [需確認]
      const hasCommit = owner && isPG && /commit/i.test(text);
      if (sent) rows.push(answeredHtml(m, sent));
      else if (pend && pend.key === 'need') rows.push(authConfirm(m, pend));
      else if (!answered) rows.push(hasCommit
        ? `<div class="auth-row"><span class="auth-title">授權 Commit</span>${authBtn(m, 'commit', '同意 Commit')}</div>`
        : quickHtml(m));
    }
    return rows.length ? `<div class="auth-box">${rows.join('')}</div>` : '';
  }
  // C-173：回覆裡寫了「選 A」「A」「問題1 選 B」就標出已選的選項
  function answerPicks(qs, body) {
    const t = body.trim(), picks = {};
    for (const x of t.matchAll(/問題\s*(\d+)\s*[:：]?\s*選?\s*([A-F①-⑥])/g)) {
      const i = qs.findIndex(q => q.no === Number(x[1]));
      if (i >= 0 && qs[i].opts.some(o => o.key === x[2])) picks[i] = x[2];
    }
    if (qs.length === 1 && !picks[0]) { const x = /^(?:選\s*)?([A-F①-⑥])(?![A-Za-z0-9])/.exec(t); if (x && qs[0].opts.some(o => o.key === x[1])) picks[0] = x[1]; }
    return picks;
  }
  function answeredHtml(m, r) {
    const body = r.text.replace(/^\s*\[回覆\]\s*/, '');
    const qs = parseQuestions(m.text), picks = answerPicks(qs, body);
    const chosen = qs.map((qq, i) => { const o = picks[i] && qq.opts.find(x => x.key === picks[i]); return o ? `<span class="ans-pick">${qs.length > 1 ? `問題${qq.no} ` : ''}<b>${esc(o.key)}</b> ${esc(o.label)}<span class="ans-tag">已選</span></span>` : ''; }).join('');
    return `<div class="auth-row sent answered"><button type="button" class="ans-jump" data-jump="${esc(r.messageId)}" title="跳到這則回覆"><b>已回覆：</b><span class="ans-text">${esc(oneLine(body, 60))}</span><span class="muted small">· ${esc(r.author.name)} · ${esc(shortTime(r.createdAt))}</span></button>${chosen ? `<div class="ans-picks">${chosen}</div>` : ''}</div>`;
  }
  // C-189：收件匣要顯示 [需確認] 的完整題目與選項，原文不在目前載入範圍的先抓回來（只放進 byId，不插進訊息串）
  async function loadConfirmMsgs() {
    const miss = legacyConfirms().map(d => d.messageId).filter(id => id && !state.byId.has(id)).slice(0, 20);
    await Promise.all(miss.map(id => api(`/api/messages/${encodeURIComponent(id)}`).then(m => { state.byId.set(id, m); }).catch(() => {})));
  }
  function refreshMsg(id) {
    if (state.page === 'inbox' && document.querySelector(`#page-work [data-q-root="${CSS.escape(id)}"], #page-work [data-conf-row="${CSS.escape(id)}"]`)) { // 收件匣裡的選項區：重畫收件匣、保留捲動位置
      const box = $('#page-work'), top = box.scrollTop, keep = document.activeElement?.dataset?.qText;
      renderWork(); box.scrollTop = top;
      if (keep) { const t = box.querySelector(`[data-q-text="${CSS.escape(keep)}"]`); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
    }
    const el = document.getElementById('msg-' + id);
    if (el && state.byId.has(id)) el.outerHTML = messageHtml(state.byId.get(id));
    document.getElementById('msg-' + id)?.querySelector('[data-auth-send]')?.focus();
  }
  function authClick(e) {
    if (quickClick(e)) return true;
    const go = e.target.closest('[data-auth]');
    if (go) {
      const m = state.byId.get(go.dataset.amsg);
      if (!m) return true;
      const kind = go.dataset.auth, sha = go.dataset.asha;
      authPending.set(m.messageId, { key: kind === 'push' ? 'push:' + sha : 'need', text: authText(m, kind, sha), requestId: newRequestId() });
      refreshMsg(m.messageId);
      return true;
    }
    const cancel = e.target.closest('[data-auth-cancel]');
    if (cancel) {
      const id = cancel.dataset.authCancel;
      authPending.delete(id); refreshMsg(id);
      document.getElementById('msg-' + id)?.querySelector('[data-auth]')?.focus();
      return true;
    }
    const send = e.target.closest('[data-auth-send]');
    if (send) {
      const id = send.dataset.authSend, m = state.byId.get(id), p = authPending.get(id);
      if (!m || !p || p.busy) return true;
      p.busy = true; p.error = ''; refreshMsg(id);
      postMsg({ text: p.text, requestId: p.requestId, replyToMessageId: id, recipientIds: [m.author.participantId] })
        .then(r => { authPending.delete(id); onNewMessage(r); refreshMsg(id); toast('已送出授權'); })
        .catch(err => {
          p.busy = false; p.error = err.message;
          if (err.code === 'IDEMPOTENCY_CONFLICT' || err.code === 'INVALID_REQUEST') p.requestId = newRequestId();
          refreshMsg(id);
        });
      return true;
    }
    return false;
  }
  // 這則訊息建過的卡（本機記住；也會在開啟卡片時補上）
  state.msgCards = new Map();
  function linkedCapsules(m) {
    const ids = state.msgCards.get(m.messageId);
    return ids?.size ? `<span class="linked">${[...ids].map(capsuleHtml).join(' ')}</span>` : '';
  }
  function rememberLinks(card) {
    for (const mid of card.messageIds || []) {
      if (!state.msgCards.has(mid)) state.msgCards.set(mid, new Set());
      state.msgCards.get(mid).add(card.cardId);
    }
  }

  // ---------- 輸入框標籤選單（C-105）----------
  // C-181：人類常用的放上面，每項附一句白話；「一般訊息」＝不加類型
  const TAGS = [['', '不加類型'], ['需確認', '要對方做決定'], ['回覆', '回應別人的問題'], ['接單', '我開始做了'], ['進度', '做到哪了'], ['受阻', '卡住了，需要幫忙'], ['完成', '做好了，請驗收'], ['通知', '讓大家知道一件事'], ['交接', '交給下一位接手']];
  const tagMenu = $('#tag-menu');
  let tagIdx = null; // null＝關閉
  const leadTagOf = v => (v.match(/^\s*\[([^\]\n]{1,40})\]/) || [])[1];
  function openTagMenu() {
    const cur = TAGS.findIndex(t => t[0] === (leadTagOf(input.value) || ''));
    tagIdx = cur >= 0 ? cur : 0;
    renderTagMenu();
  }
  function renderTagMenu() {
    const cur = leadTagOf(input.value) || '';
    tagMenu.innerHTML = TAGS.map(([t, hint], i) => `
      <li role="option" data-i="${i}" aria-selected="${cur === t}" class="${i === tagIdx ? 'active' : ''}"><b>${t ? `[${t}]` : '一般訊息'}</b><span class="muted small">${hint}${cur === t ? '（目前）' : ''}</span></li>`).join('');
    tagMenu.hidden = false;
    $('#tag-btn').setAttribute('aria-expanded', 'true');
  }
  function closeTagMenu() { tagIdx = null; tagMenu.hidden = true; $('#tag-btn').setAttribute('aria-expanded', 'false'); }
  function pickTag(i) {
    let v = input.value;
    v = v.replace(/^\s*\[[^\]\n]{0,40}\]?\s?/, ''); // 已有標籤（或只打了一半）就取代
    input.value = (TAGS[i][0] ? `[${TAGS[i][0]}] ` : '') + v;
    closeTagMenu();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    pendingRequestId = null;
    onInput();
  }
  tagMenu.addEventListener('mousedown', e => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); pickTag(Number(li.dataset.i)); }
  });
  $('#tag-btn').addEventListener('mousedown', e => e.preventDefault());
  $('#tag-btn').addEventListener('click', () => { if (tagIdx === null) { input.focus(); openTagMenu(); } else closeTagMenu(); });
  input.addEventListener('blur', () => setTimeout(closeTagMenu, 150));
  input.addEventListener('input', () => { if (input.value === '[' && tagIdx === null) openTagMenu(); else if (tagIdx !== null && !input.value.startsWith('[') && input.value !== '') closeTagMenu(); });
  input.addEventListener('keydown', e => {
    if (tagIdx === null || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopImmediatePropagation();
      tagIdx = (tagIdx + (e.key === 'ArrowDown' ? 1 : TAGS.length - 1)) % TAGS.length;
      return renderTagMenu();
    }
    if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); return pickTag(tagIdx); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeTagMenu(); }
  }, true);

  // 團隊：第一版先把四個既有畫面收進同一個入口（第二版再整合成一頁）
  function openTeamHub() {
    const body = openModal('團隊', `<div class="stack">
      <button type="button" class="btn hub-btn" data-hub="team-status"><b>團隊狀態</b><span class="muted small">每位成員目前在做什麼、誰在線、有沒有人卡住</span></button>
      <button type="button" class="btn hub-btn" data-hub="members"><b>成員名單</b><span class="muted small">誰在群組、誰在線</span></button>
      <button type="button" class="btn hub-btn" data-hub="my-ai"><b>我的 AI</b><span class="muted small">管理我名下的 AI、重發 Token</span></button></div>`, { size: 'narrow' });
    body.addEventListener('click', e => {
      const b = e.target.closest('[data-hub]'); if (!b) return;
      closeModal();
      ({ 'team-status': openTeam, members: openMembers, 'my-ai': openMyAi })[b.dataset.hub]();
    });
  }
  const openers = { team: openTeamHub, members: openMembers, 'my-ai': () => goTop('myai'), inbox: openInbox, files: () => showPage('files'), api: openApi, settings: openSettings, qr: openQr, 'proj-admin': () => goTop('perm') }; // C-182：專案管理併入「成員與權限」
  document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { closeSheet(false); openers[b.dataset.open](); }));
  // 手機選單（底部滑出）
  const sheet = $('#sheet');
  function openSheet() { sheet.hidden = false; $('#menu-btn').setAttribute('aria-expanded', 'true'); sheet.querySelector('.sheet-panel > button').focus(); }
  function closeSheet(refocus = true) {
    if (sheet.hidden) return;
    sheet.hidden = true; $('#menu-btn').setAttribute('aria-expanded', 'false');
    if (refocus) $('#menu-btn').focus();
  }
  $('#menu-btn').addEventListener('click', openSheet);
  sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });
  sheet.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
  $('#side-brand').addEventListener('click', () => { if (hasHub()) { closeSheet(false); setProjectView('hub'); } else showPage('messages'); }); // C-244：整列回我的專案

  // C-243：工作記憶裡的讀取位置 →「讀到：第 N 則・卡片到 10/17 20:30」
  const curSeq = c => { try { const b = String(c).slice(4).replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(atob(b + '==='.slice((b.length + 3) % 4))).s; } catch { return null; } };
  const posLine = st => { const n = st?.messagesCursor ? curSeq(st.messagesCursor) : null, c = st?.cardsSince; return n == null && !c ? '' : `<br><span class="muted small astate-pos">讀到：${[n != null ? `第 ${n} 則` : '', c ? `卡片到 ${fmtDate(c)}` : ''].filter(Boolean).join('・')}</span>`; };
  // ---------- 團隊狀態 ----------
  const STATE_LABEL = { working: '進行中', idle: '空閒', blocked: '卡住', waiting: '等人決定', todo: '待處理' };
  // 「等你決定」：訊息型的所有人都看；決策卡只給指定的決策者看
  work.answered = new Set(); // C-195：已經有人類回覆的 [需確認]，不等團隊狀態快取（約 1 分鐘）就先移走
  const myDecisions = t => t.decisions.filter(d => ((!d.cardId && !cardOfConfirm(d)) || d.deciderId === meId()) && !(d.messageId && work.answered.has(d.messageId)));
  const agoText = iso => {
    if (!iso) return '從未上線';
    const min = Math.floor((Date.now() - new Date(iso)) / 60000);
    if (min < 1) return '剛剛';
    if (min < 60) return `${min} 分鐘前`;
    if (min < 1440) return `${Math.floor(min / 60)} 小時前`;
    return `${Math.floor(min / 1440)} 天前`;
  };
  // 連線健康度：green 正常、yellow 可能斷線或 Token 快到期、red Token 已過期、grey 人類離線
  function health(mb) {
    if (mb.tokenExpired) return { cls: 'red', text: 'Token 已過期' };
    if (mb.memberType === 'ai' && mb.stale) return { cls: 'yellow', text: mb.lastSeenAt ? '可能斷線' : '尚未連線' };
    if (mb.tokenExpiringSoon) return { cls: 'yellow', text: 'Token 快到期' };
    if (mb.memberType === 'human' && !mb.isOnline) return { cls: 'grey', text: '離線' };
    if (mb.memberType === 'ai' && mb.standby) return { cls: 'green', text: '待命中' };
    return { cls: 'green', text: '正常' };
  }

  // 團隊狀態「尚未回應的指派」（C-153）：只有 AI，同一個 AI 合併一列，展開看各則訊息
  function unansweredByAi(list) {
    if (!list.length) return '';
    const by = new Map();
    for (const u of list) by.set(u.participantId, [...(by.get(u.participantId) || []), u]);
    const groups = [...by.values()].map(items => items.sort((a, b) => String(a.since).localeCompare(String(b.since))))
      .sort((a, b) => String(a[0].since).localeCompare(String(b[0].since)));
    return `<div class="group-title">尚未回應的指派 · ${groups.length} 個 AI</div>
      ${groups.map(items => `<details class="note-card red unans">
        <summary class="note-main"><span><b>${esc(items[0].name)}</b> <span class="red-text">· ${items.length} 則 · 最久 ${agoText(items[0].since).replace('前', '')}</span></span></summary>
        <ul class="unans-list">${items.map(u => `<li><span class="muted small">已等 ${agoText(u.since).replace('前', '')}</span> <button type="button" class="link small" data-jump-team="${esc(u.messageId)}">查看訊息</button></li>`).join('')}</ul>
      </details>`).join('')}`;
  }
  function unansweredTag(m) {
    const who = state.unansweredByMsg.get(m.messageId);
    return who?.length ? `<span class="tag unanswered" title="指派超過 ${state.team?.unansweredMinutes || 20} 分鐘仍未讀取">尚未回應：${who.map(esc).join('、')}</span>` : '';
  }

  async function loadTeam() {
    try {
      const t = await api('/api/team-status');
      state.team = t;
      const before = JSON.stringify([...state.unansweredByMsg]);
      const map = new Map();
      for (const u of t.unanswered) map.set(u.messageId, [...(map.get(u.messageId) || []), u.name]);
      state.unansweredByMsg = map;
      if (JSON.stringify([...map]) !== before) {
        const box = $('#messages');
        const keep = box.scrollTop;
        const atBottom = nearBottom();
        renderMessages(atBottom);
        if (!atBottom) box.scrollTop = keep;
      }
      renderTeamBar();
    } catch {}
  }

  // ---------- C-256 哪個 AI 正在作業 ----------
  // 在做：先看該 AI 負責、狀態「進行中」的卡；沒有才看最後的 [接單]／[進度]，超過 2 小時沒動靜改回待命
  // 待命：watcher 在線（或最近有呼叫）；離線：都沒有。資料全來自已載入的團隊狀態與卡片，不多查伺服器
  const AINOW_KEY = 'aigile-switch-ainow';
  const aiNowOn = () => store.get(AINOW_KEY) !== '0';
  const WORK_FRESH_MS = 2 * 3600_000;
  function aiNowOf(mb) {
    const pv = projectView(), inProj = PROJECTS.includes(pv);
    const card = [...(work.cards?.values() || [])].filter(c => c.owner?.participantId === mb.participantId && c.status === '進行中' && (!inProj || c.project === pv))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    if (card) return { kind: 'work', cardId: card.cardId, title: card.title };
    const s = mb.status;
    const sc = s && (s.cardId || cardIdOf(s.title)), scard = sc && work.cards?.get(sc);
    if (s && s.state === 'working' && s.source !== 'card' && Date.now() - Date.parse(s.at) < WORK_FRESH_MS && !(sc && (!scard || closedSt(scard.status)))) return { kind: 'work', cardId: sc, title: s.title }; // C-276：掛的卡已結案或沒載到（例如已封存）就不算在做
    if (mb.standby || mb.isOnline) return { kind: 'idle' };
    return { kind: 'off' };
  }
  function aiNowList() {
    if (!state.team) return [];
    const pv = projectView(), rank = { work: 0, idle: 1, off: 2 };
    return state.team.members
      .filter(mb => mb.memberType === 'ai' && inViewPerson(mb.participantId) && (!PROJECTS.includes(pv) || (mb.projects || state.participants.get(mb.participantId)?.projects || []).includes(pv)))
      .map(mb => ({ mb, now: aiNowOf(mb) }))
      .sort((a, b) => rank[a.now.kind] - rank[b.now.kind] || a.mb.name.localeCompare(b.mb.name, 'zh-Hant'));
  }
  const aiNowText = x => (x.now.kind === 'work' ? `在做${x.now.cardId ? ' ' + x.now.cardId : ''}` : x.now.kind === 'idle' ? '待命' : '離線');
  const aiNowBtn = x => `<button type="button" class="an-ai ${x.now.kind}" data-ainow="${esc(x.mb.participantId)}" title="${esc(x.now.title || '')}" aria-label="${esc(`${x.mb.name} ${aiNowText(x)}${x.now.title ? '：' + x.now.title : ''}，看團隊狀態`)}"><span class="an-dot" aria-hidden="true"></span><span class="an-name" title="${esc(x.mb.name)}">${esc(x.mb.name)}</span> <span class="an-st">${esc(aiNowText(x))}</span></button>`;
  function drawAiNow() {
    drawDmSide();
    const el = $('#ai-now');
    if (!el) return;
    const list = aiNowList();
    drawPresence(list);
    el.hidden = !aiNowOn() || !list.length || projectView() === 'hub';
    if (el.hidden) { el.innerHTML = ''; return; }
    const n = list.filter(x => x.now.kind === 'work').length;
    el.innerHTML = `<div class="an-strip" aria-label="AI 現況"><b class="an-lab">AI</b>${list.map(x => aiNowBtn(x)).join('')}<button type="button" class="link small an-team" data-ainow-team>團隊狀態 ›</button></div>
      <button type="button" class="an-chip" data-ainow-sheet><span class="an-dot ${n ? 'work' : 'idle'}" aria-hidden="true"></span>${n ? `${n} 個 AI 在做事` : 'AI 都沒在做事'} <span aria-hidden="true">›</span></button>`;
  }
  // ---------- C-270 私訊自己的 AI ----------
  // 只有本人與他名下的 AI 看得到；專案沒開就整區不出現。資料只在打開對話時讀
  const dmOn = pj => !!state.projectList.find(p => p.id === pj)?.dm?.on;
  const dmVisible = () => state.me?.memberType === 'human' && PROJECTS.includes(projectView()) && dmOn(projectView());
  const isMyAi = p => p && p.memberType === 'ai' && p.ownerParticipantId === meId();
  const myAisHere = () => [...state.participants.values()].filter(p => isMyAi(p) && p.status !== 'disabled' && (p.projects || []).includes(projectView()));
  const aiKind = id => { const mb = state.team?.members.find(m => m.participantId === id); return mb ? aiNowOf(mb).kind : 'off'; };
  const dmUnread = id => (work.notes || []).filter(n => n.dm && n.sender.participantId === id).length;
  // 這個專案可以看到私訊入口（有自己名下、在這專案的 AI）；沒開時入口淡色，點了說明怎麼開（C-270 退回）
  const dmEntry = () => state.me?.memberType === 'human' && PROJECTS.includes(projectView()) && myAisHere().length > 0;
  async function dmEnable() {
    const pv = projectView(), can = isAdmin() || myLeadProjects().includes(pv);
    if (!can) {
      const who = leadersOf(pv).map(id => state.participants.get(id)?.name).filter(Boolean);
      return confirmDialog({ title: '私訊還沒開放', confirmText: '知道了', cancelText: '關閉', message: `「<b>${esc(projName(pv))}</b>」還沒開放私訊自己的 AI。請專案 leader${who.length ? ` <b>${esc(who.join('、'))}</b>` : ''}或群組管理員 <b>${esc(state.projMeta.adminName || '')}</b> 打開。` });
    }
    const ok = await confirmDialog({ title: '打開私訊？', confirmText: '打開私訊', message: `打開後，「<b>${esc(projName(pv))}</b>」的成員可以在網頁、手機直接跟自己名下的 AI 講話。內容只有雙方看得到，你也看不到內容和數量。<br><span class="muted small">定案的事仍要寫回卡片。私訊存在平台資料庫，系統維護者技術上仍讀得到。之後可以在「成員與權限 → 專案 → ⋯」關掉。</span>` });
    if (!ok) return;
    try {
      await api(`/api/projects/${encodeURIComponent(pv)}/dm`, { method: 'PUT', body: { on: true } });
      await loadProjectList();
      drawAiNow();
      toast('已開放私訊');
      document.querySelectorAll('[data-dm-toggle]').forEach(el => { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); });
    } catch (err) { toast(err.message); }
  }
  function drawDmSide() {
    const entry = dmEntry(), on = entry && dmVisible(), ais = on ? myAisHere() : [];
    const n = ais.reduce((t, a) => t + dmUnread(a.participantId), 0);
    document.querySelectorAll('[data-fb-toggle]').forEach(b => { b.hidden = state.me?.memberType !== 'human'; }); // C-281
    document.querySelectorAll('[data-wishes]').forEach(b => { b.hidden = !state.me; });
    document.querySelectorAll('[data-dm-toggle]').forEach(b => {
      b.hidden = !entry;
      const bd = b.querySelector('.badge'); bd.hidden = !n; bd.textContent = n > 99 ? '99+' : n;
      b.setAttribute('aria-label', n ? `私訊，${n} 則未讀` : '私訊'); // C-279
    });
    if (!state.dmBooted && entry) { // 重新整理後：面板原本開著就照樣打開（舊的私訊網址也會打開）
      state.dmBooted = true;
      const s = store.get(DMP_KEY);
      if (state.dmOpenOnBoot || s) { if (!state.dmAi && s && s !== '-') state.dmAi = s; state.dmOpenOnBoot = false; dmPanel(true); }
    }
    if (dmIsOpen()) {
      if (!entry) dmPanel(false);
      else if (dm.aiId && !ais.some(a => a.participantId === dm.aiId)) { state.dmAi = null; renderDmPanel(); } // 換到沒有這個 AI 的專案
      else if (!state.dmAi) drawDmList(ais);
    }
    if (on && !(state.dmSumAt || {})[projectView()]) loadDmSummary();
  }
  // 清單的最後一句：每個專案開頁查一次；之後只在有私訊通知或打開對話時更新
  async function loadDmSummary() {
    state.dmSumAt = { ...(state.dmSumAt || {}), [projectView()]: Date.now() };
    try { const d = await api('/api/dm/summary'); state.dmSummary = new Map(d.items.map(x => [x.aiId, x])); drawDmSide(); } catch {}
  }
  const dm = { aiId: null, after: 0, items: [], canSend: true, reason: '', timer: null, wb: null, waitUntil: 0 };
  // C-272 頭像提案卡：現在 → 新的；只有被產圖的本人能按「套用為頭像」「不要」
  const apUrls = new Map();
  const apImg = id => { if (!apUrls.has(id)) apUrls.set(id, fetch(`/api/avatar-proposals/${encodeURIComponent(id)}/image`, { headers: { Authorization: `Bearer ${state.token}` } }).then(r => (r.ok ? r.blob() : null)).then(b => (b ? URL.createObjectURL(b) : null)).catch(() => null)); return apUrls.get(id); };
  const AP_LABEL = { applied: '✓ 已套用為頭像', skipped: '已略過，圖已刪掉', expired: '已過期（24 小時沒處理），圖已刪掉' };
  function apCard(d) {
    const p = d.proposal, note = d.text.replace(/^\[頭像提案 [^\]]+\]\s*/, '');
    const pending = p.status === 'pending', canAct = pending && state.me?.memberType === 'human';
    const who = p.forSelf ? (state.participants.get(d.from.participantId) || { ...d.from, memberType: 'ai' }) : state.me;
    return `<div class="ap-card${pending ? '' : ' done'}"><b>🖼 ${p.forSelf ? `${esc(d.from.name)} 自己的頭像提案` : '頭像提案'}</b>${note ? `<div class="ap-note">${esc(note)}</div>` : ''}
      ${pending ? `<div class="ap-row"><span class="ap-av" title="現在">${avatar(who)}</span><span aria-hidden="true">→</span><span class="avatar ${p.forSelf ? 'ai' : 'human'} ap-new" data-ap-img="${esc(p.proposalId)}" role="img" aria-label="新的頭像"></span></div>` : ''}
      ${canAct ? `<div class="ap-acts"><button type="button" class="btn small primary" data-ap-apply="${esc(p.proposalId)}">套用為頭像</button><button type="button" class="btn small" data-ap-skip="${esc(p.proposalId)}">不要</button><span class="muted small">${esc(fmtTime(p.expiresAt))} 前有效</span></div>` : `<span class="muted small">${AP_LABEL[p.status] || ''}</span>`}</div>`;
  }
  // C-270 退回④：今天只寫時分；同一人連續幾則只在最後一則寫時間
  const dmTime = iso => { const t = new Date(iso), hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; return t.toDateString() === new Date().toDateString() ? hm : `${t.getMonth() + 1}/${t.getDate()} ${hm}`; };
  // C-280 角色提案卡：名稱、代碼、五題可以直接改字；只有該專案 leader／管理員能按「建立角色」
  const RP_FIELDS = [['role', '名稱', 10], ['key', '代碼', 4], ['duties', '主要職責'], ['style', '溝通風格'], ['autonomy', '可自主處理'], ['mustConfirm', '要先問人'], ['handoff', '完成與交接']];
  const RP_LABEL = { skipped: '已略過', expired: '已過期（24 小時沒處理）' };
  dm.rpEdit = {};
  function rpCard(d) {
    const p = d.roleProposal, ed = dm.rpEdit[p.proposalId] || {}, v = k => ed[k] ?? p.draft[k] ?? '';
    const edit = p.canCreate, pending = p.status === 'pending', human = state.me?.memberType === 'human';
    const field = ([k, t, max]) => edit
      ? `<label class="rp-f"><span>${t}</span>${max ? `<input data-rp-f="${k}" maxlength="${max}" value="${esc(v(k))}"${k === 'key' ? ' autocapitalize="characters"' : ''}>` : `<textarea data-rp-f="${k}" rows="2" maxlength="1000">${esc(v(k))}</textarea>`}</label>`
      : `<div class="rp-f"><span>${t}</span><b>${esc(v(k))}</b></div>`;
    const acts = edit ? `<div class="ap-acts"><button type="button" class="btn small primary" data-rp-create="${esc(p.proposalId)}">建立角色</button><button type="button" class="btn small" data-rp-skip="${esc(p.proposalId)}">不要</button><span class="muted small">${esc(fmtTime(p.expiresAt))} 前有效</span></div>`
      : pending && human ? `<div class="ap-acts"><span class="muted small">只有「${esc(p.projectName)}」的 leader／管理員能按「建立角色」</span><button type="button" class="btn small" data-rp-skip="${esc(p.proposalId)}">不要</button></div>`
      : p.status === 'created' ? `<span class="muted small">✓ 已建立「${esc(p.draft.role)}」（${esc(p.createdKey || p.draft.key)}），在${esc(p.projectName)}的角色選單</span>` : `<span class="muted small">${RP_LABEL[p.status] || ''}</span>`;
    return `<div class="rp-card${pending ? '' : ' done'}" data-rp-card="${esc(p.proposalId)}"><div class="rp-head">🧩 角色提案 · 只用在「${esc(p.projectName)}」</div>
      <div class="rp-body">${RP_FIELDS.map(field).join('')}</div>${pending && p.conflict ? `<p class="rp-conflict" role="alert">⚠ ${esc(p.conflict)}</p>` : ''}${acts}</div>`;
  }
  function dmBubble(d, next) {
    const showT = !next || next.from.participantId !== d.from.participantId || !!next.proposal || !!d.proposal || !!next.roleProposal || !!d.roleProposal;
    if (d.roleProposal) return `<div class="dm-b ai rp-wrap" id="dm-${esc(d.dmId)}">${rpCard(d)}</div><div class="dm-t">${dmTime(d.createdAt)}</div>`;
    if (d.proposal) return `<div class="dm-b ai" id="dm-${esc(d.dmId)}">${apCard(d)}</div><div class="dm-t">${dmTime(d.createdAt)}</div>`;
    const mine = d.from.participantId === meId();
    const cards = mine ? [] : [...new Set(String(d.text).match(/\bC-\d{3,}\b/g) || [])];
    const wb = dm.wb && dm.wb.id === d.dmId;
    return `<div class="dm-b ${mine ? 'me' : 'ai'}" id="dm-${esc(d.dmId)}">${mine ? '' : `<div class="dm-name"><b>${esc(d.from.name)}</b></div>`}<div class="dm-text">${renderText(d.text)}</div>
      ${cards.map(c => `<button type="button" class="dm-wb" data-dm-wb="${esc(d.dmId)}" data-card-id="${c}">↗ 寫回 ${c}</button>`).join(' ')}
      ${wb ? `<div class="dm-wb-box"><label class="small">寫回 ${esc(dm.wb.card)} 的留言（發到群組時標「來自私訊」，可以先改字）<textarea id="dm-wb-text" rows="3" maxlength="1900">${esc(d.text)}</textarea></label>
        <div class="row end"><button type="button" class="btn small" data-dm-wb-cancel>取消</button><button type="button" class="btn small primary" data-dm-wb-go>寫回</button></div></div>` : ''}
      </div>${showT ? `<div class="dm-t ${mine ? 'me' : ''}">${dmTime(d.createdAt)}</div>` : ''}`;
  }
  function drawDm() {
    const list = $('#dm-list');
    if (!list) return false;
    const near = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const focus = document.activeElement?.closest?.('[data-rp-f]') ? { id: document.activeElement.closest('[data-rp-card]').dataset.rpCard, f: document.activeElement.dataset.rpF, s: document.activeElement.selectionStart } : null;
    list.innerHTML = dm.items.map((d, i) => dmBubble(d, dm.items[i + 1])).join('') || '<p class="muted small dm-empty">還沒有私訊。有新私訊會叫醒它。</p>';
    const mb = state.team?.members.find(m => m.participantId === dm.aiId), now = mb ? aiNowOf(mb) : { kind: 'off' };
    $('#dm-status').textContent = now.kind === 'work' ? `在做${now.cardId ? ' ' + now.cardId : ''}，下次醒來會先看私訊` : now.kind === 'idle' ? '待命，有新私訊會叫醒它' : '目前離線，上線後會看到';
    const ta = $('#dm-input'), sb = $('#dm-send');
    ta.disabled = sb.disabled = !dm.canSend;
    $('#dm-note').textContent = dm.canSend ? '' : dm.reason;
    if (near && !focus) list.scrollTop = list.scrollHeight;
    if (focus) { const el = list.querySelector(`[data-rp-card="${CSS.escape(focus.id)}"] [data-rp-f="${focus.f}"]`); if (el) { el.focus(); try { el.setSelectionRange(focus.s, focus.s); } catch {} } }
    list.querySelectorAll('[data-ap-img]').forEach(el => apImg(el.dataset.apImg).then(u => { if (u) { el.style.backgroundImage = `url("${u}")`; el.classList.add('img-on'); } }));
    return true;
  }
  // 清單的最後一句跟著目前對話更新（不另外查）；未處理的頭像提案寫「🖼 有頭像提案」（C-272）
  function dmSumFromItems() {
    const last = dm.items[dm.items.length - 1];
    if (!last) return false;
    if (!state.dmSummary) state.dmSummary = new Map();
    const pend = last.proposal?.status === 'pending';
    state.dmSummary.set(dm.aiId, { aiId: dm.aiId, fromMe: last.from.participantId === meId(), text: last.roleProposal ? (last.roleProposal.status === 'pending' ? '🧩 有角色提案' : '🧩 角色提案（已處理）') : last.proposal ? (pend ? '🖼 有頭像提案' : '🖼 頭像提案（已處理）') : String(last.text).slice(0, 80), proposalPending: pend, createdAt: last.createdAt });
    return true;
  }
  // C-270 退回①：同時只跑一個（開頁、計時器、送出後都會叫），換對話就作廢舊的；依 dmId 去重
  function dmLoad() {
    if (dm.loading && dm.loading.aiId === dm.aiId) return dm.loading.p;
    const aiId = dm.aiId, gen = dm.gen;
    const p = dmLoadOnce(aiId, gen).finally(() => { if (dm.loading?.p === p) dm.loading = null; });
    dm.loading = { aiId, p };
    return p;
  }
  async function dmLoadOnce(aiId, gen) {
    const d = await api(`/api/dm?aiId=${encodeURIComponent(aiId)}&after=${dm.after}`);
    if (gen !== dm.gen || aiId !== dm.aiId) return { items: [] }; // 這段對話已經換掉或重畫了
    const seen = new Set(dm.items.map(x => x.dmId));
    d.items = d.items.filter(x => !seen.has(x.dmId));
    dm.items.push(...d.items); dm.after = Math.max(dm.after, d.nextAfter || 0); dm.canSend = d.canSend; dm.reason = d.reason || '';
    if (dmSumFromItems() && d.items.length) drawDmSide();
    const before = (work.notes || []).length;
    work.notes = (work.notes || []).filter(n => !(n.dm && n.sender.participantId === dm.aiId)); // 伺服器已標已讀
    if (work.notes.length !== before) { updateTodoBadge(); drawDmSide(); }
    return d;
  }
  // C-270 A A：私訊在右側面板打開（每頁都能開、可一直開著；手機全螢幕）；重新整理後照樣開著
  const DMP_KEY = 'aigile-switch-dm-panel';
  const dmIsOpen = () => !!$('#dm-panel') && !$('#dm-panel').hidden;
  function dmPanel(open) {
    const el = $('#dm-panel');
    if (!el) return;
    if (open && !dmEntry()) open = false;
    if (open && fbIsOpen()) fbPanel(false);
    el.hidden = !open;
    document.body.classList.toggle('dm-open', open);
    document.querySelectorAll('[data-dm-toggle]').forEach(b => b.setAttribute('aria-expanded', String(open)));
    if (!open) {
      store.set(DMP_KEY, '');
      clearInterval(dm.timer); dm.gen = (dm.gen || 0) + 1; dm.loading = null; dm.aiId = null; // 關掉就停，不再看新私訊
      const box = $('#dm-box'); box.innerHTML = ''; box.dataset.h = '';
      return;
    }
    const tb = document.querySelector('.topbar'); // 桌面：面板接在頂欄下面；手機頂欄不顯示＝全螢幕
    document.documentElement.style.setProperty('--dmp-top', `${tb && tb.offsetParent ? Math.round(tb.getBoundingClientRect().bottom) : 0}px`);
    return renderDmPanel();
  }
  function openDm(aiId) {
    if (document.querySelector('#modal-root .modal')) closeModal();
    state.dmAi = aiId || null;
    return dmPanel(true);
  }
  const dmSum = () => state.dmSummary || new Map();
  const dmSorted = ais => [...ais].sort((a, b) => String(dmSum().get(b.participantId)?.createdAt || '').localeCompare(String(dmSum().get(a.participantId)?.createdAt || '')));
  const dmPreview = id => { const s = dmSum().get(id); return s ? (s.fromMe ? '你：' : '') + s.text : '還沒有私訊'; };
  // 清單：有對話的（含未讀）最多 3 個，其他收進「＋ 私訊其他 AI（n）」；沒開私訊就說明怎麼開
  function dmListHtml(ais) {
    if (!dmVisible()) return `<div class="dm-empty-page"><p class="muted">「${esc(projName(projectView()))}」還沒開放私訊自己的 AI。</p><button type="button" class="btn" data-dm-enable>看怎麼打開</button></div>`;
    if (!ais.length) return '<div class="dm-empty-page"><p class="muted">你在這個專案沒有自己的 AI。</p></div>';
    const sorted = dmSorted(ais), has = a => dmSum().has(a.participantId) || dmUnread(a.participantId);
    let top = sorted.filter(has).slice(0, 3);
    if (!top.length) top = sorted.slice(0, 3);
    const rest = sorted.filter(a => !top.includes(a));
    const row = a => { const u = dmUnread(a.participantId);
      return `<button type="button" class="dm-row" data-dm-open="${esc(a.participantId)}">${avatar(a)}<span class="dm-row-main"><b>${esc(a.name)}</b><span class="dm-prev">${esc(dmPreview(a.participantId))}</span></span>${u ? `<span class="dm-unread" aria-label="${u} 則未讀">${u}</span>` : ''}</button>`; };
    return `<div class="dm-listpage"><p class="muted small dm-lp-note">只有你和自己的 AI 看得到。</p>${top.map(row).join('')}${rest.length ? `<button type="button" class="dm-row dm-more" data-dm-more aria-expanded="${state.dmMore ? 'true' : 'false'}">${state.dmMore ? '－ 收起' : `＋ 私訊其他 AI（${rest.length}）`}</button>${state.dmMore ? rest.map(row).join('') : ''}` : ''}</div>`;
  }
  function drawDmList(ais) {
    const box = $('#dm-box'), h = dmListHtml(ais);
    if (box && box.dataset.h !== h) { box.dataset.h = h; box.innerHTML = h; }
  }
  async function renderDmPanel() {
    const box = $('#dm-box');
    if (!box) return;
    clearInterval(dm.timer);
    const ais = dmVisible() ? myAisHere() : [];
    const ai = state.dmAi && ais.find(a => a.participantId === state.dmAi);
    store.set(DMP_KEY, ai ? ai.participantId : '-');
    if (!ai) { state.dmAi = null; dm.gen = (dm.gen || 0) + 1; dm.loading = null; dm.aiId = null; drawDmList(ais); return drawDmSide(); }
    const gen = (dm.gen || 0) + 1; // 重畫一次就作廢上一次還沒回來的載入與計時器
    Object.assign(dm, { aiId: ai.participantId, after: 0, items: [], wb: null, gen, loading: null });
    box.dataset.h = '';
    box.innerHTML = `<div class="dm-page">
      <div class="dm-top"><button type="button" class="icon-btn dm-back" data-dm-back aria-label="回私訊清單">‹</button>${avatar(ai)}<div class="dm-who"><b>${esc(ai.name)}</b><span class="muted small">🔒 只有你和它看得到 · <span id="dm-status" role="status"></span></span><span class="muted small dm-tip">定案的事請寫回卡片，團隊才看得到</span></div></div>
      <div class="dm-list" id="dm-list" aria-live="polite"></div>
      <div class="dm-comp"><textarea id="dm-input" rows="2" maxlength="2000" placeholder="${esc(`私訊 ${ai.name}…`)}" aria-label="私訊內容"></textarea><button class="btn primary send" type="button" id="dm-send">送出</button></div>
      <p class="muted small" id="dm-note"></p></div>`;
    try { await dmLoad(); } catch (err) { return toast(err.message); }
    if (gen !== dm.gen) return; // 期間又重畫了，交給新的那次
    drawDm(); const l0 = $('#dm-list');
    if (l0) { // 直接開網址時頁面可能還沒顯示（高度 0）：等它有高度再捲到最新；使用者自己往上捲就不再拉回
      l0.scrollTop = l0.scrollHeight; let stick = true;
      l0.addEventListener('scroll', () => { stick = l0.scrollHeight - l0.scrollTop - l0.clientHeight < 80; }, { passive: true });
      if (window.ResizeObserver) new ResizeObserver(() => { if (stick) l0.scrollTop = l0.scrollHeight; }).observe(l0);
    }
    if (isDesktop()) $('#dm-input')?.focus();
    if (state.dmPrefill) { const ta = $('#dm-input'); if (ta && dm.canSend) { ta.value = state.dmPrefill; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } state.dmPrefill = null; } // C-272：從更換頭像來的預填
    drawDmSide();
    // 對話開著才每 10 秒看一次新私訊；關掉就停
    clearInterval(dm.timer); // 只留一個計時器
    dm.timer = setInterval(async () => { if (gen !== dm.gen) return; if (!$('#dm-list')) return clearInterval(dm.timer); if (document.hidden) return; try { const d = await dmLoad(); if (d.items.length) drawDm(); } catch {} }, 10_000);
  }
  document.addEventListener('input', e => {
    const f = e.target.closest?.('[data-rp-f]');
    if (!f) return;
    const id = f.closest('[data-rp-card]').dataset.rpCard;
    if (f.dataset.rpF === 'key') { const s = f.selectionStart; f.value = f.value.toUpperCase(); f.setSelectionRange(s, s); }
    (dm.rpEdit[id] = dm.rpEdit[id] || {})[f.dataset.rpF] = f.value;
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !dmIsOpen() || !e.target.closest?.('#dm-panel') || document.querySelector('#modal-root .modal, .confirm-root')) return;
    e.preventDefault(); dmPanel(false); document.querySelector('[data-dm-toggle]:not([hidden])')?.focus();
  });
  async function dmSend() {
    const ta = $('#dm-input'), text = ta.value.trim();
    if (!text || !dm.canSend) return;
    $('#dm-send').disabled = true;
    try {
      await api('/api/dm', { method: 'POST', body: { aiId: dm.aiId, text, requestId: newRequestId(), project: projectView() } });
      dm.waitUntil = Date.now() + 30 * 60_000; // 等它回：30 分鐘內收件匣每分鐘看一次
      ta.value = '';
      if (dm.loading) await dm.loading.p.catch(() => {}); // 還在跑的那次可能沒包含剛送的，等它跑完再載一次
      await dmLoad(); drawDm();
      const l = $('#dm-list'); if (l) l.scrollTop = l.scrollHeight;
    } catch (err) { toast(err.message); } finally { const sb = $('#dm-send'); if (sb) sb.disabled = !dm.canSend; }
  }
  document.addEventListener('click', async e => {
    const o = e.target.closest?.('[data-dm-open]');
    if (o) { if (o.closest('#sheet')) closeSheet(false); return openDm(o.dataset.dmOpen); }
    if (e.target.closest?.('[data-dm-more]')) { state.dmMore = !state.dmMore; return drawDmList(dmVisible() ? myAisHere() : []); }
    if (e.target.closest?.('[data-dm-toggle]')) { if (e.target.closest('#sheet')) closeSheet(false); return dmPanel(!dmIsOpen()); }
    if (e.target.closest?.('[data-dm-close]')) { dmPanel(false); return document.querySelector('[data-dm-toggle]:not([hidden])')?.focus(); }
    const en = e.target.closest?.('[data-dm-enable]');
    if (en) { if (en.closest('#sheet')) closeSheet(false); if (en.closest('#modal-root')) closeModal(); return dmEnable(); }
    if (e.target.closest?.('#dm-send')) return dmSend();
    if (e.target.closest?.('[data-dm-back]')) { state.dmAi = null; return renderDmPanel(); }
    const w = e.target.closest?.('[data-dm-wb]');
    if (w) { dm.wb = { id: w.dataset.dmWb, card: w.dataset.cardId }; drawDm(); return $('#dm-wb-text')?.focus(); }
    if (e.target.closest?.('[data-dm-wb-cancel]')) { dm.wb = null; return drawDm(); }
    const rp = e.target.closest?.('[data-rp-create], [data-rp-skip]'); // C-280
    if (rp) {
      const create = !!rp.dataset.rpCreate, id = rp.dataset.rpCreate || rp.dataset.rpSkip;
      const card = rp.closest('[data-rp-card]'), body = {};
      if (create) card.querySelectorAll('[data-rp-f]').forEach(f => { body[f.dataset.rpF] = f.value.trim(); });
      rp.disabled = true;
      try {
        const r = await api(`/api/role-proposals/${encodeURIComponent(id)}/${create ? 'create' : 'skip'}`, { method: 'POST', body });
        for (const it of dm.items) if (it.roleProposal?.proposalId === id) it.roleProposal = r.proposal;
        delete dm.rpEdit[id];
        if (dmSumFromItems()) drawDmSide();
        if (create) { await loadProjectList(); toast(`已建立「${r.proposal.draft.role}」，只在${r.proposal.projectName}的角色選單`); } else toast('已略過');
        drawDm();
      } catch (err) { rp.disabled = false; toast(err.message); }
      return;
    }
    const ap = e.target.closest?.('[data-ap-apply], [data-ap-skip]');
    if (ap) {
      const apply = !!ap.dataset.apApply, id = ap.dataset.apApply || ap.dataset.apSkip;
      ap.disabled = true;
      try {
        const r = await api(`/api/avatar-proposals/${encodeURIComponent(id)}/${apply ? 'apply' : 'skip'}`, { method: 'POST' });
        for (const it of dm.items) if (it.proposal?.proposalId === id) it.proposal = r.proposal;
        if (dmSumFromItems()) drawDmSide();
        if (apply && r.ai) { await loadParticipants(); renderMessages(false); drawDmSide(); const top = document.querySelector('.dm-top .avatar'); if (top) top.outerHTML = avatar(state.participants.get(r.ai.participantId) || r.ai); toast(`已換成 ${r.ai.name} 的新頭像；我的 AI › 編輯 › 頭像可以換回上一張`); }
        else if (apply) { await afterAvatar(r.me); toast('已換成新頭像；更換頭像裡可以換回上一張'); } else toast('已略過，圖已刪掉');
        drawDm();
      } catch (err) { ap.disabled = false; toast(err.message); }
      return;
    }
    if (e.target.closest?.('[data-dm-wb-go]')) {
      const t = $('#dm-wb-text')?.value.trim(), c = dm.wb?.card;
      if (!t || !c) return;
      try { await postMsg({ text: `[回覆] ${c}（來自私訊）：${t}`, cardId: c, requestId: newRequestId() }); toast(`已寫回 ${c}`); dm.wb = null; drawDm(); } catch (err) { toast(err.message); }
    }
  });
  document.addEventListener('keydown', e => { if (e.target.id === 'dm-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing && isDesktop()) { e.preventDefault(); dmSend(); } }); // 跟群組一樣：Enter 送出、Shift+Enter 換行
  // 側欄人數拆開：人類 N 在線 · AI N 在做事、N 待命
  function drawPresence(list) {
    if (!state.team) return;
    const humans = [...state.participants.values()].filter(p => p.memberType === 'human' && p.status !== 'disabled' && p.isOnline).length;
    const w = list.filter(x => x.now.kind === 'work').length, i = list.filter(x => x.now.kind === 'idle').length;
    document.querySelectorAll('.sb-presence-text').forEach(el => { el.innerHTML = `人類 ${humans} 在線<br>AI ${w} 在做事、${i} 待命`; });
  }
  function openAiNowSheet() {
    const list = aiNowList();
    openModal('AI 現況', `<div class="an-sheet">${list.map(x => aiNowBtn(x)).join('') || '<p class="muted">這個專案沒有 AI。</p>'}</div>`, { size: 'narrow', sub: '在做的排前面；點一個看團隊狀態' });
  }
  document.addEventListener('click', e => {
    if (e.target.closest?.('[data-ainow-sheet]')) return openAiNowSheet();
    const a = e.target.closest?.('[data-ainow]'), t = e.target.closest?.('[data-ainow-team]');
    if (!a && !t) return;
    if (a?.closest('.modal')) closeModal();
    work.teamTab = 'status';
    showPage('team');
    if (!a) return;
    const id = a.dataset.ainow, until = Date.now() + 3000;
    const seek = () => { const row = document.querySelector(`.tm-row[data-tm-id="${CSS.escape(id)}"]`); if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1600); } else if (Date.now() < until) setTimeout(seek, 150); };
    seek();
  });
  document.addEventListener('change', e => {
    if (e.target.id !== 'f-ainow' && e.target.id !== 'fs-ainow') return;
    store.set(AINOW_KEY, e.target.checked ? '1' : '0');
    drawAiNow();
  });
  function renderTeamBar() {
    const t = state.team;
    const bar = $('#team-bar');
    if (!t) { bar.hidden = true; return; }
    const chips = t.members.map(mb => {
      const h = health(mb);
      const st = mb.status ? STATE_LABEL[mb.status.state] : '';
      const tip = [mb.name, h.text, `最後上線 ${agoText(mb.lastSeenAt)}`, mb.status ? `${st}：${mb.status.title}` : '', mb.pendingCount ? `待處理通知 ${mb.pendingCount}` : ''].filter(Boolean).join('\n');
      return `<button type="button" class="chip h-${h.cls}" data-team title="${esc(tip)}">
        <span class="dot"></span><b>${esc(mb.name)}</b>${mb.environment ? `<span class="env-mini">${esc(mb.environment)}</span>` : ''}
        ${st ? `<span class="st st-${mb.status.state}">${st}</span>` : ''}
        <span class="muted">${mb.memberType === 'ai' ? agoText(mb.lastSeenAt) : (mb.isOnline ? '在線' : agoText(mb.lastSeenAt))}</span>
      </button>`;
    }).join('');
    const mdec = myDecisions(t);
    updateTodoBadge();
    // 收件匣開著時，團隊狀態更新（例如新的 [需確認]）也要反映；正在輸入時不重畫，避免失去焦點
    if (state.page === 'inbox' && work.loaded && !document.activeElement?.matches?.('[data-inl-text]')) renderWork();
    const dec = '';
    bar.innerHTML = dec + chips;
    bar.hidden = false;
    drawAiNow();
    // C-165：側欄「團隊」「設定」的紅點拿掉（受阻看今日總覽與工作頁，Token 問題看頂端警示列）
  }
  for (const el of [$('#team-bar')]) el.addEventListener('click', e => { if (e.target.closest('[data-team]')) openTeam(); });

  // AI 工作記憶（C-108）：AI 自己回報的目前任務與待辦；只在狀態改變時更新，依專案可見
  const stagePill = st => {
    const k = /受阻|卡住/.test(st) ? 'red' : /待確認|等/.test(st) ? 'amber' : 'blue';
    return `<span class="spill spill-${k}">${esc(st)}</span>`;
  };
  // C-188：專案內的團隊頁只列本專案的人；跨專案頻道、第一層列全部
  const inViewPerson = id => { const v = projectView(); return v === 'hub' || v === 'cross' || (state.participants.get(id)?.projects || []).includes(v); };
  function aiStateHtml(t) {
    const ais = t.members.filter(m => m.memberType === 'ai' && inViewPerson(m.participantId));
    if (!ais.length) return '';
    const WAKE = { watcher: 'watcher（被 @ 才醒）', cron: '定時輪詢', manual: '手動' };
    const rows = ais.map(m => {
      const s = m.aiState;
      const head = `<b>${esc(m.name)}</b> <span class="muted small">${esc([m.role, m.environment].filter(Boolean).join(' · '))}</span>`;
      if (!s) return `<div class="astate empty"><div>${head}<br><span class="small muted">○ 尚未同步</span></div><div class="muted small">此 AI 尚未回報工作狀態。可在群組請它同步，或看它負責的卡片。</div></div>`;
      const ct = s.currentTask;
      const sync = `${m.stale ? '◐ 可能離線' : '● 在線'} · ${agoText(s.updatedAt)}同步`;
      return `<details class="astate${ct ? ' on' : ''}"><summary>
        <div>${head}<br><span class="small ${m.stale ? 'warn-text' : 'ok-text'}">${sync}</span></div>
        <div>${ct ? `${ct.stage ? stagePill(ct.stage) : ''} <span>${esc(ct.title)}</span>${ct.cardId ? ` <button type="button" class="link small" data-open-card="${esc(ct.cardId)}">${esc(ct.cardId)}</button>` : ''}` : '<span class="muted">目前沒有進行中的任務</span>'}${posLine(s)}${m.stale ? '<br><span class="small warn-text">以下是最後同步的狀態，可能已變動。</span>' : ''}</div>
        <span class="muted small">待辦 ${s.backlog?.length || 0}</span></summary>
        <div class="astate-detail">
          <div class="small"><b>待辦（${s.backlog?.length || 0}）</b></div>
          ${(s.backlog || []).map(b => `<div class="astate-item">${esc(b.title)}${b.trigger ? `<br><span class="muted small">觸發：${esc(b.trigger)}</span>` : ''}</div>`).join('') || '<p class="muted small">沒有待辦。</p>'}
          <p class="muted small">最後同步 ${shortTime(s.updatedAt)}${s.wakeMode ? ` · 喚醒方式：${esc(WAKE[s.wakeMode] || s.wakeMode)}` : ''} · 僅在狀態改變時更新。行內／投信 AI 只寫任務標題與 SHA。</p>
        </div></details>`;
    }).join('');
    return `<div class="group-title">AI 工作記憶 · ${ais.filter(m => m.aiState).length}／${ais.length} 已同步</div><div class="astates">${rows}</div>`;
  }

  async function openTeam() {
    await loadTeam();
    const t = state.team;
    if (!t) return toast('無法取得團隊狀態');
    const pv = projectView();
    const rows = t.members.filter(mb => inViewPerson(mb.participantId)).map(mb => {
      const h = health(mb);
      const tokenCls = mb.tokenExpired ? 'bad' : mb.tokenExpiringSoon ? 'warn' : '';
      return `<div class="tm-row" data-tm-id="${esc(mb.participantId)}">
        <div class="tm-who"><span class="dot h-${h.cls}"></span><div><b>${esc(mb.name)}</b><span class="muted small">${esc(roleIn(mb, pv))}${mb.memberType === 'ai' ? ' · AI' : ''}</span></div></div>
        <div class="tm-conn"><span class="tm-health h-${h.cls}">${h.text}</span><span class="muted small">最後上線 ${agoText(mb.lastSeenAt)}</span></div>
        <div class="tm-state">${mb.status ? `<span class="st st-${mb.status.state}">${STATE_LABEL[mb.status.state]}</span> <button type="button" class="link" ${mb.status.cardId ? `data-open-card="${esc(mb.status.cardId)}"` : `data-jump-team="${esc(mb.status.messageId)}"`}>${esc(mb.status.title || '（無標題）')}</button>${mb.status.cardCount > 1 ? `<span class="muted small"> · 共 ${mb.status.cardCount} 張</span>` : ''}${mb.status.source === 'card' ? '<span class="muted small"> · 取自卡片</span>' : ''}` : '<span class="muted">—</span>'}</div>
        <div class="tm-pend muted small${mb.pendingCount ? '' : ' zero'}">${mb.pendingCount ? `待處理 ${mb.pendingCount} 則 · 最久 ${agoText(mb.oldestPendingAt).replace('前', '')}` : '待處理 0'}</div>
        <div class="tm-token small ${tokenCls}">${mb.memberType === 'ai' ? `Token ${fmtTime(mb.tokenExpiresAt)}${mb.tokenExpired ? ' 已過期' : mb.tokenExpiringSoon ? ' 快到期' : ''}` : ''}</div>
      </div>`;
    }).join('');
    const body = openModal('團隊狀態', `
      <details class="help"><summary>狀態怎麼判斷？</summary>
        <p>有負責未完成卡片的人，取自卡片（受阻 > 待確認 > 進行中 > 待處理，並標「取自卡片」）；沒有卡片的人，依最新一則訊息的開頭標籤推斷：[接單]／[進度]＝進行中，[完成]／[回覆]／[交接]＝空閒，[受阻]＝卡住，[需確認]＝等人決定。沒照標籤發文時可能不準。AI 超過 ${t.staleMinutes} 分鐘沒出現會標示「可能斷線」（用 watcher 待命的 AI 放寬到 60 分鐘，並顯示「待命中」）；AI 被指派超過 ${t.unansweredMinutes} 分鐘沒讀取會列入「尚未回應」，同一個 AI 合併一列（人類不列，請看收件匣）。</p>
      </details>
      <p class="muted small">要你決定、確認或採用的事都在<button type="button" class="link" data-goto-inbox>收件匣</button>，這裡只看團隊狀況。</p>
      ${unansweredByAi(t.unanswered)}
      <div class="group-title">成員</div>
      <div class="tm-list">${rows}</div>`, { size: 'wide', sub: '依每人最新一則訊息的開頭標籤推斷目前工作。' });
    body.addEventListener('click', async e => {
      const oc = e.target.closest('[data-open-card]');
      if (oc) { closeModal(); showPage('work'); openCard(oc.dataset.openCard); return; }
      const j = e.target.closest('[data-jump-team]');
      if (j) { closeModal(); jumpTo(j.dataset.jumpTeam); return; }
      const r = e.target.closest('[data-resolve]');
      if (r) {
        r.disabled = true;
        try {
          await api(`/api/decisions/${encodeURIComponent(r.dataset.resolve)}/resolve`, { method: 'POST' });
          toast('已從收件匣移出');
          openTeam();
        } catch (err) { r.disabled = false; toast(err.message); }
      }
    });
  }

  // 成員名單：分「近期活躍」「離線／閒置」兩組
  const avatarDot = p => `<span class="avatar-wrap">${avatar(p)}<span class="presence-dot ${p.isOnline ? 'on' : ''}" aria-label="${p.isOnline ? '近期活躍' : '離線或閒置'}"></span></span>`;
  async function openMembers() {
    const items = (await loadParticipants()).filter(p => inViewPerson(p.participantId)); // C-188
    const online = items.filter(p => p.isOnline).length;
    const body = openModal('成員名單', `
      <input id="member-q" type="search" placeholder="搜尋姓名、角色或代碼" aria-label="搜尋成員">
      <div id="member-list"></div>`, { sub: `${items.length} 人 · 近期活躍 ${online} · 燈號是 30 秒內的活動估計，不是即時連線。` });
    const row = p => {
      const self = p.participantId === meId();
      const line2 = p.memberType === 'ai'
        ? ['AI', p.ownerName ? `所屬 ${p.ownerName}` : '', p.environment].filter(Boolean).join(' · ')
        : ['人類', p.environment].filter(Boolean).join(' · ');
      return `<div class="mem-row">
        ${avatarDot(p)}
        <div class="mem-main">
          <div class="mem-name"><b title="代號（AI 用來找你）：${esc(p.shortCode)}">${esc(p.name)}</b>${myProjects().includes(projectView()) ? leaderTag(p.participantId, projectView()) : ''}<span class="muted small">${esc(roleIn(p, projectView()))}</span></div>
          <div class="muted small">${esc(line2)}</div>
          ${p.duties ? `<div class="mem-duty muted small">${esc(p.duties)}</div>` : ''}
        </div>
        ${self ? '<span class="self">本人</span>' : `<button class="btn small" type="button" data-mention="${esc(p.name)}">@ 提及</button>`}
      </div>`;
    };
    const draw = () => {
      const q = body.querySelector('#member-q').value.trim().toLowerCase();
      const list = items
        .filter(p => !q || [p.name, p.role, p.shortCode, p.ownerName].some(v => (v || '').toLowerCase().includes(q)))
        .sort((a, b) => (a.participantId === meId() ? -1 : b.participantId === meId() ? 1 : 0) || (a.memberType === b.memberType ? 0 : a.memberType === 'human' ? -1 : 1));
      const on = list.filter(p => p.isOnline), off = list.filter(p => !p.isOnline);
      body.querySelector('#member-list').innerHTML = list.length
        ? (on.length ? `<div class="group-title">近期活躍 · ${on.length}</div>${on.map(row).join('')}` : '')
          + (off.length ? `<div class="group-title">離線／閒置 · ${off.length}</div>${off.map(row).join('')}` : '')
        : '<p class="muted">找不到符合的成員。</p>';
    };
    body.querySelector('#member-q').addEventListener('input', draw);
    body.addEventListener('click', e => {
      const b = e.target.closest('[data-mention]');
      if (!b) return;
      const tag = '@' + b.dataset.mention + ' ';
      input.value = (input.value && !/\s$/.test(input.value) ? input.value + ' ' : input.value) + tag;
      closeModal();
      input.focus();
      onInput();
    });
    draw();
  }

  // 我的 AI
  async function loadRoles() {
    if (!state.roles) state.roles = await api('/api/roles');
    return state.roles;
  }

  // C-182：第一層「我的 AI」頁：名下所有 AI，不分專案
  // ---------- C-281 回報問題＋許願池 ----------
  const fb = { tab: 'report', shots: [], wishes: null, reports: null, repAt: 0, repOpen: true, repDone: false, draft: {} };
  const FB_INSIDE = () => ['行內', '投信'].includes(state.me?.environment);
  const fbIsOpen = () => !!$('#fb-panel') && !$('#fb-panel').hidden;
  function fbPanel(open) {
    const el = $('#fb-panel');
    if (!el) return;
    if (open && dmIsOpen()) dmPanel(false);
    el.hidden = !open;
    document.body.classList.toggle('dm-open', open || dmIsOpen());
    document.querySelectorAll('[data-fb-toggle]').forEach(b => b.setAttribute('aria-expanded', String(open)));
    if (!open) return;
    const tb = document.querySelector('.topbar');
    document.documentElement.style.setProperty('--dmp-top', `${tb && tb.offsetParent ? Math.round(tb.getBoundingClientRect().bottom) : 0}px`);
    drawFb();
    if (fb.tab === 'wish' && !fb.wishes) loadWishes().then(() => { if (fb.tab === 'wish') { fbKeep(); drawFb(); } });
    setTimeout(() => $('#fb-title')?.focus(), 0);
  }
  const fbDevice = () => {
    const u = navigator.userAgent;
    const os = /iPhone|iPad/.test(u) ? (/iPad/.test(u) ? 'iPad' : 'iPhone') : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac OS X/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : '';
    const br = /Edg\//.test(u) ? 'Edge' : /Chrome\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : '';
    return [os, br].filter(Boolean).join(' ') || '未知';
  };
  const fbPage = () => (TOP_PAGES[state.page] ? PAGE_NAME[state.page] : [viewLabel(projectView()), projectView() === 'hub' ? '' : PAGE_NAME[state.page] || '訊息'].filter(Boolean).join(' › '));
  const fbErr = () => (state.lastErr && Date.now() - state.lastErr.at < 30 * 60_000 ? state.lastErr.code : '');
  const fbContext = () => ({ page: fbPage(), version: APP_VERSION, device: fbDevice(), at: new Date().toLocaleString('zh-TW', { hour12: false }), errorCode: fbErr() });
  function drawFb() {
    const box = $('#fb-box');
    if (!box) return;
    const tabs = `<div class="fb-tabs" role="tablist" aria-label="回報或許願"><button type="button" role="tab" data-fb-tab="report" aria-selected="${fb.tab === 'report'}">🐞 回報問題</button><button type="button" role="tab" data-fb-tab="wish" aria-selected="${fb.tab === 'wish'}">✨ 許個願</button></div>`;
    const d = fb.draft;
    if (fb.tab === 'report') {
      box.innerHTML = tabs + `<form class="fb-form" id="fb-report" novalidate>
        <label>哪裡怪怪的？（一句話）<input id="fb-title" maxlength="100" required placeholder="例：手機按送出沒反應" value="${esc(d.title || '')}"></label>
        <label>發生什麼（選填）<textarea id="fb-detail" rows="3" maxlength="2000" placeholder="我做了什麼、預期看到什麼…">${esc(d.detail || '')}</textarea></label>
        <div class="fb-lbl">截圖（選填，貼上或拖進來）</div>
        <button type="button" class="fb-drop" id="fb-drop">📎 Ctrl+V 貼上 或 點一下選圖 · 每張 1 MB 內（太大會自動壓縮）· 最多 3 張 · 保存 30 天</button>
        <input type="file" id="fb-file" accept="image/png,image/jpeg,image/webp" multiple hidden>
        ${fb.shots.length ? `<div class="fb-shots">${fb.shots.map((s, i) => `<span class="fb-shot"><img src="${s.url}" alt="截圖 ${i + 1}"><button type="button" class="icon-btn" data-fb-unshot="${i}" aria-label="拿掉截圖 ${i + 1}">×</button></span>`).join('')}</div>` : ''}
        ${FB_INSIDE() ? `<div class="fb-warn">⚠ 不要貼內部資料、程式碼、客戶個資<label class="chk"><input type="checkbox" id="fb-declare"${d.declared ? ' checked' : ''}> 我確認截圖不含以上內容</label></div>` : ''}
        <button type="submit" class="btn primary fb-send">送出回報</button>
        <p class="muted small">送出後只有平台團隊看得到；不會另外通知你進度。</p></form>`;
    } else {
      box.innerHTML = tabs + `<form class="fb-form" id="fb-wish" novalidate>
        <button type="button" class="link fb-wishlink" data-wishes>✨ 看許願池${fb.wishes ? `（${fb.wishes.length} 個願望）` : ''} ›</button>
        <label>你想要什麼？<input id="fb-title" maxlength="100" required placeholder="例：卡片可以設提醒時間" value="${esc(d.wish || '')}"></label>
        <div id="fb-similar" aria-live="polite"></div>
        <label>為什麼（選填）<textarea id="fb-why" rows="2" maxlength="1000" placeholder="讓我們知道對你有多重要">${esc(d.why || '')}</textarea></label>
        <button type="submit" class="btn primary fb-send">許這個新願望</button></form>`;
      drawFbSimilar();
    }
  }
  // 相似願望：兩字一組比對，有重疊就列出來（最多 3 個）
  const bigrams = s => { const t = String(s).toLowerCase().replace(/[\s，。、！？,.!?：:「」]/g, ''); const out = new Set(); for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2)); if (t.length === 1) out.add(t); return out; };
  function similarWishes(q) {
    const a = bigrams(q);
    if (a.size < 2 || !fb.wishes) return [];
    return fb.wishes.map(w => { const b = bigrams(w.title); let n = 0; for (const x of a) if (b.has(x)) n++; return { w, s: n / Math.min(a.size, b.size || 1) }; })
      .filter(x => x.s >= 0.34).sort((x, y) => y.s - x.s || y.w.votes - x.w.votes).slice(0, 3).map(x => x.w);
  }
  const WISH_CLS = { 收到: 's1', 評估中: 's2', 排入: 's5', 已上線: 's3', 先不做: 's4' };
  const wishSt = w => `<span class="wst ${WISH_CLS[w.status] || ''}">${esc(w.status === '排入' && w.cardId ? `排入 ${w.cardId}` : w.status)}</span>`;
  const wishRow = (w, { full = false } = {}) => `<div class="wish${w.status === '先不做' ? ' off' : ''}"><button type="button" class="wish-plus${w.voted ? ' on' : ''}" data-wish-vote="${esc(w.wishId)}" aria-pressed="${w.voted}" aria-label="${esc(`${w.voted ? '取消 +1' : '+1'}：${w.title}，目前 ${w.votes}`)}"><b>${w.voted ? '✓' : '+1'}</b>${w.votes}</button>
    <div class="wish-main"><b>${esc(w.title)}</b> ${wishSt(w)}${full ? `<div class="muted small">${[w.project?.name, mmdd(w.createdAt), w.voted ? '你已 +1' : ''].filter(Boolean).map(esc).join(' · ')}${w.status === '先不做' && w.statusNote ? ` · 原因：${esc(w.statusNote)}` : ''}</div>${w.why ? `<div class="small wish-why">${esc(w.why)}</div>` : ''}` : ''}</div>
    ${full && fb.canEdit ? `<button type="button" class="link small" data-wish-edit="${esc(w.wishId)}">改狀態</button>` : ''}</div>`;
  function drawFbSimilar() {
    const el = $('#fb-similar');
    if (!el) return;
    const list = similarWishes($('#fb-title')?.value || '');
    el.innerHTML = list.length ? `<p class="small">有人許過類似的，<b>+1 就好</b>：</p>${list.map(w => wishRow(w)).join('')}` : '';
  }
  async function loadWishes() {
    try { const d = await api('/api/wishes'); fb.wishes = d.items; fb.canEdit = d.canEdit; } catch (err) { toast(err.message); }
  }
  async function addShots(files) {
    for (const f of files) {
      if (fb.shots.length >= 3) { toast('最多 3 張截圖'); break; }
      if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { toast('截圖只接受 png、jpg、webp'); continue; }
      let blob = f;
      if (f.size > 1024 * 1024) blob = await shrinkShot(f); // 太大先壓縮
      if (!blob || blob.size > 1024 * 1024) { toast('截圖壓縮後還是超過 1 MB，請裁小一點'); continue; }
      fb.shots.push({ blob, url: URL.createObjectURL(blob) });
    }
    fbKeep(); drawFb();
  }
  function shrinkShot(file) {
    return new Promise(resolve => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = async () => {
        URL.revokeObjectURL(url);
        for (const [max, q] of [[1920, 0.85], [1600, 0.75], [1280, 0.6]]) {
          const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
          c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          const b = await new Promise(r => c.toBlob(r, 'image/webp', q));
          if (b && b.size <= 1024 * 1024) return resolve(b);
        }
        resolve(null);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  // 打字先記著（切分頁、重畫都不會丟）
  function fbKeep() {
    const v = id => $(id)?.value;
    if (fb.tab === 'report') { if ($('#fb-title')) Object.assign(fb.draft, { title: v('#fb-title'), detail: v('#fb-detail'), declared: !!$('#fb-declare')?.checked }); }
    else if ($('#fb-title')) Object.assign(fb.draft, { wish: v('#fb-title'), why: v('#fb-why') });
  }
  async function sendReport() {
    fbKeep();
    const d = fb.draft, title = (d.title || '').trim();
    if (!title) { toast('請寫一句話說哪裡怪怪的'); return $('#fb-title')?.focus(); }
    if (fb.shots.length && FB_INSIDE() && !d.declared) { toast('附截圖要先勾「我確認截圖不含以上內容」'); return $('#fb-declare')?.focus(); }
    const btn = $('#fb-report .fb-send'); btn.disabled = true;
    try {
      const pv = projectView();
      const r = await api('/api/reports', { method: 'POST', body: { title, detail: d.detail || '', project: PROJECTS.includes(pv) ? pv : undefined, context: fbContext() } }); // C-281 退回：頁面、版本、裝置、時間、錯誤代碼照樣自動附上，面板不列出
      let failed = 0;
      for (const s of fb.shots) {
        const res = await fetch(`/api/reports/${encodeURIComponent(r.reportId)}/shots${FB_INSIDE() ? '?declared=1' : ''}`, { method: 'POST', headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': s.blob.type || 'image/webp' }, body: s.blob }).catch(() => null);
        if (!res || !res.ok) failed++;
      }
      fb.shots.forEach(s => URL.revokeObjectURL(s.url));
      Object.assign(fb, { shots: [], draft: {} });
      drawFb();
      toast(`已送出 ${r.reportId}，謝謝！${failed ? `（${failed} 張截圖沒傳上去）` : ''}平台團隊會整理。`);
    } catch (err) { toast(err.message); } finally { const b = $('#fb-report .fb-send'); if (b) b.disabled = false; }
  }
  async function sendWish() {
    fbKeep();
    const d = fb.draft, title = (d.wish || '').trim();
    if (!title) { toast('請寫你想要什麼'); return $('#fb-title')?.focus(); }
    const btn = $('#fb-wish .fb-send'); btn.disabled = true;
    try {
      const pv = projectView();
      const w = await api('/api/wishes', { method: 'POST', body: { title, why: d.why || '', project: PROJECTS.includes(pv) ? pv : undefined } });
      fb.wishes = [w, ...(fb.wishes || [])];
      fb.draft = {};
      drawFb();
      toast(`已許願 ${w.wishId}，大家都看得到、可以 +1`);
    } catch (err) { toast(err.message); } finally { const b = $('#fb-wish .fb-send'); if (b) b.disabled = false; }
  }
  async function voteWish(id) {
    const w = (fb.wishes || []).find(x => x.wishId === id);
    try {
      const v = await api(`/api/wishes/${encodeURIComponent(id)}/vote`, { method: w?.voted ? 'DELETE' : 'POST' });
      fb.wishes = (fb.wishes || []).map(x => (x.wishId === id ? v : x));
      if (state.page === 'wishes') drawWishesPage();
      drawFbSimilar();
    } catch (err) { toast(err.message); }
  }
  // 許願池頁：所有登入的人；依 +1 或最新排序、狀態篩選；平台團隊可以改狀態
  function openWishes() { if (state.page !== 'wishes') fb.back = { view: state.view, page: state.page }; return goTop('wishes'); } // C-290
  async function renderWishesPage() {
    const box = $('#page-work');
    box.classList.remove('is-board');
    box.innerHTML = '<p class="muted">載入中…</p>';
    await loadWishes();
    drawWishesPage();
  }
  function drawWishesPage() {
    const box = $('#page-work');
    if (state.page !== 'wishes' || !fb.wishes) return;
    const sort = fb.wSort || 'votes', st = fb.wSt || '';
    const list = fb.wishes.filter(w => !st || w.status === st).sort((a, b) => (sort === 'votes' ? b.votes - a.votes : 0) || String(b.createdAt).localeCompare(String(a.createdAt)));
    box.innerHTML = `<button type="button" class="link wish-back" data-wishes-back>‹ 返回</button><div class="work-head"><div class="work-title"><h2>✨ 許願池</h2><span class="muted small">${fb.wishes.length} 個願望 · 所有登入的人看得到、可以 +1${fb.canEdit ? ' · 你可以改狀態（平台團隊）' : ''}</span></div>
      <button type="button" class="btn primary" data-fb-open="wish">＋ 許個願</button></div>
      <div class="work-filters"><select id="wish-sort" aria-label="排序"><option value="votes"${sort === 'votes' ? ' selected' : ''}>依 +1</option><option value="new"${sort === 'new' ? ' selected' : ''}>最新</option></select>
      <select id="wish-st" aria-label="狀態"><option value="">全部狀態</option>${Object.keys(WISH_CLS).map(s => `<option${st === s ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
      <section class="wpanel wish-list">${list.map(w => wishRow(w, { full: true })).join('') || '<p class="muted">還沒有願望。按「＋ 許個願」許第一個。</p>'}</section>
      <p class="muted small">問題回報不會出現在這裡，只有平台團隊看得到。</p>`;
  }
  function editWish(id) {
    const w = fb.wishes.find(x => x.wishId === id);
    if (!w) return;
    const body = openModal(`改狀態 · ${w.title}`, `<form id="wish-form" class="stack">
      <label>狀態<select name="status">${['收到', '評估中', '排入', '先不做'].map(s => `<option${(w.status === s || (s === '排入' && w.status === '已上線')) ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
      <label>排入的工作卡（排入時必填，例：C-290；卡完成會自動顯示「已上線」）<input name="cardId" value="${esc(w.cardId || '')}" placeholder="C-xxx"></label>
      <label>原因（先不做時必填）<input name="statusNote" maxlength="200" value="${esc(w.statusNote || '')}"></label>
      <p class="error small" id="wish-err" role="alert"></p></form>`, { size: 'narrow', foot: '<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit" form="wish-form">儲存</button>' });
    body.querySelector('#wish-form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        const v = await api(`/api/wishes/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: f.status, cardId: f.status === '排入' ? f.cardId.trim().toUpperCase() : null, statusNote: f.statusNote } });
        fb.wishes = fb.wishes.map(x => (x.wishId === id ? v : x)); closeModal(); drawWishesPage(); toast('已改狀態');
      } catch (err) { body.querySelector('#wish-err').textContent = err.message; }
    });
  }
  // 平台工作頁的回報區（只有平台團隊；打開工作頁才讀）
  const fbTeamView = () => projectView() === '平台' && (state.me?.projects || myProjects()).includes('平台') && state.page === 'work';
  async function loadReports() {
    fb.repAt = Date.now();
    try { const d = await api('/api/reports'); fb.reports = d.items; if (fbTeamView()) { const el = $('#rep-strip'); if (el) el.outerHTML = reportsHtml(); } } catch {}
  }
  const SEV_CLS = { 嚴重: 'sev-hi', 一般: 'sev-mid', 小: 'sev-lo' };
  function reportsHtml() {
    if (!fbTeamView()) return '';
    if (!fb.reports) return '<section id="rep-strip" class="rep-strip"><div class="rep-head"><b>🐞 回報</b><span class="muted small">載入中…</span></div></section>';
    const open = fb.reports.filter(r => r.status === '未整理'), done = fb.reports.filter(r => r.status !== '未整理');
    const ctx = r => [r.reporter.name, r.reporterProject?.name && r.context.page ? r.context.page : r.reporterProject?.name || r.context.page, r.context.device, r.context.version && `v${r.context.version}`, r.context.errorCode && `錯誤 ${r.context.errorCode}`, r.shots.length && `📎${r.shots.length}`].filter(Boolean).map(esc).join(' · ');
    const row = r => `<div class="rep-row" data-rep="${esc(r.reportId)}"><div class="rep-main"><span class="sev ${SEV_CLS[r.severity] || 'sev-no'}">${esc(r.severity || '未標')}</span> <b>${esc(r.reportId)} ${esc(r.title)}</b>${r.status !== '未整理' ? ` <span class="wst s4">${esc(r.status === '已轉工作卡' || r.status === '已修好' ? `${r.status} ${r.cardId}` : r.status === '已合併' ? `合併到 ${r.mergedInto}` : r.status)}</span>` : ''}
      <div class="muted small">${ctx(r)} · ${esc(fmtTime(r.createdAt))}${r.context.version ? ` · <button type="button" class="link small" data-rel-ver="${esc(r.context.version)}">看 v${esc(r.context.version)} 改了什麼</button>` : ''}</div>${r.detail ? `<div class="small rep-detail">${esc(r.detail)}</div>` : ''}</div>
      <div class="rep-acts">${r.shots.length ? `<button type="button" class="link small" data-rep-shots="${esc(r.reportId)}">看截圖</button>` : ''}${r.status === '未整理' ? `<select data-rep-sev="${esc(r.reportId)}" aria-label="${esc(r.reportId)} 嚴重度">${['', '嚴重', '一般', '小'].map(s => `<option value="${s}"${r.severity === s ? ' selected' : ''}>${s || '標嚴重度'}</option>`).join('')}</select>
        <button type="button" class="link small" data-rep-card="${esc(r.reportId)}">轉工作卡</button><button type="button" class="link small" data-rep-merge="${esc(r.reportId)}">合併到…</button><button type="button" class="link small" data-rep-skip="${esc(r.reportId)}">先不處理</button>` : `<button type="button" class="link small" data-rep-reopen="${esc(r.reportId)}">改回未整理</button>`}</div></div>`;
    return `<section id="rep-strip" class="rep-strip"><div class="rep-head"><button type="button" class="link rep-toggle" data-rep-toggle aria-expanded="${fb.repOpen}"><b>🐞 回報 · 未整理 ${open.length}</b></button><span class="muted small">只有平台團隊看得到；回報的人不會收到進度通知</span></div>
      ${fb.repOpen ? (open.map(row).join('') || '<p class="muted small rep-empty">沒有未整理的回報。</p>') + (done.length ? `<button type="button" class="link small rep-more" data-rep-done>${fb.repDone ? '收起已整理的' : `看已整理的（${done.length}）`}</button>${fb.repDone ? done.map(row).join('') : ''}` : '') : ''}</section>`;
  }
  const redrawReports = () => { const el = $('#rep-strip'); if (el) el.outerHTML = reportsHtml(); };
  async function patchReport(id, body) {
    const v = await api(`/api/reports/${encodeURIComponent(id)}`, { method: 'PATCH', body });
    fb.reports = fb.reports.map(r => (r.reportId === id ? v : r)); redrawReports();
    return v;
  }
  async function showShots(id) {
    const r = fb.reports.find(x => x.reportId === id);
    const body = openModal(`${id} 的截圖`, `<div class="rep-shots">${r.shots.map(s => `<a target="_blank" rel="noopener" data-shot="${esc(s.id)}"><img alt="截圖" data-shot-img="${esc(s.id)}"></a>`).join('')}</div><p class="muted small">截圖保存 30 天後自動刪除。</p>`, { size: 'form' });
    for (const s of r.shots) {
      const res = await fetch(`/api/reports/${encodeURIComponent(id)}/shots/${encodeURIComponent(s.id)}`, { headers: { Authorization: `Bearer ${state.token}` } }).catch(() => null);
      if (!res?.ok) continue;
      const u = URL.createObjectURL(await res.blob());
      const im = body.querySelector(`[data-shot-img="${CSS.escape(s.id)}"]`); if (im) { im.src = u; im.closest('a').href = u; }
    }
  }
  async function reportToCard(id) {
    const r = fb.reports.find(x => x.reportId === id);
    if (!await confirmDialog({ title: `${id} 轉成工作卡？`, confirmText: '建立工作卡', message: `在平台建一張「${esc(id)} ${esc(r.title)}」工作卡（待整理），回報會連到這張卡；卡完成時回報顯示「已修好」。` })) return;
    try {
      const c = r.context, reason = [`來自回報 ${id}（${r.reporter.name}${r.reporterProject ? '，' + r.reporterProject.name : ''}）`, r.detail, [c.page, c.device, c.version && 'v' + c.version, c.errorCode && '錯誤 ' + c.errorCode].filter(Boolean).join(' · ')].filter(Boolean).join('\n').slice(0, 500);
      const card = await api('/api/cards', { method: 'POST', body: { requestId: newRequestId(), project: '平台', type: '工作', title: `${id} ${r.title}`.slice(0, 100), reason } });
      await patchReport(id, { cardId: card.cardId });
      await loadCards().catch(() => {});
      toast(`已建 ${card.cardId}，${id} 連到這張卡`);
    } catch (err) { toast(err.message); }
  }
  function mergeReport(id) {
    const others = fb.reports.filter(x => x.reportId !== id && x.status !== '已合併');
    if (!others.length) return toast('沒有別的回報可以合併');
    const body = openModal(`${id} 合併到哪一則？`, `<div class="an-sheet">${others.map(o => `<button type="button" class="dm-row" data-merge-to="${esc(o.reportId)}"><span class="dm-row-main"><b>${esc(o.reportId)} ${esc(o.title)}</b><span class="dm-prev">${esc(o.status)}</span></span></button>`).join('')}</div>`, { size: 'narrow', sub: '重複的回報合併後，只要處理被合併到的那一則' });
    body.addEventListener('click', async e => { const b = e.target.closest('[data-merge-to]'); if (!b) return; closeModal(); try { await patchReport(id, { mergedInto: b.dataset.mergeTo }); toast(`${id} 已合併到 ${b.dataset.mergeTo}`); } catch (err) { toast(err.message); } });
  }
  document.addEventListener('click', async e => {
    const t = e.target;
    if (t.closest?.('[data-fb-toggle]')) { if (t.closest('#sheet')) closeSheet(false); return fbPanel(!fbIsOpen()); }
    if (t.closest?.('[data-fb-close]')) { fbPanel(false); return document.querySelector('[data-fb-toggle]:not([hidden])')?.focus(); }
    const op = t.closest?.('[data-fb-open]');
    if (op) { fbKeep(); fb.tab = op.dataset.fbOpen; return fbPanel(true); }
    const tab = t.closest?.('[data-fb-tab]');
    if (tab) { fbKeep(); fb.tab = tab.dataset.fbTab; drawFb(); if (fb.tab === 'wish' && !fb.wishes) { await loadWishes(); if (fb.tab === 'wish') { fbKeep(); drawFb(); } } return $(`[data-fb-tab="${fb.tab}"]`)?.focus(); }
    if (t.closest?.('#fb-drop')) return $('#fb-file')?.click();
    const un = t.closest?.('[data-fb-unshot]');
    if (un) { fbKeep(); const [s] = fb.shots.splice(Number(un.dataset.fbUnshot), 1); if (s) URL.revokeObjectURL(s.url); return drawFb(); }
    const wv = t.closest?.('[data-wish-vote]');
    if (wv) return voteWish(wv.dataset.wishVote);
    const we = t.closest?.('[data-wish-edit]');
    if (we) return editWish(we.dataset.wishEdit);
    if (t.closest?.('[data-wishes]')) { if (t.closest('#sheet')) closeSheet(false); fbKeep(); fbPanel(false); return openWishes(); }
    if (t.closest?.('[data-wishes-back]')) { const b = fb.back; fb.back = null; return b && b.page !== 'wishes' ? (b.view && b.view !== state.view ? setProjectView(b.view, b.page) : showPage(b.page)) : setProjectView('hub'); }
    if (t.closest?.('[data-rep-toggle]')) { fb.repOpen = !fb.repOpen; return redrawReports(); }
    if (t.closest?.('[data-rep-done]')) { fb.repDone = !fb.repDone; return redrawReports(); }
    const rs = t.closest?.('[data-rep-shots]'); if (rs) return showShots(rs.dataset.repShots);
    const rc = t.closest?.('[data-rep-card]'); if (rc) return reportToCard(rc.dataset.repCard);
    const rm = t.closest?.('[data-rep-merge]'); if (rm) return mergeReport(rm.dataset.repMerge);
    const rk = t.closest?.('[data-rep-skip], [data-rep-reopen]');
    if (rk) { const id = rk.dataset.repSkip || rk.dataset.repReopen; try { await patchReport(id, { status: rk.dataset.repSkip ? '先不處理' : '未整理' }); } catch (err) { toast(err.message); } }
  });
  document.addEventListener('change', async e => {
    const sv = e.target.closest?.('[data-rep-sev]');
    if (sv) { try { await patchReport(sv.dataset.repSev, { severity: sv.value }); } catch (err) { toast(err.message); } return; }
    if (e.target.id === 'fb-file') { await addShots([...e.target.files]); e.target.value = ''; return; }
    if (e.target.id === 'wish-sort') { fb.wSort = e.target.value; return drawWishesPage(); }
    if (e.target.id === 'wish-st') { fb.wSt = e.target.value; return drawWishesPage(); }
    if (e.target.id === 'fb-declare') fbKeep();
  });
  document.addEventListener('input', e => { if (e.target.closest?.('#fb-box')) { fbKeep(); if (e.target.id === 'fb-title' && fb.tab === 'wish') drawFbSimilar(); } });
  document.addEventListener('submit', e => {
    if (e.target.id === 'fb-report') { e.preventDefault(); return sendReport(); }
    if (e.target.id === 'fb-wish') { e.preventDefault(); return sendWish(); }
  });
  document.addEventListener('paste', e => {
    if (!fbIsOpen() || fb.tab !== 'report') return;
    const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file' && /^image\//.test(i.type)).map(i => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addShots(files); }
  });
  document.addEventListener('dragover', e => { if (e.target.closest?.('#fb-drop')) e.preventDefault(); });
  document.addEventListener('drop', e => { if (e.target.closest?.('#fb-drop')) { e.preventDefault(); addShots([...(e.dataTransfer?.files || [])]); } });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !fbIsOpen() || !e.target.closest?.('#fb-panel') || document.querySelector('#modal-root .modal, .confirm-root')) return;
    e.preventDefault(); fbPanel(false); document.querySelector('[data-fb-toggle]:not([hidden])')?.focus();
  });

  // ---------- C-291 版本紀錄（版本、上線時間、卡片、commit）與 3 張流程圖 ----------
  // 資料是部署時產生的靜態檔 /releases.json、/flows.md，打開才讀，不碰資料庫
  const rel = { data: null, flows: null, tab: 'list', q: '', back: null, hit: '' };
  async function loadReleases() {
    if (!rel.data) rel.data = await api('/api/releases').catch(() => null); // C-291 退回：要登入
    return rel.data;
  }
  function openReleases(ver = '') {
    if (state.page !== 'releases') rel.back = { view: state.view, page: state.page };
    rel.hit = ver ? String(ver).replace(/^v/, '') : '';
    if (ver) { rel.tab = 'list'; rel.q = ''; }
    return state.page === 'releases' ? drawReleases() : goTop('releases');
  }
  async function renderReleasesPage() {
    const box = $('#page-work');
    box.classList.remove('is-board');
    box.innerHTML = '<p class="muted">載入中…</p>';
    if (!rel.hit && location.hash.startsWith('#v')) rel.hit = location.hash.slice(2);
    await loadReleases();
    if (rel.tab === 'flows' && rel.flows === null) rel.flows = await fetch('/api/flows', { headers: { Authorization: `Bearer ${state.token}` } }).then(r => (r.ok ? r.text() : '')).catch(() => '');
    drawReleases();
  }
  const relTime = iso => { const t = new Date(iso); return `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };
  // 很小的 Markdown 顯示：標題、清單、程式碼區塊、表格、粗體、行內程式碼
  function mdHtml(md) {
    const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const out = []; let code = null, list = false, table = null;
    const flush = () => { if (list) { out.push('</ul>'); list = false; } if (table) { out.push(`<div class="md-table"><table>${table.map((r, i) => `<tr>${r.map(c => (i ? `<td>${inline(c)}</td>` : `<th>${inline(c)}</th>`)).join('')}</tr>`).join('')}</table></div>`); table = null; } };
    for (const line of String(md).split('\n')) {
      if (line.startsWith('```')) { if (code) { out.push(`<pre class="md-pre">${esc(code.join('\n'))}</pre>`); code = null; } else { flush(); code = []; } continue; }
      if (code) { code.push(line); continue; }
      if (/^\|/.test(line)) { if (/^\|[-| ]+\|$/.test(line)) continue; (table = table || []).push(line.slice(1, -1).split('|').map(c => c.trim())); continue; }
      if (/^\s*- /.test(line)) { if (!list) { flush(); out.push('<ul>'); list = true; } out.push(`<li>${inline(line.replace(/^\s*- /, ''))}</li>`); continue; }
      flush();
      const h = /^(#{1,3}) (.*)$/.exec(line);
      if (h) out.push(`<h${h[1].length + 1} id="${esc(h[2].replace(/\s+/g, ''))}">${inline(h[2])}</h${h[1].length + 1}>`);
      else if (line.trim() === '---') out.push('<hr>');
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    flush();
    return out.join('');
  }
  function drawReleases() {
    const box = $('#page-work');
    if (state.page !== 'releases') return;
    const d = rel.data;
    const tabs = `<div class="seg-scope" role="tablist" aria-label="分頁"><button type="button" role="tab" data-rel-tab="list" aria-selected="${rel.tab === 'list'}" aria-pressed="${rel.tab === 'list'}">版本紀錄</button><button type="button" role="tab" data-rel-tab="flows" aria-selected="${rel.tab === 'flows'}" aria-pressed="${rel.tab === 'flows'}">流程圖</button></div>`;
    const head = `<button type="button" class="link wish-back" data-rel-back>‹ 返回</button><div class="work-head"><div class="work-title"><h2>版本紀錄</h2><span class="muted small">目前 v${esc(APP_VERSION)}${d ? ` · ${d.items.length} 個版本` : ''} · 修 bug 要附重現測試；改動前寫影響哪張流程圖的哪一段</span></div>${tabs}</div>`;
    if (rel.tab === 'flows') { box.innerHTML = head + `<section class="wpanel md-doc">${rel.flows ? mdHtml(rel.flows) : '<p class="muted">流程圖讀不到，請重新整理。</p>'}</section>`; return; }
    if (!d) { box.innerHTML = head + '<p class="muted">版本紀錄讀不到，請重新整理。</p>'; return; }
    const q = rel.q.trim().toLowerCase().replace(/^v/, '');
    const list = d.items.filter(r => !q || r.version.includes(q) || r.cards.some(c => c.toLowerCase() === q || c.toLowerCase().startsWith(q)) || r.commits.some(c => c.title.toLowerCase().includes(q) || c.sha.startsWith(q)));
    const row = r => `<article class="rel-item${rel.hit === r.version ? ' hit' : ''}" id="v${esc(r.version)}">
      <div class="rel-head"><b>v${esc(r.version)}</b><span class="muted small">${esc(relTime(r.at))}${r.deployedAt ? ' 上線' : '（commit 時間）'}</span>${r.cards.map(c => `<button type="button" class="cid-chip" data-card="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      ${r.fixes.map(f => `<div class="rel-inc fix">🩹 修正 ${esc(f.cause)}（<button type="button" class="link small" data-rel-ver="${esc(f.causeVersion)}">v${esc(f.causeVersion)}</button>）造成的問題：${esc(f.note)}${f.flow ? `（流程 ${esc(f.flow)}）` : ''}</div>`).join('')}
      ${r.causes.map(c => `<div class="rel-inc cause">⚠ 這版造成的問題，由 ${esc(c.fix)}（<button type="button" class="link small" data-rel-ver="${esc(c.fixVersion)}">v${esc(c.fixVersion)}</button>）修好：${esc(c.note)}</div>`).join('')}
      <ul class="rel-commits">${r.commits.map(c => `<li><code>${esc(c.sha)}</code> ${esc(c.title)}</li>`).join('')}</ul></article>`;
    box.innerHTML = head + `<div class="work-filters"><input id="rel-q" type="search" placeholder="找版本、卡號或關鍵字（例：C-276、0.62、快取）" aria-label="找版本或卡號" value="${esc(rel.q)}"></div>
      ${d.incidents?.length && !q ? `<section class="wpanel rel-incidents"><b>事故對照</b>${d.incidents.map(i => `<div class="small">${esc(i.fix)}（v${esc(i.fixVersion)}）← ${esc(i.cause)}（<button type="button" class="link small" data-rel-ver="${esc(i.causeVersion)}">v${esc(i.causeVersion)}</button>）：${esc(i.note)}${i.flow ? `（${esc(i.flow)}）` : ''}</div>`).join('')}</section>` : ''}
      <section class="rel-list">${list.map(row).join('') || '<p class="muted">找不到符合的版本。</p>'}</section>`;
    if (rel.hit) { const el = document.getElementById('v' + rel.hit); if (el) setTimeout(() => el.scrollIntoView({ block: 'center' }), 0); }
  }
  // 卡片抽屜：這張卡在哪幾版上線
  async function fillRelLines(root = document) {
    const els = root.querySelectorAll?.('[data-rel-card]:not([data-filled])');
    if (!els?.length) return;
    const d = await loadReleases();
    for (const el of els) {
      el.dataset.filled = '1';
      const vs = (d?.items || []).filter(r => r.cards.includes(el.dataset.relCard)).map(r => r.version);
      el.innerHTML = vs.length ? `<span class="muted small">上線版本：</span>${vs.slice(0, 6).map(v => `<button type="button" class="link small" data-rel-ver="${esc(v)}">v${esc(v)}</button>`).join(' ')}${vs.length > 6 ? ` <span class="muted small">等 ${vs.length} 版</span>` : ''}` : '';
    }
  }
  new MutationObserver(muts => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches?.('[data-rel-card]') || n.querySelector?.('[data-rel-card]'))) fillRelLines(n.parentElement || n); })
    .observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', e => {
    const v = e.target.closest?.('[data-rel-ver]');
    if (v) { if (document.querySelector('.drawer')) closeCard(); return openReleases(v.dataset.relVer); }
    const t = e.target.closest?.('[data-rel-tab]');
    if (t) { rel.tab = t.dataset.relTab; return renderReleasesPage(); }
    if (e.target.closest?.('[data-rel-back]')) { const b = rel.back; rel.back = null; return b && b.page !== 'releases' ? (b.view && b.view !== state.view ? setProjectView(b.view, b.page) : showPage(b.page)) : setProjectView('hub'); }
  });
  document.addEventListener('input', e => { if (e.target.id === 'rel-q') { rel.q = e.target.value; rel.hit = ''; drawReleases(); const q = $('#rel-q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); } });

  async function renderMyAiPage() {
    const box = $('#page-work');
    box.classList.remove('is-board');
    box.innerHTML = '<div id="myai-pane" class="inline-pane myai-page"></div>';
    await loadProjectList().catch(() => {});
    await openMyAi();
  }
  async function openMyAi() {
    const body = openModal('我的 AI', `
      <p class="muted small">你名下所有 AI，不分專案；每列看得到它在哪些專案。</p>
      <div class="row spread">
        <button class="btn primary" type="button" id="ai-new">＋ 新增 AI 助手</button>
        <a href="/api/docs/ai-integration" target="_blank" rel="noopener">AI 接入規格文件</a>
      </div>
      <label class="check"><input type="checkbox" id="ai-auto-standby"${autoStandbyConsent ? ' checked' : ''}> 允許 AI 自動啟動待命（watcher／wait-for-bell，簽到後直接啟動再回報；行內／投信仍會先問你）</label>
      <div id="ai-list" class="stack"></div>`, { sub: '每位 AI 有獨立身分、專屬 Token 與通知收件匣。' });
    body.querySelector('#ai-auto-standby').onchange = e => { autoStandbyConsent = e.target.checked; };
    let items = [];
    const open = new Set();
    async function draw() {
      items = (await api('/api/my-ais')).items;
      state.myAiCount = items.filter(a => a.status !== 'deleted').length; drawAvatarMenu();
      body.querySelector('#ai-list').innerHTML = items.length ? items.map(ai => aiCardHtml(ai, open.has(ai.participantId))).join('')
        : '<p class="muted">還沒有 AI 助手。按「新增 AI 助手」選一個角色範例開始。</p>';
    }
    body.querySelector('#ai-new').onclick = () => openAiForm(null);
    body.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const ai = items.find(x => x.participantId === b.dataset.id);
      try {
        if (b.dataset.act === 'more') {
          if (open.has(ai.participantId)) open.delete(ai.participantId); else open.add(ai.participantId);
          b.closest('.ai-card').outerHTML = aiCardHtml(ai, open.has(ai.participantId));
        } else if (b.dataset.act === 'copy') {
          if (ai.tokenExpired) return toast('Token 已過期，請先按「重發 Token」');
          const { text } = await api(onboardingUrl(ai));
          toast((await copyText(text)) ? '已複製，貼到你的 AI 對話即可' : '複製失敗，請手動複製');
        } else if (b.dataset.act === 'short') { // C-283：3～4 行、不含 Token，連結 15 分鐘、只能讀一次
          if (ai.tokenExpired) return toast('Token 已過期，請先按「重發 Token」');
          const r = await api(`/api/my-ais/${encodeURIComponent(ai.participantId)}/onboarding-link`, { method: 'POST', body: { autoStandby: !!autoStandbyConsent } });
          // 改成終端機指令＋讀本機檔：很多 AI 不肯「照網頁上寫的去做」，但會照使用者交代的指令與檔案做（昱志 10/19 codex 實測讀不到）
          const text = `你是「${ai.name}」，${state.me.name} 在 Aigile 協作群組的 AI 助手（${ai.role || 'AI'}）。以下是 ${state.me.name} 交代的接入步驟：
1. 在終端機執行（15 分鐘內、只能下載一次；Windows PowerShell 請把 curl 換成 curl.exe）：
curl -s --create-dirs -o .aigile/setup.md "${r.url}"
2. 讀 .aigile/setup.md，照裡面的步驟接入。這個檔含你的 Token：不要進 git、不要貼到群組。
下載失敗、或檔案內容寫「已失效」，就告訴 ${state.me.name}，請他在網頁重按「複製短版接入」。`;
          toast((await copyText(text)) ? '已複製短版接入（連結 15 分鐘內有效、只能讀一次）' : '複製失敗，請手動複製');
        } else if (b.dataset.act === 'token') {
          if (ai.tokenExpired) return toast('Token 已過期，請先按「重發 Token」');
          toast((await copyText(ai.token)) ? '已複製 Token' : '複製失敗，請手動複製');
        } else if (b.dataset.act === 'edit') {
          openAiForm(ai);
        } else if (b.dataset.act === 'grants') {
          openGrants(ai, draw);
        } else if (b.dataset.act === 'reissue') {
          if (!await confirmDialog({ title: '重發 Token？', confirmText: '重發',
            message: `重發後，<b>${esc(ai.name)}</b> 目前的 Token 會立即失效，需要把新 Token 換給它。` })) return;
          const r = await api(`/api/my-ais/${ai.participantId}/reissue`, { method: 'POST' });
          loadParticipants().catch(() => {});
          openTokenOnly(r);
        } else if (b.dataset.act === 'disable') {
          if (!await confirmDialog({ title: '停用 AI 助手？', confirmText: '停用', danger: true,
            message: `停用後 <b>${esc(ai.name)}</b> 的 Token 會立即失效，它將無法再讀寫群組，之後可以重新啟用。` })) return;
          await api(`/api/my-ais/${ai.participantId}/disable`, { method: 'POST' });
          await draw();
        } else if (b.dataset.act === 'delete') {
          if (!await confirmDialog({ title: '永久刪除 AI 助手？', confirmText: '永久刪除', danger: true, expectText: ai.name,
            message: `<b>${esc(ai.name)}</b> 的 Token 會立即失效，從成員名單、@ 選單、團隊狀態消失，<b>不可復原</b>。它發過的訊息與卡片紀錄會保留並標「（已刪除）」；它負責且未完成的卡片會變成未指派。` })) return;
          const r = await api(`/api/my-ais/${ai.participantId}/delete`, { method: 'POST', body: { confirmName: ai.name } });
          toast(r.unassignedCards.length ? `已刪除；${r.unassignedCards.join('、')} 變成未指派` : '已刪除');
          loadParticipants().catch(() => {});
          await draw();
        } else if (b.dataset.act === 'enable') {
          await api(`/api/my-ais/${ai.participantId}/enable`, { method: 'POST' });
          await draw();
        }
      } catch (err) { toast(err.message); }
    });
    await draw();
  }

  // C-147：「允許 AI 自動啟動待命」預設勾選；勾選才在接入設定寫明已同意，沒勾照舊先問
  let autoStandbyConsent = true;
  const onboardingUrl = ai => `/api/my-ais/${ai.participantId}/onboarding${autoStandbyConsent ? '?autoStandby=1' : ''}`;

  // 重發後：只需把新 Token 換進 AI 的環境，不用重讀整份接入設定
  function openTokenOnly(ai) {
    const body = openModal('已重發 Token', `
      <p>${esc(ai.name)} 的舊 Token 已立即失效。新 Token 到期：<b>${fmtTime(ai.expiresAt)}</b></p>
      <p class="notice">已接入的 AI：把新 Token 換進它的 Token 檔或環境變數（例如 <code>.token</code>、<code>AIGILE_TOKEN</code>）即可，不必重讀整份設定。也可以直接貼給它：「Token 已更新為 ……，請替換後繼續輪詢」。第一次接入或 AI 已忘記設定時，才用「複製完整接入設定」。</p>`, {
      size: 'narrow',
      foot: `<button class="btn" type="button" id="tok-full">複製完整接入設定</button>
             <button class="btn primary" type="button" id="tok-copy">只複製 Token</button>`,
    });
    const m = body.modal;
    m.querySelector('#tok-copy').onclick = async () => toast((await copyText(ai.token)) ? '已複製 Token' : '複製失敗，請手動複製');
    m.querySelector('#tok-full').onclick = async () => {
      const { text } = await api(onboardingUrl(ai));
      toast((await copyText(text)) ? '已複製，貼到你的 AI 對話即可' : '複製失敗，請手動複製');
    };
  }

  function aiCardHtml(ai, expanded = false) {
    const active = ai.status === 'active';
    const level = tokenLevel(ai.expiresAt);
    const expired = level === 'expired';
    const statusTag = !active ? '<span class="pill-tag grey">已停用</span>'
      : expired ? '<span class="pill-tag red">Token 已過期</span>'
      : level === '2h' ? '<span class="pill-tag yellow">Token 2 小時內到期</span>'
      : level === '24h' ? '<span class="pill-tag yellow">Token 24 小時內到期</span>' : '<span class="pill-tag green">有效</span>';
    const id = ai.participantId;
    return `
      <div class="ai-card">
        <div class="ai-card-head">
          ${avatar(ai)}
          <div class="member-info">
            <div class="member-name"><b>${esc(ai.name)}</b>${statusTag}${state.projMeta.crossRoleIds.includes(ai.participantId) ? '<span class="ptag ptag-all">跨專案角色</span>' : (ai.projects || []).filter(p => PROJECTS.includes(p)).map(projTag).join('')}</div>
            <div class="member-sub">${esc([ai.role, '#' + ai.shortCode, ai.environment].filter(Boolean).join(' · '))}
              <span class="ai-online"><span class="dot ${ai.isOnline ? 'on' : ''}"></span>${ai.isOnline ? '在線' : '離線／閒置'}</span></div>
            <div class="member-sub ${active && level ? 'warn-text' : ''}">Token 到期：${ai.expiresAt ? fmtTime(ai.expiresAt) : '—'}</div>
          </div>
        </div>
        <div class="row actions">
          ${!active ? `<button class="btn" type="button" data-act="enable" data-id="${id}">重新啟用</button>`
            : expired ? `<button class="btn primary" type="button" data-act="reissue" data-id="${id}">重發 Token</button>
               <button class="btn" type="button" data-act="edit" data-id="${id}">編輯</button>`
            : `<button class="btn" type="button" data-act="token" data-id="${id}">只複製 Token</button>
               <button class="btn" type="button" data-act="copy" data-id="${id}">複製完整接入設定</button>
               <button class="btn" type="button" data-act="short" data-id="${id}" title="貼長設定會當掉的工具用：只有幾行，AI 自己去讀完整設定">複製短版接入</button>
               <button class="btn" type="button" data-act="edit" data-id="${id}">編輯</button>
               <button class="btn" type="button" data-act="reissue" data-id="${id}">重發 Token</button>`}
          <button type="button" class="link push-right" data-act="more" data-id="${id}" aria-expanded="${expanded}">${expanded ? '收合設定' : '詳細設定'}</button>
        </div>
        ${expanded ? `
        <div class="ai-detail">
          <dl>
            <dt>主要職責</dt><dd>${esc(ai.duties)}</dd>
            <dt>溝通風格</dt><dd>${esc(ai.style)}</dd>
            <dt>可自主處理的事項</dt><dd>${esc(ai.autonomy)}</dd>
            <dt>必須確認的事項</dt><dd>${esc(ai.mustConfirm)}</dd>
            <dt>完成與交接條件</dt><dd>${esc(ai.handoff)}</dd>
          </dl>
          ${grantsBlock(ai, active)}
          ${active ? `
          <div class="row actions">
            <button class="btn small danger-outline" type="button" data-act="disable" data-id="${id}" title="立即撤銷：Token 馬上失效，AI 無法再讀寫">停用（撤銷）</button>
          </div>
          <p class="muted small">接入設定與 Token 都是此 AI 的存取憑證，請只貼到自己的 AI 對話。</p>` : ''}
          <div class="row actions"><button class="btn small danger-outline" type="button" data-act="delete" data-id="${id}" title="永久刪除：不可復原，歷史訊息保留並標已刪除">刪除</button></div>
          <p class="muted small">版本 v${ai.version} · 更新時間 ${fmtTime(ai.updatedAt)}</p>
        </div>` : ''}
      </div>`;
  }

  // ---------- C-229 長期授權（只有行外的 AI；昱志選 C：只有「部署到正式環境」） ----------
  const twYmd = ms => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '/');
  function quarterEnd(now = Date.now()) { const tw = new Date(now + 8 * 3600_000), next = Math.floor(tw.getUTCMonth() / 3) * 3 + 3; return Date.UTC(tw.getUTCFullYear(), next, 1) - 8 * 3600_000 - 1; }
  function grantsBlock(ai, active) {
    const g = ai.grants || { items: [] };
    const body = !ai.grantable
      ? `<p class="muted small">所在環境是「${esc(ai.environment || '未設定')}」：部署、遷移、git 一律每次在本機問，不開放長期授權。</p>`
      : g.items.length ? `<p class="small">${g.items.map(i => esc(i.label)).join('、')}<span class="muted">（${g.until ? `到 ${twYmd(Date.parse(g.until))}` : '不限期'}）</span></p>`
      : '<p class="muted small">沒有。部署、遷移、git 都每次在本機問你。</p>';
    return `<div class="ai-grants${ai.grantable ? '' : ' off'}"><div class="ai-grants-head"><b>長期授權</b>${active && ai.grantable ? `<button class="btn small" type="button" data-act="grants" data-id="${esc(ai.participantId)}">設定</button>` : ''}</div>${body}</div>`;
  }
  async function openGrants(ai, redraw) {
    let g;
    try { g = await api(`/api/my-ais/${encodeURIComponent(ai.participantId)}/grants`); } catch (err) { return toast(err.message); }
    const cur = g.items.map(i => i.key), q = quarterEnd(), d30 = Date.now() + 30 * 86_400_000;
    const sel = cur.length && !g.until ? 'none' : 'quarter';
    const body = openModal(`長期授權 · ${ai.name}`, `<form id="gr-form" class="stack">
        <p class="muted small">勾了的事，AI 不用每次在本機問你；沒勾的照舊先問。只有你（所屬人類）能改。</p>
        <fieldset class="gr-items"><legend class="field-label">可以長期授權的事</legend>
          ${g.choices.map(c => `<label class="gr-ck"><input type="checkbox" name="items" value="${esc(c.key)}" ${cur.includes(c.key) ? 'checked' : ''}><span>${esc(c.label)}${c.note ? `<small>${esc(c.note)}</small>` : ''}</span></label>`).join('')}
        </fieldset>
        <label class="field">有效到<select name="until">
            <option value="quarter" ${sel === 'quarter' ? 'selected' : ''}>本季底（${twYmd(q)}）</option>
            <option value="30d">30 天（到 ${twYmd(d30)}）</option>
            <option value="none" ${sel === 'none' ? 'selected' : ''}>不限</option></select>
          <span class="field-hint">到期自動失效，AI 回到每次都問。${cur.length ? `目前：${g.until ? `到 ${twYmd(Date.parse(g.until))}` : '不限期'}` : ''}</span></label>
        <div class="warn-box small gr-never">固定每次都問：${esc(g.alwaysAsk)}。<br>不能長期授權：${esc(g.never)}。</div>
        <p class="error" id="gr-err" role="alert"></p>
      </form>`, { size: 'narrow', foot: '<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit" form="gr-form">儲存</button>' });
    body.querySelector('#gr-form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target, items = [...f.querySelectorAll('[name=items]:checked')].map(x => x.value);
      try {
        await api(`/api/my-ais/${encodeURIComponent(ai.participantId)}/grants`, { method: 'PUT', body: { items, until: f.until.value } });
        closeModal();
        toast('已儲存長期授權');
        await redraw?.();
        const pj = (ai.projects || []).filter(p => PROJECTS.includes(p));
        askNotifyAis([ai], '[通知] 你的長期授權已更新，請重新讀 GET /api/me（grants）。', pj.length === 1 ? pj[0] : 'all');
      } catch (err) { body.querySelector('#gr-err').textContent = err.message; }
    });
  }
  // C-229：改了程式庫或長期授權後，問要不要通知相關 AI（只寫「已更新，請重讀 /api/me」）
  async function askNotifyAis(ais, text, project) {
    const list = ais.filter(Boolean);
    if (!list.length) return;
    const names = list.map(a => a.name).join('、');
    if (!await confirmDialog({ title: '要不要通知相關 AI？', confirmText: '通知', cancelText: '不用',
      message: `已接入的 AI 不會自動知道這次的修改。要發一則訊息給 <b>${esc(names)}</b> 嗎？<br><span class="muted small">內容：${esc(text)}</span>` })) return;
    try {
      await api('/api/messages', { method: 'POST', body: { text, recipientIds: list.map(a => a.participantId), project, requestId: newRequestId() } });
      toast(`已通知 ${names}`);
    } catch (err) { toast('沒有通知成功：' + err.message); }
  }
  // C-229：專案程式庫連結（管理員、該專案 leader）
  function repoLine(p, canEdit, { code = true } = {}) {
    const r = p.repo;
    return `<div class="pm-repo small">${code ? `<span>API 代號：<b>${esc(p.id)}</b></span>` : ''}<span class="pm-repo-url">${r ? `程式庫：<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.url)}</a>${r.branch ? `（分支 ${esc(r.branch)}）` : ''}` : '<span class="muted">還沒有程式庫連結</span>'}</span>${canEdit ? `<button type="button" class="link small" data-pm-repo="${esc(p.id)}">程式庫設定</button>` : ''}</div>`;
  }
  function openRepoEditor(pj) {
    const p = state.projectList.find(x => x.id === pj);
    if (!p) return;
    const r = p.repo || {};
    const body = openModal(`程式庫設定 · ${p.name}`, `<form id="repo-form" class="stack">
        <p class="small">專案名稱 <b>${esc(p.name)}</b><br><span class="muted">API 代號：<b>${esc(p.id)}</b>（AI 發訊息、查卡片用這個，不能改）</span></p>
        <label class="field">程式庫連結（選填）<input name="url" maxlength="300" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://github.com/帳號/專案" value="${esc(r.url || '')}"></label>
        <label class="field">分支（選填）<input name="branch" maxlength="100" autocomplete="off" spellcheck="false" placeholder="main" value="${esc(r.branch || '')}"></label>
        <ul class="muted small repo-hints"><li>只放連結，不放帳號密碼或 Token；網址含帳密或 token 會被擋下。</li><li>改了之後，這個專案 AI 的接入設定下次複製就會帶上；已接入的 AI 不會自動知道，存檔後可以通知它們。</li><li>只有管理員和這個專案的 leader 能改。</li></ul>
        <p class="error" id="repo-err" role="alert"></p>
      </form>`, { size: 'narrow', foot: '<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit" form="repo-form">儲存</button>' });
    body.querySelector('#repo-form').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      try {
        await api(`/api/projects/${encodeURIComponent(pj)}/repo`, { method: 'PUT', body: { url: f.url.value.trim(), branch: f.branch.value.trim() } });
        closeModal();
        await loadProjectList().catch(() => {});
        drawPerm();
        toast('已儲存程式庫設定');
        const ais = [...state.participants.values()].filter(x => x.memberType === 'ai' && !x.deleted && (x.projects || []).includes(pj));
        askNotifyAis(ais, `[通知] 專案「${p.name}」（API 代號 ${p.id}）的程式庫設定已更新，請重新讀 GET /api/me（repos）。`, pj);
      } catch (err) { body.querySelector('#repo-err').textContent = err.message; }
    });
  }

  // 角色範本：常用的排前面，其餘收進「其他角色」群組（只是選單分組，角色定義不變；既有成員的角色照常顯示已選）
  const COMMON_ROLES = ['PO', 'SM', 'BA', 'UX', 'PG', 'QA', 'TRY', 'custom'];
  function roleOptionsHtml(roles) {
    const opt = r => `<option value="${esc(r.key)}">${esc(r.option)}</option>`;
    const builtIn = roles.filter(r => !r.project);
    const common = COMMON_ROLES.map(k => builtIn.find(r => r.key === k)).filter(Boolean);
    const other = builtIn.filter(r => !COMMON_ROLES.includes(r.key));
    // C-280：本專案角色分組；最後「＋ 跟 AI 討論新角色…」（leader／管理員）
    const pjs = [...new Set(roles.filter(r => r.project).map(r => r.project))];
    const mine = pjs.map(pj => `<optgroup label="本專案角色（${esc(projName(pj))}）">${roles.filter(r => r.project === pj).map(opt).join('')}</optgroup>`).join('');
    const tail = myProjects().some(canMakeRole) ? '<option value="__ai">＋ 跟 AI 討論新角色…</option>' : '<option value="__ai_no" disabled>新角色請 leader 建立</option>';
    return common.map(opt).join('') + (other.length ? `<optgroup label="其他角色">${other.map(opt).join('')}</optgroup>` : '') + mine + tail;
  }
  const roleAiPj = () => { const pv = projectView(); return canMakeRole(pv) && myProjects().includes(pv) ? pv : myProjects().find(canMakeRole); };
  // C-182：AI 屬於哪些專案（新增、編輯都能勾）；只列自己在的專案，不在的灰掉寫原因；跨專案角色固定在所有專案
  function aiProjField(ai) {
    const cross = ai && state.projMeta.crossRoleIds.includes(ai.participantId);
    const has = p => (ai ? (ai.projects || []).includes(p) : myProjects().length === 1);
    const boxes = PROJECTS.map(p => myProjects().includes(p)
      ? `<label class="chk"><input type="checkbox" name="proj" value="${esc(p)}" ${has(p) ? 'checked' : ''} ${cross ? 'disabled' : ''}> ${esc(projName(p))}</label>`
      : `<label class="chk off"><input type="checkbox" disabled> ${esc(projName(p))}<span class="muted small">（你不在這個專案）</span></label>`).join('');
    return `<div class="field"><span class="field-label">所屬專案（至少選一個）</span>
      <div class="proj-row new-ai-proj">${myProjects().length ? boxes : '<span class="muted small">你還沒有加入任何專案，請群組管理員把你加入專案。</span>'}</div>
      <span class="field-hint">${cross ? '這個 AI 是跨專案角色，固定在所有專案（由管理員在「成員與權限」設定）。' : '改了專案，這個 AI 在被移出的專案負責的卡會退回待處理，儲存前會先列出。'}</span></div>`;
  }
  async function openAiForm(ai) {
    const { items: baseRoles, fields, environments = [] } = await loadRoles();
    const editing = !!ai;
    // C-280：加上自己所在專案的本專案角色（AI 已在用、但停用的也列出，免得選單空掉）
    const pjRole = (d, pj) => ({ ...d, option: `${d.key}：${d.role}${d.status === 'disabled' ? '（已停用）' : ''}`, suffix: `${d.role}助手`, project: pj, projects: [pj] });
    const roles = [...baseRoles, ...myProjects().flatMap(pj => projRoleDefs(pj, true).filter(d => d.status !== 'disabled' || (editing && ai.roleKey === d.key)).map(d => pjRole(d, pj)))];
    const envKeys = environments.map(e => e.key);
    const cur = editing ? (ai.environment || '') : '';
    const envOpts = [...envKeys, ...(cur && !envKeys.includes(cur) ? [cur] : []), ''];
    const body = openModal(editing ? '編輯 AI 助手' : '新增 AI 助手', `
      <form id="ai-form" class="stack">
        <label>角色範本
          <select name="roleKey">${roleOptionsHtml(roles)}</select>
          <span class="field-hint" id="role-hint">選取後自動預填下方六題，可再修改。</span>
        </label>
        ${aiProjField(ai)}
        <div class="two-col">
          <div class="field">
            <label>角色顯示名稱<input name="role" required maxlength="30"></label>
            <div class="avatar-row compact">
              <span class="av-48" id="ai-avatar-preview"></span>
              <div><b>頭像</b><span class="muted small">未設定時顯示角色代碼</span></div>
              <button class="btn small" type="button" id="ai-avatar-change">更換</button>
              <input type="hidden" name="avatar">
            </div>
          </div>
          <div class="field">
            <span class="field-label" id="env-label">所在環境</span>
            <div class="seg-scope env-seg" role="group" aria-labelledby="env-label">
              ${envOpts.map(k => `<button type="button" data-env="${esc(k)}" aria-pressed="false">${esc(k || '未設定')}</button>`).join('')}
            </div>
            <input type="hidden" name="environment">
            <span class="field-hint">會在「必須確認的事項」帶入該環境的限制。</span>
          </div>
        </div>
        <hr>
        <div><div class="group-title flush">AI 設定六題</div><span class="field-hint">皆為必填，每題上限 1000 字。</span></div>
        <label>1. AI 名稱<input name="name" required maxlength="40"></label>
        ${fields.map(f => `<label class="ta-field"><span class="ta-head"><span>${esc(f.label)}</span><span class="counter" data-count="${f.key}">0/1000</span></span><textarea autocomplete="off" autocorrect="on" name="${f.key}" rows="4" required maxlength="1000"></textarea></label>`).join('')}
        <p class="error" id="ai-error" role="alert"></p>
      </form>`, {
      size: 'form',
      foot: `<button class="btn" type="button" data-close>取消</button>
             <button class="btn primary" type="submit" form="ai-form">${editing ? '儲存變更' : '建立 AI 助手'}</button>`,
    });
    const form = body.querySelector('#ai-form');
    const counts = () => { for (const f of fields) body.querySelector(`[data-count="${f.key}"]`).textContent = `${form[f.key].value.length}/1000`; };
    const setEnv = v => {
      form.environment.value = v;
      body.querySelectorAll('[data-env]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.env === v)));
    };
    // 頭像圖片：existing＝沿用已上傳的、new＝這次新選的、none＝不用圖片
    const img = { state: editing && ai.avatarImg ? 'existing' : 'none', blob: null, url: null };
    const autoText = () => form.roleKey.value !== 'custom' ? form.roleKey.value : [...(form.role.value || 'AI')].slice(0, 2).join('');
    const preview = () => {
      const p = { memberType: 'ai', roleKey: form.roleKey.value, role: form.role.value, avatar: form.avatar.value.trim() };
      if (img.state === 'new') p.imgUrl = img.url;
      if (img.state === 'existing') Object.assign(p, { participantId: ai.participantId, avatarImg: ai.avatarImg });
      body.querySelector('#ai-avatar-preview').innerHTML = avatar(p);
    };
    body.querySelector('#ai-avatar-change').onclick = async () => {
      const cur = { text: form.avatar.value, imgUrl: img.state === 'new' ? img.url : img.state === 'existing' ? await avatarUrl(ai.participantId, ai.avatarImg) : null };
      const aiRow = editing ? { askLabel: '請它幫自己做', prevPath: `/api/my-ais/${encodeURIComponent(ai.participantId)}/avatar/prev` } : null;
      const r = await avatarDialog({ title: '更換 AI 頭像', isAi: true, fallback: autoText(), cur, aiRow });
      if (!r || r.kind === 'keep') return;
      if (r.kind === 'ask') return askAvatar([state.participants.get(ai.participantId) || ai], '幫你自己做一個頭像：');
      if (r.kind === 'revert') {
        try {
          const v = await api(`/api/my-ais/${encodeURIComponent(ai.participantId)}/avatar/revert`, { method: 'POST' });
          Object.assign(ai, { avatar: v.avatar, avatarImg: v.avatarImg });
          form.avatar.value = v.avatar || '';
          Object.assign(img, { state: v.avatarImg ? 'existing' : 'none', blob: null, url: null });
          preview(); await loadParticipants(); renderMessages(false);
          toast('已換回上一張頭像');
        } catch (err) { toast(err.message); }
        return;
      }
      if (r.kind === 'img') Object.assign(img, { state: 'new', blob: r.blob, url: r.url });
      else { form.avatar.value = r.text; Object.assign(img, { state: 'none', blob: null, url: null }); }
      preview();
    };
    const fill = (src, includeName) => {
      form.role.value = src.role;
      if (src.environment !== undefined) setEnv(src.environment || '');
      if (includeName) form.name.value = src.name;
      for (const f of fields) form[f.key].value = src[f.key];
      counts();
    };
    const roleHint = key => {
      const r = roles.find(x => x.key === key);
      body.querySelector('#role-hint').textContent = (editing ? '切換範本會覆蓋下方六題內容（名稱不變）。' : '選取後自動預填下方六題，可再修改。')
        + (r?.resident === false ? '試用者不常駐，被叫醒才跑一輪；回饋只發給 PO。' : '');
      return r;
    };
    // C-171：範本帶預設專案（試用者只勾平台）；換回沒有預設專案的範本時，恢復原本的預設勾選
    let projAuto = false;
    const applyRoleProjects = r => {
      if (editing || (!r?.projects && !projAuto)) return;
      form.querySelectorAll('input[name="proj"]').forEach(c => { c.checked = r?.projects ? r.projects.includes(c.value) : myProjects().length === 1; });
      projAuto = !!r?.projects;
    };
    setEnv('');
    if (editing) {
      form.roleKey.value = ai.roleKey || 'custom';
      fill(ai, true);
      roleHint(form.roleKey.value);
    } else {
      const r = roleHint(roles[0].key);
      fill({ ...r, name: `${state.me.name}的${r.suffix}` }, true);
    }
    if (editing) form.avatar.value = ai.avatar || '';
    preview();
    let lastAutoName = form.name.value;
    const applyEnvNote = () => {
      let text = form.mustConfirm.value;
      for (const e of environments) text = text.split(e.note).join('');
      text = text.trim();
      const note = environments.find(e => e.key === form.environment.value.trim())?.note;
      form.mustConfirm.value = note ? (text ? text + '\n' + note : note) : text;
      counts();
    };
    let prevKey = form.roleKey.value;
    form.roleKey.addEventListener('change', e => {
      if (form.roleKey.value === '__ai') { form.roleKey.value = prevKey; e.stopImmediatePropagation(); const pj = roleAiPj(); if (pj) askRoleAi(pj); return; } // C-280
      prevKey = form.roleKey.value;
      const r = roleHint(form.roleKey.value);
      const autoName = `${state.me.name}的${r.suffix}`;
      // 名稱若還是自動產生的就一起換；使用者改過就保留
      const keepName = editing || form.name.value !== lastAutoName;
      const env = form.environment.value;
      fill({ ...r, name: autoName }, !keepName);
      applyRoleProjects(r);
      setEnv(env);
      if (!keepName) lastAutoName = autoName;
      applyEnvNote(); // 換角色範本後補回環境限制
    });
    body.querySelectorAll('[data-env]').forEach(b => b.addEventListener('click', () => { setEnv(b.dataset.env); applyEnvNote(); }));
    form.addEventListener('input', () => { counts(); preview(); });
    form.roleKey.addEventListener('change', preview);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      delete data.proj;
      for (const [k, v] of Object.entries(data)) data[k] = v.trim();
      const picked = [...form.querySelectorAll('input[name="proj"]:checked:not(:disabled)')].map(i => i.value);
      if (!editing) {
        data.projects = picked;
        if (!data.projects.length) return toast('請至少選一個所屬專案');
      } else if (!state.projMeta.crossRoleIds.includes(ai.participantId) && myProjects().length) {
        // C-182：編輯時改了專案：先看影響（移出的專案有幾張卡會退回待處理）再確認
        const before = (ai.projects || []).filter(p => PROJECTS.includes(p));
        const next = [...picked, ...before.filter(p => !myProjects().includes(p))]; // 自己不在的專案不動
        if (!next.length) return toast('請至少選一個所屬專案');
        if (next.slice().sort().join() !== before.slice().sort().join()) {
          try {
            const d = await api(`/api/my-ais/${ai.participantId}`, { method: 'PATCH', body: { projects: next, dryRun: true } });
            const im = d.impact?.[0];
            if (im?.removed.length && !await confirmDialog({ title: '移出專案？', confirmText: '確定移出', danger: true,
              message: `${esc(ai.name)} 將移出「${esc(im.removed.map(projName).join('、'))}」${im.returnedCards.length ? `，它負責的 <b>${im.returnedCards.length} 張卡</b>（${esc(im.returnedCards.join('、'))}）會退回待處理、改為未指派` : '，它在那邊沒有負責的卡'}。` })) return;
          } catch (err) { body.querySelector('#ai-error').textContent = err.message; return; }
          data.projects = next;
        }
      }
      try {
        const saved = editing ? await api(`/api/my-ais/${ai.participantId}`, { method: 'PATCH', body: data })
          : await api('/api/my-ais', { method: 'POST', body: data });
        if (img.state === 'new') {
          const res = await fetch(`/api/my-ais/${saved.participantId}/avatar`, { method: 'PUT', headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': img.blob.type }, body: img.blob });
          if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message || '頭像上傳失敗');
        } else if (img.state === 'none' && editing && ai.avatarImg) {
          await api(`/api/my-ais/${saved.participantId}/avatar`, { method: 'DELETE' });
        }
        loadParticipants().then(() => renderMessages(false)).catch(() => {});
        if (state.page === 'myai' || state.page === 'team') closeModal(); // 頁面模式：先關表單再重畫清單
        await openMyAi();
        toast(editing ? '已儲存' : '已建立。按卡片上的「只複製 Token」或「複製完整接入設定」給你的 AI');
      } catch (err) { body.querySelector('#ai-error').textContent = err.message; }
    });
  }

  // 通知收件匣
  // 收件匣：有新訊息通知時更新（徽章只算「要你做的」，由 updateTodoBadge 負責；在收件匣頁時順便更新「給你知道的」）
  async function refreshInboxCount() {
    try {
      if ((state.newMsgAt || 0) >= (work.notesAt || 0) || Date.now() - (work.notesAt || 0) > (dm.waitUntil > Date.now() ? 60_000 : 300_000)) { await loadNotes(); if (state.page === 'inbox') renderWork(); if ((work.notes || []).some(n => n.dm)) dm.waitUntil = 0; } // C-270：只在送出私訊、AI 還沒回的 30 分鐘內每分鐘看一次；其他時間照舊 5 分鐘 // C-245：沒新訊息就不重抓；C-268：徽章要算要你回覆，所以每頁都更新
      updateTodoBadge();
    } catch {}
  }

  async function openInbox() {
    const body = openModal('通知', '<div id="inbox-list"></div>', {
      sub: '<span id="inbox-sub">載入中…</span>',
      actions: '<button class="btn small" type="button" id="ack-all" hidden>全部標為已處理</button>',
    });
    const ack = ids => api('/api/notifications/ack', { method: 'POST', body: { notificationIds: ids } });
    const ackAll = body.modal.querySelector('#ack-all');
    let ids = [];
    async function draw() {
      const d = await api('/api/notifications?status=pending&limit=50&order=desc');
      ids = d.items.map(n => n.notificationId);
      body.modal.querySelector('#inbox-sub').textContent = d.items.length ? (d.hasMore ? `共 ${d.total} 則待處理，只顯示最新 50 則` : `${d.items.length} 則待處理`) : '沒有待處理的通知';
      ackAll.hidden = !d.items.length;
      const reasonTag = { mention: '<span class="tag me">指定給我</span>', reply: '<span class="tag reply">回覆我</span>', all: '<span class="tag all">全體通知</span>' };
      body.querySelector('#inbox-list').innerHTML = d.items.length ? d.items.map(n => {
        const who = state.participants.get(n.sender.participantId) || { ...n.sender, memberType: 'human' };
        return `
          <div class="inbox-row">
            ${avatar(who)}
            <div class="inbox-main">
              <div class="inbox-top"><b>${esc(n.sender.name)}</b>${n.reasons.map(r => reasonTag[r] || '').join('')}<span class="msg-time">${fmtTime(n.createdAt)}</span></div>
              <div class="inbox-preview">${esc(n.preview)}</div>
              <div class="row"><button class="btn primary small" type="button" data-goto="${esc(n.messageId)}" data-n="${esc(n.notificationId)}">查看</button>
                <button class="btn small" type="button" data-ack="${esc(n.notificationId)}">標為已處理</button></div>
            </div>
          </div>`;
      }).join('') : '<p class="muted">沒有待處理的通知。</p>';
    }
    body.modal.addEventListener('click', async e => {
      try {
        if (e.target.closest('#ack-all')) await ack(ids);
        else if (e.target.closest('[data-ack]')) await ack([e.target.closest('[data-ack]').dataset.ack]);
        else if (e.target.closest('[data-goto]')) {
          const g = e.target.closest('[data-goto]');
          await ack([g.dataset.n]);
          closeModal();
          refreshInboxCount();
          return jumpTo(g.dataset.goto);
        } else return;
        await draw();
        refreshInboxCount();
      } catch (err) { toast(err.message); }
    });
    await draw();
  }

  // ---------- 上傳文件 ----------
  const FILE_EXTS = ['pdf', 'docx', 'xlsx', 'pptx', 'md', 'txt', 'png', 'jpg', 'jpeg'];
  const MAX_FILE = 2 * 1024 * 1024;
  const fmtBytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`;
  const fileIcon = ext => ({ pdf: '📕', docx: '📘', xlsx: '📗', pptx: '📙', png: '🖼️', jpg: '🖼️', jpeg: '🖼️' }[ext] || '📄');
  // 上傳者本人，或上傳者是我名下的 AI → 可刪除
  const canDeleteFile = f => f.uploaderId === meId() || myAiIds().has(f.uploaderId);
  const leftText = iso => {
    const min = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60000));
    return min >= 60 ? `剩 ${Math.floor(min / 60)} 小時 ${min % 60} 分鐘` : `剩 ${min} 分鐘`;
  };

  // 附檔訊息：只顯示上傳者的附註，自動產生的「[文件] …」由卡片呈現
  function fileNoteHtml(text) {
    const i = text.indexOf('[文件] ');
    const note = i > 0 ? text.slice(0, i).trim() : '';
    return note ? `<div class="msg-text">${renderText(note)}</div>` : '';
  }

  function fileCardHtml(f) {
    if (!f.available) return '<div class="file-card gone">📄 文件已過期或已刪除</div>';
    return `
      <div class="file-card" data-file="${esc(f.fileId)}">
        <span class="file-icon" aria-hidden="true">${fileIcon(f.ext)}</span>
        <div class="file-info">
          <b class="file-name">${esc(f.name)}</b>
          <span class="muted small">${fmtBytes(f.size)} <span class="file-ok">✓ 已聲明不含程式碼與個資</span></span>
          <details class="file-more"><summary>詳細</summary><span class="muted small">到期 ${fmtTime(f.expiresAt)} · SHA-256 ${esc(f.sha256.slice(0, 12))}…（給稽核用）</span></details>
        </div>
        <button class="btn" type="button" data-download="${esc(f.fileId)}" data-name="${esc(f.name)}">下載</button>
        ${canDeleteFile(f) ? `<button class="btn danger-outline" type="button" data-delete-file="${esc(f.fileId)}">刪除</button>` : ''}
      </div>`;
  }

  async function downloadFile(id, name) {
    try {
      const r = await fetch(`/api/files/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${state.token}` } });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e?.error?.message || `HTTP ${r.status}`);
      }
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) { toast('下載失敗：' + err.message); }
  }

  async function deleteFileById(id) {
    if (!await confirmDialog({ title: '刪除文件？', confirmText: '刪除', danger: true, message: '刪除後所有人都無法再下載這個文件。' })) return false;
    try {
      await api(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('已刪除');
      // 讓訊息中的卡片同步顯示為已刪除
      for (const m of state.messages) if (m.file?.fileId === id) m.file = { fileId: id, available: false };
      renderMessages(false);
      return true;
    } catch (err) { toast(err.message); return false; }
  }

  document.addEventListener('click', e => {
    const d = e.target.closest('[data-download]');
    if (d) return downloadFile(d.dataset.download, d.dataset.name);
    const x = e.target.closest('[data-delete-file]');
    if (x) deleteFileById(x.dataset.deleteFile).then(ok => { if (ok && x.closest('.modal')) openFiles(); });
  });

  // 選檔 → 聲明 → 上傳
  $('#attach').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) openUpload(file);
  });

  // C-128：在輸入框 Ctrl+V 貼上截圖 → 走同一個上傳流程（先預覽、可取消、每張都要重新勾聲明）
  input.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.items || [])].filter(it => it.kind === 'file' && /^image\/(png|jpeg)$/.test(it.type)).map(it => it.getAsFile()).filter(Boolean);
    if (!files.length) return; // 純文字照舊貼上
    e.preventDefault();
    if (files.length > 1) toast('一次只能貼一張截圖，先處理第一張');
    const f = files[0], ext = f.type === 'image/jpeg' ? 'jpg' : 'png', d = new Date(), p = n => String(n).padStart(2, '0');
    const name = `截圖-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
    openUpload(new File([f], name, { type: f.type }));
  });

  // @ 成員選單（上傳視窗的附註欄用）：輸入 @ 跳出清單，↑↓ 移動、Enter／Tab／點選插入、Esc 關閉
  function attachMention(ta, list, { candidates = mentionCandidates } = {}) {
    let st = null;
    const close = () => { st = null; list.hidden = true; };
    const render = () => {
      list.innerHTML = st.items.map((p, i) => `<li role="option" data-i="${i}" aria-selected="${i === st.index}"><span class="dot ${p.isOnline ? 'on' : ''}"></span><b>${esc(p.label || p.name)}</b><span class="muted small">${esc(p.role || '')}</span>${p.memberType === 'ai' ? '<span class="tag ai">AI</span>' : ''}</li>`).join('');
      list.hidden = false;
      scrollPicked(list);
    };
    const update = () => {
      const pos = ta.selectionStart, m = ta.value.slice(0, pos).match(/@([^\s@]*)$/);
      if (!m) return close();
      const items = candidates(m[1]);
      if (!items.length) return close();
      st = { start: pos - m[0].length, end: pos, items, index: 0 };
      render();
    };
    ta.openMention = update; // 「＠ 加人」按鈕插入 @ 後直接開選單
    const pick = i => {
      const insert = '@' + st.items[i].name + ' ';
      ta.value = ta.value.slice(0, st.start) + insert + ta.value.slice(st.end);
      const caret = st.start + insert.length;
      close(); ta.focus(); ta.setSelectionRange(caret, caret);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    };
    ta.addEventListener('input', update);
    ta.addEventListener('click', update);
    ta.addEventListener('blur', () => setTimeout(close, 150));
    ta.addEventListener('keydown', e => {
      if (!st || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); st.index = (st.index + (e.key === 'ArrowDown' ? 1 : st.items.length - 1)) % st.items.length; return render(); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pick(st.index); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    list.addEventListener('mousedown', e => { const li = e.target.closest('li'); if (li && st) { e.preventDefault(); pick(Number(li.dataset.i)); } });
  }

  function openUpload(file) {
    const isImg = /^image\//.test(file.type);
    const previewUrl = isImg ? URL.createObjectURL(file) : '';
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let problem = '';
    if (!FILE_EXTS.includes(ext)) problem = `不允許的檔案類型「.${ext}」，只接受 pdf、docx、xlsx、pptx、md、txt、png、jpg。`;
    else if (file.size > MAX_FILE) problem = `檔案 ${fmtBytes(file.size)} 超過 2 MB 上限。`;
    const body = openModal('上傳文件', `
      <div class="file-box"><span class="file-icon">${fileIcon(ext)}</span>
        <div class="file-info"><b class="file-name">${esc(file.name)}</b><span class="muted small">${fmtBytes(file.size)}</span></div></div>
      ${isImg && !problem ? `<img class="up-preview" alt="截圖預覽" src="${previewUrl}">` : ''}
      ${problem ? `<div class="warn-box red">${esc(problem)}</div>` : `
      <div class="warn-box">上傳到平台等同把資料送到行外，所有群組成員都能下載，1 小時後自動刪除。${isImg ? '截圖請先確認沒有客戶資料（尤其行內畫面）。' : ''}</div>
      <label>附註<span class="field-hint">選填，可用 @ 指定對象</span><div class="input-wrap"><ul id="up-mention" class="mention-list" role="listbox" hidden></ul><textarea autocomplete="off" autocorrect="on" id="up-note" rows="3" maxlength="1500" placeholder="例如：@劉昱志的程式開發助手 這是今天的會議紀錄"></textarea></div></label>
      <p class="mention-warn" id="up-warn" role="status" hidden></p>
      <label class="declare-box"><input type="checkbox" id="up-declare"><span>我確認此檔案不含任何程式碼（原始碼、打包檔、設定檔）與客戶個資</span></label>
      <p class="error" id="up-error" role="alert"></p>`}`, problem ? {} : {
      foot: `<button class="btn" type="button" data-close>取消</button>
             <button class="btn primary" type="button" id="up-go" disabled>上傳</button>`,
    });
    body.querySelector('.up-preview')?.addEventListener('load', () => URL.revokeObjectURL(previewUrl));
    if (problem) { if (previewUrl) URL.revokeObjectURL(previewUrl); return; }
    attachMention(body.querySelector('#up-note'), body.querySelector('#up-mention'));
    body.querySelector('#up-note').addEventListener('input', e => { const w = body.querySelector('#up-warn'), t = outsideText(outsideMentions(e.target.value)); w.textContent = t; w.hidden = !t; }); // C-174
    const go = body.modal.querySelector('#up-go');
    body.querySelector('#up-declare').addEventListener('change', e => { go.disabled = !e.target.checked; });
    go.addEventListener('click', async () => {
      go.disabled = true; go.textContent = '上傳中…';
      const note = body.querySelector('#up-note').value.trim();
      const q = new URLSearchParams({ name: file.name, declared: 'true' });
      if (note) q.set('text', note);
      const rec = note ? resolveRecipients(note) : {};
      if (rec.audience) q.set('audience', 'all');
      if (rec.recipientIds) q.set('recipientIds', rec.recipientIds.join(','));
      if (state.replyTo) q.set('replyToMessageId', state.replyTo.messageId);
      q.set('project', sendTarget());
      try {
        const r = await fetch(`/api/files?${q}`, { method: 'POST', headers: { Authorization: `Bearer ${state.token}` }, body: file });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
        closeModal();
        setReply(null);
        onNewMessage(data.message);
        toast('已上傳，群組已發出附檔訊息');
      } catch (err) {
        body.querySelector('#up-error').textContent = '上傳失敗：' + err.message;
        go.disabled = false; go.textContent = '上傳';
      }
    });
  }

  // 文件：目前檔案、容量、稽核
  async function openFiles() {
    const body = openModal('文件', '<div id="files-list" class="stack"></div>', {
      sub: '上傳 1 小時後自動刪除',
      actions: '<button class="btn small" type="button" id="files-up">上傳</button>',
    });
    body.modal.querySelector('#files-up').onclick = () => $('#file-input').click();
    try {
      const d = await api('/api/files');
      const pct = Math.min(100, d.usedBytes / d.limitBytes * 100);
      body.querySelector('#files-list').innerHTML = `
        <p class="muted small">只接受 pdf、docx、xlsx、pptx、md、txt、png、jpg，單檔 2 MB 以內，禁止程式碼與客戶個資。</p>
        <div class="usage"><div class="usage-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
          <span class="muted small">已用 ${fmtBytes(d.usedBytes)} / ${fmtBytes(d.limitBytes)}</span></div>
        <div class="file-list">${(d.items = d.items.filter(f => inView(f.project))).length ? d.items.map(f => `
          <div class="file-row">
            <span class="file-icon" aria-hidden="true">${fileIcon(f.ext)}</span>
            <div class="file-info">
              <b class="file-name">${esc(f.name)}</b>
              <span class="muted small">${fmtBytes(f.size)} · ${leftText(f.expiresAt)}</span>
              <span class="muted small">${esc(f.uploader?.name || '?')}${f.uploader?.memberType === 'ai' ? '（AI）' : ''} · ${fmtTime(f.createdAt)}</span>
            </div>
            <button class="btn small" type="button" data-download="${esc(f.fileId)}" data-name="${esc(f.name)}">下載</button>
            ${canDeleteFile(f) ? `<button class="btn small danger-outline" type="button" data-delete-file="${esc(f.fileId)}">刪除</button>` : ''}
          </div>`).join('') : '<p class="muted">目前沒有文件。按右上角「上傳」或輸入框旁的 📎。</p>'}</div>
        <details class="audit"><summary>稽核紀錄</summary><div id="audit-list" class="muted small">載入中…</div></details>`;
      body.querySelector('details.audit').addEventListener('toggle', async e => {
        if (!e.target.open) return;
        const box = body.querySelector('#audit-list');
        try {
          const a = await api('/api/files/audit?limit=200');
          const label = { upload: '上傳', download: '下載', delete: '刪除', reject: '拒絕', expire: '到期清除' };
          box.innerHTML = (a.scope === 'mine' ? '<p class="muted small">只顯示你所屬專案的檔案紀錄與你自己的操作；全站稽核限群組管理員。</p>' : '') + (a.items.length ? `<div class="table-scroll"><table class="audit-table"><thead><tr><th>時間</th><th>動作</th><th>操作者</th><th>檔名</th><th>大小</th><th>SHA-256</th><th>聲明</th><th>備註</th></tr></thead><tbody>${
            a.items.map(x => `<tr><td>${fmtTime(x.at)}</td><td>${label[x.action] || x.action}</td>
              <td>${esc(x.actor.name || x.actor.participantId || '')}${x.actor.memberType === 'ai' ? '（AI）' : x.actor.memberType === 'human' ? '（人類）' : ''}</td>
              <td>${esc(x.name || '')}</td><td>${x.size == null ? '' : fmtBytes(x.size)}</td>
              <td>${x.sha256 ? esc(x.sha256.slice(0, 12)) + '…' : ''}</td><td>${x.declared == null ? '' : x.declared ? '✓' : '✗'}</td>
              <td>${esc(x.detail || '')}</td></tr>`).join('')}</tbody></table></div>` : '沒有紀錄。');
        } catch (err) { box.textContent = err.message; }
      });
    } catch (err) {
      body.querySelector('#files-list').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  }

  // API 資訊
  function openApi() {
    const base = location.origin;
    const ep = (m, path, desc) => `<li><span class="method ${m.toLowerCase()}">${m}</span><div><code>${path}</code><span class="muted small">${desc}</span></div></li>`;
    const body = openModal('API 資訊與登入碼', `
      <div class="kv-field"><span class="field-label">API Base URL</span>
        <div class="copy-row"><code class="val" title="${esc(base)}">${esc(base)}</code><button class="btn small" type="button" data-copy="${esc(base)}">複製</button></div></div>
      <div class="kv-field"><span class="field-label">本人 participantId</span>
        <div class="copy-row"><code class="val" title="${esc(meId())}">${esc(meId())}</code><button class="btn small" type="button" data-copy="${esc(meId())}">複製</button></div></div>
      <div class="kv-field"><span class="field-label">本人登入碼（長期有效）</span>
        <div class="copy-row"><code class="val" id="my-token">••••••••••••</code><button class="btn small" type="button" id="tok-show">顯示</button><button class="btn small" type="button" id="tok-copy">複製</button><button class="btn small" type="button" id="tok-rotate">換一組登入碼</button></div></div>
      <div class="warn-box red">這是你本人的登入碼，等同密碼：在其他裝置的登入頁選「用登入碼登入」貼上即可用同一身分登入（換裝置比較建議用「我的裝置」的 6 位數配對）。不要給 AI 用；AI 請到「我的 AI」建立專屬身分。覺得外流了就按「換一組登入碼」，舊的立刻失效，已登入的裝置不受影響。</div>
      <div class="row"><button class="btn" type="button" id="api-qr">用手機掃 QR Code 登入</button><span class="muted small">掃了就以你的身分登入，等同密碼，請勿分享</span></div>
      <div class="group-title">主要端點</div>
      <ul class="endpoints">
        ${ep('GET', '/api/me', '自身身分')}
        ${ep('GET', '/api/participants', '有效成員與在線狀態')}
        ${ep('GET', '/api/messages?limit=50&amp;after=&lt;nextCursor&gt;', '增量讀取訊息')}
        ${ep('GET', '/api/messages/:messageId', '單則訊息')}
        ${ep('POST', '/api/messages', '發文（text、requestId、project、recipientIds、replyToMessageId、audience）；屬於多個專案要帶 project（平台／銀行系統／all）')}
        ${ep('GET', '/api/notifications?status=pending&amp;limit=50', '待處理通知')}
        ${ep('GET', '/api/notifications/count', '未讀通知數')}
        ${ep('POST', '/api/notifications/ack', '確認通知（notificationIds）')}
        ${ep('POST', '/api/files?name=&amp;declared=true', '上傳文件（原始位元組）')}
        ${ep('GET', '/api/files', '文件清單；/api/files/:id 下載')}
      </ul>
      <p><a href="/api/docs/ai-integration" target="_blank" rel="noopener">完整規格：AI 代理人接入通訊協定指南</a></p>
      <div class="group-title">快速測試</div>
      <code class="block">curl -H "Authorization: Bearer &lt;TOKEN&gt;" ${esc(base)}/api/me</code>`);
    let code = null;
    const getCode = async () => (code ||= (await api('/api/me/login-code')).code);
    body.querySelector('#tok-show').onclick = async () => { try { body.querySelector('#my-token').textContent = await getCode(); } catch (err) { toast(err.message); } };
    body.querySelector('#tok-copy').onclick = async () => { try { toast((await copyText(await getCode())) ? '已複製' : '複製失敗'); } catch (err) { toast(err.message); } };
    body.querySelector('#tok-rotate').onclick = async () => {
      if (!await confirmDialog({ title: '換一組登入碼？', confirmText: '換一組', message: '舊的登入碼會<b>立刻失效</b>（貼過舊登入碼、還沒登入的地方要改用新的）。已經登入的裝置不受影響。' })) return;
      try {
        code = (await api('/api/me/rotate-code', { method: 'POST' })).code;
        body.querySelector('#my-token').textContent = code;
        toast('已換一組登入碼，舊的已失效');
      } catch (err) { toast(err.message); }
    };
    body.querySelector('#api-qr').onclick = () => openQr(); // C-186：QR Code 併進 API 資訊與登入碼
    body.addEventListener('click', async e => {
      const c = e.target.closest('[data-copy]');
      if (c) toast((await copyText(c.dataset.copy)) ? '已複製' : '複製失敗');
    });
  }

  // 進階設定
  // 所屬專案（C-146 B）：一般成員只能看；群組管理員在「專案管理」調整
  function projMineHtml() {
    const rows = [state.me, ...[...state.participants.values()].filter(p => p.ownerParticipantId === meId() && p.status !== 'disabled')];
    return rows.map(p => `<div class="proj-row"><b>${esc(p.name)}${p.participantId === meId() ? '（我）' : ''}</b><span class="muted small">${(p.projects || []).filter(x => PROJECTS.includes(x)).map(projName).map(esc).join('、') || '尚未加入任何專案'}</span></div>`).join('');
  }

  // 專案管理（只有群組管理員）：左邊專案清單與異動紀錄，右邊勾選成員
  function openProjAdmin(selected = state.projectList.find(p => !p.archived)?.id) {
    const pm = { sel: selected, draft: null, events: [] };
    const body = openModal('專案管理', '<div class="pa-grid"><section class="pa-col" id="pa-left"></section><section class="pa-col" id="pa-right"></section></div>',
      { size: 'wide', sub: `僅群組管理員（${esc(state.projMeta.adminName || '')}）可操作` });
    const people = () => [...state.participants.values()].filter(p => p.status !== 'disabled');
    const fixed = p => state.projMeta.crossRoleIds.includes(p.participantId);
    // 跨專案角色一律算在內（固定在所有專案），儲存時順便補齊
    const resetDraft = () => { pm.draft = new Set(people().filter(p => fixed(p) || (p.projects || []).includes(pm.sel)).map(p => p.participantId)); };
    async function loadEvents() {
      pm.events = pm.sel ? (await api(`/api/projects/${encodeURIComponent(pm.sel)}/events?limit=10`).catch(() => ({ items: [] }))).items : [];
    }
    function drawLeft() {
      const rows = state.projectList.map(p => {
        const blocked = p.openCards > 0;
        return `<div class="pa-row${p.id === pm.sel ? ' sel' : ''}${p.archived ? ' archived' : ''}" data-pj="${esc(p.id)}">
          <button type="button" class="pa-pick" data-pa="pick" aria-pressed="${p.id === pm.sel}"><b>${esc(p.name)}</b>${p.archived ? ' <span class="pill-tag grey">已封存</span>' : ''}
            <span class="muted small">成員 ${p.memberCount} · 未結案卡 ${p.openCards}</span></button>
          ${p.archived ? '<button type="button" class="btn small" data-pa="unarchive">還原</button>'
            : `<button type="button" class="btn small" data-pa="rename">改名</button>
               <button type="button" class="btn small danger-outline" data-pa="archive" ${blocked ? `aria-disabled="true" title="還有 ${p.openCards} 張未結案卡，請先結案或移到別的專案"` : ''}>封存</button>`}
        </div>`;
      }).join('');
      const selP = state.projectList.find(p => p.id === pm.sel);
      body.querySelector('#pa-left').innerHTML = `<div class="pa-head"><b>專案</b></div>${rows}
        ${state.projectList.some(p => !p.archived && p.openCards) ? '<p class="muted small pa-note">「封存」不能按：還有未結案卡，請先結案或把卡移到別的專案。</p>' : ''}
        <div class="pm-new"><input id="pa-new-name" maxlength="20" placeholder="新專案名稱" aria-label="新專案名稱"><button type="button" class="btn small primary" data-pa="create">新增專案</button></div>
        <p class="muted small">${esc(newProjText())}，其他成員請在成員清單勾選加入。</p>
        ${selP ? `<div class="pa-head"><b>異動紀錄（${esc(selP.name)}）</b></div>
        <ul class="pa-log">${pm.events.map(e => `<li><span class="muted small">${esc(fmtTime(e.at))}</span> ${esc(e.text)}</li>`).join('') || '<li class="muted small">還沒有紀錄</li>'}</ul>` : ''}`;
    }
    function memberRow(p, archived) {
      const on = pm.draft.has(p.participantId);
      const owner = p.memberType === 'ai' ? state.participants.get(p.ownerParticipantId) : null;
      const ownerOut = owner && !pm.draft.has(owner.participantId);
      let dis = '', why = '';
      if (archived) dis = 'disabled';
      else if (fixed(p)) dis = 'disabled'; // 標籤已說明是跨專案角色
      else if (ownerOut && !on) { dis = 'disabled'; why = `所屬人類 ${owner.name} 不在此專案`; }
      const sub = fixed(p) ? '<span class="pill-tag blue">跨專案角色</span>'
        : !(p.projects || []).filter(x => PROJECTS.includes(x)).length ? '<span class="muted small">· 新加入，尚未指派專案</span>'
        : p.environment ? `<span class="muted small">· ${esc(p.environment)}</span>` : '';
      return `<div class="pa-mem"><span class="pa-mem-name">${esc(p.name)} ${sub}${why ? `<span class="muted small pa-why">${esc(why)}</span>` : ''}</span>
        <label class="check"><input type="checkbox" data-mem="${esc(p.participantId)}" ${on || fixed(p) ? 'checked' : ''} ${dis}> ${fixed(p) ? '成員（固定）' : '成員'}</label></div>`;
    }
    function drawRight() {
      const selP = state.projectList.find(p => p.id === pm.sel);
      const box = body.querySelector('#pa-right');
      if (!selP) { box.innerHTML = '<p class="muted">選一個專案來管理成員。</p>'; return; }
      const list = people(), humans = list.filter(p => p.memberType === 'human'), ais = list.filter(p => p.memberType === 'ai');
      box.innerHTML = `<div class="pa-head"><b>${esc(selP.name)} · 成員</b><span class="muted small">勾選＝可看到並參與此專案</span></div>
        <div class="pa-group">人類</div>${humans.map(p => memberRow(p, selP.archived)).join('')}
        <div class="pa-group">AI</div>${ais.map(p => memberRow(p, selP.archived)).join('') || '<p class="muted small">沒有 AI</p>'}
        <p class="muted small pa-note">AI 的專案不能超出所屬人類的專案。一般成員在「進階設定」只能看自己的專案，不能自己加入。取消勾選時，該成員在這個專案負責的未結案卡會退回待處理。</p>
        ${selP.archived ? '<p class="muted small">專案已封存，請先還原再調整成員。</p>' : '<div class="pa-save"><button type="button" class="btn primary" data-pa="save">儲存</button></div>'}`;
    }
    async function refresh() {
      await Promise.all([loadProjectList(), loadParticipants()]);
      const m = await api('/api/me').catch(() => null);
      if (m) state.me = { ...state.me, ...m };
      if (!state.projectList.some(p => p.id === pm.sel)) pm.sel = state.projectList.find(p => !p.archived)?.id;
      resetDraft(); await loadEvents(); drawLeft(); drawRight();
      drawProjSwitch(); renderMessages(false); if (state.page === 'work') renderWork();
    }
    body.addEventListener('change', e => {
      const c = e.target.closest('[data-mem]');
      if (!c) return;
      if (c.checked) pm.draft.add(c.dataset.mem); else pm.draft.delete(c.dataset.mem);
      // 所屬人類被取消時，他名下還沒勾的 AI 要跟著停用；重畫右欄即可
      if (state.participants.get(c.dataset.mem)?.memberType === 'human') drawRight();
    });
    body.addEventListener('click', async e => {
      const b = e.target.closest('[data-pa]');
      if (!b) return;
      const row = b.closest('.pa-row'), id = row?.dataset.pj, act = b.dataset.pa;
      try {
        if (act === 'pick') { pm.sel = id; resetDraft(); await loadEvents(); drawLeft(); drawRight(); return; }
        if (act === 'archive' && b.getAttribute('aria-disabled') === 'true') return toast(b.title);
        if (act === 'create') {
          const name = body.querySelector('#pa-new-name').value.trim();
          if (!name) return toast('請輸入專案名稱');
          const r = await api('/api/projects', { method: 'POST', body: { name } });
          pm.sel = r.id; toast(crossNames().length ? `已新增專案，你和 ${crossNames().join('、')} 已加入` : '已新增專案，目前只有你');
        } else if (act === 'rename') {
          const p = state.projectList.find(x => x.id === id);
          const name = await promptName('改名', p?.name || '');
          if (!name || name === p?.name) return;
          await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
          toast('已改名');
        } else if (act === 'archive') {
          if (!await confirmDialog({ title: '封存專案？', confirmText: '封存', danger: true, message: `封存「<b>${esc(projName(id))}</b>」後，不能再選它來發訊息或建卡；歷史內容保留，之後可以還原。` })) return;
          await api(`/api/projects/${encodeURIComponent(id)}/archive`, { method: 'POST' });
          toast('已封存');
        } else if (act === 'unarchive') {
          await api(`/api/projects/${encodeURIComponent(id)}/unarchive`, { method: 'POST' });
          toast('已還原');
        } else if (act === 'save') {
          const memberIds = [...pm.draft];
          const path = `/api/projects/${encodeURIComponent(pm.sel)}/members`;
          const dry = await api(path, { method: 'PUT', body: { memberIds, dryRun: true } });
          if (!dry.impact.length) return toast('沒有變更');
          const back = dry.impact.filter(x => x.returnedCards.length);
          if (back.length && !await confirmDialog({ title: '移出成員？', confirmText: '確認儲存', danger: true,
            message: back.map(x => `<b>${esc(x.name)}</b> 負責的 ${x.returnedCards.length} 張卡（${esc(x.returnedCards.join('、'))}）會退回待處理、改為未指派。`).join('<br>') })) return;
          await api(path, { method: 'PUT', body: { memberIds } });
          toast(`已更新 ${projName(pm.sel)} 的成員`);
        }
        await refresh();
      } catch (err) { toast(err.message); }
    });
    resetDraft();
    loadEvents().then(() => { drawLeft(); drawRight(); });
    drawLeft(); drawRight();
  }
  // 小對話框：輸入名稱（改名用）
  // ---------- C-182 成員與權限（第一層，只有管理員）----------
  // C-233：分頁 成員｜專案｜邀請；成員分頁裡再分「依專案／依成員」（memView）
  const perm = { tab: 'members', memView: 'byProject', moreOpen: null, invites: null, draft: new Map(), events: {}, openLog: null, pq: '', mq: '', selProj: null, selMember: null, picker: false, pickSel: new Set(), pickQ: '', addOpen: false, mobileDetail: false };
  const permDirty = () => perm.draft.size > 0;
  // C-221：新專案一開始的成員＝建立者＋目前的跨專案角色（不寫死 PO、SM）
  const crossNames = () => state.projMeta.crossRoleIds.filter(x => x !== meId()).map(x => state.participants.get(x)?.name).filter(Boolean);
  const newProjText = () => { const n = crossNames(); return n.length ? `新專案一開始只有你與跨專案角色（${n.join('、')}）` : '新專案一開始只有你'; };
  function permLeave(go) {
    confirmDialog({ title: '還有沒儲存的變更', confirmText: '放棄變更並離開', danger: true, message: `成員與權限有 <b>${perm.draft.size} 位成員</b>的變更還沒儲存，離開後會不見。` })
      .then(ok => { if (ok) go(); });
  }
  const permPeople = () => [...state.participants.values()].filter(p => p.status !== 'disabled' && p.status !== 'deleted' && p.memberType !== 'system');
  const permBase = p => ({ projects: new Set((p.projects || []).filter(x => PROJECTS.includes(x))), cross: state.projMeta.crossRoleIds.includes(p.participantId), leaders: new Set(PROJECTS.filter(pj => leadersOf(pj).includes(p.participantId))), roles: new Map(Object.entries(p.projectRoles || {}).filter(([, v]) => v)) });
  const sameRoles = (a, b) => [...new Set([...a.keys(), ...b.keys()])].every(k => (a.get(k) || '') === (b.get(k) || ''));
  const permCanEdit = pj => isAdmin() || myLeadProjects().includes(pj); // leader 只能改自己當 leader 的專案欄
  const permCur = p => perm.draft.get(p.participantId) || permBase(p);
  const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
  function permSet(p, next) {
    const b = permBase(p);
    next.leaders = new Set([...(next.leaders || b.leaders)].filter(pj => next.cross || next.projects.has(pj))); // 移出專案，leader 身分一起拿掉
    // C-219：角色沿用目前的；移出的專案角色清掉、原本就在的專案恢復原角色
    next.roles = new Map(next.roles || permCur(p).roles || b.roles);
    for (const pj of PROJECTS) { const inNow = next.cross || next.projects.has(pj); if (!inNow) next.roles.delete(pj); else if (!next.roles.has(pj) && (b.cross || b.projects.has(pj)) && b.roles.has(pj) && !(permCur(p).cross || permCur(p).projects.has(pj))) next.roles.set(pj, b.roles.get(pj)); }
    if (next.cross === b.cross && (next.cross || sameSet(next.projects, b.projects)) && sameSet(next.leaders, b.leaders) && sameRoles(next.roles, b.roles)) perm.draft.delete(p.participantId);
    else perm.draft.set(p.participantId, next);
  }
  // AI 所屬人類不在那個專案時鎖住（以畫面上的變更後狀態判斷）
  function ownerBlocks(p, pj) {
    if (p.memberType !== 'ai') return '';
    const o = state.participants.get(p.ownerParticipantId);
    if (!o) return '找不到所屬人類';
    const oc = permCur(o);
    return oc.cross || oc.projects.has(pj) ? '' : `所屬人類 ${o.name} 不在${projName(pj)}，AI 的專案不能超出所屬人類`;
  }
  function permSummary() {
    const out = [];
    for (const [id, d] of perm.draft) {
      const p = state.participants.get(id), b = permBase(p);
      if (d.cross !== b.cross) out.push(`${p.name}${d.cross ? '設為' : '取消'}跨專案角色`);
      if (!d.cross) {
        for (const x of d.projects) if (!b.projects.has(x) || b.cross) out.push(`${p.name}加入${projName(x)}`);
        if (!b.cross) for (const x of b.projects) if (!d.projects.has(x)) out.push(`${p.name}離開${projName(x)}`);
      }
      for (const x of PROJECTS) if ((d.roles?.get(x) || '') !== (b.roles.get(x) || '') && (d.cross || d.projects.has(x))) out.push(`${p.name}在${projName(x)}的角色改成${d.roles?.get(x) || '未設定'}`);
      for (const x of d.leaders || []) if (!b.leaders.has(x)) out.push(`${p.name}成為${projName(x)} leader`);
      for (const x of b.leaders) if (!(d.leaders || new Set()).has(x)) out.push(`${p.name}不再是${projName(x)} leader`);
    }
    return out;
  }
  // C-184：專案再多都只看一個專案或一個人；兩種檢視共用 perm.draft 與底部變更列
  const narrowPerm = () => matchMedia('(max-width: 899px)').matches;
  const permProjects = () => (isAdmin() ? PROJECTS : myLeadProjects());
  const inProj = (p, pj) => { const c = permCur(p); return c.cross || c.projects.has(pj); };
  const ownerOf = p => state.participants.get(p.ownerParticipantId);
  const permSub = p => (p.memberType === 'ai' ? [`${ownerOf(p)?.name || ''}的`, p.environment].filter(Boolean).join(' · ') : p.environment || '');
  const pmSw = (on, attrs, chg, label, extra = '') => `<button type="button" class="pm-sw${chg ? ' chg' : ''}" role="switch" aria-checked="${on}" aria-label="${esc(label)}" ${attrs} ${extra}></button>`;
  const projChanges = pj => [...perm.draft.keys()].filter(id => {
    const p = state.participants.get(id), d = perm.draft.get(id), b = permBase(p);
    return (b.cross || b.projects.has(pj)) !== (d.cross || d.projects.has(pj)) || (d.leaders || b.leaders).has(pj) !== b.leaders.has(pj);
  }).length;
  function permAdd(p, pj) { const c = permCur(p); permSet(p, { projects: new Set([...c.projects, pj]), cross: c.cross, leaders: c.leaders }); }
  function permRemove(p, pj) {
    const c = permCur(p), np = new Set(c.projects); np.delete(pj);
    permSet(p, { projects: np, cross: c.cross, leaders: c.leaders });
    // 人類移出時，他在這個專案的 AI 一併移出（列在「這次會移出」看得到）
    if (p.memberType === 'human') for (const a of permPeople().filter(a => a.memberType === 'ai' && a.ownerParticipantId === p.participantId && !permCur(a).cross && permCur(a).projects.has(pj))) permRemove(a, pj);
  }
  function permSetRole(p, pj, v) { const c = permCur(p), r = new Map(c.roles || permBase(p).roles); if (v) r.set(pj, v); else r.delete(pj); permSet(p, { projects: new Set(c.projects), cross: c.cross, leaders: c.leaders, roles: r }); }
  const roleChanged = (p, pj) => (permCur(p).roles?.get(pj) || '') !== (permBase(p).roles.get(pj) || '');
  // 人類：可改就下拉，不能改就顯示文字；AI：角色跟著 AI 設定，固定
  function permRoleHtml(p, pj) {
    if (p.memberType !== 'human') return `<span class="pm-role-tag">${esc(p.role || '')}</span><span class="muted small">${state.projMeta.crossRoleIds.includes(p.participantId) ? '跨專案角色' : '固定'}</span>`;
    const v = permCur(p).roles?.get(pj) || '';
    if (!permCanEdit(pj)) return `<span class="pm-role-tag${v ? '' : ' empty'}">${esc(v || '未設定')}</span>`;
    return roleSelectHtml(v, `data-pm-role="${esc(p.participantId)}" data-pj="${esc(pj)}"`, { changed: roleChanged(p, pj), label: `${p.name} 在${projName(pj)}的角色`, pj, ai: false });
  }
  function permStar(p, pj) { const c = permCur(p), l = new Set(c.leaders || permBase(p).leaders); if (l.has(pj)) l.delete(pj); else l.add(pj); permSet(p, { projects: new Set(c.projects), cross: c.cross, leaders: l }); }
  // 誰能移出：管理員全部（跨專案角色除外）；leader 只能動自己的專案，不能動管理員與自己
  const canRemove = (p, pj) => permCanEdit(pj) && !permCur(p).cross && (isAdmin() || (p.participantId !== state.projMeta.adminId && p.participantId !== meId()));
  // C-233：共用的小元件
  const permView = () => (isAdmin() ? perm.memView : 'byProject'); // leader 只有依專案
  const pmViewSeg = () => (isAdmin() ? `<div class="seg-scope full pm-view" role="group" aria-label="檢視方式">${[['byProject', '依專案'], ['byMember', '依成員']].map(([k, t]) => `<button type="button" data-pm-view="${k}" aria-pressed="${perm.memView === k}">${t}</button>`).join('')}</div>` : '');
  const pmLock = why => `<span class="pm-lock" role="img" aria-label="${esc(why)}" title="${esc(why)}">🔒</span>`;
  const pmHead = first => `<thead><tr><th scope="col">${first}</th><th scope="col" class="c-role">角色</th><th scope="col" class="c-lead">leader</th><th scope="col" class="c-act">移出</th></tr></thead>`;
  const pmGrp = t => `<tr class="pm-grp-tr"><td colspan="4">${t}</td></tr>`;
  // leader 欄：只有人類；管理員本人「—」；管理員可切 ★／☆，其他人唯讀
  function pmLeadCell(p, pj) {
    const c = permCur(p), b = permBase(p), lead = (c.leaders || b.leaders).has(pj), lchg = lead !== b.leaders.has(pj);
    if (p.memberType !== 'human') return '<span class="muted">—</span>';
    if (p.participantId === state.projMeta.adminId) return '<span class="muted" title="管理員本來就能管所有專案">—</span>';
    if (isAdmin() && !c.cross) return `<button type="button" class="pm-star on-${lead}${lchg ? ' chg' : ''}" data-pm-star="${esc(p.participantId)}" data-pj="${esc(pj)}" aria-pressed="${lead}" aria-label="${esc(p.name)} 是${esc(projName(pj))}的 leader" title="${lead ? '取消 leader' : '設為 leader'}">${lead ? '★' : '☆'}</button>`;
    return lead ? '<span class="pm-star-ro" aria-label="leader">★</span>' : '<span class="muted">—</span>';
  }
  function pmActCell(p, pj, crossWhere) {
    const c = permCur(p);
    if (p.participantId === state.projMeta.adminId) return pmLock('管理員自動在所有專案');
    if (c.cross) return pmLock(`跨專案角色自動在所有專案；要移出請先${crossWhere}關掉跨專案角色`);
    if (canRemove(p, pj)) return `<button type="button" class="pm-x" data-pm-rm="${esc(p.participantId)}" data-pj="${esc(pj)}" aria-label="把 ${esc(p.name)} 移出${esc(projName(pj))}" title="移出">✕</button>`;
    return p.participantId === meId() ? pmLock('自己不能移出') : '<span class="muted">—</span>';
  }
  const pmRoleCell = (p, pj) => (p.memberType === 'human' ? permRoleHtml(p, pj) : `<span class="pm-ai-role">${esc(p.role || '')}</span>`);
  function permByProjectHtml() {
    const all = permProjects();
    if (!all.includes(perm.selProj)) perm.selProj = all[0] || null;
    const pj = perm.selProj, admin = isAdmin(), q = perm.pq.trim().toLowerCase();
    const list = all.filter(x => !q || projName(x).toLowerCase().includes(q));
    const left = `<section class="pm-col pm-list" aria-label="專案清單"><div class="pm-search">${pmViewSeg()}<input id="pm-pq" type="search" placeholder="搜尋專案（${all.length} 個）" aria-label="搜尋專案" value="${esc(perm.pq)}"></div>
      ${list.map(x => { const n = permPeople().filter(p => inProj(p, x)).length, ch = projChanges(x); return `<button type="button" class="pm-li${x === pj ? ' sel' : ''}" data-pm-proj="${esc(x)}" aria-current="${x === pj}"><b>${esc(projName(x))}</b>${ch ? `<span class="pm-chg-tag">${ch} 變更</span>` : ''}<span class="muted small">${n}</span></button>`; }).join('') || '<p class="muted small pm-pad">找不到專案</p>'}</section>`;
    if (!pj) return `<div class="pm-split">${left}</div>`;
    const members = permPeople().filter(p => inProj(p, pj));
    // C-222 表格「成員｜角色｜leader｜移出」；C-233：名字可以點，跳到依成員
    const row = p => {
      const c = permCur(p), b = permBase(p), isNew = !(b.cross || b.projects.has(pj)), lchg = (c.leaders || b.leaders).has(pj) !== b.leaders.has(pj), isAdm = p.participantId === state.projMeta.adminId;
      const tags = [isAdm ? '<span class="pill-tag blue">管理員</span>' : c.cross ? '<span class="pm-cross-tag">跨專案</span>' : '', isNew ? '<span class="pill-tag yellow">新加入</span>' : '', !admin && p.participantId === meId() ? '<span class="muted small">· 你</span>' : ''].join('');
      const name = admin ? `<button type="button" class="pm-name-link" data-pm-goto-mem="${esc(p.participantId)}" title="看 ${esc(p.name)} 的所有專案">${esc(p.name)}</button>` : `<b>${esc(p.name)}</b>`;
      return `<tr class="pm-tr${isNew || lchg ? ' chg' : ''}"><td class="c-name">${name}${tags}${permSub(p) ? `<span class="pm-sub"> · ${esc(permSub(p))}</span>` : ''}</td><td class="c-role">${pmRoleCell(p, pj)}</td><td class="c-lead">${pmLeadCell(p, pj)}</td><td class="c-act">${pmActCell(p, pj, '到「依成員」')}</td></tr>`;
    };
    const removed = permPeople().filter(p => { const b = permBase(p); return (b.cross || b.projects.has(pj)) && !inProj(p, pj); });
    const rmRow = p => `<tr class="pm-tr chg pm-gone"><td class="c-name"><s>${esc(p.name)}</s><span class="pill-tag red">將移出</span>${permSub(p) ? `<span class="pm-sub"> · ${esc(permSub(p))}</span>` : ''}</td><td class="c-role"><span class="muted">—</span></td><td class="c-lead"><span class="muted">—</span></td><td class="c-act"><button type="button" class="link small" data-pm-restore="${esc(p.participantId)}" data-pj="${esc(pj)}">復原</button></td></tr>`;
    const humans = members.filter(p => p.memberType === 'human');
    const owner = a => ownerOf(a)?.name || '';
    const ais = members.filter(p => p.memberType === 'ai').sort((a, b) => owner(a).localeCompare(owner(b), 'zh-Hant') || a.name.localeCompare(b.name, 'zh-Hant')); // 依主人分組
    const pr = state.projectList.find(x => x.id === pj);
    const mid = `<section class="pm-col pm-detail" aria-label="${esc(projName(pj))} 的成員">
      ${narrowPerm() ? '<button type="button" class="ph-back pm-back" data-pm-back>‹ 專案清單</button>' : ''}
      <div class="pm-dhead"><div class="pm-dtitle"><strong>${esc(projName(pj))}</strong><span class="pm-sub"> · API 代號 ${esc(pj)} · ${members.length} 人</span></div><span class="grow"></span>
        ${admin ? '<button type="button" class="btn small" data-pm-invite>邀請新的人</button>' : ''}${permCanEdit(pj) ? '<button type="button" class="btn primary small" data-pm-pick>＋ 加入成員</button>' : ''}</div>
      ${pr ? repoLine(pr, permCanEdit(pj), { code: false }) : ''}
      <table class="pm-table">${pmHead('成員')}
      <tbody>${pmGrp(`人類 · ${humans.length}`)}${humans.map(row).join('') || '<tr><td colspan="4" class="muted small">沒有人類成員</td></tr>'}
      ${pmGrp(`AI · ${ais.length}（依主人分組；角色跟著 AI 設定）`)}${ais.map(row).join('') || '<tr><td colspan="4" class="muted small">沒有 AI</td></tr>'}
      ${removed.length ? pmGrp('這次會移出') + removed.map(rmRow).join('') : ''}</tbody></table>
      <p class="muted small pm-note">🔒＝管理員或跨專案角色，自動在所有專案，滑過看怎麼移出。✕＝移出（人類名下的 AI 會一起移出）${admin ? '；☆ 點了變 ★＝設為 leader（只有人類）；點名字看他的所有專案' : ''}。</p></section>`;
    const cls = narrowPerm() ? (perm.picker ? ' m-pick' : perm.mobileDetail ? ' m-detail' : ' m-list') : perm.picker ? ' with-pick' : '';
    return `<div class="pm-split${cls}">${left}${mid}${perm.picker ? permPickerHtml(pj) : ''}</div>`;
  }
  // 「＋ 加入成員」：只列還不在這個專案的人；人類底下縮排列他的 AI；主人不在的 AI 鎖住
  function permPickerHtml(pj) {
    const q = perm.pickQ.trim().toLowerCase(), sel = perm.pickSel, admin = isAdmin();
    const out = permPeople().filter(p => !inProj(p, pj));
    const match = p => !q || p.name.toLowerCase().includes(q) || (p.role || '').toLowerCase().includes(q);
    const mineP = myProjects();
    const humanOk = p => admin || (!permBase(p).projects.size && !permBase(p).cross) || [...permBase(p).projects].some(x => mineP.includes(x));
    const humans = out.filter(p => p.memberType === 'human' && humanOk(p));
    const ownerIn = a => { const o = ownerOf(a); return !!o && (inProj(o, pj) || sel.has(o.participantId)); };
    const box = (p, indent, lock = '') => {
      const note = lock ? '🔒 ' + lock : p.memberType === 'ai' ? (indent ? '跟著主人' : permSub(p)) : `人類${permCur(p).projects.size || permCur(p).cross ? '' : ' · 還沒有專案'}`;
      return `<label class="pm-row pm-pick-row${indent ? ' indent' : ''}${lock ? ' off' : ''}"><input type="checkbox" data-pm-picksel="${esc(p.participantId)}" ${sel.has(p.participantId) ? 'checked' : ''} ${lock ? 'disabled' : ''}><span class="pm-name"><b>${esc(p.name)}</b></span><span class="muted small">${esc(note)}</span></label>`;
    };
    const rows = [];
    for (const h of humans) {
      const kids = sel.has(h.participantId) ? out.filter(a => a.memberType === 'ai' && a.ownerParticipantId === h.participantId) : []; // 勾了人類，名下的 AI 才列在下面
      if (!match(h) && !kids.some(match)) continue;
      rows.push(box(h, false), ...kids.map(a => box(a, true)));
    }
    const listed = new Set(humans.filter(h => sel.has(h.participantId)).map(h => h.participantId));
    const ownerInAis = out.filter(a => a.memberType === 'ai' && !listed.has(a.ownerParticipantId) && ownerOf(a) && inProj(ownerOf(a), pj) && match(a));
    if (ownerInAis.length) rows.push('<div class="pm-grp">主人已在這個專案的 AI</div>', ...ownerInAis.map(a => box(a, false)));
    const others = admin ? out.filter(a => a.memberType === 'ai' && !listed.has(a.ownerParticipantId) && !ownerIn(a) && match(a)) : [];
    if (others.length) rows.push(`<details class="pm-others"><summary class="pm-grp">其他（主人不在${esc(projName(pj))}的 AI，${others.length} 個）</summary>${others.map(a => box(a, false, `主人${ownerOf(a) ? ' ' + ownerOf(a).name : ''}不在${projName(pj)}`)).join('')}</details>`);
    const pending = perm.draft.size > 0;
    return `<section class="pm-col pm-pick" aria-label="加入${esc(projName(pj))}的成員">
      <div class="pm-dhead"><strong>加入${esc(projName(pj))}的成員</strong></div>
      <div class="pm-search"><input id="pm-pickq" type="search" placeholder="搜尋要加入的人" aria-label="搜尋要加入的人" value="${esc(perm.pickQ)}"></div>
      <div class="pm-pick-list">${rows.join('') || '<p class="muted small pm-pad">沒有可以加入的人</p>'}</div>
      <div class="pm-pick-foot"><button type="button" class="btn" data-pm-pick-cancel>取消</button><button type="button" class="btn primary" data-pm-pick-ok ${sel.size ? '' : 'disabled'}>加入 ${sel.size} 人${pending ? '（跟其他變更一起儲存）' : ''}</button></div>
      <p class="muted small pm-pad">${pending ? '底下還有沒儲存的變更，這次加入會一起放進變更列。' : '加入不會退回任何卡片，按下就直接儲存，10 秒內可以復原。'}勾人類時，名下的 AI 會列在下面可一起勾。</p></section>`;
  }
  function permByMemberHtml() {
    const all = permPeople(), q = perm.mq.trim().toLowerCase();
    if (!all.some(p => p.participantId === perm.selMember)) perm.selMember = all[0]?.participantId || null;
    const list = all.filter(p => !q || p.name.toLowerCase().includes(q) || (p.role || '').toLowerCase().includes(q));
    const li = p => { const c = permCur(p); return `<button type="button" class="pm-li${p.participantId === perm.selMember ? ' sel' : ''}" data-pm-mem="${esc(p.participantId)}" aria-current="${p.participantId === perm.selMember}"><b>${esc(p.name)}</b>${perm.draft.has(p.participantId) ? '<span class="pm-chg-tag">變更</span>' : ''}<span class="muted small">${c.cross ? '全部' : `${c.projects.size} 專案`}</span></button>`; };
    const hs = list.filter(p => p.memberType === 'human'), as = list.filter(p => p.memberType === 'ai');
    const left = `<section class="pm-col pm-list" aria-label="成員清單"><div class="pm-search">${pmViewSeg()}<input id="pm-mq" type="search" placeholder="搜尋成員（${all.length} 人）" aria-label="搜尋成員" value="${esc(perm.mq)}"></div>
      ${hs.length ? `<div class="pm-sec">人類</div>${hs.map(li).join('')}` : ''}${as.length ? `<div class="pm-sec">AI</div>${as.map(li).join('')}` : ''}${list.length ? '' : '<p class="muted small pm-pad">找不到成員</p>'}</section>`;
    const p = state.participants.get(perm.selMember);
    if (!p) return `<div class="pm-split">${left}</div>`;
    const c = permCur(p), b = permBase(p), id = esc(p.participantId), isAdm = p.participantId === state.projMeta.adminId;
    const projs = c.cross ? PROJECTS : PROJECTS.filter(x => c.projects.has(x));
    const gone = c.cross ? [] : PROJECTS.filter(x => (b.cross || b.projects.has(x)) && !c.projects.has(x));
    const addable = c.cross ? [] : PROJECTS.filter(x => !c.projects.has(x) && permCanEdit(x));
    const addWhy = x => (p.memberType === 'ai' && !(ownerOf(p) && inProj(ownerOf(p), x)) ? `主人不在${projName(x)}` : '');
    const menu = perm.addOpen ? `<div class="pm-addmenu" role="menu">${addable.map(x => { const why = addWhy(x); return `<button type="button" role="menuitem" data-pm-addp="${esc(x)}" ${why ? `disabled title="${esc(why)}"` : ''}>${esc(projName(x))}${why ? `<span class="muted small">🔒 ${esc(why)}</span>` : ''}</button>`; }).join('')}</div>` : '';
    // C-233：所屬專案也是「專案｜角色｜leader｜移出」表格；專案名可以點，跳到依專案
    const row = x => {
      const isNew = !(b.cross || b.projects.has(x)), lchg = (c.leaders || b.leaders).has(x) !== b.leaders.has(x);
      return `<tr class="pm-tr${isNew || lchg ? ' chg' : ''}"><td class="c-name"><button type="button" class="pm-name-link" data-pm-goto-proj="${esc(x)}" title="看${esc(projName(x))}的成員">${esc(projName(x))}</button>${isNew ? '<span class="pill-tag yellow">新加入</span>' : ''}</td><td class="c-role">${pmRoleCell(p, x)}</td><td class="c-lead">${pmLeadCell(p, x)}</td><td class="c-act">${pmActCell(p, x, '在下面「帳號」')}</td></tr>`;
    };
    const goneRow = x => `<tr class="pm-tr chg pm-gone"><td class="c-name"><s>${esc(projName(x))}</s><span class="pill-tag red">將離開</span></td><td class="c-role"><span class="muted">—</span></td><td class="c-lead"><span class="muted">—</span></td><td class="c-act"><button type="button" class="link small" data-pm-restore="${id}" data-pj="${esc(x)}">復原</button></td></tr>`;
    const addRow = addable.length ? `<tr class="pm-add-tr"><td colspan="4"><span class="pm-addwrap"><button type="button" class="link pm-add-proj" data-pm-addopen aria-expanded="${perm.addOpen}">＋ 加入專案</button>${menu}</span></td></tr>` : '';
    const crossNow = state.projMeta.crossRoleIds.map(x => state.participants.get(x)?.name).filter(Boolean);
    const sub = [p.memberType === 'ai' ? 'AI' : '人類', permSub(p), p.lastSeenAt ? `最後上線 ${agoText(p.lastSeenAt)}` : ''].filter(Boolean).join(' · ');
    const account = isAdmin() ? `<div class="pm-sec">帳號</div>
        <div class="pm-set"><div class="pm-set-t"><b id="pm-cross-t">跨專案角色</b><span class="pm-sub">開了會自動在所有專案${crossNow.length ? `（現在：${esc(crossNow.join('、'))}）` : ''}；跟其他變更一起儲存</span></div>
          ${pmSw(c.cross, `data-pm-cross="${id}" aria-describedby="pm-cross-t"`, c.cross !== b.cross, `${p.name} 跨專案角色`, isAdm && c.cross ? 'aria-disabled="true" title="管理員本人不能關掉自己的跨專案角色（避免沒人能管）"' : '')}</div>
        ${p.memberType === 'human' && p.participantId !== meId() ? `<div class="pm-set"><div class="pm-set-t"><b>重設登入</b><span class="pm-sub">登出他所有裝置、作廢舊登入碼、清掉帳號密碼，產生新邀請連結（立即執行）</span></div><button type="button" class="btn small danger-outline" data-pm-reset="${id}">重設登入…</button></div>` : ''}` : '';
    const right = `<section class="pm-col pm-detail" aria-label="${esc(p.name)} 的專案與帳號">
      ${narrowPerm() ? '<button type="button" class="ph-back pm-back" data-pm-back>‹ 成員清單</button>' : ''}
      <div class="pm-dhead"><div class="pm-dtitle"><strong>${esc(p.name)}</strong>${isAdm ? '<span class="pill-tag blue">管理員</span>' : c.cross ? '<span class="pm-cross-tag">跨專案</span>' : ''}<span class="pm-sub"> · ${esc(sub)}</span></div></div>
      <div class="pm-sec">所屬專案</div>
      <table class="pm-table">${pmHead('專案')}<tbody>
        ${projs.map(row).join('') || '<tr><td colspan="4" class="muted small">還沒有專案</td></tr>'}${gone.map(goneRow).join('')}${addRow}</tbody></table>
      ${account}</section>`;
    return `<div class="pm-split${narrowPerm() ? (perm.mobileDetail ? ' m-detail' : ' m-list') : ''}">${left}${right}</div>`;
  }
  // 依成員加入專案時：人類有 AI 就問一次要不要一起加入
  async function permAskAis(p, pj) {
    const mine = permPeople().filter(a => a.memberType === 'ai' && a.ownerParticipantId === p.participantId && !inProj(a, pj));
    if (!mine.length) return;
    const pick = await new Promise(res => {
      const body = openModal('也讓這位成員的 AI 加入？', `<p>${esc(p.name)} 加入「${esc(projName(pj))}」。要不要讓這位成員名下的 AI 一起加入？</p>
        <div class="stack">${mine.map(a => `<label class="chk"><input type="checkbox" name="pm-ai" value="${esc(a.participantId)}"> ${esc(a.name)}<span class="muted small">${esc(a.role || '')}</span></label>`).join('')}</div>`,
        { size: 'narrow', foot: '<button class="btn" type="button" id="pm-ai-no">都不用</button><button class="btn primary" type="button" id="pm-ai-ok">加入勾選的 AI</button>' });
      body.modal.querySelector('#pm-ai-no').onclick = () => { closeModal(); res([]); };
      body.modal.querySelector('#pm-ai-ok').onclick = () => { const ids = [...body.querySelectorAll('input[name="pm-ai"]:checked')].map(i => i.value); closeModal(); res(ids); };
    });
    for (const id of pick) permAdd(state.participants.get(id), pj);
  }
  // C-233：專案分頁＝群組名稱一張卡＋專案表格；改名／程式庫／異動紀錄／封存收進「⋯」
  function permProjectsHtml() {
    const list = state.projectList, active = list.filter(p => !p.archived);
    const rows = list.map(p => {
      const open = perm.openLog === p.id, blocked = !p.archived && p.openCards > 0, why = `還有 ${p.openCards} 張未結案卡，請先結案或移到別的專案`;
      const repo = p.repo ? `<a class="pm-url" href="${esc(p.repo.url)}" target="_blank" rel="noopener noreferrer" title="${esc(p.repo.url)}">${esc(p.repo.url.replace(/^https?:\/\//, ''))}</a>${p.repo.branch ? `<span class="pm-sub">${esc(p.repo.branch)}</span>` : ''}`
        : p.archived ? '<span class="muted">—</span>' : `<span class="pm-sub">未填 · </span><button type="button" class="link small" data-pm-repo="${esc(p.id)}">設定</button>`;
      const menu = perm.moreOpen === p.id ? `<div class="pm-more-menu" role="menu" aria-label="${esc(p.name)} 的動作" data-pj="${esc(p.id)}">
          <button type="button" role="menuitem" data-pp="rename">改名</button>
          <button type="button" role="menuitem" data-pp="slug">網址英文名…<span class="pm-sub">/p/${esc(p.slug || p.id)}</span></button>
          <button type="button" role="menuitem" data-pm-repo="${esc(p.id)}">程式庫設定</button>
          <button type="button" role="menuitem" data-pp="dm">${p.dm?.on ? '關閉私訊…' : '開放成員私訊自己的 AI…'}<span class="pm-sub">${p.dm?.on ? `已開放${p.dm.at ? ' · ' + esc(mmdd(p.dm.at)) : ''}${p.dm.byName ? ' ' + esc(p.dm.byName) + ' 打開' : ''}` : '預設關'}</span></button>
          <button type="button" role="menuitem" data-pp="log">異動紀錄</button>
          <button type="button" role="menuitem" class="danger" data-pp="archive" ${blocked ? `aria-disabled="true" title="${esc(why)}"` : ''}>封存…${blocked ? `<span class="pm-sub">${esc(why)}</span>` : ''}</button></div>` : '';
      const last = p.archived ? '<button type="button" class="btn small" data-pp="unarchive">還原</button>'
        : `<span class="pm-more-wrap"><button type="button" class="pm-more" data-pm-more="${esc(p.id)}" aria-haspopup="menu" aria-expanded="${perm.moreOpen === p.id}" aria-label="${esc(p.name)} 的更多動作">⋯</button>${menu}</span>`;
      const log = open ? `<tr class="pm-log-tr" data-pj="${esc(p.id)}"><td colspan="6"><div class="pm-log-head"><b>異動紀錄 · ${esc(p.name)}</b><button type="button" class="link small" data-pp="log" aria-expanded="true">收起</button></div><ul class="pa-log">${(perm.events[p.id] || []).map(e => `<li><span class="muted small">${esc(fmtTime(e.at))}</span> ${esc(e.text)}</li>`).join('') || '<li class="muted small">還沒有紀錄</li>'}</ul></td></tr>` : '';
      return `<tr class="pm-prow${p.archived ? ' archived' : ''}" data-pj="${esc(p.id)}"><td class="c-pname"><b>${esc(p.name)}</b>${p.archived ? ' <span class="pill-tag grey">已封存</span>' : ''}</td><td class="c-code" data-label="API 代號" title="${esc(p.id)}">${esc(p.id)}</td><td class="c-num" data-label="成員">${p.memberCount}</td><td class="c-num2" data-label="未結案卡">${p.openCards}</td><td class="c-repo" data-label="程式庫">${repo}</td><td class="c-more">${last}</td></tr>${log}`;
    }).join('');
    return `<div class="pm-projs">
      <div class="pm-card pm-group-name"><label for="pm-group-name">群組名稱</label><input id="pm-group-name" maxlength="30" value="${esc(BASE_TITLE)}" aria-describedby="pm-gn-hint"><button type="button" class="btn small primary" data-pp="groupname">儲存</button><span class="muted small" id="pm-gn-hint">顯示在登入頁、左上角、分頁標題與 AI 接入設定。</span></div>
      <div class="pm-card"><div class="pm-card-head"><strong>專案 · ${active.length}</strong><span class="grow"></span><button type="button" class="btn primary small" data-pm-newproj>＋ 新增專案</button></div>
        <table class="pm-table pm-ptable"><thead><tr><th scope="col">專案</th><th scope="col" class="c-code">API 代號</th><th scope="col" class="c-num">成員</th><th scope="col" class="c-num2">未結案卡</th><th scope="col" class="c-repo">程式庫</th><th scope="col" class="c-more"><span class="sr-only">動作</span></th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`;
  }
  // C-233：新增專案彈窗：名稱＋程式庫＋分支（選填）一次填完
  function openNewProject() {
    const body = openModal('新增專案', `<form id="np-form" class="stack">
        <label class="field">專案名稱<input name="name" required maxlength="20" autocomplete="off"></label>
        <label class="field">程式庫連結（選填）<input name="url" maxlength="300" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://github.com/帳號/專案"></label>
        <label class="field">分支（選填）<input name="branch" maxlength="100" autocomplete="off" spellcheck="false" placeholder="main"></label>
        <p class="muted small" id="pm-new-hint">${esc(newProjText())}，其他成員請到「成員」分頁加入。</p>
        <p class="error" id="np-err" role="alert"></p>
      </form>`, { size: 'narrow', foot: '<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit" form="np-form">新增專案</button>' });
    const f = body.querySelector('#np-form');
    setTimeout(() => f.name.focus(), 30);
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const err = body.querySelector('#np-err'), name = f.name.value.trim(), url = f.url.value.trim(), branch = f.branch.value.trim();
      err.textContent = '';
      if (!name) { err.textContent = '請輸入專案名稱'; return f.name.focus(); }
      if (!url && branch) { err.textContent = '有分支就要填程式庫連結'; return f.url.focus(); }
      if (url && (!/^https?:\/\//i.test(url) || url.includes('@'))) { err.textContent = url.includes('@') ? '連結裡不要放帳號密碼或 Token，只放網址' : '程式庫連結要用 https:// 開頭'; return f.url.focus(); }
      try {
        const r = await api('/api/projects', { method: 'POST', body: { name } });
        let repoErr = '';
        if (url) { try { await api(`/api/projects/${encodeURIComponent(r.id)}/repo`, { method: 'PUT', body: { url, branch } }); } catch (e2) { repoErr = e2.message; } }
        closeModal();
        await Promise.all([loadProjectList(), loadParticipants()]);
        drawProjSwitch(); drawPerm();
        toast(repoErr ? `已新增專案「${name}」，但程式庫沒存：${repoErr}` : crossNames().length ? `已新增專案「${name}」，你和 ${crossNames().join('、')} 已加入` : `已新增專案「${name}」，目前只有你`);
      } catch (e2) { err.textContent = e2.message; }
    });
  }
  function drawPermBar() {
    const bar = $('#pm-bar');
    if (!bar) return;
    const s = permSummary();
    bar.hidden = !perm.draft.size;
    bar.innerHTML = perm.draft.size ? `<span class="pm-bar-text">${s.length} 項變更：${esc(s.slice(0, 4).join('；'))}${s.length > 4 ? '…' : ''}</span><span class="grow"></span>
      <button type="button" class="btn small pm-undo" data-pm-act="undo">復原</button><button type="button" class="btn primary" data-pm-act="save">檢查並儲存</button>` : '';
  }
  function drawPerm() {
    const box = $('#page-work');
    if (state.page !== 'perm') return;
    const keep = document.activeElement?.id, top = box.scrollTop, admin = isAdmin();
    if (!admin && perm.tab !== 'roles') perm.tab = 'members'; // C-233：leader 只有成員分頁；C-280 加角色
    const nValid = (perm.invites || []).filter(iv => iv.status === '有效').length;
    const tabs = `<div class="seg-scope pm-tabs" role="tablist" aria-label="分頁">${(admin ? [['members', '成員'], ['projects', '專案'], ['roles', '角色'], ['invites', `邀請${nValid ? ` · ${nValid}` : ''}`]] : [['members', '成員'], ['roles', '角色']]).map(([k, t]) => `<button type="button" role="tab" data-pm-tab="${k}" aria-selected="${perm.tab === k}" aria-pressed="${perm.tab === k}">${t}</button>`).join('')}</div>`;
    const body = perm.tab === 'roles' ? permRolesHtml() : perm.tab === 'projects' ? permProjectsHtml() : perm.tab === 'invites' ? permInvitesHtml() : permView() === 'byMember' ? permByMemberHtml() : permByProjectHtml();
    box.innerHTML = `<div class="work-head"><div class="work-title"><h2>成員與權限</h2><span class="muted small">群組管理員：${esc(state.projMeta.adminName || '')}${admin ? '' : ' · 你是 leader'}</span></div>${tabs}</div>
      ${admin ? '' : `<div class="pm-banner">你是 <b>${esc(myLeadProjects().map(projName).join('、'))}</b> 的 leader，可以加入或移出${esc(myLeadProjects().map(projName).join('、'))}的成員。其他專案只能看。</div>`}
      <section class="wpanel pm-panel pm-tab-${perm.tab}">${body}</section>
      <div id="pm-bar" class="pm-bar" role="region" aria-label="未儲存的變更" hidden></div>`;
    box.scrollTop = top;
    drawPermBar();
    if (['pm-pq', 'pm-mq', 'pm-pickq'].includes(keep)) { const q = $('#' + keep); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
    if (perm.moreOpen) box.querySelector('.pm-more-menu [role="menuitem"]')?.focus();
  }
  // C-280：本專案角色（只列自己能管理的專案）：改字、停用／啟用、沒人用才能刪
  function permRolesHtml() {
    const pjs = PROJECTS.filter(canMakeRole);
    if (!pjs.length) return '<p class="muted">你不是任何專案的 leader，不能管理本專案角色。</p>';
    return `<p class="muted small pr-note">本專案角色只出現在該專案的角色選單（建 AI、設人類角色都能選）。內建角色（PO、PG、UX…）所有專案共用，不在這裡改。</p>` + pjs.map(pj => {
      const defs = projRoleDefs(pj, true);
      const row = d => `<div class="pr-row${d.status === 'disabled' ? ' off' : ''}"><span class="pr-key" aria-hidden="true">${esc(d.key)}</span><div class="pr-main"><b>${esc(d.role)}</b> <span class="tag pr-tag">本專案</span>${d.status === 'disabled' ? ' <span class="tag pr-off">已停用</span>' : ''}<div class="muted small">${d.inUse} 個成員在用 · ${esc(mmdd(d.createdAt))} ${esc(d.createdByName || '')} 建立</div></div>
        <div class="pr-acts"><button type="button" class="link small" data-pr-edit="${esc(d.key)}" data-pj="${esc(pj)}">編輯</button><button type="button" class="link small" data-pr-toggle="${esc(d.key)}" data-pj="${esc(pj)}">${d.status === 'disabled' ? '啟用' : '停用'}</button>${d.inUse ? '' : `<button type="button" class="link small danger-text" data-pr-del="${esc(d.key)}" data-pj="${esc(pj)}">刪除</button>`}</div></div>`;
      return `<section class="pr-proj" aria-label="${esc(projName(pj))} 的本專案角色"><div class="pr-head"><b>${esc(projName(pj))} · 角色</b><button type="button" class="btn small" data-pr-new="${esc(pj)}">＋ 跟 AI 討論新角色</button></div>
        ${defs.map(row).join('') || '<p class="muted small pr-empty">還沒有本專案角色。按「＋ 跟 AI 討論新角色」，在私訊跟自己的 AI 討論，它會送角色提案卡，你按「建立角色」才生效。</p>'}</section>`;
    }).join('');
  }
  function editProjRole(pj, key) {
    const d = projRoleDefs(pj, true).find(x => x.key === key);
    if (!d) return;
    const body = openModal(`編輯角色 · ${d.role}（${d.key}）`, `<form id="pr-form" class="stack"><label>名稱<input name="role" maxlength="10" required value="${esc(d.role)}"></label>
      ${RP_FIELDS.slice(2).map(([k, t]) => `<label>${t}<textarea name="${k}" rows="3" maxlength="1000" required>${esc(d[k] || '')}</textarea></label>`).join('')}
      <p class="muted small">代碼 ${esc(d.key)} 不能改。改名稱時，用這個角色的人類角色字會一起換；AI 的設定是建立時帶入的，不會跟著改。</p><p class="error small" id="pr-err" role="alert"></p></form>`,
      { size: 'form', foot: '<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit" form="pr-form">儲存</button>' });
    body.querySelector('#pr-form').addEventListener('submit', async e => {
      e.preventDefault();
      try { await api(`/api/projects/${encodeURIComponent(pj)}/roles/${encodeURIComponent(key)}`, { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); closeModal(); await loadProjectList(); drawPerm(); toast('已儲存角色'); }
      catch (err) { body.querySelector('#pr-err').textContent = err.message; }
    });
  }
  document.addEventListener('click', async e => {
    const b = state.page === 'perm' && e.target.closest?.('[data-pr-new], [data-pr-edit], [data-pr-toggle], [data-pr-del]');
    if (!b) return;
    const pj = b.dataset.pj || b.dataset.prNew;
    if (b.dataset.prNew) return askRoleAi(pj);
    if (b.dataset.prEdit) return editProjRole(pj, b.dataset.prEdit);
    const key = b.dataset.prToggle || b.dataset.prDel, d = projRoleDefs(pj, true).find(x => x.key === key);
    if (!d) return;
    try {
      if (b.dataset.prToggle) {
        const off = d.status !== 'disabled';
        if (off && !await confirmDialog({ title: `停用「${d.role}」？`, confirmText: '停用', message: '停用後選單不再出現；已經在用的人照舊。之後可以再啟用。' })) return;
        await api(`/api/projects/${encodeURIComponent(pj)}/roles/${encodeURIComponent(key)}`, { method: 'PUT', body: { status: off ? 'disabled' : 'active' } });
        toast(off ? '已停用' : '已啟用');
      } else {
        if (!await confirmDialog({ title: `刪除「${d.role}」？`, confirmText: '刪除', message: '沒有人在用這個角色。刪除後選單不再出現，不能復原（要再用就重新跟 AI 討論）。' })) return;
        await api(`/api/projects/${encodeURIComponent(pj)}/roles/${encodeURIComponent(key)}`, { method: 'DELETE' });
        toast('已刪除');
      }
      await loadProjectList(); drawPerm();
    } catch (err) { toast(err.message); }
  });
  async function renderPermPage() {
    $('#page-work').classList.remove('is-board');
    await Promise.all([loadProjectList(), loadParticipants()]).catch(() => {});
    drawPerm();
    if (isAdmin()) loadInvites(); // C-233：分頁上顯示有效邀請數
  }
  // C-190：只有「加入」時直接儲存（不會退回卡片），toast 可在 10 秒內復原
  async function permQuickAdd(ids, pj) {
    const before = ids.map(id => ({ id, projects: [...permBase(P2(id)).projects] }));
    const changes = ids.map(id => ({ id, projects: PROJECTS.filter(x => perm.draft.get(id)?.projects.has(x)) })).filter(c => c.projects.length);
    try {
      await api('/api/members/matrix', { method: 'PUT', body: { changes } });
      perm.draft.clear();
      await Promise.all([loadProjectList(), loadParticipants()]);
      drawProjSwitch(); drawPerm();
      const names = ids.map(id => P2(id)?.name).filter(Boolean).join('、');
      const t = $('#toast');
      t.innerHTML = `已加入 ${esc(names)} <button type="button" class="link toast-undo" id="toast-undo">復原</button>`;
      t.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { t.hidden = true; }, 10_000);
      t.querySelector('#toast-undo').onclick = async () => {
        t.hidden = true;
        try {
          await api('/api/members/matrix', { method: 'PUT', body: { changes: before.slice().reverse().map(b => ({ id: b.id, projects: b.projects })) } });
          await Promise.all([loadProjectList(), loadParticipants()]);
          drawProjSwitch(); drawPerm(); toast(`已復原：${names} 不在${projName(pj)}`);
        } catch (err) { toast(err.message); }
      };
    } catch (err) { toast(err.message); drawPerm(); }
  }
  const P2 = id => state.participants.get(id);
  async function permSave() {
    const changes = [];
    const order = [...perm.draft.keys()].sort((a, b) => (state.participants.get(a)?.memberType === 'ai') - (state.participants.get(b)?.memberType === 'ai'));
    for (const id of order) {
      const p = state.participants.get(id), d = perm.draft.get(id), b = permBase(p), ch = { id };
      if (d.cross !== b.cross) ch.crossRole = d.cross;
      if (!d.cross) ch.projects = PROJECTS.filter(x => d.projects.has(x));
      if (isAdmin() && d.leaders && !sameSet(d.leaders, b.leaders)) ch.leaderOf = PROJECTS.filter(x => d.leaders.has(x));
      if (p.memberType === 'human') { const rc = PROJECTS.filter(x => (d.cross || d.projects.has(x)) && permCanEdit(x) && (d.roles?.get(x) || '') !== (b.roles.get(x) || '') && (b.cross || b.projects.has(x) || d.roles?.get(x))); if (rc.length) ch.projectRoles = Object.fromEntries(rc.map(x => [x, d.roles?.get(x) || ''])); }
      if (!isAdmin() && sameSet(d.projects, b.projects) && d.cross === b.cross && !ch.projectRoles) continue;
      changes.push(ch);
    }
    try {
      const dry = await api('/api/members/matrix', { method: 'PUT', body: { changes, dryRun: true } });
      const lines = [
        ...(dry.crossChanges || []).map(c => `${c.name}：${c.crossRole ? '設為跨專案角色（自動在所有專案）' : '取消跨專案角色'}`),
        ...(dry.leaderChanges || []).map(c => `${c.name}：${c.leader ? '成為' : '不再是'}${projName(c.project)} leader${c.auto ? '（已移出專案）' : ''}`),
        ...(dry.roleChanges || []).map(c => `${c.name}：在${projName(c.project)}的角色改成${c.role || '未設定'}`),
        ...dry.impact.map(x => `${x.name}：${[x.added.length ? '加入 ' + x.added.map(projName).join('、') : '', x.removed.length ? '離開 ' + x.removed.map(projName).join('、') : ''].filter(Boolean).join('；')}${x.returnedCards.length ? `（<b>${x.returnedCards.length} 張卡退回待處理</b>：${x.returnedCards.join('、')}）` : ''}`),
      ];
      if (!await confirmDialog({ title: '確定儲存這些變更？', confirmText: '確定儲存', danger: dry.impact.some(x => x.returnedCards.length),
        message: `<ul class="pm-impact">${lines.map(l => `<li>${l}</li>`).join('') || '<li>沒有實際變更</li>'}</ul>` })) return;
      await api('/api/members/matrix', { method: 'PUT', body: { changes } });
      perm.draft.clear();
      await Promise.all([loadProjectList(), loadParticipants()]);
      drawProjSwitch(); drawAvatarMenu(); drawPerm();
      toast('已儲存成員與權限');
    } catch (err) { toast(err.message); }
  }
  $('#page-work').addEventListener('change', async e => {
    const sel = state.page === 'perm' && e.target.closest?.('[data-pm-role]');
    if (!sel) return;
    const p = state.participants.get(sel.dataset.pmRole), pj = sel.dataset.pj, cur = permCur(p).roles?.get(pj) || '';
    const v = await pickRole(sel, cur);
    if (v === null) return;
    permSetRole(p, pj, v); drawPerm();
    document.querySelector(`[data-pm-role="${CSS.escape(p.participantId)}"][data-pj="${CSS.escape(pj)}"]`)?.focus();
  });
  $('#page-work').addEventListener('click', async e => {
    if (state.page !== 'perm') return;
    const t = e.target;
    // C-233：「⋯」選單開著時，點外面就關
    if (perm.moreOpen && !t.closest('.pm-more-wrap')) { perm.moreOpen = null; drawPerm(); if (!t.closest('[data-pm-more]')) return; }
    const tab = t.closest('[data-pm-tab]');
    if (tab) { perm.tab = tab.dataset.pmTab; if (state.page === 'perm') loadInvites(); Object.assign(perm, { picker: false, addOpen: false, mobileDetail: false, moreOpen: null }); return drawPerm(); } // 切換檢視不丟變更
    const vw = t.closest('[data-pm-view]');
    if (vw) { Object.assign(perm, { memView: vw.dataset.pmView, picker: false, addOpen: false, mobileDetail: false }); return drawPerm(); }
    const gm = t.closest('[data-pm-goto-mem]'), gp = t.closest('[data-pm-goto-proj]');
    if (gm) { Object.assign(perm, { tab: 'members', memView: 'byMember', selMember: gm.dataset.pmGotoMem, addOpen: false, picker: false, mobileDetail: true, mq: '' }); return drawPerm(); }
    if (gp) { Object.assign(perm, { tab: 'members', memView: 'byProject', selProj: gp.dataset.pmGotoProj, addOpen: false, picker: false, mobileDetail: true, pq: '' }); return drawPerm(); }
    const more = t.closest('[data-pm-more]');
    if (more) { perm.moreOpen = perm.moreOpen === more.dataset.pmMore ? null : more.dataset.pmMore; return drawPerm(); }
    if (t.closest('[data-pm-newproj]')) return openNewProject();
    // C-202 邀請與重設登入
    if (t.closest('[data-pm-invite]')) return openInvite();
    if (t.closest('[data-pm-inv-reload]')) return loadInvites();
    const ivR = t.closest('[data-pm-inv-regen]'), ivC = t.closest('[data-pm-inv-cancel]'), rs = t.closest('[data-pm-reset]');
    if (ivR) { try { showInviteLink(await api(`/api/invites/${encodeURIComponent(ivR.dataset.pmInvRegen)}/regenerate`, { method: 'POST' })); loadInvites(); } catch (err) { toast(err.message); } return; }
    if (ivC) {
      if (!await confirmDialog({ title: '取消這個邀請？', confirmText: '取消邀請', danger: true, message: '連結會立刻失效。' })) return;
      try { await api(`/api/invites/${encodeURIComponent(ivC.dataset.pmInvCancel)}/cancel`, { method: 'POST' }); toast('已取消邀請'); loadInvites(); } catch (err) { toast(err.message); }
      return;
    }
    if (rs) return resetLogin(state.participants.get(rs.dataset.pmReset));
    const P = id => state.participants.get(id);
    const el = (sel) => t.closest(sel);
    let x;
    if ((x = el('[data-pm-proj]'))) { Object.assign(perm, { selProj: x.dataset.pmProj, picker: false, pickSel: new Set(), mobileDetail: true }); return drawPerm(); }
    if ((x = el('[data-pm-mem]'))) { Object.assign(perm, { selMember: x.dataset.pmMem, addOpen: false, mobileDetail: true }); return drawPerm(); }
    if (el('[data-pm-back]')) { perm.mobileDetail = false; return drawPerm(); }
    if (el('[data-pm-pick]')) { Object.assign(perm, { picker: true, pickSel: new Set(), pickQ: '' }); drawPerm(); return $('#pm-pickq')?.focus(); }
    if (el('[data-pm-pick-cancel]')) { perm.picker = false; return drawPerm(); }
    if (el('[data-pm-pick-ok]')) {
      const ids = [...perm.pickSel].sort((a, b) => (P(a)?.memberType === 'ai') - (P(b)?.memberType === 'ai'));
      const direct = perm.draft.size === 0, pj = perm.selProj;
      for (const id of ids) permAdd(P(id), pj);
      Object.assign(perm, { picker: false, pickSel: new Set() });
      if (!direct) return drawPerm();
      return permQuickAdd(ids, pj); // C-190：加入沒有破壞性，直接儲存，10 秒內可復原
    }
    if ((x = el('[data-pm-rm]'))) { permRemove(P(x.dataset.pmRm), x.dataset.pj); return drawPerm(); }
    if ((x = el('[data-pm-restore]'))) { permAdd(P(x.dataset.pmRestore), x.dataset.pj); return drawPerm(); }
    if ((x = el('[data-pm-star]'))) { permStar(P(x.dataset.pmStar), x.dataset.pj); return drawPerm(); }
    if (el('[data-pm-addopen]')) { perm.addOpen = !perm.addOpen; return drawPerm(); }
    if ((x = el('[data-pm-addp]'))) {
      if (x.disabled) return;
      const p = P(perm.selMember);
      permAdd(p, x.dataset.pmAddp); perm.addOpen = false;
      if (p.memberType === 'human') await permAskAis(p, x.dataset.pmAddp);
      return drawPerm();
    }
    const cr = t.closest('[data-pm-cross]');
    if (cr) {
      if (cr.getAttribute('aria-disabled') === 'true') return toast(cr.title);
      const p = state.participants.get(cr.dataset.pmCross), c = permCur(p), b = permBase(p);
      permSet(p, { projects: c.cross ? (b.cross ? new Set(PROJECTS) : new Set(b.projects.size ? b.projects : PROJECTS)) : new Set(PROJECTS), cross: !c.cross, leaders: c.leaders });
      return drawPerm();
    }
    const rp = t.closest('[data-pm-repo]'); // C-229
    if (rp) { if (perm.moreOpen) { perm.moreOpen = null; drawPerm(); } return openRepoEditor(rp.dataset.pmRepo); }
    const act = t.closest('[data-pm-act]')?.dataset.pmAct;
    if (act === 'undo') { perm.draft.clear(); return drawPerm(); }
    if (act === 'save') return permSave();
    const pp = t.closest('[data-pp]');
    if (!pp) return;
    const id = pp.closest('[data-pj]')?.dataset.pj, a = pp.dataset.pp;
    if (perm.moreOpen) perm.moreOpen = null; // 選單裡選了就收起
    if (a === 'groupname') {
      const name = $('#pm-group-name').value.trim();
      if (!name) return toast('請輸入群組名稱');
      try { const d = await api('/api/group', { method: 'PUT', body: { name } }); applyGroupName(d.name); toast(`群組名稱已改成「${d.name}」`); } catch (err) { toast(err.message); }
      return;
    }
    try {
      if (a === 'log') {
        perm.openLog = perm.openLog === id ? null : id;
        if (perm.openLog) perm.events[id] = (await api(`/api/projects/${encodeURIComponent(id)}/events?limit=20`).catch(() => ({ items: [] }))).items;
        return drawPerm();
      }
      if (a === 'create') {
        const name = $('#pm-new-name').value.trim();
        if (!name) return toast('請輸入專案名稱');
        await api('/api/projects', { method: 'POST', body: { name } });
        toast(crossNames().length ? `已新增專案「${name}」，你和 ${crossNames().join('、')} 已加入` : `已新增專案「${name}」，目前只有你`);
      } else if (a === 'rename') {
        const name = await promptName('改專案名稱', projName(id));
        if (!name || name === projName(id)) return;
        await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
      } else if (a === 'slug') { // C-285
        const cur = state.projectList.find(p => p.id === id)?.slug || id;
        const slug = await promptName('網址英文名', cur, { label: '英文小寫、數字或 -（例：platform）', max: 40, hint: `網址會變成 /p/${'<英文名>'}/messages；API 與 AI 接入設定的專案代號不變（${id}），舊網址照樣能開。` });
        if (!slug || slug === cur) return;
        await api(`/api/projects/${encodeURIComponent(id)}/slug`, { method: 'PUT', body: { slug } });
        if (projectView() === id) setTimeout(() => syncUrl(true), 0);
        toast(`網址改成 /p/${slug.toLowerCase()}/…`);
      } else if (a === 'archive') {
        if (pp.getAttribute('aria-disabled') === 'true') { drawPerm(); return toast(pp.title); }
        if (!await confirmDialog({ title: '封存專案？', confirmText: '封存', danger: true, message: `封存「<b>${esc(projName(id))}</b>」後，不能再選它來發訊息或建卡；歷史內容保留，之後可以還原。` })) return;
        await api(`/api/projects/${encodeURIComponent(id)}/archive`, { method: 'POST' });
      } else if (a === 'dm') { // C-270
        const on = !state.projectList.find(p => p.id === id)?.dm?.on;
        const ok = await confirmDialog(on
          ? { title: '開放私訊？', confirmText: '開放', message: `打開後，「<b>${esc(projName(id))}</b>」的成員可以在網頁、手機直接跟自己名下的 AI 講話。內容只有雙方看得到，你也看不到內容和數量。<br><span class="muted small">定案的事仍要寫回卡片。私訊存在平台資料庫，系統維護者技術上仍讀得到。</span>` }
          : { title: '關閉私訊？', confirmText: '關閉', danger: true, message: '關掉後成員不能再送私訊，舊的私訊雙方還看得到。' });
        if (!ok) return;
        await api(`/api/projects/${encodeURIComponent(id)}/dm`, { method: 'PUT', body: { on } });
        toast(on ? '已開放私訊' : '已關閉私訊');
      } else if (a === 'unarchive') {
        await api(`/api/projects/${encodeURIComponent(id)}/unarchive`, { method: 'POST' });
      }
      await Promise.all([loadProjectList(), loadParticipants()]);
      if (perm.openLog) perm.events[perm.openLog] = (await api(`/api/projects/${encodeURIComponent(perm.openLog)}/events?limit=20`).catch(() => ({ items: [] }))).items;
      drawProjSwitch(); drawPerm();
    } catch (err) { toast(err.message); }
  });
  $('#page-work').addEventListener('keydown', e => {
    if (state.page !== 'perm' || !perm.moreOpen) return;
    const items = [...document.querySelectorAll('.pm-more-menu [role="menuitem"]')], i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const id = perm.moreOpen; perm.moreOpen = null; drawPerm(); document.querySelector(`[data-pm-more="${CSS.escape(id)}"]`)?.focus(); }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
  });
  $('#page-work').addEventListener('input', e => {
    if (state.page !== 'perm') return;
    const k = { 'pm-pq': 'pq', 'pm-mq': 'mq', 'pm-pickq': 'pickQ' }[e.target.id];
    if (k) { perm[k] = e.target.value; drawPerm(); }
  });
  $('#page-work').addEventListener('change', e => {
    const cb = e.target.closest?.('[data-pm-picksel]');
    if (!cb || state.page !== 'perm') return;
    const id = cb.dataset.pmPicksel;
    if (cb.checked) perm.pickSel.add(id);
    else {
      perm.pickSel.delete(id);
      // 取消勾人類：名下因此被鎖住的 AI 也取消
      for (const a of permPeople()) if (a.memberType === 'ai' && a.ownerParticipantId === id && !inProj(state.participants.get(id), perm.selProj)) perm.pickSel.delete(a.participantId);
    }
    drawPerm();
  });
  function promptName(title, value, { label = '專案名稱', max = 20, hint = '' } = {}) {
    return new Promise(resolve => {
      const host = document.createElement('div');
      host.className = 'confirm-root';
      host.innerHTML = modalFrame({ title, size: 'narrow', body: `<label class="field"><span class="field-label">${esc(label)}</span><input id="pn-input" maxlength="${max}" value="${esc(value)}">${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}</label>`,
        foot: '<button class="btn" type="button" data-pn="0">取消</button><button class="btn primary" type="button" data-pn="1">確定</button>' });
      document.body.appendChild(host);
      const input = host.querySelector('#pn-input');
      input.focus(); input.select();
      const done = ok => { const v = input.value.trim(); host.remove(); resolve(ok ? v : null); };
      holdBackdrop(host.firstElementChild);
      host.addEventListener('click', e => { const b = e.target.closest('[data-pn]'); if (b) done(b.dataset.pn === '1'); else if (e.target.closest('[data-close]')) done(false); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) done(true); if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
    });
  }
  // C-272：「請我的 AI 幫我做」「請它幫自己做」→ 打開私訊、預填開頭；私訊沒開走開啟說明
  const myAisForAvatar = () => [...state.participants.values()].filter(p => isMyAi(p) && p.status !== 'disabled');
  function askAvatar(ais, prefill, onlyPj = '') {
    closeModal();
    const pv = projectView();
    const cands = ais.map(a => ({ a, pj: (onlyPj ? [onlyPj] : [pv, ...(a.projects || [])]).find(p => PROJECTS.includes(p) && (a.projects || []).includes(p) && dmOn(p)) })).filter(x => x.pj);
    if (!cands.length) {
      if (onlyPj && onlyPj !== pv) return toast(`「${projName(onlyPj)}」還沒開放私訊自己的 AI；請 leader 或管理員在「成員與權限 → 專案 → ⋯」打開。`);
      if (PROJECTS.includes(pv) && dmEntry()) return dmEnable();
      return toast(`${ais.length === 1 ? ais[0].name + ' ' : '你的 AI '}所在的專案還沒開放私訊；請管理員或 leader 在「成員與權限 → 專案 → ⋯」打開。`);
    }
    const go = ({ a, pj }) => { state.dmPrefill = prefill; state.dmAi = a.participantId; return pj !== pv ? Promise.resolve(setProjectView(pj)).then(() => openDm(a.participantId)) : openDm(a.participantId); };
    if (cands.length === 1) return go(cands[0]);
    const body = openModal(onlyPj ? '跟哪個 AI 討論新角色？' : '請哪個 AI 幫你做頭像？', `<div class="an-sheet">${cands.map((x, i) => `<button type="button" class="dm-row" data-ask-pick="${i}">${avatar(x.a)}<span class="dm-row-main"><b>${esc(x.a.name)}</b><span class="dm-prev">${esc(projName(x.pj))}</span></span></button>`).join('')}</div>`, { size: 'narrow', sub: onlyPj ? `在「${projName(onlyPj)}」的私訊跟它討論，它會送角色提案卡` : '會打開跟它的私訊，幫你先打好開頭' });
    body.addEventListener('click', ev => { const b = ev.target.closest('[data-ask-pick]'); if (b) { closeModal(); go(cands[Number(b.dataset.askPick)]); } });
  }
  function openSettings(opts = {}) {
    const theme = store.get(THEME_KEY) || 'system';
    const body = openModal('個人設定', `
      <div class="field"><span class="field-label" id="theme-label">外觀</span>
        <div class="seg-scope full" role="group" aria-labelledby="theme-label">
          ${[['system', '跟隨系統'], ['light', '淺色'], ['dark', '深色']].map(([k, t]) => `<button type="button" data-theme-opt="${k}" aria-pressed="${theme === k}">${t}</button>`).join('')}
        </div></div>
      <div class="avatar-row">
        <span class="av-56" id="set-avatar">${avatar(state.me)}</span>
        <div><b>我的頭像</b><span class="muted small">可上傳圖片，或用文字、表情符號。所有成員都會看到。</span></div>
        <button class="btn small" type="button" data-change-avatar>更換</button>
      </div>
      <div class="field"><span class="field-label">所屬專案</span>
        <p class="muted small">單一專案成員只看自己專案與「全部專案」的訊息與卡片。所屬專案由群組管理員（${esc(state.projMeta.adminName || '')}）在頭像選單的「成員與權限」調整，這裡只能看。</p>
        <div class="proj-rows">${projMineHtml()}</div>
      </div>
      ${state.me.memberType === 'human' && myProjects().length ? `<div class="field my-roles" id="my-roles"><span class="field-label">我的角色</span>
        <p class="muted small">每個專案各一個，只能改自己的；跨專案角色在成員與權限。</p>
        ${myProjects().map(pj => `<div class="my-role-row"><b class="my-role-name" title="${esc(projName(pj))}">${esc(projName(pj))}</b>${roleSelectHtml(state.me.projectRoles?.[pj] || '', `data-myrole="${esc(pj)}"`, { pj, label: `我在${projName(pj)}的角色` })}</div>`).join('')}
        <div class="my-role-foot"><button type="button" class="btn primary small" id="my-roles-save">儲存角色</button></div></div>` : ''}
      <div class="field pwd-set" id="pwd-set"><span class="field-label" id="pwd-set-h">帳號密碼</span>
        <div class="pwd-status" id="pwd-status" role="status"><span class="muted small">讀取中…</span></div>
        <form id="pwd-set-form" class="stack" aria-labelledby="pwd-set-h" hidden>
          <label>帳號<input name="username" required maxlength="30" autocomplete="username" autocapitalize="none" spellcheck="false"><span class="field-hint">4～30 字，英文、數字、. _ -；不分大小寫</span></label>
          <label id="pwd-cur-l">目前密碼<span class="pwd-wrap"><input name="current" type="password" maxlength="128" autocomplete="current-password"><button type="button" class="pwd-eye" data-eye aria-pressed="false" aria-label="顯示目前密碼">顯示</button></span><span class="field-hint">改帳號或密碼都要先填</span></label>
          <label><span id="pwd-new-t">新密碼</span><span class="pwd-wrap"><input name="newPassword" type="password" maxlength="128" autocomplete="new-password"><button type="button" class="pwd-eye" data-eye aria-pressed="false" aria-label="顯示新密碼">顯示</button></span><span class="field-hint" id="pwd-new-hint">至少 8 碼</span></label>
          <label>再輸入一次<input name="again" type="password" maxlength="128" autocomplete="new-password"></label>
          <p class="error" id="pwd-set-err" role="alert"></p>
          <div><button class="btn primary small" type="submit">儲存</button></div>
          <p class="muted small" id="pwd-forgot"></p>
        </form>
      </div>
      <div class="switch-row">
        <div><b>只顯示與我相關的訊息</b><span class="muted small">包含我和我名下 AI 發出或收到的訊息</span></div>
        <button type="button" class="switch" role="switch" id="set-mine" aria-checked="${state.filter.scope === 'related'}" aria-label="只顯示與我相關的訊息"><span></span></button>
      </div>
      <div class="danger-zone">
        <b>離開群組</b>
        <p class="muted small">會停用你和你名下的所有 AI，其他成員將看不到你們，Token 全部失效。</p>
        <button class="btn small danger-outline" type="button" id="set-leave">離開群組</button>
      </div>`);
    // C-219：我的角色
    body.querySelectorAll('[data-myrole]').forEach(sel => sel.addEventListener('change', async () => {
      const pj = sel.dataset.myrole, prev = sel.dataset.v ?? (state.me.projectRoles?.[pj] || '');
      const v = await pickRole(sel, prev);
      if (v === null) return;
      if (!ROLE_CHOICES.includes(v) && v && ![...sel.options].some(o => o.value === v || o.textContent === v)) sel.insertAdjacentHTML('afterbegin', `<option value="${esc(v)}">${esc(v)}</option>`);
      sel.value = v; sel.dataset.v = v; sel.classList.toggle('empty', !v);
    }));
    body.querySelector('#my-roles-save')?.addEventListener('click', async () => {
      const roles = Object.fromEntries([...body.querySelectorAll('[data-myrole]')].map(s => [s.dataset.myrole, s.value === '__other' ? '' : s.value]));
      try {
        const r = await api(`/api/participants/${encodeURIComponent(meId())}/project-roles`, { method: 'PUT', body: { roles } });
        state.me.projectRoles = r.projectRoles;
        const mine = state.participants.get(meId()); if (mine) mine.projectRoles = r.projectRoles;
        drawAvatarMenu(); drawRoleBanner(); toast('已儲存我的角色');
      } catch (err) { toast(err.message); }
    });
    if (opts.focusRoles) setTimeout(() => body.querySelector('#my-roles [data-myrole]')?.focus(), 50);
    initPwdSettings(body);
    body.querySelectorAll('[data-theme-opt]').forEach(b => b.addEventListener('click', () => {
      const v = b.dataset.themeOpt;
      if (v === 'system') store.del(THEME_KEY); else store.set(THEME_KEY, v);
      applyTheme(v);
      body.querySelectorAll('[data-theme-opt]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    }));
    const sw = body.querySelector('#set-mine');
    sw.onclick = () => {
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(on));
      setFilter({ scope: on ? 'related' : 'all' });
    };
    body.querySelector('#set-leave').onclick = async () => {
      if (!await confirmDialog({ title: '離開群組？', confirmText: '離開群組', danger: true,
        message: '你和名下所有 AI 的 Token 都會立即失效，其他成員將看不到你們。' })) return;
      await api('/api/leave', { method: 'POST' }).catch(() => {});
      logout(false);
    };
  }

  // ---------- C-223 個人設定 › 帳號密碼 ----------
  async function initPwdSettings(body) {
    const form = body.querySelector('#pwd-set-form'), status = body.querySelector('#pwd-status');
    if (!form) return;
    let cur;
    const draw = (saved = '') => {
      status.innerHTML = cur.set
        ? `<div class="ok-box">已設定 · 帳號 <b>${esc(cur.username)}</b> · 上次修改 ${esc(fmtDate(cur.updatedAt))}</div>`
        : '<p class="muted small">還沒設定。設了以後換裝置、清掉瀏覽器也能自己登入。</p>';
      if (saved) status.insertAdjacentHTML('beforeend', `<p class="ok-text small pwd-saved">${saved}</p>`);
      form.hidden = false;
      form.username.value = cur.username || form.username.value;
      body.querySelector('#pwd-cur-l').hidden = !cur.set;
      body.querySelector('#pwd-new-hint').textContent = cur.set ? '至少 8 碼；只改帳號可以留白' : '至少 8 碼';
      form.newPassword.required = !cur.set;
      body.querySelector('#pwd-forgot').textContent = isAdmin() ? '忘記密碼要請有主機權限的人用救援指令（npm run admin-rescue）。' : `忘記密碼請管理員（${state.projMeta.adminName || '管理員'}）在「成員與權限」按「重設登入」。`;
      for (const k of ['current', 'newPassword', 'again']) form[k].value = '';
    };
    try { cur = await api('/api/me/password'); } catch (err) { status.innerHTML = `<p class="error">${esc(err.message)}</p>`; return; }
    draw();
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const err = body.querySelector('#pwd-set-err');
      err.textContent = '';
      const username = form.username.value.trim(), np = form.newPassword.value, again = form.again.value;
      if (!/^[a-z0-9._-]{4,30}$/i.test(username)) { err.textContent = '帳號需為 4～30 字，只能用英文、數字、. _ -'; return form.username.focus(); }
      if (np || !cur.set) { const bad = credError(username, np, again); if (bad) { err.textContent = bad; return form.newPassword.focus(); } }
      if (cur.set && !form.current.value) { err.textContent = '請先填目前密碼'; return form.current.focus(); }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const r = await api('/api/me/password', { method: 'PUT', body: { username, ...(cur.set ? { currentPassword: form.current.value } : {}), ...(np ? { newPassword: np, newPasswordAgain: again } : {}) } });
        const first = !cur.set;
        cur = r;
        draw(`已儲存。建議存到密碼管理器。${r.loggedOut ? `另外 ${r.loggedOut} 台用帳號密碼登入的裝置已登出。` : ''}`);
        toast(first ? '已設定帳號密碼' : '已儲存帳號密碼');
      } catch (e2) { err.textContent = e2.message; }
      finally { btn.disabled = false; }
    });
  }

  // ---------- C-202 我的裝置：列每台、登出這台、＋配對新裝置（6 位數、5 分鐘、一次性） ----------
  let pairTimer = null;
  async function openDevices() {
    const body = openModal('我的裝置', `<p class="muted small">這些裝置正以「${esc(state.me.name)}」登入。不認得的裝置請按「登出這台」。</p>
      <ul class="dev-list" id="dev-list"><li class="muted small">讀取中…</li></ul>
      <div class="dev-pair" id="dev-pair"><button class="btn primary" type="button" data-dev-pair>＋配對新裝置</button>
        <span class="muted small">在新裝置的登入頁選「配對這台裝置」，輸入這裡出現的 6 位數字。</span></div>`, { size: 'narrow' });
    const draw = async () => {
      let items;
      try { items = (await api('/api/devices')).items; } catch (err) { body.querySelector('#dev-list').innerHTML = `<li class="error">${esc(err.message)}</li>`; return; }
      body.querySelector('#dev-list').innerHTML = items.map(d => `<li class="dev-row"><div class="dev-main"><b>${esc(d.label || '瀏覽器')}</b>${d.current ? '<span class="pill-tag blue">這台</span>' : ''}
          <span class="muted small">最後使用 ${esc(d.current ? '現在' : agoText(d.lastUsedAt))} · ${esc(fmtDate(d.createdAt))} 登入</span></div>
        <button class="btn small" type="button" data-dev-out="${esc(d.id)}" data-cur="${d.current ? 1 : ''}">登出這台</button></li>`).join('') || '<li class="muted small">沒有其他裝置</li>';
    };
    body.addEventListener('click', async e => {
      const out = e.target.closest('[data-dev-out]');
      if (out) {
        const cur = !!out.dataset.cur;
        if (!await confirmDialog({ title: cur ? '登出這台裝置？' : '登出那台裝置？', confirmText: '登出', danger: !cur, message: cur ? '登出後這台要重新配對或用登入碼才能再登入。' : '那台裝置會立刻被登出，要重新配對才能再用。' })) return;
        try {
          await api(`/api/devices/${encodeURIComponent(out.dataset.devOut)}/logout`, { method: 'POST' });
          if (cur) { state.me = null; store.del(TOKEN_KEY); state.token = null; return location.replace('/'); }
          toast('已登出那台裝置'); draw();
        } catch (err) { toast(err.message); }
        return;
      }
      if (e.target.closest('[data-dev-pair]')) showPairCode(body);
    });
    draw();
  }
  async function showPairCode(body) {
    const box = body.querySelector('#dev-pair');
    let d;
    try { d = await api('/api/devices/pair-code', { method: 'POST' }); } catch (err) { return toast(err.message); }
    box.innerHTML = `<div class="pair-code" aria-label="配對碼 ${d.code.split('').join(' ')}">${d.code.slice(0, 3)}<span> </span>${d.code.slice(3)}</div>
      <p class="small">在新裝置打開 <b>${esc(location.host)}</b> ▸「配對這台裝置」輸入這 6 位數字。<span class="pair-left">剩 <b id="pair-cd"></b>，只能用一次。</span></p>
      <button class="btn small" type="button" data-dev-pair>重新產生</button>`;
    const end = Date.parse(d.expiresAt);
    const tick = () => {
      const cd = body.querySelector('#pair-cd');
      if (!cd || !cd.isConnected) return clearInterval(pairTimer);
      const left = end - Date.now();
      if (left <= 0) { clearInterval(pairTimer); box.querySelector('.pair-code').classList.add('expired'); box.querySelector('.pair-left').textContent = '已過期，請重新產生。'; return; }
      cd.textContent = mmss(left);
    };
    clearInterval(pairTimer); pairTimer = setInterval(tick, 1000); tick();
  }
  const fmtDate = iso => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  // ---------- C-202 邀請（只有管理員）：名字、角色、專案 → 一次性連結＋QR，15 分鐘 ----------
  let invTimer = null;
  function openInvite() {
    const body = openModal('＋邀請', `<form id="inv-new" class="stack">
        <label class="field">名字<input name="name" required maxlength="40" autocomplete="off" placeholder="例如：王小明"></label>
        <fieldset class="field inv-projs"><legend class="field-label">專案與角色</legend>
          ${PROJECTS.map(pj => `<div class="inv-proj-row"><label class="chk"><input type="checkbox" name="projects" value="${esc(pj)}"> ${esc(projName(pj))}</label>${roleSelectHtml('', `data-inv-role="${esc(pj)}" disabled`, { pj, ai: false, label: `在${projName(pj)}的角色` })}</div>`).join('')}
          <span class="muted small">每個專案各自一個角色；不勾＝還沒有專案，之後再指派</span></fieldset>
        <p class="error" id="inv-new-err" role="alert"></p>
      </form>`, { size: 'narrow', foot: '<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit" form="inv-new">產生邀請連結</button>' });
    // 勾了專案才能選那個專案的角色
    body.querySelector('#inv-new').addEventListener('change', async e => {
      const cb = e.target.closest('input[name="projects"]');
      if (cb) { const s = body.querySelector(`[data-inv-role="${CSS.escape(cb.value)}"]`); s.disabled = !cb.checked; return; }
      const s = e.target.closest('[data-inv-role]');
      if (!s) return;
      const v = await pickRole(s, s.dataset.v || '');
      if (v === null) return;
      if (v && ![...s.options].some(o => o.value === v)) s.insertAdjacentHTML('afterbegin', `<option value="${esc(v)}">${esc(v)}</option>`);
      s.value = v; s.dataset.v = v; s.classList.toggle('empty', !v);
    });
    body.querySelector('#inv-new').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const projects = f.getAll('projects');
      const roles = Object.fromEntries(projects.map(pj => [pj, body.querySelector(`[data-inv-role="${CSS.escape(pj)}"]`)?.value || '']).filter(([, v]) => v && v !== '__other'));
      try {
        const out = await api('/api/invites', { method: 'POST', body: { name: f.get('name').trim(), projects, roles } });
        showInviteLink(out);
        if (state.page === 'perm') loadInvites();
      } catch (err) { body.querySelector('#inv-new-err').textContent = err.message; }
    });
  }
  async function showInviteLink(out, title) {
    const iv = out.invite, reset = iv.kind === 'reset';
    const body = openModal(title || (reset ? `重設登入：${iv.name}` : '邀請連結'), `
      <p>${reset ? `已登出 <b>${esc(iv.name)}</b> 的所有裝置、舊登入碼已作廢、帳號密碼已清掉。把這個連結傳給他，打開就能重新登入（可以順便重設帳號密碼）。` : `把連結傳給 <b>${esc(iv.name)}</b>${iv.role ? `（${esc(iv.role)}）` : ''}，對方打開確認名字就能加入。`}</p>
      <p class="muted small">專案：${iv.projects.length ? iv.projects.map(x => esc(projName(x))).join('、') : '還沒有'} · 只能用一次</p>
      <div class="copy-row"><code class="val inv-url" id="inv-url">${esc(out.url)}</code><button class="btn small" type="button" data-inv="copy">複製</button></div>
      <div id="inv-qr" class="qr"></div>
      <p class="inv-count" id="inv-count"><span>剩 <b id="inv-cd"></b> 失效</span></p>
      <div class="row inv-acts"><button class="btn" type="button" data-inv="regen">重新產生</button><button class="btn danger" type="button" data-inv="cancel">取消邀請</button></div>
      <p class="muted small">重新產生：舊連結立刻失效，重新計時 15 分鐘。</p>`, { size: 'narrow' });
    try {
      if (!window.QRCode) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js');
      new window.QRCode(body.querySelector('#inv-qr'), { text: out.url, width: 200, height: 200 });
    } catch { body.querySelector('#inv-qr').outerHTML = '<p class="muted small">QR Code 元件載入失敗（可能離線），請改用「複製」。</p>'; }
    const end = Date.parse(iv.expiresAt);
    const tick = () => {
      const cd = body.querySelector('#inv-cd');
      if (!cd || !cd.isConnected) return clearInterval(invTimer);
      const left = end - Date.now();
      if (left <= 0) {
        clearInterval(invTimer);
        body.querySelector('#inv-count').innerHTML = '<b class="bad">已過期</b>，按「重發」產生新連結（同樣內容）';
        body.querySelector('#inv-url').classList.add('expired');
        body.querySelector('[data-inv="regen"]').textContent = '重發';
        return;
      }
      cd.textContent = mmss(left);
    };
    clearInterval(invTimer); invTimer = setInterval(tick, 1000); tick();
    body.addEventListener('click', async e => {
      const k = e.target.closest('[data-inv]')?.dataset.inv;
      if (k === 'copy') toast((await copyText(out.url)) ? '已複製邀請連結' : '複製失敗');
      else if (k === 'regen') {
        try { showInviteLink(await api(`/api/invites/${encodeURIComponent(iv.id)}/regenerate`, { method: 'POST' }), title); toast('已重新產生，舊連結已失效'); if (state.page === 'perm') loadInvites(); } catch (err) { toast(err.message); }
      } else if (k === 'cancel') {
        if (!await confirmDialog({ title: '取消這個邀請？', confirmText: '取消邀請', danger: true, message: `給 ${esc(iv.name)} 的連結會立刻失效。` })) return;
        try { await api(`/api/invites/${encodeURIComponent(iv.id)}/cancel`, { method: 'POST' }); clearInterval(invTimer); closeModal(); toast('已取消邀請'); if (state.page === 'perm') loadInvites(); } catch (err) { toast(err.message); }
      }
    });
  }
  // 邀請清單（最近 7 天）
  async function loadInvites() {
    try { perm.invites = (await api('/api/invites')).items; } catch (err) { perm.invites = []; toast(err.message); }
    drawPerm();
  }
  // C-233：邀請分頁：名字｜專案與角色｜狀態｜動作（按鈕固定在最後一欄）
  function permInvitesHtml() {
    if (!perm.invites) { loadInvites(); return '<p class="muted pm-pad">讀取中…</p>'; }
    const cls = { 有效: 'green', 已使用: 'blue', 已過期: 'grey', 已取消: 'grey' };
    const st = iv => iv.status === '有效' ? `有效 · 剩 ${Math.max(1, Math.ceil((Date.parse(iv.expiresAt) - Date.now()) / 60000))} 分`
      : iv.status === '已使用' ? `已使用 · ${fmtDate(iv.usedAt).split(' ')[0]}` : iv.status;
    const projText = iv => iv.projects.map(x => projName(x) + (iv.roles?.[x] ? ` · ${iv.roles[x]}` : '')).join('、') + (!iv.roles && iv.role ? ` · ${iv.role}` : '') || (iv.kind === 'reset' ? '—' : '還沒有專案');
    const acts = iv => iv.status === '有效' ? `<button type="button" class="btn small" data-pm-inv-regen="${esc(iv.id)}">重新產生</button><button type="button" class="btn small" data-pm-inv-cancel="${esc(iv.id)}">取消</button>`
      : iv.status === '已使用' ? '' : `<button type="button" class="btn small primary" data-pm-inv-regen="${esc(iv.id)}">重發</button>`;
    return `<div class="pm-projs"><div class="pm-card"><div class="pm-card-head"><strong>最近 7 天的邀請</strong><span class="muted small">連結 15 分鐘有效、只能用一次；過期可以「重發」（同樣內容、新連結）</span><span class="grow"></span><button type="button" class="link small" data-pm-inv-reload>重新整理</button><button type="button" class="btn primary small" data-pm-invite>＋ 邀請新的人</button></div>
      ${perm.invites.length ? `<table class="pm-table pm-itable"><thead><tr><th scope="col">名字</th><th scope="col" class="c-proj">專案與角色</th><th scope="col" class="c-st">狀態</th><th scope="col" class="c-iact"><span class="sr-only">動作</span></th></tr></thead><tbody>
        ${perm.invites.map(iv => `<tr class="pm-irow"><td class="c-name"><b>${esc(iv.name)}</b>${iv.kind === 'reset' ? '<span class="pill-tag yellow">重設登入</span>' : ''}</td><td class="c-proj">${esc(projText(iv))}</td><td class="c-st"><span class="inv-st ${cls[iv.status]}">${esc(st(iv))}</span></td><td class="c-iact">${acts(iv)}</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted small pm-pad">最近 7 天沒有邀請。按「＋ 邀請新的人」邀請新成員。</p>'}</div></div>`;
  }
  async function resetLogin(p) {
    if (!await confirmDialog({ title: `重設 ${esc(p.name)} 的登入？`, confirmText: '重設登入', danger: true,
      message: `會<b>登出 ${esc(p.name)} 所有裝置</b>、作廢他的舊登入碼、清掉他的帳號密碼，並產生一個新的邀請連結（15 分鐘）讓他重新登入。他的 AI 不受影響。` })) return;
    try { showInviteLink(await api(`/api/participants/${encodeURIComponent(p.participantId)}/reset-login`, { method: 'POST' })); if (perm.invites) perm.invites = null; } catch (err) { toast(err.message); }
  }

  // QR Code：在另一台裝置登入同一身分
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.append(s);
    });
  }
  async function openQr() {
    let link;
    try { link = `${location.origin}/?login=${encodeURIComponent((await api('/api/me/login-code')).code)}`; } catch (err) { return toast(err.message); }
    const body = openModal('QR Code 登入', `
      <p class="notice">用手機掃描，即可在手機上以「${esc(state.me.name)}」身分登入。此 QR Code 等同密碼，請勿分享。</p>
      <div id="qr" class="qr"></div>
      <button class="btn" type="button" id="qr-copy">複製登入連結</button>
      <p class="notice">提示：用 localhost 開啟時手機連不到；請改用電腦的區網 IP 開啟本頁後再產生 QR Code。</p>`, { size: 'narrow' });
    body.querySelector('#qr-copy').onclick = async () => toast((await copyText(link)) ? '已複製' : '複製失敗');
    try {
      if (!window.QRCode) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js');
      new window.QRCode(body.querySelector('#qr'), { text: link, width: 220, height: 220 });
    } catch {
      body.querySelector('#qr').outerHTML = '<p class="notice warn">QR Code 元件載入失敗（可能離線），請改用「複製登入連結」。</p>';
    }
  }

  // ---------- 進入點 ----------
  const params = new URLSearchParams(location.search);
  const qrCode = params.get('login');
  if (qrCode) {
    store.set(TOKEN_KEY, qrCode);
    history.replaceState(null, '', '/');
    // C-238：先開登入碼分頁並帶入；自動登入成功就直接進去，失敗就停在這裡顯示原因
    setLoginTab('code', false);
    document.querySelector('#token-form [name=token]').value = qrCode;
  }
  state.token = store.get(TOKEN_KEY);
  if (/^\/invite(\/|$)/.test(location.pathname)) showInvite(); // C-202：被邀請頁優先（這台裝置已登入別人也一樣）
  else if (/^\/rescue(\/|$)/.test(location.pathname)) showRescue(); // C-223：主機救援連結
  else if (state.token) start().then(() => { if (qrCode && state.me) rememberLoginTab('code'); }).catch(() => { store.del(TOKEN_KEY); state.token = null; if (qrCode) $('#token-error').textContent = '這個登入碼無效或已換過，請在已登入的裝置重新複製。'; showJoin(); });
  else showJoin();
  if (!state.token) $('#boot').hidden = true;
})();
