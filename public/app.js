// Aigile-Switch 網頁端
(() => {
  const $ = sel => document.querySelector(sel);
  const TOKEN_KEY = 'aigile-switch-token';
  const THEME_KEY = 'aigile-switch-theme';
  const FILTER_KEY = 'aigile-switch-only-mine';
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

  // ---------- 加入 / 登入 ----------
  async function showJoin() {
    $('#app').hidden = true;
    $('#join').hidden = false;
    if (store.get('aigile-switch-login-tab') === 'token' && $('#token-form').hidden) {
      const msg = $('#join-error').textContent;
      showLoginTab('token');
      if (msg) $('#token-error').textContent = msg;
    }
    try {
      const h = await api('/api/health');
      $('#room-code-field').hidden = !h.roomCodeRequired;
    } catch {}
  }

  $('#join-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('#join-error').textContent = '';
    try {
      const r = await api('/api/join', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      state.token = r.token;
      store.set(TOKEN_KEY, r.token);
      await start();
    } catch (err) {
      if (err.code === 'NAME_TAKEN') {
        showLoginTab('token');
        $('#token-error').textContent = `${err.message}。如果是你本人，請貼上你的 Token 登入。`;
      } else {
        $('#join-error').textContent = err.message;
      }
    }
  });

  // 登入頁籤：加入群組 ／ 用 Token 登入
  const LOGIN_TAB_KEY = 'aigile-switch-login-tab';
  function showLoginTab(which) {
    const token = which === 'token';
    $('#tab-join').setAttribute('aria-selected', String(!token));
    $('#tab-token').setAttribute('aria-selected', String(token));
    $('#join-form').hidden = token;
    $('#token-form').hidden = !token;
    $('#join-error').textContent = '';
    $('#token-error').textContent = '';
    store.set(LOGIN_TAB_KEY, which);
    (token ? $('#token-form input') : $('#join-form input')).focus();
  }
  $('#tab-join').addEventListener('click', () => showLoginTab('join'));
  $('#tab-token').addEventListener('click', () => showLoginTab('token'));
  $('.seg').addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const next = $('#tab-join').getAttribute('aria-selected') === 'true' ? 'token' : 'join';
      showLoginTab(next);
      $(next === 'token' ? '#tab-token' : '#tab-join').focus();
    }
  });

  $('#token-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('#token-error').textContent = '';
    const token = new FormData(e.target).get('token').trim();
    state.token = token;
    try {
      const me = await api('/api/me');
      if (me.memberType !== 'human') throw new Error('這是 AI 助手的 Token，只能透過 API 使用。請貼「你本人」的 Token（API 資訊 → 本人 Token）。');
      store.set(TOKEN_KEY, token);
      await start();
    } catch (err) {
      state.token = null;
      $('#token-error').textContent = err.code === 'INVALID_TOKEN' || err.code === 'TOKEN_EXPIRED'
        ? 'Token 無效或已過期。請確認是從同一個網站（網址相同）複製的。'
        : err.message;
    }
  });

  async function logout(confirmFirst = true) {
    if (confirmFirst && !await confirmDialog({ title: '登出？', confirmText: '登出', message: '登出後，要用「API 資訊」裡的本人 Token（或其他裝置的 QR Code）才能再登入此身分。建議先複製 Token 保存。' })) return;
    store.del(TOKEN_KEY);
    state.token = null;
    state.me = null;
    clearTimeout(pollTimer);
    location.replace('/');
  }
  document.querySelectorAll('.logout-btn').forEach(b => b.addEventListener('click', () => logout(true)));

  function drawMe() {
    const meCard = `<button type="button" class="me-avatar-btn" data-change-avatar title="更換頭像" aria-label="更換頭像">${avatar(state.me)}<span class="pen" aria-hidden="true">✎</span></button><div class="me-info"><b>${esc(state.me.name)}</b><span class="muted small">${esc(state.me.role || '未設定角色')} · #${esc(state.me.shortCode)} · 本人</span></div>`;
    $('#me-line').innerHTML = meCard;
    $('#sheet-me').innerHTML = meCard;
  }

  document.addEventListener('click', e => { if (e.target.closest('[data-change-avatar]')) { closeSheet(false); changeMyAvatar(); } });

  // ---------- 啟動 ----------
  async function start() {
    state.me = await api('/api/me');
    if (state.me.memberType !== 'human') {
      store.del(TOKEN_KEY);
      state.token = null;
      state.me = null;
      $('#join-error').textContent = '這是 AI 助手的 Token，只能透過 API 存取，不能登入網頁。';
      return showJoin();
    }
    $('#join').hidden = true;
    $('#app').hidden = false;
    drawMe();
    await loadProjectList().catch(() => {});
    drawProjSwitch();
    await loadParticipants();
    const d = await api('/api/messages?limit=100');
    state.messages = d.items;
    state.byId = new Map(d.items.map(m => [m.messageId, m]));
    state.nextCursor = d.nextCursor;
    state.olderCursor = d.olderCursor;
    renderMessages(true);
    refreshInboxCount();
    loadTeam();
    loadCards().then(() => { renderMessages(false); if (state.page === 'work') renderWork(); }).catch(() => {});
    connectEvents();
    const savedPage = store.get(PAGE_KEY);
    showPage(['work', 'inbox', 'team', 'overview'].includes(savedPage) ? savedPage : !savedPage && myProjects().length > 1 ? 'overview' : 'messages');
  }

  async function loadParticipants() {
    const d = await api('/api/participants');
    state.participants = new Map(d.items.map(p => [p.participantId, p]));
    const online = d.items.filter(p => p.isOnline).length;
    document.querySelectorAll('.presence-text').forEach(el => { el.textContent = `${d.items.length} 人在群 · 近期活躍 ${online}`; el.dataset.short = `${online} 人在線`; });
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
  const BASE_TITLE = document.title;
  const meId = () => state.me.participantId;
  const isToMe = m => m.recipients.some(r => r.participantId === meId());
  const isReplyToMe = m => {
    const parent = m.replyToMessageId && state.byId.get(m.replyToMessageId);
    return !!parent && parent.author.participantId === meId();
  };
  const isMine = m => m.author.participantId === meId();
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
    if (!c) return work.loaded ? `<span class="cap cap-miss">${id} 找不到</span>` : id;
    return `<button type="button" class="cap" data-cap="${id}" data-st="${esc(c.status)}">${id}<i class="cdot" aria-hidden="true"></i>${esc(c.status)}</button>`;
  }

  // 第二行：AI 寫成「角色 · AI · 所屬人 · 所在環境」
  function subLine(a) {
    if (a.memberType === 'ai') return [a.role, 'AI', a.ownerName, a.environment].filter(Boolean).join(' · ');
    if (a.memberType === 'system') return '系統';
    return [a.role || '人類', a.environment].filter(Boolean).join(' · ');
  }
  function statusTags(m, toMe, replyMe) {
    const tags = [
      m.audience === 'all' ? '<span class="tag all">全體通知</span>' : '',
      toMe && m.audience !== 'all' && !isMine(m) ? '<span class="tag me">指定給我</span>' : '',
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

  function messageHtml(m) {
    const toMe = isToMe(m);
    const replyMe = isReplyToMe(m);
    const parent = m.replyToMessageId ? state.byId.get(m.replyToMessageId) : null;
    const a = m.author;
    const cls = ['msg', isMine(m) ? 'mine' : '', (toMe || replyMe) && !isMine(m) ? 'to-me' : ''].join(' ');
    const recipients = m.audience === 'all'
      ? '<span class="mention">@所有人</span>'
      : m.recipients.map(r => `<span class="mention">@${esc(r.name)}</span>`).join(' ');
    return `
      <article class="${cls}" id="msg-${esc(m.messageId)}">
        <div class="msg-head">
          ${avatar(state.participants.get(a.participantId) || a)}
          <div class="msg-who">
            <div class="msg-line1"><span class="msg-author">${esc(a.name)}</span><time class="msg-time" datetime="${esc(m.createdAt)}" title="seq ${m.sequence}">${fmtTime(m.createdAt)}</time>${projTag(m.project)}</div>
            <div class="msg-line2">${esc(subLine(a))}</div>
          </div>
        </div>
        ${statusTags(m, toMe, replyMe)}
        ${recipients ? `<div class="recipients"><span class="muted">給</span> ${recipients}</div>` : ''}
        ${m.replyToMessageId ? `<button class="quote" type="button" data-jump="${esc(m.replyToMessageId)}">回覆 ${parent ? `<b>${esc(parent.author.name)}</b>：${esc(parent.text.slice(0, 80))}` : `較早的訊息（${esc(shortId(m.replyToMessageId))}）`}</button>` : ''}
        ${m.file ? fileNoteHtml(m.text) + fileCardHtml(m.file) : textHtml(m)}
        ${authHtml(m)}
        <div class="msg-foot">
          <button class="reply-btn" type="button" data-reply="${esc(m.messageId)}">回覆</button>
          ${m.file ? '' : `<button class="reply-btn newcard" type="button" data-newcard="${esc(m.messageId)}">＋建卡</button>`}
          ${linkedCapsules(m)}
          ${!m.file && isLong(m.text) ? `<button type="button" class="link more" data-more="${esc(m.messageId)}">${state.expanded.has(m.messageId) ? '收合' : '展開全文'}</button>` : ''}
          ${threadToggle(m)}
        </div>
      </article>`;
  }

  // 長訊息預設折疊（超過 6 行或 400 字）
  const isLong = t => t.split('\n').length > 6 || t.length > 400;
  function textHtml(m) {
    const clamp = isLong(m.text) && !state.expanded.has(m.messageId);
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
  const PROJ_KEY = 'aigile-switch-project';
  // 專案清單來自伺服器（可新增、改名、封存）；PROJECTS 是未封存專案的 id，專案顯示名稱用 projName
  const PROJECTS = [];
  state.projectList = [];
  state.projMeta = { adminId: null, adminName: '', crossRoleIds: [] };
  const projName = id => state.projectList.find(p => p.id === id)?.name || id;
  async function loadProjectList() {
    const d = await api('/api/projects');
    state.projectList = d.items;
    state.projMeta = { adminId: d.adminId, adminName: d.adminName || '', crossRoleIds: d.crossRoleIds || [] };
    document.querySelectorAll('[data-admin-only]').forEach(b => { b.hidden = !d.adminId || d.adminId !== state.me?.participantId; });
    PROJECTS.length = 0;
    PROJECTS.push(...state.projectList.filter(p => !p.archived).map(p => p.id));
  }
  const myProjects = () => (state.me?.projects || []).filter(p => PROJECTS.includes(p));
  const singleProject = () => myProjects().length === 1;
  // 目前檢視（C-146 A）：單一專案成員固定自己的專案；多專案成員可切換各專案、跨專案頻道（cross）或全部專案（all），記在瀏覽器。
  // 下拉只列各專案與跨專案頻道；全部專案由側欄「今日總覽」進入（昱志第 997 則、UX 第 998 則），多專案成員預設就是全部專案
  function projectView() {
    if (singleProject()) return myProjects()[0];
    if (!myProjects().length) return 'cross';
    const v = store.get(PROJ_KEY);
    return myProjects().includes(v) || v === 'cross' ? v : 'all';
  }
  const projTag = p => (p ? `<span class="ptag" data-p="${esc(p)}">${esc(projName(p))}</span>` : '');
  // 卡片標題（C-146 A）：不再手打「[平台]」，舊卡的前綴顯示時去掉，改看專案標籤
  const cardTitle = c => { const m = /^\s*\[([^\]\n]{1,20})\]\s*/.exec(c.title || ''); return m && state.projectList.some(p => p.id === m[1] || p.name === m[1]) ? c.title.slice(m[0].length) || c.title : c.title; };
  // 訊息：總覽全部；跨專案頻道只看「全部專案」的訊息；選了專案只看該專案（單一專案成員另外看得到跨專案頻道）
  const msgInView = p => { const v = projectView(); return v === 'all' || (v === 'cross' ? !p : p === v || (!p && singleProject())); };
  const cardInView = c => { const v = projectView(); return v === 'all' || v === 'cross' || c.project === v; };
  const inView = p => { const v = projectView(); return v === 'all' || (v === 'cross' ? !p : p === v); }; // 收件匣、文件用
  const viewLabel = v => (v === 'all' ? '全部專案' : v === 'cross' ? '跨專案頻道' : projName(v));
  // 各檢視「要你做的」件數：等你決定（決策卡、[需確認]）＋待審核的 AI 建議
  function todoByView() {
    const items = [...(state.team ? myDecisions(state.team) : []), ...(work.sugg || [])];
    const n = { all: items.length, cross: items.filter(x => !x.project).length };
    for (const p of myProjects()) n[p] = items.filter(x => x.project === p).length;
    return n;
  }
  function drawProjSwitch() {
    document.querySelectorAll('[data-nav="overview"]').forEach(b => { b.hidden = myProjects().length < 2; });
    const v = projectView(), counts = todoByView();
    const opts = [...myProjects(), ...(myProjects().length > 1 ? ['cross'] : [])];
    const badge = k => (counts[k] ? `<span class="ps-count" aria-label="要你做的 ${counts[k]} 件">${counts[k]}</span>` : '');
    document.querySelectorAll('.proj-switch').forEach((el, i) => {
      el.innerHTML = singleProject() || !myProjects().length
        ? `<span class="proj-fixed" title="目前專案">${myProjects().length ? esc(projName(myProjects()[0])) : '尚未加入任何專案（只看得到跨專案頻道）'}</span>`
        : `<button type="button" class="ps-btn" aria-haspopup="listbox" aria-expanded="false" aria-controls="ps-list-${i}"><span class="ps-label">目前專案</span><b>${esc(viewLabel(v))}</b>${badge(v)}<span class="ps-chev" aria-hidden="true">▾</span></button>
          <ul class="ps-list" id="ps-list-${i}" role="listbox" aria-label="切換專案" hidden>${opts.map(k => `<li role="option" tabindex="-1" data-proj="${esc(k)}" aria-selected="${k === v}"><span>${esc(viewLabel(k))}</span>${badge(k)}</li>`).join('')}</ul>`;
    });
    drawProjSel();
  }
  // 發訊息的專案：預設跟目前檢視；回覆時不選就繼承被回覆訊息的專案（由伺服器處理）
  let projTouched = false;
  const defaultProj = () => (projectView() === 'all' ? '' : projectView() === 'cross' ? 'all' : projectView());
  function drawProjSel() {
    const sel = $('#proj-sel');
    if (!sel) return;
    const opts = [['', '專案：預設'], ...myProjects().map(p => [p, projName(p)]), ['all', '全部專案']];
    sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    sel.value = projTouched ? sel.value : defaultProj();
  }
  function setProjectView(k) {
    store.set(PROJ_KEY, k);
    if (state.page === 'overview') showPage('messages');
    projTouched = false;
    drawProjSwitch();
    syncFilterBar();
    renderMessages(true);
    if (state.page === 'work' || state.page === 'inbox') renderWork();
    if (state.page === 'team') renderTeamPage();
  }
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
    if (b) setProjectView(b.dataset.proj);
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
  $('#proj-sel').addEventListener('change', () => { projTouched = true; });

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
    $('#f-tag').value = f.tag;
    const sel = $('#f-member');
    const people = [...state.participants.values()].filter(p => p.status !== 'disabled').sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    sel.innerHTML = '<option value="">所有成員</option>' + people.map(p => `<option value="${esc(p.participantId)}">${esc(p.name)}</option>`).join('');
    sel.value = f.member;
    $('#f-clear').hidden = !filtering();
    const fo = $('#f-open'); if (fo) { const n = filterCount(); fo.textContent = n ? `篩選 · ${n}` : '篩選 ▾'; }
  }
  const filterCount = () => (state.filter.scope !== 'all' ? 1 : 0) + (state.filter.member ? 1 : 0) + (state.filter.tag ? 1 : 0);
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
    return [{ all: '全部', mine: '給我的', related: '與我相關' }[f.scope], p || '所有成員', f.tag || ''].filter(Boolean).join(' · ');
  }
  function openFilterSheet() {
    const f = state.filter;
    const people = [...state.participants.values()].filter(p => p.status !== 'disabled').sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    const tags = ['需確認', '決策紀錄', '接單', '進度', '完成', '受阻', '交接', '回覆'];
    const draft = { scope: f.scope, member: f.member, tag: f.tag, project: projectView() };
    const showProj = !singleProject();
    const body = openModal('篩選', `
      <div class="stack">
        <div class="field"><span class="field-label" id="fs-scope">範圍</span>
          <div class="seg-scope full" role="group" aria-labelledby="fs-scope" id="fs-scope-g"></div></div>
        ${showProj ? `<div class="field"><span class="field-label" id="fs-proj">專案</span>
          <div class="seg-scope full" role="group" aria-labelledby="fs-proj" id="fs-proj-g"></div></div>` : ''}
        <label>成員<select id="fs-member"><option value="">所有成員</option>${people.map(p => `<option value="${esc(p.participantId)}">${esc(p.name)}</option>`).join('')}</select></label>
        <label>標籤<select id="fs-tag"><option value="">所有標籤</option>${tags.map(t => `<option>${t}</option>`).join('')}</select></label>
      </div>`, { size: 'narrow', foot: '<button class="btn" type="button" id="fs-clear">清除</button><button class="btn primary grow" type="button" id="fs-apply">套用</button>' });
    const draw = () => {
      body.querySelector('#fs-scope-g').innerHTML = [['all', '全部'], ['mine', '給我的'], ['related', '與我相關']].map(([k, t]) => `<button type="button" data-fs-scope="${k}" aria-pressed="${draft.scope === k}">${t}</button>`).join('');
      const pg = body.querySelector('#fs-proj-g');
      if (pg) pg.innerHTML = [['all', '全部專案'], ...myProjects().map(p => [p, projName(p)]), ['cross', '跨專案頻道']].map(([k, t]) => `<button type="button" data-fs-proj="${k}" aria-pressed="${draft.project === k}">${t}</button>`).join('');
      body.querySelector('#fs-member').value = draft.member;
      body.querySelector('#fs-tag').value = draft.tag;
    };
    draw();
    body.addEventListener('click', e => {
      const sc = e.target.closest('[data-fs-scope]'); if (sc) { draft.scope = sc.dataset.fsScope; draw(); }
      const pr = e.target.closest('[data-fs-proj]'); if (pr) { draft.project = pr.dataset.fsProj; draw(); }
    });
    body.querySelector('#fs-member').onchange = e => { draft.member = e.target.value; };
    body.querySelector('#fs-tag').onchange = e => { draft.tag = e.target.value; };
    body.modal.querySelector('#fs-clear').onclick = () => { Object.assign(draft, { scope: 'all', member: '', tag: '', project: projectView() }); draw(); };
    body.modal.querySelector('#fs-apply').onclick = () => {
      closeModal();
      if (showProj && draft.project !== projectView()) { store.set(PROJ_KEY, draft.project); projTouched = false; drawProjSwitch(); if (state.page === 'work') renderWork(); }
      setFilter({ scope: draft.scope, member: draft.member, tag: draft.tag });
    };
  }
  $('#f-open').onclick = openFilterSheet;
  document.querySelectorAll('[data-scope]').forEach(b => { b.onclick = () => setFilter({ scope: b.dataset.scope }); });
  $('#f-member').onchange = e => setFilter({ member: e.target.value });
  $('#f-tag').onchange = e => setFilter({ tag: e.target.value });
  $('#f-clear').onclick = () => setFilter({ scope: 'all', member: '', tag: '' });

  const nearBottom = () => { const el = $('#messages'); return el.scrollHeight - el.scrollTop - el.clientHeight < 120; };
  const scrollBottom = () => { const el = $('#messages'); el.scrollTop = el.scrollHeight; };

  function renderMessages(toBottom) {
    const list = state.messages.filter(visible);
    $('#f-count').textContent = filtering() ? `符合 ${list.length} 則` : '';
    const older = state.olderCursor ? '<button type="button" class="load-older" id="load-older">載入更早歷史訊息</button>' : '';
    $('#messages').innerHTML = older + (list.length
      ? list.map(messageHtml).join('')
      : `<div class="empty">${filtering() ? '沒有符合篩選條件的訊息。' : '還沒有訊息。打個招呼，或到「我的 AI」新增助手。'}</div>`);
    syncScrollbar();
    if (toBottom) scrollBottom();
  }

  async function loadOlder() {
    const box = $('#messages');
    const prevHeight = box.scrollHeight;
    const d = await api(`/api/messages?limit=100&before=${encodeURIComponent(state.olderCursor)}`);
    const fresh = d.items.filter(m => !state.byId.has(m.messageId));
    fresh.forEach(m => state.byId.set(m.messageId, m));
    state.messages = fresh.concat(state.messages);
    state.olderCursor = d.olderCursor;
    renderMessages(false);
    box.scrollTop = box.scrollHeight - prevHeight;
  }

  function onNewMessage(m) {
    if (state.byId.has(m.messageId)) return;
    const stick = nearBottom() || isMine(m);
    state.messages.push(m);
    state.byId.set(m.messageId, m);
    if (m.replyToMessageId && state.byId.has(m.replyToMessageId)) {
      renderMessages(stick);
      if (!isMine(m) && (isToMe(m) || isReplyToMe(m))) refreshInboxCount();
      return;
    }
    if (!visible(m)) return;
    const box = $('#messages');
    box.querySelector('.empty')?.remove();
    box.insertAdjacentHTML('beforeend', messageHtml(m));
    if (stick) scrollBottom();
    if (!isMine(m) && (isToMe(m) || isReplyToMe(m))) {
      refreshInboxCount();
      if (!stick) toast(`${m.author.name} 有訊息指定給你`);
    }
  }

  $('#messages').addEventListener('input', e => { const t = e.target.closest?.('[data-q-text]'); if (!t) return; quickState(t.dataset.qText).text = t.value; const sb = t.closest('[data-q-root]')?.querySelector('[data-q-send]'); if (sb && cardOfConfirm({ messageId: t.dataset.qText })) sb.disabled = !t.value.trim(); });
  $('#messages').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || !e.target.matches?.('[data-q-text]')) return;
    e.preventDefault(); const b = e.target.closest('.quick')?.querySelector('[data-q-send]'); if (b && !b.disabled) b.click();
  });
  $('#messages').addEventListener('click', e => {
    if (e.target.closest('#load-older')) return loadOlder().catch(err => toast(err.message));
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

  async function jumpTo(id) {
    let el = document.getElementById('msg-' + id);
    if (!el && state.byId.has(id) && (filtering() || state.collapsed.size)) {
      state.collapsed.clear();
      Object.assign(state.filter, { scope: 'all', member: '', tag: '' });
      state.onlyMine = false; store.set(FILTER_KEY, '0');
      syncFilterBar(); renderMessages(false);
      el = document.getElementById('msg-' + id);
    }
    if (!el) {
      try {
        const m = await api(`/api/messages/${encodeURIComponent(id)}`);
        toast(`較早的訊息：${m.author.name}（seq ${m.sequence}），請按「載入更早歷史訊息」`);
      } catch { toast('找不到原訊息'); }
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  }
  $('#reply-cancel').addEventListener('click', () => setReply(null));

  // ---------- 輸入與 @提及 ----------
  // @ 選單候選（C-150）：不截斷，清單可捲動；所有人在最前，再來是跟我同專案的成員
  function mentionCandidates(raw) {
    const q = raw.toLowerCase();
    const mine = myProjects();
    const near = p => (p.projects?.length ? p.projects : PROJECTS).some(x => mine.includes(x));
    const people = [...state.participants.values()]
      .filter(p => p.participantId !== meId() && (!q || p.name.toLowerCase().includes(q) || (p.role || '').toLowerCase().includes(q)));
    return [...(!q || ALL.name.includes(q) || ALL.role.includes(q) ? [ALL] : []), ...people.filter(near), ...people.filter(p => !near(p))];
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
        <span class="dot ${p.isOnline ? 'on' : ''}"></span><b>${esc(p.name)}</b>
        <span class="muted small">${esc(p.role || '')}</span>${p.memberType === 'ai' ? '<span class="tag ai">AI</span>' : ''}
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

  function onInput() {
    sendBtn.disabled = !input.value.trim();
    autoGrow();
    updateMention();
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

  // 正文中的 @名字 → 收件人；@所有人 → audience: all
  function resolveRecipients(text) {
    if (text.includes('@' + ALL.name)) return { audience: 'all' };
    const ids = [];
    let scan = text;
    const people = [...state.participants.values()].sort((a, b) => b.name.length - a.name.length);
    for (const p of people) {
      const tag = '@' + p.name;
      if (scan.includes(tag)) {
        if (p.participantId !== meId()) ids.push(p.participantId);
        scan = scan.split(tag).join(' ');
      }
    }
    return ids.length ? { recipientIds: ids } : {};
  }

  // 沒動過專案選單：回覆時不帶（繼承），否則帶目前檢視的專案；動過就照選的
  function sendProject() {
    const v = projTouched ? $('#proj-sel').value : (state.replyTo ? '' : defaultProj());
    return v ? { project: v } : {};
  }
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
      projTouched = false; drawProjSel();
      onNewMessage(m);
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
    const pane = state.page === 'team' && TEAM_PANES.includes(title) ? $('#team-pane') : null;
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
    overlay.addEventListener('click', e => {
      if (e.target === overlay || e.target.closest('[data-close]')) closeModal();
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
  function confirmDialog({ title, message, confirmText = '確認', danger = false, expectText = '' }) {
    return new Promise(resolve => {
      const prev = document.activeElement;
      const host = document.createElement('div');
      host.className = 'confirm-root';
      host.innerHTML = modalFrame({
        title, size: 'narrow',
        body: `<div class="confirm-msg${danger ? ' danger' : ''}">${message}</div>${expectText ? `<label class="field">請輸入「${esc(expectText)}」確認<input type="text" data-expect autocomplete="off"></label>` : ''}`,
        foot: `<button class="btn" type="button" data-close>取消</button>
               <button class="btn ${danger ? 'danger' : 'primary'}" type="button" data-ok ${expectText ? 'disabled' : ''}>${esc(confirmText)}</button>`,
      });
      document.body.append(host);
      const overlay = host.firstElementChild;
      const done = ok => { host.remove(); if (prev?.isConnected) prev.focus(); resolve(ok); };
      overlay.addEventListener('click', e => {
        if (e.target.closest('[data-ok]')) return done(true);
        if (e.target === overlay || e.target.closest('[data-close]')) done(false);
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
  function avatarDialog({ title, isAi, fallback, cur }) {
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
      overlay.addEventListener('click', async e => {
        if (e.target.closest('[data-ok]')) {
          const text = $('#av-text').value.trim();
          if (st.mode === 'img' && st.img) return done({ kind: 'img', blob: await crop('blob'), url: crop('url'), text: cur.text || '' });
          if (st.mode === 'img') return done({ kind: 'keep' });
          return done({ kind: 'text', text, removeImg: !!cur.imgUrl });
        }
        if (e.target === overlay || e.target.closest('[data-close]')) done(null);
      });
      overlay.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
      draw();
      host.querySelector(`[data-mode="${st.mode}"]`).focus();
    });
  }

  // 套用到自己
  async function changeMyAvatar() {
    const cur = { text: state.me.avatar || '', imgUrl: state.me.avatarImg ? await avatarUrl(meId(), state.me.avatarImg) : null };
    const r = await avatarDialog({ title: '更換頭像', isAi: state.me.memberType === 'ai', fallback: [...(state.me.name || '人')][0], cur });
    if (!r || r.kind === 'keep') return;
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
      Object.assign(state.me, { avatar: me.avatar, avatarImg: me.avatarImg });
      drawMe();
      await loadParticipants();
      renderMessages(false);
      document.querySelectorAll('#set-avatar').forEach(el => { el.innerHTML = avatar(state.me); });
      toast('頭像已更新');
    } catch (err) { toast(err.message); }
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
  const typeTag = c => projTag(c.project) + (c.type !== '工作' ? `<span class="ctype" data-ty="${esc(c.type)}">${esc(c.type)}</span>` : '');
  const waitText = c => (c.waitFor ? `等 ${isMeRef(c.waitFor) ? '你' : c.waitFor.name}${c.blocker ? '：' + c.blocker : ''}` : c.blocker || '');
  const staleTag = c => (c.staleHint ? `<span class="cmark stale" title="最後更新 ${esc(shortTime(c.staleHint.lastUpdatedAt))} · 最新相關訊息 ${esc(shortTime(c.staleHint.latestMessageAt))}">可能過時</span>` : '');
  const markHtml = c => (c.verified ? '<span class="cmark ok">✓ 已驗證</span>' : c.done ? '<span class="cmark wait">待驗證</span>' : '') + staleTag(c);
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
      hint = '說明可選填；不同意或要求補充一定要寫；「暫緩」可寫原因（Ctrl+Enter 只送意見）';
      btns = optionsOf(c).map((o, i) => inlBtn(key, 'decide', `決定「${esc(o)}」`, { cls: i === 0 ? 'ok' : '', result: o })).join('')
        + inlBtn(key, 'opinion', '只送意見', { need: true, primary: true })
        + inlBtn(key, 'decide', '不同意', { need: true, result: '不同意' })
        + inlBtn(key, 'decide', '要求補充', { need: true, result: '要求補充' })
        + inlBtn(key, 'defer', '暫緩');
    }
    return `<div class="inl" data-inl-root="${esc(key)}">
      <div class="inl-field"><textarea class="inl-text" rows="2" maxlength="1500" data-inl-text="${esc(key)}" placeholder="${kind === 'card' ? '想說什麼都可以寫在這裡，打 @ 可以指定人（Ctrl+Enter 送出）' : hint}" aria-label="輸入想法">${esc(work.drafts[key] || '')}</textarea>
        ${kind === 'card' ? '<ul class="mention-list" role="listbox" aria-label="選擇成員" hidden></ul>' : ''}</div>
      ${kind === 'card' ? cardToHtml(key, c) : ''}
      <div class="inl-actions">${btns}</div>
      <p class="error small" data-inl-err="${esc(key)}" role="alert"></p></div>`;
  }
  const decisionActions = c => inlineHtml('c:' + c.cardId, 'decision', c);
  // C-162：卡片回覆的收件人
  work.inlRm = {}; // key → 使用者按 × 移除的成員
  const cardMembers = c => [...state.participants.values()].filter(p => p.status !== 'disabled' && (p.projects || []).includes(c.project));
  const cardMentionCandidates = c => raw => { const q = raw.toLowerCase(); return cardMembers(c).filter(p => p.participantId !== meId() && (!q || p.name.toLowerCase().includes(q) || (p.role || '').toLowerCase().includes(q))); };
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
    const post = body => api('/api/messages', { method: 'POST', body: { requestId: newRequestId(), ...body } });
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
    if (d.items.length) work.since = d.nextSince;
    if (archMoved) await refreshArchivedCount(); // 有卡被封存或重新打開，已封存數字跟著更新
    renderWork();
    if (state.page === 'messages' && d.items.length) { const box = $('#messages'), top = box.scrollTop; renderMessages(false); box.scrollTop = top; }
    if (work.openId && d.items.some(c => c.cardId === work.openId) && !work.editing) openCard(work.openId);
  }

  // AI 建議區塊
  function suggHtml(batch = false) {
    const list = work.sugg || [];
    if (!list.length) return '';
    for (const id of [...work.sel]) if (!list.some(g => g.suggestionId === id)) work.sel.delete(id);
    const batchBar = batch ? `<div class="batch-bar" role="group" aria-label="批次處理"><span class="small">已選 <b>${work.sel.size}</b> 則</span><button type="button" class="btn small primary" data-batch="apply" ${work.sel.size ? '' : 'disabled'}>批次採用</button><button type="button" class="btn small" data-batch="skip" ${work.sel.size ? '' : 'disabled'}>批次略過</button><span class="muted small">逐則勾選後才能批次處理，不提供一鍵全部採用</span></div>` : '';
    const what = g => (g.kind === 'create'
      ? `建立${g.create.type}卡片「${esc(g.create.title)}」，負責人 ${esc(g.create.owner?.name || '未指派')}`
      : `${esc(g.card?.cardId || '')} ${esc(g.card?.title || '')} 狀態改為「${esc(g.to)}」${g.waitFor ? `，等 ${esc(g.waitFor.name)}` : ''}`);
    return `<section class="wsugg"><div class="wsugg-head"><span class="wdot sg"></span><h3>AI 建議</h3><span class="wcount pur">${list.length}</span><span class="muted small">由你採用後才會建立或更新卡片</span></div>
      ${batchBar}
      ${list.map(g => `<div class="sugg-row${g.expired ? ' expired' : ''}">
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
    const tabs = [['status', '團隊狀態'], ['memory', 'AI 工作記憶'], ['members', '成員名單'], ['ai', '我的 AI']];
    box.innerHTML = `<div class="work-head"><div class="work-title"><h2>團隊</h2></div>
      <div class="seg-scope" role="group" aria-label="團隊分頁">${tabs.map(([k, t]) => `<button type="button" data-team-tab="${k}" aria-pressed="${work.teamTab === k}">${t}</button>`).join('')}</div></div>
      <div id="team-pane" class="inline-pane"></div>`;
    const done = ({ status: openTeam, memory: openTeamMemory, members: openMembers, ai: openMyAi })[work.teamTab]();
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
    if (go) { closeSheet(false); work.teamTab = go.dataset.teamGo; store.set(TEAM_NAV_KEY, '1'); if (state.page === 'team') renderTeamPage(); else showPage('team'); }
  });
  function openTodoPage() { closeSheet(false); showPage('inbox'); }
  document.addEventListener('click', e => { if (e.target.closest('[data-todo]')) openTodoPage(); });
  function showPage(page) {
    if (work.openId) closeCard();
    state.page = ['work', 'inbox', 'team', 'overview'].includes(page) ? page : 'messages';
    if (state.page !== 'team') work.teamScrollTab = null; // C-157：離開團隊頁就不再保留捲動位置（UX 第 1010 則），回來從頂端開始
    store.set(PAGE_KEY, state.page);
    $('#page-messages').hidden = state.page !== 'messages';
    $('#page-work').hidden = state.page === 'messages'; // 收件匣與工作共用同一個容器
    document.querySelectorAll('[data-nav]').forEach(b => {
      if (b.dataset.nav === state.page) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    syncTeamNav();
    if (state.page === 'work') {
      (work.loaded ? Promise.resolve() : loadCards()).then(renderWork).catch(err => toast(err.message));
    } else if (state.page === 'team') {
      renderTeamPage();
    } else if (state.page === 'overview') {
      Promise.all([work.loaded ? null : loadCards(), loadTeam().catch(() => {})]).then(renderWork).catch(err => toast(err.message));
    } else if (state.page === 'inbox') {
      Promise.all([work.loaded ? null : loadCards(), loadNotes(), loadTeam().catch(() => {})]).then(() => { updateTodoBadge(); renderWork(); }).catch(err => toast(err.message));
    } else scrollBottom();
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-nav]');
    if (!b) return;
    closeSheet(false);
    if (b.dataset.nav === 'overview' && projectView() !== 'all') { store.set(PROJ_KEY, 'all'); drawProjSwitch(); syncFilterBar(); renderMessages(true); }
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

  function renderWork() {
    const box = $('#page-work');
    if (!['work', 'inbox', 'overview'].includes(state.page) || !work.loaded) return;
    box.classList.remove('is-board');
    if (state.page === 'inbox') { box.innerHTML = inboxHtml(); return; }
    if (state.page === 'overview') { box.innerHTML = todayHtml(); return; }
    const all = visibleCards();
    const people = [...state.participants.values()].filter(p => p.status !== 'disabled');
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
        <select id="card-type" aria-label="類型"><option value="">所有類型</option>${['工作', '阻塞', '決策'].map(t => `<option ${work.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </div>
      ${work.view === 'B' ? boardHtml(all) : overviewHtml(all)}`;
    box.classList.toggle('is-board', work.view === 'B'); // 看板：高度＝頁面剩餘高度，欄內各自捲動（C-142）
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
        ${list.length ? list.slice(0, 3).map(c => `<button type="button" class="wpanel-item" data-card="${esc(c.cardId)}"><span>${projTag(c.project)} ${esc(cardTitle(c))}</span><span class="muted small">${esc(meta(c))}</span></button>`).join('')
          : `<p class="muted small">${empty}</p>`}
        ${list.length > 3 ? `<button type="button" class="link small" data-filter="${cls === 'done' ? '已完成' : cls === 'blocked' ? '受阻' : 'open'}">查看全部 ${list.length} 張</button>` : ''}
        ${extra}
      </section>`;
    const chips = [['open', '未完成', all.filter(c => !closedSt(c.status)).length], ...CARD_ST.map(s => [s, s === '已完成' ? '已完成（7 天）' : s, s === '已封存' ? work.archived.count : all.filter(c => c.status === s).length])];
    const listed = all.filter(c => (work.filter === 'open' ? !closedSt(c.status) : c.status === work.filter));
    const archMore = work.filter === '已封存' && work.archived.hasMore ? `<button type="button" class="btn small" data-arch-more ${work.archived.loading ? 'disabled' : ''}>再載入 50 張</button>` : '';
    const sa = work.archSearch, archHits = work.q.trim() && sa.q === work.q.trim() && work.filter !== '已封存' ? sa.items.filter(c => !listed.some(x => x.cardId === c.cardId)) : [];
    const archGroup = archHits.length ? `<div class="arch-group"><button type="button" class="arch-group-head" data-arch-toggle aria-expanded="${sa.open}">已封存 ${archHits.length}（${sa.open ? '點一下收合' : '收合中，點開'}）${sa.open ? '▴' : '▾'}</button>
        ${sa.open ? archHits.map(c => `<button type="button" class="crow arch" data-card="${esc(c.cardId)}"><span class="cid">${esc(c.cardId)}</span><span class="crow-main"><span class="crow-title">${projTag(c.project)} ${esc(cardTitle(c))}</span></span><span class="crow-st">${archTag(c)}</span></button>`).join('') : ''}</div>` : '';
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
          <button type="button" class="crow${isMeRef(c.waitFor) ? ' me' : ''}" data-card="${esc(c.cardId)}">
            <span class="cid">${esc(c.cardId)}</span>
            <span class="crow-main"><span class="crow-title">${typeTag(c)}${projTag(c.project)} ${esc(cardTitle(c))}</span><span class="muted small">${c.next ? '下一步：' + esc(c.next) : c.status === '待整理' ? '尚未整理下一步' : '—'}</span></span>
            <span class="crow-st">${stPill(c.status)}${ownerHtml(c)}</span>
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
      <section class="wdecisions"><div class="wdec-head"><h3>決策卡</h3><span class="wcount ora">${decideMe.length}</span></div>
        <div class="dgrid">${decideMe.map(c => `
          <article class="dcard">
            <div class="dcard-top"><span class="ctype" data-ty="決策">決策</span><span class="cid">${esc(c.cardId)}</span><span class="grow"></span>
              <button type="button" class="link small" data-card="${esc(c.cardId)}">查看詳情</button></div>
            <h4>${esc(c.decision.question)}</h4>
            ${decisionBox(c)}
            ${decisionActions(c)}
          </article>`).join('')}</div></section>` : '';
  }
  // ---------- 收件匣（C-134）：要你做的＋給你知道的 ----------
  work.notes = [];
  async function loadNotes() { work.notes = (await api('/api/notifications?status=pending&limit=100')).items; }
  const ackNotes = ids => api('/api/notifications/ack', { method: 'POST', body: { notificationIds: ids } });
  // 「給你知道的」：同一則已經出現在「要你做的」的 [需確認]，不重複顯示
  const noteList = () => { const dup = new Set(legacyConfirms().map(d => d.messageId)); return work.notes.filter(n => !dup.has(n.messageId) && !cardOfConfirm({ messageId: n.messageId, title: n.preview })); };
  function notesHtml() {
    const list = noteList();
    const reason = { mention: '<span class="tag me">指定給我</span>', reply: '<span class="tag reply">回覆我</span>', all: '<span class="tag all">全體通知</span>' };
    return `<section class="wsugg"><div class="wsugg-head"><span class="wdot"></span><h3>給你知道的</h3><span class="wcount">${list.length}</span><span class="grow"></span>
        ${list.length ? '<button type="button" class="btn small" data-note-ackall>全部標為已讀</button>' : ''}</div>
      ${list.length ? list.map(n => {
        const who = state.participants.get(n.sender.participantId) || { ...n.sender, memberType: 'human' };
        return `<div class="sugg-row"><span class="ndot" aria-label="未讀"></span>${avatar(who)}
          <div class="sugg-main"><div class="sugg-top"><b>${esc(n.sender.name)}</b>${n.reasons.map(r => reason[r] || '').join('')}<span class="msg-time">${fmtTime(n.createdAt)}</span></div>
            <span class="small">${esc(n.preview)}</span></div>
          <div class="sugg-actions"><button type="button" class="btn small primary" data-note-goto="${esc(n.messageId)}" data-n="${esc(n.notificationId)}">查看</button>
            <button type="button" class="link small" data-note-ack="${esc(n.notificationId)}">已讀</button></div></div>`;
      }).join('') : '<p class="muted small">沒有需要你知道的新通知。</p>'}</section>`;
  }
  // 今日總覽（C-146 A）：每個專案一列，阻塞與跨專案頻道最新 3 則
  function todayHtml() {
    const cards = [...work.cards.values()], today = new Date().toDateString();
    const isToday = iso => !!iso && new Date(iso).toDateString() === today;
    const rows = myProjects().map(p => {
      const cs = cards.filter(c => c.project === p);
      const n = { done: cs.filter(c => c.status === '已完成' && isToday(c.done?.at)).length, doing: cs.filter(c => c.status === '進行中').length,
        blocked: cs.filter(c => c.status === '受阻').length, verify: cs.filter(c => c.status === '已完成' && !c.verified).length };
      const num = (v, cls) => (v ? `<span class="pill-tag ${cls}">${v}</span>` : '0');
      return `<tr><th scope="row">${esc(projName(p))}</th><td>${n.done}</td><td>${n.doing}</td><td>${num(n.blocked, 'red')}</td><td>${num(n.verify, 'yellow')}</td><td class="muted">—</td>
        <td><button type="button" class="link ov-enter" data-ov-enter="${esc(p)}">進入 ›</button></td></tr>`;
    }).join('');
    const blocked = cards.filter(c => c.status === '受阻' && myProjects().includes(c.project));
    const cross = state.messages.filter(m => !m.project).slice(-3);
    return `<div class="work-head"><div class="work-title"><h2>今日總覽</h2><span class="muted small">${esc(new Date().toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short' }))}</span></div></div>
      <section class="wpanel ov-table-wrap"><table class="ov-table"><thead><tr><th scope="col">專案</th><th scope="col">今日完成</th><th scope="col">進行中</th><th scope="col">受阻</th><th scope="col">待驗收</th><th scope="col">外部依賴</th><th scope="col"><span class="sr-only">進入</span></th></tr></thead><tbody>${rows}</tbody></table></section>
      <div class="ov-grid">
        <section class="wpanel"><h3>阻塞</h3>${blocked.length ? blocked.map(c => `<button type="button" class="wpanel-item" data-card="${esc(c.cardId)}"><span><span class="pill-tag red">受阻</span> ${projTag(c.project)} ${esc(c.cardId)} ${esc(cardTitle(c))}</span><span class="muted small">${c.waitFor ? '等 ' + esc(c.waitFor.name) : ''}</span></button>`).join('') : '<p class="muted small">目前沒有受阻的卡。</p>'}</section>
        <section class="wpanel"><h3>跨專案頻道（最新 3 則）</h3>${cross.length ? cross.map(m => `<button type="button" class="wpanel-item" data-ov-cross="${esc(m.messageId)}"><span>${esc(m.text.slice(0, 60))}</span><span class="muted small">${esc(m.author.name)} · ${esc(fmtTime(m.createdAt))}</span></button>`).join('') : '<p class="muted small">還沒有跨專案訊息。</p>'}
          <p class="muted small">規則公告、跨團隊協調請發在跨專案頻道（全部專案），所有人可見。</p></section>
      </div>`;
  }
  document.addEventListener('click', e => {
    const en = e.target.closest('[data-ov-enter]');
    if (en) { setProjectView(en.dataset.ovEnter); showPage('messages'); return; }
    const cr = e.target.closest('[data-ov-cross]');
    if (cr) { setProjectView('cross'); showPage('messages'); jumpTo(cr.dataset.ovCross); }
  });
  function inboxHtml() {
    const all = [...work.cards.values()].filter(cardInView);
    const open = todoCount();
    return `<div class="work-head"><div class="work-title"><h2>收件匣</h2><span class="muted small">${open ? `${open} 件要你做` : '沒有要你做的事'}</span></div></div>
      <div class="inbox-block-title">要你做的</div>
      ${todoHtml(all)}
      <div class="inbox-block-title">給你知道的</div>
      ${notesHtml()}`;
  }

  // 「待你處理」：決策卡、舊式 [需確認] 訊息、待審核的 AI 建議（C-107）
  const legacyConfirms = () => (state.team?.decisions || []).filter(d => !d.cardId && !cardOfConfirm(d) && inView(d.project));
  const todoCount = () => (state.team ? myDecisions(state.team).length : 0) + (work.sugg?.length || 0);
  function updateTodoBadge() {
    const n = todoCount();
    document.querySelectorAll('.inbox-badge').forEach(b => { b.hidden = !n; b.textContent = n > 99 ? '99+' : n; });
    if (document.querySelector('.ps-btn[aria-expanded="false"]') || !document.querySelector('.ps-btn')) drawProjSwitch(); // 下拉的件數跟著更新（開著時不重畫）
    document.title = (n ? `(${n > 99 ? '99+' : n}) ` : '') + BASE_TITLE;
  }
  function todoHtml(all) {
    const decideMe = all.filter(decidingMe);
    const confirms = legacyConfirms();
    const sg = (work.sugg || []).filter(x => inView(x.project));
    if (!decideMe.length && !confirms.length && !sg.length) return '<section class="wpanel"><p class="muted">目前沒有要你做的事。</p></section>';
    const confSection = confirms.length ? `
      <section class="wsugg"><div class="wsugg-head"><span class="wdot"></span><h3>[需確認] 訊息</h3><span class="wcount ora">${confirms.length}</span><span class="muted small">AI 發出、還沒人回覆的確認；授權列在訊息上</span></div>
        ${confirms.map(d => `<div class="sugg-row">
          <div class="sugg-main"><b>${esc(d.title || '（無標題）')}</b><span class="muted small">${esc(d.author?.name || '')} · ${agoText(d.createdAt)}${d.replyCount ? ` · 後續回覆 ${d.replyCount} 則` : ''}</span></div>
          <div class="sugg-actions"><button type="button" class="btn small primary" data-todo-jump="${esc(d.messageId)}">到訊息處理</button>
            <button type="button" class="link small" data-todo-resolve="${esc(d.messageId)}" title="已經決定了，從這裡移出">已處理</button></div>
          ${inlineHtml('m:' + d.messageId, 'confirm', d)}
        </div>`).join('')}</section>` : '';
    return decisionSectionHtml(decideMe) + confSection + suggHtml(true);
  }

  const wide = () => matchMedia('(min-width: 900px)').matches;
  function boardHtml(all) {
    const cols = wide() ? CARD_ST.filter(s => s !== '已封存' || work.showArchived) : [work.mCol];
    const tile = c => `
      <div class="ctile${isMeRef(c.waitFor) ? ' me' : ''}" role="button" tabindex="0" data-card="${esc(c.cardId)}" draggable="${wide()}">
        <div class="ctile-top"><span class="cid">${esc(c.cardId)}</span>${typeTag(c)}${c.status === '已完成' ? doneTag(c) : c.status === '已封存' ? archTag(c) : markHtml(c)}</div>
        <b class="ctile-title">${projTag(c.project)} ${esc(cardTitle(c))}</b>
        ${c.next ? `<span class="muted small">下一步：${esc(c.next)}</span>` : ''}
        ${waitText(c) ? `<span class="cwait ${isMeRef(c.waitFor) ? 'me' : c.status === '受阻' ? 'bad' : ''}">${esc(waitText(c))}</span>` : ''}
        <div class="ctile-foot">${ownerHtml(c)}<span class="muted small">${shortTime(c.updatedAt).split(' ')[0]}</span></div>
      </div>`;
    const mini = c => `<button type="button" class="cmini" data-card="${esc(c.cardId)}" draggable="${wide()}"><span class="cid">${esc(c.cardId)}</span><span class="cmini-t">${projTag(c.project)} ${esc(cardTitle(c))}</span><span class="muted small">${esc(mmdd(c.verified?.at || c.done?.at || c.updatedAt))}</span>${doneTag(c)}</button>`;
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
        : `<div class="wchips" role="group" aria-label="狀態">${CARD_ST.map(st => `<button type="button" data-mcol="${esc(st)}" aria-pressed="${work.mCol === st}"${st === '已封存' ? ' class="dashed"' : ''}>${mLabel(st)}<span>${st === '已封存' ? work.archived.count : all.filter(c => c.status === st).length}</span></button>`).join('')}</div>`}
      <div class="board">
        ${cols.map(s => {
          const list = all.filter(c => c.status === s);
          return `<section class="bcol" data-col="${esc(s)}" aria-label="${esc(s)}">
            <div class="bcol-head"><span class="wdot" data-st="${esc(s)}"></span><b>${esc(s)}</b>${s === '已完成' ? '<span class="small ok-text">最近 7 天</span>' : ''}<span class="wcount">${s === '已封存' ? work.archived.count : list.length}</span></div>
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
    if (na) { try { await ackNotes([na.dataset.noteAck]); await loadNotes(); renderWork(); } catch (err) { toast(err.message); } return; }
    if (t.closest('[data-note-ackall]')) { try { const ids = noteList().map(n => n.notificationId); for (let i = 0; i < ids.length; i += 100) await ackNotes(ids.slice(i, i + 100)); await loadNotes(); renderWork(); toast('已全部標為已讀'); } catch (err) { toast(err.message); } return; }
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
    try { d = await api(`/api/cards/${encodeURIComponent(id)}`); } catch (err) { return toast(err.message); }
    if (trigger) work.returnFocus = trigger;
    rememberLinks(d);
    work.cards.set(id, { ...d, log: undefined, messageIds: undefined });
    const reopen = work.openId === id && $('#card-drawer');
    work.openId = id; work.detail = d;
    if (!reopen) work.editing = false;
    renderDrawer(!reopen);
  }
  const canHandover = d => d.type !== '決策' && !closedSt(d.status) && d.owner && (state.me.memberType === 'human' || d.owner.participantId === meId());
  // 交接歷程：從紀錄裡「交接 A → B：說明」整理成 PO → UX → PG
  function handoverChain(d) {
    const hs = [...(d.log || [])].reverse().map(l => /^交接 (.+?) → (.+?)：/.exec(l.text)).filter(Boolean);
    if (!hs.length) return '';
    const names = [hs[0][1], ...hs.map(m => m[2])];
    return `<div class="handover-chain"><span class="muted small">交接歷程</span> ${names.map(n => `<b>${esc(n)}</b>`).join(' → ')}</div>`;
  }
  function openHandover() {
    const d = work.detail;
    const people = [...state.participants.values()].filter(p => p.status !== 'disabled' && p.participantId !== d.owner?.participantId && (p.projects || []).includes(d.project));
    const body = openModal('交接卡片', `
      <form id="handover-form" class="stack">
        <div class="info-box">${esc(d.cardId)} ${esc(cardTitle(d))}<br>交接後負責人換成對方，狀態回到「待處理」，並在群組 @ 對方通知。</div>
        <label>交給誰<select name="toId" required>${people.map(p => `<option value="${esc(p.participantId)}">${esc(p.name)}${p.role ? '（' + esc(p.role) + '）' : ''}</option>`).join('')}</select></label>
        <label>交接說明（必填）<textarea name="note" rows="3" required maxlength="300" placeholder="我做完了什麼、希望對方接著做什麼"></textarea></label>
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
  // 在訊息頁的桌面版，抽屜與訊息並排（不遮住訊息）；手機與工作頁維持原本的遮罩／底部面板
  const dockedMode = () => state.page === 'messages' && matchMedia('(min-width: 900px)').matches;
  function renderDrawer(focus) {
    const d = work.detail;
    const people = [...state.participants.values()].filter(p => p.status !== 'disabled');
    const opts = (cur, none) => `<option value="">${none}</option>` + people.map(p => `<option value="${esc(p.participantId)}" ${cur === p.participantId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    const mine = d.done && isMeRef(d.done.by);
    const msgs = (d.messageIds || []).map(mid => {
      const m = state.byId.get(mid);
      return `<button type="button" class="dmsg" data-jump-msg="${esc(mid)}">${m ? `<b>${esc(m.author.name)}</b> <span class="muted small">${shortTime(m.createdAt)}</span><span class="dmsg-text">${esc(m.text.slice(0, 120))}</span>` : `<span class="muted small">較早的訊息 ${esc(shortId(mid))}</span>`}</button>`;
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
          <div class="drawer-titles"><span class="cid">${esc(d.cardId)}</span>${typeTag(d)}${projTag(d.project)}<h2 id="drawer-title">${esc(cardTitle(d))}</h2>
            <span class="muted small">建立 ${shortTime(d.createdAt)} · ${esc(d.createdBy?.name || '')}</span></div>
          <button class="icon-btn modal-x" type="button" data-close-drawer aria-label="關閉">×</button>
        </div>
        <div class="drawer-body">
          <div class="drawer-status">
            <label class="dst">狀態<select id="d-status">${CARD_ST.map(s => `<option ${s === d.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
            ${!closedSt(d.status) ? '<button class="btn small" type="button" data-act="done">標為已完成</button>' : ''}
            ${canHandover(d) ? '<button class="btn small" type="button" data-act="handover">交接</button>' : ''}
            ${d.status === '已完成' && !d.verified ? `<button class="btn small primary" type="button" data-act="verify" ${mine ? 'disabled title="完成者不能自己驗證"' : ''}>標為已驗證</button>` : ''}
          </div>
          ${d.status === '已封存' ? (() => {
            const sys = (d.log || []).find(l => /^系統自動封存/.test(l.text));
            const why = sys ? `${mmdd(sys.at)} 系統自動封存（${mmdd(d.verified?.at || d.done?.at || sys.at)} 驗證完成，滿 ${ARCHIVE_DAYS} 天）。` : `${mmdd(d.updatedAt)} 已封存。`;
            return `<div class="arch-note" role="status">${why}內容和紀錄都還在，只是不在看板與 AI 預設查詢裡。
              <div class="row"><button class="btn small" type="button" data-act="reopen">重新打開（改回待處理）</button></div>
              <span class="muted small">重新打開後照一般卡片流程；再次完成＋驗證後重新計 ${ARCHIVE_DAYS} 天。</span></div>`;
          })() : ''}
          ${d.status === '已完成' && doneTag(d) ? `<div class="dmarks">${doneTag(d)}<span class="muted small">${d.verified ? '已驗證：明天會自動收進已封存' : pendingDays(d) > ARCHIVE_DAYS ? '超過 7 天沒驗證，請驗證或退回' : '待驗證的卡不會自動收起'}</span></div>` : ''}
          ${d.done || d.verified ? `<div class="dmarks">
            ${d.done ? `<span class="cmark ok-bg">已完成 · ${esc(d.done.by?.name || '')} · ${shortTime(d.done.at)}</span>` : ''}
            ${d.verified ? `<span class="cmark ver-bg">已驗證 · ${esc(d.verified.by?.name || '')} · ${shortTime(d.verified.at)}</span>` : ''}
            ${mine && !d.verified ? '<span class="muted small">你是完成者，需由其他人或其他 AI 驗證。</span>' : ''}
          </div>` : ''}
          ${d.staleHint ? `<div class="stale-note" role="status"><b>可能過時</b><span class="small">卡片最後更新 ${esc(shortTime(d.staleHint.lastUpdatedAt))}，但之後 ${esc(shortTime(d.staleHint.latestMessageAt))} 有新的相關訊息。</span>${d.staleHint.latestMessageId ? `<button type="button" class="link small" data-stale-jump="${esc(d.staleHint.latestMessageId)}">看最新訊息</button>` : ''}</div>` : ''}
          ${handoverChain(d)}
          ${d.type === '決策' && d.decision ? `<section class="ddecision"><h3>決策</h3><p class="dq">${esc(d.decision.question)}</p>${decisionBox(d)}${decisionStatus(d)}</section>` : ''}
          ${work.editing ? `
          <form id="card-edit" class="stack">
            <label>標題<input name="title" required maxlength="100" value="${esc(d.title)}"></label>
            ${d.type === '決策' ? '' : `<label>類型<select name="type">${['工作', '阻塞'].map(t => `<option ${d.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`}
            ${d.type === '決策' && !d.decision?.result ? `
            <label>決策問題<input name="question" required maxlength="200" value="${esc(d.decision.question)}"></label>
            <label>建議方案<textarea name="recommendation" rows="2" maxlength="500">${esc(d.decision.recommendation)}</textarea></label>
            <label>選項<textarea name="options" rows="2" placeholder="每行一個，最多 4 個；留白＝「同意」">${esc((d.decision.options || []).join('\n'))}</textarea></label>
            <label>影響<input name="impact" maxlength="200" value="${esc(d.decision.impact)}"></label>
            <label>決定後<input name="afterNext" maxlength="300" value="${esc(d.decision.afterNext)}"></label>
            <label>決策者<select name="deciderId">${[...state.participants.values()].filter(p => p.memberType === 'human' && p.status !== 'disabled').map(p => `<option value="${esc(p.participantId)}" ${d.decision.decider?.participantId === p.participantId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>` : ''}
            <label>專案<select name="project">${PROJECTS.map(p => `<option value="${esc(p)}" ${d.project === p ? 'selected' : ''}>${esc(projName(p))}</option>`).join('')}</select></label>
            <label>原因<textarea name="reason" rows="2" maxlength="500">${esc(d.reason)}</textarea></label>
            <label>負責人<select name="ownerId">${opts(d.owner?.participantId, '未指派')}</select></label>
            <label>下一步<textarea name="next" rows="2" maxlength="300">${esc(d.next)}</textarea></label>
            <label>阻塞<input name="blocker" maxlength="300" value="${esc(d.blocker)}"></label>
            <label>等誰<select name="waitForId">${opts(d.waitFor?.participantId, '不用等人')}</select></label>
            <label>完成條件<textarea name="criteria" rows="2" maxlength="500">${esc(d.criteria)}</textarea></label>
            <div class="row end"><button class="btn" type="button" data-act="cancel-edit">取消</button><button class="btn primary" type="submit">儲存</button></div>
          </form>` : `
          <dl class="dfields">
            <dt>專案</dt><dd>${esc(projName(d.project) || '')}</dd>
            <dt>原因</dt><dd class="${d.reason ? '' : 'muted'}">${esc(d.reason || '未填寫')}</dd>
            <dt>負責人</dt><dd>${ownerHtml(d)}</dd>
            <dt>下一步</dt><dd class="${d.next ? '' : 'muted'}">${esc(d.next || '未填寫')}</dd>
            <dt>阻塞與等誰</dt><dd class="${waitText(d) ? '' : 'muted'}">${esc(waitText(d) || '沒有阻塞')}</dd>
            <dt>完成條件</dt><dd class="${d.criteria ? '' : 'muted'}">${esc(d.criteria || '未填寫')}</dd>
          </dl>
          <div><button class="btn small" type="button" data-act="edit">編輯</button></div>`}
          <div class="group-title">相關訊息 · ${(d.messageIds || []).length}</div>
          ${msgs || '<p class="muted small">還沒有關聯訊息。</p>'}
          ${!(d.type === '決策' && decidingMe(d) && !d.decision?.result) ? `<div class="group-title">想法與回覆</div>${inlineHtml('k:' + d.cardId, 'card', d)}` : ''}
          <div class="group-title">紀錄</div>
          <ol class="dlog">${d.log.map(l => `<li><span class="ldot ${l.via === 'API' ? 'api' : ''}"></span><div><span>${esc(l.text)}</span><span class="muted small">${esc(l.by?.name || '')} · ${shortTime(l.at)} · ${esc(l.via)}</span></div></li>`).join('')}</ol>
        </div>
        ${state.page === 'messages' ? `<div class="drawer-foot"><button class="btn primary" type="button" data-act="open-work">在工作頁開啟</button><button class="btn" type="button" data-act="copy-id">複製卡號</button></div>` : ''}
      </aside>`;
    host.querySelector('#card-edit')?.addEventListener('submit', async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target));
      for (const k of Object.keys(data)) data[k] = data[k].trim();
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
    const j = e.target.closest('[data-jump-msg]');
    if (j) { const id = j.dataset.jumpMsg; if (!(state.page === 'messages' && dockedMode())) { closeCard(); showPage('messages'); } return jumpTo(id); }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const id = work.openId;
    if (a.dataset.act === 'open-work') { work.returnFocus = null; closeCard(); showPage('work'); return openCard(id); }
    if (a.dataset.act === 'copy-id') return copyText(id).then(ok => toast(ok ? `已複製 ${id}` : '複製失敗'));
    if (a.dataset.act === 'handover') return openHandover();
    if (a.dataset.act === 'edit') { work.editing = true; renderDrawer(false); work.detail && $('#card-edit [name=title]')?.focus(); }
    else if (a.dataset.act === 'cancel-edit') { work.editing = false; renderDrawer(false); }
    else if (a.dataset.act === 'done') patchCard(id, { status: '已完成' });
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
    const opts = none => `<option value="">${none}</option>` + people.map(p => `<option value="${esc(p.participantId)}">${esc(p.name)}</option>`).join('');
    const body = openModal(sg ? '編輯後採用建議' : srcMsg ? '從訊息建立卡片' : '新增卡片', `
      <form id="card-new-form" class="stack">
        ${srcMsg ? `<div class="info-box">來源訊息「${esc(srcMsg.author.name)} · ${shortTime(srcMsg.createdAt)}」會自動關聯到這張卡，無法移除。</div>` : ''}
        ${sg ? `<div class="warn-box">${esc(sg.from?.name || 'AI')} 的建議：${esc(sg.why)}</div>` : ''}
        <div class="field"><span class="field-label" id="nt-label">類型</span>
          <div class="seg-scope full" role="group" aria-labelledby="nt-label">
            <button type="button" data-nt="工作" aria-pressed="true">工作</button><button type="button" data-nt="阻塞" aria-pressed="false">阻塞</button><button type="button" data-nt="決策" aria-pressed="false">決策</button>
          </div><input type="hidden" name="type" value="工作"></div>
        <label>標題<input name="title" required maxlength="100" placeholder="一句話說明要做什麼"></label>
        <label>專案（必填）<select name="project" required ${singleProject() ? 'disabled' : ''}>${singleProject() ? '' : '<option value="">請選擇專案</option>'}${myProjects().map(p => `<option value="${esc(p)}" ${(srcMsg?.project || projectView()) === p ? 'selected' : ''}>${esc(projName(p))}</option>`).join('')}</select></label>
        <div id="nc-decision" class="stack" hidden>
          <label>決策問題<input name="question" maxlength="200" placeholder="留白＝同標題"></label>
          <label>建議方案<textarea name="recommendation" rows="2" maxlength="500" placeholder="你建議怎麼做、為什麼"></textarea></label>
          <label>選項<textarea name="options" rows="2" placeholder="每行一個，最多 4 個；留白＝「同意」"></textarea>
            <span class="field-hint">決策者另外一定能選「不同意」「要求補充」。</span></label>
          <div class="two-col">
            <label>影響<input name="impact" maxlength="200" placeholder="例如：UX、PG"></label>
            <label>決策者<select name="deciderId">${people.filter(p => p.memberType === 'human').map(p => `<option value="${esc(p.participantId)}" ${p.participantId === meId() ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
          </div>
          <label>決定後<input name="afterNext" maxlength="300" placeholder="決定後下一步是什麼"></label>
        </div>
        <label>原因<textarea name="reason" rows="2" maxlength="500" placeholder="為什麼要做"></textarea></label>
        <div class="two-col">
          <label>負責人<select name="ownerId">${opts('未指派')}</select></label>
          <label>狀態<select name="status">${['待整理', '待處理', '進行中'].map(s => `<option>${s}</option>`).join('')}</select></label>
        </div>
        <label>下一步<textarea name="next" rows="2" maxlength="300"></textarea></label>
        <label>完成條件<textarea name="criteria" rows="2" maxlength="500"></textarea></label>
        <label>等誰<select name="waitForId">${opts('不用等人')}</select></label>
        <p class="muted small">卡片內容所有成員都看得到，請勿填入內部路徑、程式碼或客戶個資。</p>
        <p class="error" id="card-new-error" role="alert"></p>
      </form>`, {
      size: 'form',
      foot: '<button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit" form="card-new-form">建立卡片</button>',
    });
    const form = body.querySelector('#card-new-form');
    body.querySelectorAll('[data-nt]').forEach(b => b.addEventListener('click', () => {
      form.type.value = b.dataset.nt;
      body.querySelectorAll('[data-nt]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      const t = b.dataset.nt;
      form.status.disabled = t !== '工作'; // 阻塞固定為受阻、決策固定為待確認
      body.querySelector('#nc-decision').hidden = t !== '決策';
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
        toast(`已建立 ${c.cardId}`);
        openCard(c.cardId);
      } catch (err) { body.querySelector('#card-new-error').textContent = err.message; }
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
      <textarea class="inl-text" rows="2" maxlength="1500" data-q-text="${id}" placeholder="想說什麼都可以寫在這裡（Ctrl+Enter 只送意見）" aria-label="輸入想法">${esc(q.text)}</textarea>
      <div class="inl-actions"><button type="button" class="btn small primary" data-q-send data-qm="${id}" ${q.busy || !q.text.trim() ? 'disabled' : ''}>${q.busy ? '送出中…' : '只送意見'}</button>
        <button type="button" class="btn small" data-q-hold data-qm="${id}" ${q.busy ? 'disabled' : ''}>暫緩處理</button></div>
      ${q.error ? `<p class="error small" role="alert">送出失敗：${esc(q.error)}（內容還在，可以再試一次）</p>` : ''}</div>`;
    }
    const qs = parseQuestions(m.text);
    const id = esc(m.messageId);
    const missing = qs.filter((_, i) => !q.sels[i]).length, picked = qs.length - missing;
    const sendLabel = !qs.length ? '同意照辦' : missing ? `還有 ${missing} 題未選` : qs.length > 1 ? `送出 ${qs.length} 題回覆` : `選 ${esc(q.sels[0])} 並送出`;
    const qBlock = (qq, i) => {
      const long = qq.opts.some(o => o.label.length > 16);
      const head = qs.length > 1 || qq.named ? `<div class="q-title" id="qt-${id}-${i}">問題${qq.no}${qq.title ? '　' + esc(qq.title) : ''}${picked && !q.sels[i] ? ' <span class="pill-tag yellow">未選</span>' : ''}</div>` : '';
      return `<div class="q-group" role="radiogroup" ${head ? `aria-labelledby="qt-${id}-${i}"` : 'aria-label="選項"'}>${head}
        <div class="q-opts${long ? ' vertical' : ''}">${qq.opts.map(o => `<button type="button" class="btn q-opt" role="radio" aria-checked="${q.sels[i] === o.key}" data-q-opt="${esc(o.key)}" data-qi="${i}" data-qm="${id}"><b>${esc(o.key)}</b><span>${esc(o.label)}</span></button>`).join('')}</div></div>`;
    };
    return `<div class="auth-row quick" data-q-root="${id}">
      ${qs.map(qBlock).join('')}
      <textarea class="inl-text" rows="2" maxlength="1500" data-q-text="${id}" placeholder="想說什麼都可以寫在這裡（Ctrl+Enter 送出）" aria-label="輸入想法">${esc(q.text)}</textarea>
      <div class="inl-actions">
        <button type="button" class="btn small primary" data-q-send data-qm="${id}" ${q.busy || missing ? 'disabled' : ''}>${q.busy ? '送出中…' : sendLabel}</button>
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
        else onNewMessage(await api('/api/messages', { method: 'POST', body: { text: `[回覆] ${dcard.cardId}（決策意見）：${q.text.trim()}`, requestId: newRequestId(), replyToMessageId: id, cardId: dcard.cardId, recipientIds: [m.author.participantId] } }));
        quickMap.delete(id); refreshMsg(id);
        toast(kind === 'hold' ? '已暫緩，決策卡已移出收件匣' : '已送出');
        await Promise.all([loadTeam().catch(() => {}), syncCards().catch(() => {})]); updateTodoBadge();
      } catch (err) { q.busy = false; q.error = err.message; refreshMsg(id); }
      return;
    }
    const qs = parseQuestions(m.text);
    if (kind === 'send' && qs.some((_, i) => !q.sels[i])) return;
    const picks = qs.length === 1 && !qs[0].named ? `選 ${q.sels[0]}` : qs.map((qq, i) => `問題${qq.no} 選 ${q.sels[i]}`).join('；');
    const head = kind === 'hold' ? '暫緩處理' : qs.length ? picks : '同意照辦';
    const text = `[回覆] ${head}${q.text.trim() ? '。' + q.text.trim() : ''}`;
    q.busy = true; q.error = ''; refreshMsg(id);
    try {
      const r = await api('/api/messages', { method: 'POST', body: { text, requestId: newRequestId(), replyToMessageId: id, recipientIds: [m.author.participantId] } });
      quickMap.delete(id);
      onNewMessage(r); refreshMsg(id);
      toast('已送出');
      loadTeam().catch(() => {});
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

  function authHtml(m) {
    if (!myAiMsg(m)) return '';
    const text = m.text, mineR = repliesOf(m.messageId).filter(isMine);
    const pend = authPending.get(m.messageId);
    const rows = [];
    // Push 授權列只給「程式開發（PG）AI 發的 [需確認]」；[完成]／[進度]／[通知] 就算含完整 SHA 也不顯示（C-140：事後會被誤按成再授權一次）
    const authorPG = (state.participants.get(m.author.participantId) || m.author).roleKey === 'PG';
    const pushAsk = authorPG && /^\s*\[需確認\]/.test(text);
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
      const sent = mineR.find(r => /^\[回覆\] (同意 commit|同意照辦|暫緩處理|選 [A-F①-⑥]|問題\d+ 選 [A-F①-⑥])/.test(r.text));
      const answered = sent || repliesOf(m.messageId).some(r => !isMine(r) && poRole(r));
      const isPG = (state.participants.get(m.author.participantId) || m.author).roleKey === 'PG'; // Commit 授權只給程式開發 AI 的 [需確認]
      const hasCommit = isPG && /commit/i.test(text);
      if (sent) rows.push(`<div class="auth-row sent"><b>已回覆 · ${shortTime(sent.createdAt)}</b><span class="muted small">${esc(sent.text.slice(5, 40))}</span></div>`);
      else if (pend && pend.key === 'need') rows.push(authConfirm(m, pend));
      else if (!answered) rows.push(hasCommit
        ? `<div class="auth-row"><span class="auth-title">授權 Commit</span>${authBtn(m, 'commit', '同意 Commit')}</div>`
        : quickHtml(m));
    }
    return rows.length ? `<div class="auth-box">${rows.join('')}</div>` : '';
  }
  function refreshMsg(id) {
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
      api('/api/messages', { method: 'POST', body: { text: p.text, requestId: p.requestId, replyToMessageId: id, recipientIds: [m.author.participantId] } })
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
  const TAGS = [['接單', '說明理解的範圍'], ['進度', ''], ['完成', ''], ['需確認', ''], ['受阻', ''], ['交接', ''], ['回覆', '']];
  const tagMenu = $('#tag-menu');
  let tagIdx = null; // null＝關閉
  const leadTagOf = v => (v.match(/^\s*\[([^\]\n]{1,40})\]/) || [])[1];
  function openTagMenu() {
    const cur = TAGS.findIndex(t => t[0] === leadTagOf(input.value));
    tagIdx = cur >= 0 ? cur : 0;
    renderTagMenu();
  }
  function renderTagMenu() {
    const cur = leadTagOf(input.value);
    tagMenu.innerHTML = TAGS.map(([t, hint], i) => `
      <li role="option" data-i="${i}" aria-selected="${cur === t}" class="${i === tagIdx ? 'active' : ''}">[${t}]${cur === t ? '<span class="small">目前選取</span>' : hint ? `<span class="muted small">${hint}</span>` : ''}</li>`).join('');
    tagMenu.hidden = false;
    $('#tag-btn').setAttribute('aria-expanded', 'true');
  }
  function closeTagMenu() { tagIdx = null; tagMenu.hidden = true; $('#tag-btn').setAttribute('aria-expanded', 'false'); }
  function pickTag(i) {
    let v = input.value;
    v = v.replace(/^\s*\[[^\]\n]{0,40}\]?\s?/, ''); // 已有標籤（或只打了一半）就取代
    input.value = `[${TAGS[i][0]}] ` + v;
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
  const openers = { team: openTeamHub, members: openMembers, 'my-ai': openMyAi, inbox: openInbox, files: openFiles, api: openApi, settings: openSettings, qr: openQr, 'proj-admin': () => openProjAdmin() };
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
  $('#presence-pill').addEventListener('click', openMembers);

  // ---------- 團隊狀態 ----------
  const STATE_LABEL = { working: '進行中', idle: '空閒', blocked: '卡住', waiting: '等人決定', todo: '待處理' };
  // 「等你決定」：訊息型的所有人都看；決策卡只給指定的決策者看
  const myDecisions = t => t.decisions.filter(d => (!d.cardId && !cardOfConfirm(d)) || d.deciderId === meId());
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
    const abnormal = t.members.filter(mb => ['yellow', 'red'].includes(health(mb).cls));
    document.querySelectorAll('.presence-alert').forEach(el => { el.hidden = !abnormal.length; el.title = abnormal.length ? '需要注意：' + abnormal.map(mb => `${mb.name}（${health(mb).text}）`).join('、') : ''; });
    const mdec = myDecisions(t);
    updateTodoBadge();
    // 收件匣開著時，團隊狀態更新（例如新的 [需確認]）也要反映；正在輸入時不重畫，避免失去焦點
    if (state.page === 'inbox' && work.loaded && !document.activeElement?.matches?.('[data-inl-text]')) renderWork();
    const dec = '';
    bar.innerHTML = dec + chips;
    bar.hidden = false;
    // 側欄已無團隊狀態區（C-141）：有人卡住／可能斷線時，「團隊」選單旁亮小紅點
    document.querySelectorAll('.nav-parent').forEach(el => el.toggleAttribute('data-alert', abnormal.length > 0));
  }
  for (const el of [$('#team-bar')]) el.addEventListener('click', e => { if (e.target.closest('[data-team]')) openTeam(); });

  // AI 工作記憶（C-108）：AI 自己回報的目前任務與待辦；只在狀態改變時更新，依專案可見
  const stagePill = st => {
    const k = /受阻|卡住/.test(st) ? 'red' : /待確認|等/.test(st) ? 'amber' : 'blue';
    return `<span class="spill spill-${k}">${esc(st)}</span>`;
  };
  function aiStateHtml(t) {
    const ais = t.members.filter(m => m.memberType === 'ai');
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
        <div>${ct ? `${ct.stage ? stagePill(ct.stage) : ''} <span>${esc(ct.title)}</span>${ct.cardId ? ` <button type="button" class="link small" data-open-card="${esc(ct.cardId)}">${esc(ct.cardId)}</button>` : ''}` : '<span class="muted">目前沒有進行中的任務</span>'}${m.stale ? '<br><span class="small warn-text">以下是最後同步的狀態，可能已變動。</span>' : ''}</div>
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
    const rows = t.members.filter(mb => pv === 'all' || pv === 'cross' || (state.participants.get(mb.participantId)?.projects || []).includes(pv)).map(mb => {
      const h = health(mb);
      const tokenCls = mb.tokenExpired ? 'bad' : mb.tokenExpiringSoon ? 'warn' : '';
      return `<div class="tm-row">
        <div class="tm-who"><span class="dot h-${h.cls}"></span><div><b>${esc(mb.name)}</b><span class="muted small">${esc(mb.role || '')}${mb.memberType === 'ai' ? ' · AI' : ''}</span></div></div>
        <div class="tm-conn"><span class="tm-health h-${h.cls}">${h.text}</span><span class="muted small">最後上線 ${agoText(mb.lastSeenAt)}</span></div>
        <div class="tm-state">${mb.status ? `<span class="st st-${mb.status.state}">${STATE_LABEL[mb.status.state]}</span> <button type="button" class="link" ${mb.status.cardId ? `data-open-card="${esc(mb.status.cardId)}"` : `data-jump-team="${esc(mb.status.messageId)}"`}>${esc(mb.status.title || '（無標題）')}</button>${mb.status.cardCount > 1 ? `<span class="muted small"> · 共 ${mb.status.cardCount} 張</span>` : ''}${mb.status.source === 'card' ? '<span class="muted small"> · 取自卡片</span>' : ''}` : '<span class="muted">—</span>'}</div>
        <div class="tm-pend muted small">${mb.pendingCount ? `待處理 ${mb.pendingCount} 則 · 最久 ${agoText(mb.oldestPendingAt).replace('前', '')}` : '待處理 0'}</div>
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
    const items = await loadParticipants();
    const online = items.filter(p => p.isOnline).length;
    const body = openModal('成員名單', `
      <input id="member-q" type="search" placeholder="搜尋姓名、角色或代碼" aria-label="搜尋成員">
      <div id="member-list"></div>`, { sub: `${items.length} 人 · 近期活躍 ${online} · 燈號是 30 秒內的活動估計，不是即時連線。` });
    const row = p => {
      const self = p.participantId === meId();
      const line2 = p.memberType === 'ai'
        ? [`#${p.shortCode}`, 'AI', p.ownerName ? `所屬 ${p.ownerName}` : '', p.environment].filter(Boolean).join(' · ')
        : [`#${p.shortCode}`, '人類', p.environment].filter(Boolean).join(' · ');
      return `<div class="mem-row">
        ${avatarDot(p)}
        <div class="mem-main">
          <div class="mem-name"><b>${esc(p.name)}</b><span class="muted small">${esc(p.role || '')}</span></div>
          <div class="muted small">${esc(line2)}</div>
          ${p.duties ? `<div class="mem-duty muted small">${esc(p.duties)}</div>` : ''}
        </div>
        ${self ? '<span class="self">本人</span>' : `<button class="btn small" type="button" data-mention="${esc(p.name)}">@ 提及</button>`}
      </div>`;
    };
    const draw = () => {
      const q = body.querySelector('#member-q').value.trim().toLowerCase();
      const list = [...state.participants.values()]
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

  async function openMyAi() {
    const body = openModal('我的 AI', `
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
        } else if (b.dataset.act === 'token') {
          if (ai.tokenExpired) return toast('Token 已過期，請先按「重發 Token」');
          toast((await copyText(ai.token)) ? '已複製 Token' : '複製失敗，請手動複製');
        } else if (b.dataset.act === 'edit') {
          openAiForm(ai);
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
            <div class="member-name"><b>${esc(ai.name)}</b>${statusTag}</div>
            <div class="member-sub">${esc([ai.role, '#' + ai.shortCode, ai.environment].filter(Boolean).join(' · '))}
              <span class="ai-online"><span class="dot ${ai.isOnline ? 'on' : ''}"></span>${ai.isOnline ? '在線' : '離線／閒置'}</span></div>
            <div class="member-sub ${active && level ? 'warn-text' : ''}">Token 到期：${ai.expiresAt ? fmtTime(ai.expiresAt) : '—'}</div>
          </div>
        </div>
        <div class="row actions">
          ${!active ? `<button class="btn" type="button" data-act="enable" data-id="${id}">重新啟用</button>`
            : expired ? `<button class="btn primary" type="button" data-act="reissue" data-id="${id}">重發 Token</button>`
            : `<button class="btn primary" type="button" data-act="token" data-id="${id}">只複製 Token</button>
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
          ${active ? `
          <div class="row actions">
            <button class="btn small" type="button" data-act="copy" data-id="${id}">複製完整接入設定</button>
            <button class="btn small" type="button" data-act="edit" data-id="${id}">編輯</button>
            <button class="btn small danger-outline" type="button" data-act="disable" data-id="${id}" title="立即撤銷：Token 馬上失效，AI 無法再讀寫">停用（撤銷）</button>
          </div>
          <p class="muted small">接入設定與 Token 都是此 AI 的存取憑證，請只貼到自己的 AI 對話。</p>` : ''}
          <div class="row actions"><button class="btn small danger-outline" type="button" data-act="delete" data-id="${id}" title="永久刪除：不可復原，歷史訊息保留並標已刪除">刪除</button></div>
          <p class="muted small">版本 v${ai.version} · 更新時間 ${fmtTime(ai.updatedAt)}</p>
        </div>` : ''}
      </div>`;
  }

  // 角色範本：常用的排前面，其餘收進「其他角色」群組（只是選單分組，角色定義不變；既有成員的角色照常顯示已選）
  const COMMON_ROLES = ['PO', 'SM', 'BA', 'UX', 'PG', 'QA', 'custom'];
  function roleOptionsHtml(roles) {
    const opt = r => `<option value="${r.key}">${esc(r.option)}</option>`;
    const common = COMMON_ROLES.map(k => roles.find(r => r.key === k)).filter(Boolean);
    const other = roles.filter(r => !COMMON_ROLES.includes(r.key));
    return common.map(opt).join('') + (other.length ? `<optgroup label="其他角色">${other.map(opt).join('')}</optgroup>` : '');
  }
  async function openAiForm(ai) {
    const { items: roles, fields, environments = [] } = await loadRoles();
    const editing = !!ai;
    const envKeys = environments.map(e => e.key);
    const cur = editing ? (ai.environment || '') : '';
    const envOpts = [...envKeys, ...(cur && !envKeys.includes(cur) ? [cur] : []), ''];
    const body = openModal(editing ? '編輯 AI 助手' : '新增 AI 助手', `
      <form id="ai-form" class="stack">
        <label>角色範本
          <select name="roleKey">${roleOptionsHtml(roles)}</select>
          <span class="field-hint" id="role-hint">選取後自動預填下方六題，可再修改。</span>
        </label>
        ${editing ? '' : `<div class="field"><span class="field-label">所屬專案（至少選一個）</span>
          <div class="proj-row new-ai-proj">${myProjects().map(p => `<label class="chk"><input type="checkbox" name="proj" value="${esc(p)}" ${myProjects().length === 1 ? 'checked' : ''}> ${esc(projName(p))}</label>`).join('') || '<span class="muted small">你還沒有加入任何專案，請群組管理員把你加入專案。</span>'}</div></div>`}
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
        ${fields.map(f => `<label class="ta-field"><span class="ta-head"><span>${esc(f.label)}</span><span class="counter" data-count="${f.key}">0/1000</span></span><textarea name="${f.key}" rows="4" required maxlength="1000"></textarea></label>`).join('')}
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
      const r = await avatarDialog({ title: '更換 AI 頭像', isAi: true, fallback: autoText(), cur });
      if (!r || r.kind === 'keep') return;
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
      body.querySelector('#role-hint').textContent = editing ? '切換範本會覆蓋下方六題內容（名稱不變）。' : '選取後自動預填下方六題，可再修改。';
      return roles.find(r => r.key === key);
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
    form.roleKey.addEventListener('change', () => {
      const r = roleHint(form.roleKey.value);
      const autoName = `${state.me.name}的${r.suffix}`;
      // 名稱若還是自動產生的就一起換；使用者改過就保留
      const keepName = editing || form.name.value !== lastAutoName;
      const env = form.environment.value;
      fill({ ...r, name: autoName }, !keepName);
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
      if (!editing) {
        data.projects = [...form.querySelectorAll('input[name="proj"]:checked')].map(i => i.value);
        if (!data.projects.length) return toast('請至少選一個所屬專案');
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
        await openMyAi();
        toast(editing ? '已儲存' : '已建立。按「只複製 Token」或在詳細設定裡複製完整接入設定給你的 AI');
      } catch (err) { body.querySelector('#ai-error').textContent = err.message; }
    });
  }

  // 通知收件匣
  // 收件匣：有新訊息通知時更新（徽章只算「要你做的」，由 updateTodoBadge 負責；在收件匣頁時順便更新「給你知道的」）
  async function refreshInboxCount() {
    try {
      if (state.page === 'inbox') { await loadNotes(); renderWork(); }
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
      const d = await api('/api/notifications?status=pending&limit=100');
      ids = d.items.map(n => n.notificationId);
      body.modal.querySelector('#inbox-sub').textContent = d.items.length ? `${d.items.length}${d.hasMore ? '+' : ''} 則待處理` : '沒有待處理的通知';
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
          <span class="muted small">${fmtBytes(f.size)} · 到期 ${fmtTime(f.expiresAt)} · SHA-256 ${esc(f.sha256.slice(0, 12))}…</span>
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
      list.innerHTML = st.items.map((p, i) => `<li role="option" data-i="${i}" aria-selected="${i === st.index}"><span class="dot ${p.isOnline ? 'on' : ''}"></span><b>${esc(p.name)}</b><span class="muted small">${esc(p.role || '')}</span>${p.memberType === 'ai' ? '<span class="tag ai">AI</span>' : ''}</li>`).join('');
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
      <label>附註<span class="field-hint">選填，可用 @ 指定對象</span><div class="input-wrap"><ul id="up-mention" class="mention-list" role="listbox" hidden></ul><textarea id="up-note" rows="3" maxlength="1500" placeholder="例如：@劉昱志的程式開發助手 這是今天的會議紀錄"></textarea></div></label>
      <label class="declare-box"><input type="checkbox" id="up-declare"><span>我確認此檔案不含任何程式碼（原始碼、打包檔、設定檔）與客戶個資</span></label>
      <p class="error" id="up-error" role="alert"></p>`}`, problem ? {} : {
      foot: `<button class="btn" type="button" data-close>取消</button>
             <button class="btn primary" type="button" id="up-go" disabled>上傳</button>`,
    });
    body.querySelector('.up-preview')?.addEventListener('load', () => URL.revokeObjectURL(previewUrl));
    if (problem) { if (previewUrl) URL.revokeObjectURL(previewUrl); return; }
    attachMention(body.querySelector('#up-note'), body.querySelector('#up-mention'));
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
          box.innerHTML = a.items.length ? `<div class="table-scroll"><table class="audit-table"><thead><tr><th>時間</th><th>動作</th><th>操作者</th><th>檔名</th><th>大小</th><th>SHA-256</th><th>聲明</th><th>備註</th></tr></thead><tbody>${
            a.items.map(x => `<tr><td>${fmtTime(x.at)}</td><td>${label[x.action] || x.action}</td>
              <td>${esc(x.actor.name || x.actor.participantId || '')}${x.actor.memberType === 'ai' ? '（AI）' : x.actor.memberType === 'human' ? '（人類）' : ''}</td>
              <td>${esc(x.name || '')}</td><td>${x.size == null ? '' : fmtBytes(x.size)}</td>
              <td>${x.sha256 ? esc(x.sha256.slice(0, 12)) + '…' : ''}</td><td>${x.declared == null ? '' : x.declared ? '✓' : '✗'}</td>
              <td>${esc(x.detail || '')}</td></tr>`).join('')}</tbody></table></div>` : '沒有紀錄。';
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
    const body = openModal('API 資訊', `
      <div class="kv-field"><span class="field-label">API Base URL</span>
        <div class="copy-row"><code class="val">${esc(base)}</code><button class="btn small" type="button" data-copy="${esc(base)}">複製</button></div></div>
      <div class="kv-field"><span class="field-label">本人 participantId</span>
        <div class="copy-row"><code class="val">${esc(meId())}</code><button class="btn small" type="button" data-copy="${esc(meId())}">複製</button></div></div>
      <div class="kv-field"><span class="field-label">本人 Token（登入用）</span>
        <div class="copy-row"><code class="val" id="my-token">••••••••••••</code><button class="btn small" type="button" id="tok-show">顯示</button><button class="btn small" type="button" id="tok-copy">複製</button></div></div>
      <div class="warn-box red">這是你本人的 Token，等同登入密碼：在其他裝置選「用 Token 登入」貼上即可用同一身分登入。不要給 AI 用；AI 請到「我的 AI」建立專屬身分。</div>
      <div class="group-title">主要端點</div>
      <ul class="endpoints">
        ${ep('GET', '/api/me', '自身身分')}
        ${ep('GET', '/api/participants', '有效成員與在線狀態')}
        ${ep('GET', '/api/messages?limit=50&amp;after=&lt;nextCursor&gt;', '增量讀取訊息')}
        ${ep('GET', '/api/messages/:messageId', '單則訊息')}
        ${ep('POST', '/api/messages', '發文（text、requestId、recipientIds、replyToMessageId、audience）')}
        ${ep('GET', '/api/notifications?status=pending&amp;limit=50', '待處理通知')}
        ${ep('GET', '/api/notifications/count', '未讀通知數')}
        ${ep('POST', '/api/notifications/ack', '確認通知（notificationIds）')}
        ${ep('POST', '/api/files?name=&amp;declared=true', '上傳文件（原始位元組）')}
        ${ep('GET', '/api/files', '文件清單；/api/files/:id 下載')}
      </ul>
      <p><a href="/api/docs/ai-integration" target="_blank" rel="noopener">完整規格：AI 代理人接入通訊協定指南</a></p>
      <div class="group-title">快速測試</div>
      <code class="block">curl -H "Authorization: Bearer &lt;TOKEN&gt;" ${esc(base)}/api/me</code>`);
    body.querySelector('#tok-show').onclick = () => { body.querySelector('#my-token').textContent = state.token; };
    body.querySelector('#tok-copy').onclick = async () => toast((await copyText(state.token)) ? '已複製' : '複製失敗');
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
        <p class="muted small">新專案一開始只有你與跨專案角色（PO、SM），其他成員請在成員清單勾選加入。</p>
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
          pm.sel = r.id; toast('已新增專案，你和 PO、SM 已加入');
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
  function promptName(title, value) {
    return new Promise(resolve => {
      const host = document.createElement('div');
      host.className = 'confirm-root';
      host.innerHTML = modalFrame({ title, size: 'narrow', body: `<label class="field"><span class="field-label">專案名稱</span><input id="pn-input" maxlength="20" value="${esc(value)}"></label>`,
        foot: '<button class="btn" type="button" data-pn="0">取消</button><button class="btn primary" type="button" data-pn="1">確定</button>' });
      document.body.appendChild(host);
      const input = host.querySelector('#pn-input');
      input.focus(); input.select();
      const done = ok => { const v = input.value.trim(); host.remove(); resolve(ok ? v : null); };
      host.addEventListener('click', e => { const b = e.target.closest('[data-pn]'); if (b) done(b.dataset.pn === '1'); else if (e.target === host.firstElementChild || e.target.closest('[data-close]')) done(false); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) done(true); if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
    });
  }
  function openSettings() {
    const theme = store.get(THEME_KEY) || 'system';
    const body = openModal('進階設定', `
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
        <p class="muted small">單一專案成員只看自己專案與「全部專案」的訊息與卡片。所屬專案由群組管理員（${esc(state.projMeta.adminName || '')}）在「設定 ▸ 專案管理」調整，這裡只能看。</p>
        <div class="proj-rows">${projMineHtml()}</div>
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

  // QR Code：在另一台裝置登入同一身分
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.append(s);
    });
  }
  async function openQr() {
    const link = `${location.origin}/?login=${encodeURIComponent(state.token)}`;
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
  if (params.get('login')) {
    store.set(TOKEN_KEY, params.get('login'));
    history.replaceState(null, '', '/');
  }
  state.token = store.get(TOKEN_KEY);
  if (state.token) start().catch(() => { store.del(TOKEN_KEY); state.token = null; showJoin(); });
  else showJoin();
})();
