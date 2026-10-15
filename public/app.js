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
  async function api(path, { method = 'GET', body } = {}) {
    const r = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
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
    showPage(store.get(PAGE_KEY) === 'work' ? 'work' : 'messages');
  }

  async function loadParticipants() {
    const d = await api('/api/participants');
    state.participants = new Map(d.items.map(p => [p.participantId, p]));
    const online = d.items.filter(p => p.isOnline).length;
    document.querySelectorAll('.presence-text').forEach(el => { el.textContent = `${d.items.length} 人在群 · 近期活躍 ${online}`; });
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
    const word = { expired: '已過期', '2h': '2 小時內到期', '24h': '24 小時內到期' };
    box.className = 'token-alert' + (mine.some(x => x.level !== '24h') ? ' urgent' : '');
    const key = mine.map(x => x.p.participantId + x.level).join();
    if (state.tokenAlertDismissed === key) { box.hidden = true; return; }
    box.innerHTML = `<span class="token-alert-text">你的 AI ${mine.map(x => `「${esc(x.p.name)}」Token ${word[x.level]}（${fmtTime(x.p.expiresAt)}）`).join('、')}，到期後 AI 會停止連線。</span>
      <button type="button" class="btn alert-btn">重發 Token</button>
      <button type="button" class="icon-btn alert-close" aria-label="關閉提醒">×</button>`;
    box.querySelector('.alert-btn').onclick = () => openMyAi();
    box.querySelector('.alert-close').onclick = () => { state.tokenAlertDismissed = key; box.hidden = true; };
  }

  // 輪詢：前景每 3 秒拉新訊息，背景分頁放慢到 15 秒；成員與通知數每 15 秒更新
  let pollTimer = null;
  let lastSlowPoll = 0;
  let lastTeamPoll = 0;
  function connectEvents() {
    clearTimeout(pollTimer);
    const tick = async () => {
      if (!state.token) return;
      await catchUp();
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
      pollTimer = setTimeout(tick, document.hidden ? 60_000 : 5_000);
    };
    pollTimer = setTimeout(tick, 5_000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.me) connectEvents(); });

  let catching = false;
  async function catchUp() {
    if (!state.token || !state.nextCursor || catching) return;
    catching = true;
    try {
      for (let i = 0; i < 5; i++) {
        const d = await api(`/api/messages?limit=100&after=${encodeURIComponent(state.nextCursor)}`);
        d.items.forEach(onNewMessage);
        state.nextCursor = d.nextCursor;
        if (!d.hasMore) break;
      }
    } catch {} finally { catching = false; }
  }

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
            <div class="msg-line1"><span class="msg-author">${esc(a.name)}</span><time class="msg-time" datetime="${esc(m.createdAt)}" title="seq ${m.sequence}">${fmtTime(m.createdAt)}</time></div>
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
  function visible(m) {
    const f = state.filter;
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
  }
  function setFilter(patch) {
    Object.assign(state.filter, patch);
    state.onlyMine = state.filter.scope === 'related';
    store.set(FILTER_KEY, state.onlyMine ? '1' : '0');
    syncFilterBar();
    renderMessages(true);
  }
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
  const input = $('#input');
  const sendBtn = $('#send');
  const mentionList = $('#mention-list');
  let mentionState = null;

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight + 2, window.innerHeight * 0.4) + 'px';
  }

  function updateMention() {
    const pos = input.selectionStart;
    const m = input.value.slice(0, pos).match(/@([^\s@]*)$/);
    if (!m) return closeMention();
    const q = m[1].toLowerCase();
    const items = [ALL, ...[...state.participants.values()].filter(p => p.participantId !== meId())]
      .filter(p => !q || p.name.toLowerCase().includes(q) || (p.role || '').toLowerCase().includes(q))
      .slice(0, 8);
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
        body: { text, requestId: pendingRequestId, replyToMessageId: state.replyTo?.messageId, ...resolveRecipients(text) },
      });
      pendingRequestId = null;
      onNewMessage(m);
      input.value = '';
      setReply(null);
      onInput();
    } catch (err) {
      if (err.code === 'IDEMPOTENCY_CONFLICT' || err.code === 'INVALID_REQUEST') pendingRequestId = null;
      toast('送出失敗：' + err.message);
    } finally {
      sending = false;
      sendBtn.disabled = !input.value.trim();
    }
  }
  input.addEventListener('input', () => { pendingRequestId = null; });

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
  function openModal(title, bodyHtml, opts = {}) {
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
  function confirmDialog({ title, message, confirmText = '確認', danger = false }) {
    return new Promise(resolve => {
      const prev = document.activeElement;
      const host = document.createElement('div');
      host.className = 'confirm-root';
      host.innerHTML = modalFrame({
        title, size: 'narrow',
        body: `<div class="confirm-msg${danger ? ' danger' : ''}">${message}</div>`,
        foot: `<button class="btn" type="button" data-close>取消</button>
               <button class="btn ${danger ? 'danger' : 'primary'}" type="button" data-ok>${esc(confirmText)}</button>`,
      });
      document.body.append(host);
      const overlay = host.firstElementChild;
      const done = ok => { host.remove(); if (prev?.isConnected) prev.focus(); resolve(ok); };
      overlay.addEventListener('click', e => {
        if (e.target.closest('[data-ok]')) return done(true);
        if (e.target === overlay || e.target.closest('[data-close]')) done(false);
      });
      overlay.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
      overlay.querySelector('[data-ok]').focus();
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
    view: store.get(VIEW_KEY) === 'B' ? 'B' : 'A', q: '', owner: '', type: '', filter: 'open', mCol: '進行中',
    showArchived: false, openId: null, detail: null, editing: false, dragId: null,
  };
  const isMeRef = r => r && r.participantId === meId();
  const closedSt = s => s === '已完成' || s === '已封存';
  const stPill = s => `<span class="cst" data-st="${esc(s)}">${esc(s)}</span>`;
  const typeTag = c => (c.type !== '工作' ? `<span class="ctype" data-ty="${esc(c.type)}">${esc(c.type)}</span>` : '');
  const waitText = c => (c.waitFor ? `等 ${isMeRef(c.waitFor) ? '你' : c.waitFor.name}${c.blocker ? '：' + c.blocker : ''}` : c.blocker || '');
  const markHtml = c => (c.verified ? '<span class="cmark ok">✓ 已驗證</span>' : c.done ? '<span class="cmark wait">待驗證</span>' : '');
  const shortTime = iso => fmtTime(iso).replace(/^\d{4}\//, '').replace(/(\d\d:\d\d):\d\d$/, '$1');
  function ownerHtml(c) {
    if (!c.owner) return '<span class="cowner none">未指派</span>';
    const p = state.participants.get(c.owner.participantId) || c.owner;
    return `<span class="cowner">${avatar(p)}<span>${esc(c.owner.name)}</span></span>`;
  }

  const optionsOf = c => (c.decision?.options?.length ? c.decision.options : ['同意']);
  // 這張決策卡現在是在等「我」做決定
  const decidingMe = c => c.type === '決策' && c.status === '待確認' && !c.decision?.result && c.decision?.decider?.participantId === meId() && isMeRef(c.waitFor);
  work.note = null; // { id, kind: '不同意' | '要求補充', text }
  function decisionActions(c) {
    if (work.note && work.note.id === c.cardId) {
      const n = work.note;
      return `<label class="dnote">${n.kind === '不同意' ? '不同意的原因' : '需要補充什麼'}
          <textarea rows="2" maxlength="500" data-note-text>${esc(n.text)}</textarea></label>
        <div class="row end"><button type="button" class="btn small" data-note-cancel>取消</button>
          <button type="button" class="btn small primary" data-note-submit="${esc(c.cardId)}" ${n.text.trim() ? '' : 'disabled'}>${n.kind === '不同意' ? '送出不同意' : '送出要求'}</button></div>`;
    }
    return `<div class="dactions">
      ${optionsOf(c).map((o, i) => `<button type="button" class="btn small ${i === 0 ? 'ok' : ''}" data-decide="${esc(c.cardId)}" data-result="${esc(o)}">${esc(o)}</button>`).join('')}
      <button type="button" class="btn small" data-note-open="${esc(c.cardId)}" data-kind="不同意">不同意</button>
      <button type="button" class="btn small" data-note-open="${esc(c.cardId)}" data-kind="要求補充">要求補充</button></div>`;
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
    if (decidingMe(c)) return decisionActions(c);
    if (c.status !== '待確認') return '';
    const who = c.waitFor?.name || d.decider?.name;
    return `<p class="muted small">${c.waitFor && c.waitFor.participantId !== d.decider?.participantId ? `已請 ${esc(who)} 補充後，再回到 ${esc(d.decider?.name || '決策者')} 決定。` : `等 ${esc(who)} 決定。`}</p>`;
  }

  async function loadCards() {
    const d = await api('/api/cards?include=archived&limit=200');
    work.cards = new Map(d.items.map(c => [c.cardId, c]));
    work.since = d.nextSince;
    work.loaded = true;
    work.lastSync = Date.now();
    await loadSuggestions();
  }
  async function loadSuggestions() {
    work.sugg = (await api('/api/suggestions?state=pending')).items;
  }
  // 增量同步：只讀上次之後有變動的卡片
  async function syncCards() {
    if (!work.loaded) return;
    work.lastSync = Date.now();
    const [d, sg] = await Promise.all([api('/api/cards?since=' + encodeURIComponent(work.since || '')), api('/api/suggestions?state=pending')]);
    const suggChanged = JSON.stringify(sg.items.map(x => x.suggestionId)) !== JSON.stringify((work.sugg || []).map(x => x.suggestionId));
    work.sugg = sg.items;
    if (!d.items.length && !suggChanged) return;
    for (const c of d.items) work.cards.set(c.cardId, c);
    if (d.items.length) work.since = d.nextSince;
    renderWork();
    if (state.page === 'messages' && d.items.length) { const box = $('#messages'), top = box.scrollTop; renderMessages(false); box.scrollTop = top; }
    if (work.openId && d.items.some(c => c.cardId === work.openId) && !work.editing) openCard(work.openId);
  }

  // AI 建議區塊
  function suggHtml() {
    const list = work.sugg || [];
    if (!list.length) return '';
    const what = g => (g.kind === 'create'
      ? `建立${g.create.type}卡片「${esc(g.create.title)}」，負責人 ${esc(g.create.owner?.name || '未指派')}`
      : `${esc(g.card?.cardId || '')} ${esc(g.card?.title || '')} 狀態改為「${esc(g.to)}」${g.waitFor ? `，等 ${esc(g.waitFor.name)}` : ''}`);
    return `<section class="wsugg"><div class="wsugg-head"><span class="wdot sg"></span><h3>AI 建議</h3><span class="wcount pur">${list.length}</span><span class="muted small">由你採用後才會建立或更新卡片</span></div>
      ${list.map(g => `<div class="sugg-row">
        <div class="sugg-main"><div class="sugg-top"><span class="sgk">${g.kind === 'create' ? '建立卡片' : '更新狀態'}</span><span class="muted small">${esc(g.from?.name || '')}</span></div>
          <b>${what(g)}</b><span class="small">${esc(g.why)}</span>
          ${g.basisMessageId ? `<button type="button" class="link small" data-sugg-basis="${esc(g.basisMessageId)}">看依據訊息</button>` : ''}</div>
        <div class="sugg-actions">
          <button type="button" class="btn small primary" data-sugg-apply="${esc(g.suggestionId)}">採用</button>
          ${g.kind === 'create' ? `<button type="button" class="btn small" data-sugg-edit="${esc(g.suggestionId)}">編輯後採用</button>` : ''}
          <button type="button" class="link small" data-sugg-skip="${esc(g.suggestionId)}">略過</button></div>
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

  function showPage(page) {
    if (work.openId) closeCard();
    state.page = page === 'work' ? 'work' : 'messages';
    store.set(PAGE_KEY, state.page);
    $('#page-messages').hidden = state.page !== 'messages';
    $('#page-work').hidden = state.page !== 'work';
    document.querySelectorAll('[data-nav]').forEach(b => {
      if (b.dataset.nav === state.page) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (state.page === 'work') {
      (work.loaded ? Promise.resolve() : loadCards()).then(renderWork).catch(err => toast(err.message));
    } else scrollBottom();
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
      (!work.type || c.type === work.type)
      && (!work.owner || c.owner?.participantId === work.owner)
      && (!q || [c.title, c.next, c.cardId].some(v => (v || '').toLowerCase().includes(q))))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function renderWork() {
    const box = $('#page-work');
    if (state.page !== 'work' || !work.loaded) return;
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
      ${work.view === 'A' ? overviewHtml(all) : boardHtml(all)}`;
    if (keep === 'card-q') { const q = $('#card-q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  }

  function overviewHtml(all) {
    const decideMe = all.filter(decidingMe);
    const waitMe = all.filter(c => isMeRef(c.waitFor) && !closedSt(c.status) && !decidingMe(c));
    const blocked = all.filter(c => c.status === '受阻');
    const done = all.filter(c => c.status === '已完成');
    const panel = (title, cls, list, empty, meta) => `
      <section class="wpanel ${cls}${list.length ? ' has' : ''}">
        <div class="wpanel-head"><span class="wdot"></span><b>${title}</b><span class="wcount">${list.length}</span></div>
        ${list.length ? list.slice(0, 3).map(c => `<button type="button" class="wpanel-item" data-card="${esc(c.cardId)}"><span>${esc(c.title)}</span><span class="muted small">${esc(meta(c))}</span></button>`).join('')
          : `<p class="muted small">${empty}</p>`}
        ${list.length > 3 ? `<button type="button" class="link small" data-filter="${cls === 'done' ? '已完成' : cls === 'blocked' ? '受阻' : 'open'}">查看全部 ${list.length} 張</button>` : ''}
      </section>`;
    const chips = [['open', '未完成', all.filter(c => !closedSt(c.status)).length], ...CARD_ST.map(s => [s, s, all.filter(c => c.status === s).length])];
    const listed = all.filter(c => (work.filter === 'open' ? !closedSt(c.status) : c.status === work.filter));
    const decSection = decideMe.length ? `
      <section class="wdecisions"><div class="wdec-head"><h3>待你決定</h3><span class="wcount ora">${decideMe.length}</span></div>
        <div class="dgrid">${decideMe.map(c => `
          <article class="dcard">
            <div class="dcard-top"><span class="ctype" data-ty="決策">決策</span><span class="cid">${esc(c.cardId)}</span><span class="grow"></span>
              <button type="button" class="link small" data-card="${esc(c.cardId)}">查看詳情</button></div>
            <h4>${esc(c.decision.question)}</h4>
            ${decisionBox(c)}
            ${decisionActions(c)}
          </article>`).join('')}</div></section>` : '';
    return `
      ${decSection}
      ${suggHtml()}
      <div class="wpanels">
        ${panel('等你處理', 'mine', waitMe, '目前沒有等你處理的卡片。', c => `${c.status} · ${c.owner?.name || '未指派'}`)}
        ${panel('受阻', 'blocked', blocked, '沒有受阻的卡片。', c => waitText(c) || '未填寫阻塞原因')}
        ${panel('最近完成', 'done', done, '最近沒有完成的卡片。', c => `${c.verified ? '已驗證' : '待驗證'} · ${c.done?.by?.name || ''} · ${shortTime(c.done?.at || c.updatedAt)}`)}
      </div>
      <div class="wchips" role="group" aria-label="依狀態篩選">
        ${chips.map(([v, label, n]) => `<button type="button" data-filter="${esc(v)}" aria-pressed="${work.filter === v}">${label}<span>${n}</span></button>`).join('')}
      </div>
      <div class="crows">
        ${listed.length ? listed.map(c => `
          <button type="button" class="crow${isMeRef(c.waitFor) ? ' me' : ''}" data-card="${esc(c.cardId)}">
            <span class="cid">${esc(c.cardId)}</span>
            <span class="crow-main"><span class="crow-title">${typeTag(c)}${esc(c.title)}</span><span class="muted small">${c.next ? '下一步：' + esc(c.next) : c.status === '待整理' ? '尚未整理下一步' : '—'}</span></span>
            <span class="crow-st">${stPill(c.status)}${ownerHtml(c)}</span>
            <span class="crow-wait small ${isMeRef(c.waitFor) ? 'me' : c.status === '受阻' ? 'bad' : ''}">${esc(waitText(c) || '—')}</span>
            <span class="crow-time muted small">${shortTime(c.updatedAt)}${markHtml(c)}</span>
          </button>`).join('') : '<p class="muted">沒有符合條件的卡片。</p>'}
      </div>`;
  }

  const wide = () => matchMedia('(min-width: 900px)').matches;
  function boardHtml(all) {
    const cols = wide() ? CARD_ST.filter(s => s !== '已封存' || work.showArchived) : [work.mCol];
    const tile = c => `
      <div class="ctile${isMeRef(c.waitFor) ? ' me' : ''}" role="button" tabindex="0" data-card="${esc(c.cardId)}" draggable="${wide()}">
        <div class="ctile-top"><span class="cid">${esc(c.cardId)}</span>${typeTag(c)}${markHtml(c)}</div>
        <b class="ctile-title">${esc(c.title)}</b>
        ${c.next ? `<span class="muted small">下一步：${esc(c.next)}</span>` : ''}
        ${waitText(c) ? `<span class="cwait ${isMeRef(c.waitFor) ? 'me' : c.status === '受阻' ? 'bad' : ''}">${esc(waitText(c))}</span>` : ''}
        <div class="ctile-foot">${ownerHtml(c)}<span class="muted small">${shortTime(c.updatedAt).split(' ')[0]}</span></div>
      </div>`;
    return `
      ${wide() ? `<div class="board-tools"><button type="button" class="link small" id="toggle-archived">${work.showArchived ? '隱藏已封存' : '顯示已封存'}</button><span class="muted small">拖曳卡片到其他欄可以改狀態</span></div>`
        : `<div class="wchips" role="group" aria-label="狀態">${CARD_ST.map(s => `<button type="button" data-mcol="${esc(s)}" aria-pressed="${work.mCol === s}">${s}<span>${all.filter(c => c.status === s).length}</span></button>`).join('')}</div>`}
      <div class="board">
        ${cols.map(s => {
          const list = all.filter(c => c.status === s);
          return `<section class="bcol" data-col="${esc(s)}" aria-label="${esc(s)}">
            <div class="bcol-head"><span class="wdot" data-st="${esc(s)}"></span><b>${esc(s)}</b><span class="wcount">${list.length}</span></div>
            <div class="bcol-list">${list.length ? list.map(tile).join('') : `<p class="muted small bempty">${wide() ? '拖曳卡片到這裡' : '這個狀態沒有卡片'}</p>`}</div>
          </section>`;
        }).join('')}
      </div>`;
  }

  // 互動
  const workBox = $('#page-work');
  workBox.addEventListener('input', decisionInput);
  workBox.addEventListener('click', e => {
    if (decisionClick(e)) return;
    const t = e.target;
    const v = t.closest('[data-view]');
    if (v) { work.view = v.dataset.view; store.set(VIEW_KEY, work.view); return renderWork(); }
    const f = t.closest('[data-filter]');
    if (f) { work.filter = f.dataset.filter; work.view = 'A'; return renderWork(); }
    const sa = t.closest('[data-sugg-apply]');
    if (sa) return void suggAction(sa.dataset.suggApply, 'apply');
    const ss = t.closest('[data-sugg-skip]');
    if (ss) return void suggAction(ss.dataset.suggSkip, 'skip');
    const se = t.closest('[data-sugg-edit]');
    if (se) return openNewCard((work.sugg || []).find(x => x.suggestionId === se.dataset.suggEdit));
    const sb = t.closest('[data-sugg-basis]');
    if (sb) { const id = sb.dataset.suggBasis; showPage('messages'); return void jumpTo(id); }
    const mc = t.closest('[data-mcol]');
    if (mc) { work.mCol = mc.dataset.mcol; return renderWork(); }
    if (t.closest('#toggle-archived')) { work.showArchived = !work.showArchived; return renderWork(); }
    if (t.closest('#card-new')) return openNewCard();
    const c = t.closest('[data-card]');
    if (c) openCard(c.dataset.card);
  });
  workBox.addEventListener('keydown', e => {
    const c = e.target.closest?.('.ctile');
    if (c && e.key === 'Enter') openCard(c.dataset.card);
  });
  workBox.addEventListener('input', e => { if (e.target.id === 'card-q') { work.q = e.target.value; renderWork(); } });
  workBox.addEventListener('change', e => {
    if (e.target.id === 'card-owner') { work.owner = e.target.value; renderWork(); }
    if (e.target.id === 'card-type') { work.type = e.target.value; renderWork(); }
  });
  // 看板拖曳（桌面）
  workBox.addEventListener('dragstart', e => {
    const c = e.target.closest?.('.ctile');
    if (!c) return;
    work.dragId = c.dataset.card;
    e.dataTransfer.setData('text/plain', c.dataset.card);
    e.dataTransfer.effectAllowed = 'move';
    c.classList.add('dragging');
  });
  workBox.addEventListener('dragend', () => { work.dragId = null; workBox.querySelectorAll('.bcol.over').forEach(x => x.classList.remove('over')); });
  workBox.addEventListener('dragover', e => {
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
    const t = e.target;
    const dc = t.closest('[data-decide]');
    if (dc) { decideCard(dc.dataset.decide, dc.dataset.result, ''); return true; }
    const open = t.closest('[data-note-open]');
    if (open) { work.note = { id: open.dataset.noteOpen, kind: open.dataset.kind, text: '' }; refreshDecisionUi(); return true; }
    if (t.closest('[data-note-cancel]')) { work.note = null; refreshDecisionUi(); return true; }
    const sub = t.closest('[data-note-submit]');
    if (sub && work.note?.text.trim()) { decideCard(sub.dataset.noteSubmit, work.note.kind, work.note.text.trim()); return true; }
    return false;
  }
  function decisionInput(e) {
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
    const people = [...state.participants.values()].filter(p => p.status !== 'disabled' && p.participantId !== d.owner?.participantId);
    const body = openModal('交接卡片', `
      <form id="handover-form" class="stack">
        <div class="info-box">${esc(d.cardId)} ${esc(d.title)}<br>交接後負責人換成對方，狀態回到「待處理」，並在群組 @ 對方通知。</div>
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
          <div class="drawer-titles"><span class="cid">${esc(d.cardId)}</span>${typeTag(d)}<h2 id="drawer-title">${esc(d.title)}</h2>
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
          ${d.done || d.verified ? `<div class="dmarks">
            ${d.done ? `<span class="cmark ok-bg">已完成 · ${esc(d.done.by?.name || '')} · ${shortTime(d.done.at)}</span>` : ''}
            ${d.verified ? `<span class="cmark ver-bg">已驗證 · ${esc(d.verified.by?.name || '')} · ${shortTime(d.verified.at)}</span>` : ''}
            ${mine && !d.verified ? '<span class="muted small">你是完成者，需由其他人或其他 AI 驗證。</span>' : ''}
          </div>` : ''}
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
            <label>原因<textarea name="reason" rows="2" maxlength="500">${esc(d.reason)}</textarea></label>
            <label>負責人<select name="ownerId">${opts(d.owner?.participantId, '未指派')}</select></label>
            <label>下一步<textarea name="next" rows="2" maxlength="300">${esc(d.next)}</textarea></label>
            <label>阻塞<input name="blocker" maxlength="300" value="${esc(d.blocker)}"></label>
            <label>等誰<select name="waitForId">${opts(d.waitFor?.participantId, '不用等人')}</select></label>
            <label>完成條件<textarea name="criteria" rows="2" maxlength="500">${esc(d.criteria)}</textarea></label>
            <div class="row end"><button class="btn" type="button" data-act="cancel-edit">取消</button><button class="btn primary" type="submit">儲存</button></div>
          </form>` : `
          <dl class="dfields">
            <dt>原因</dt><dd class="${d.reason ? '' : 'muted'}">${esc(d.reason || '未填寫')}</dd>
            <dt>負責人</dt><dd>${ownerHtml(d)}</dd>
            <dt>下一步</dt><dd class="${d.next ? '' : 'muted'}">${esc(d.next || '未填寫')}</dd>
            <dt>阻塞與等誰</dt><dd class="${waitText(d) ? '' : 'muted'}">${esc(waitText(d) || '沒有阻塞')}</dd>
            <dt>完成條件</dt><dd class="${d.criteria ? '' : 'muted'}">${esc(d.criteria || '未填寫')}</dd>
          </dl>
          <div><button class="btn small" type="button" data-act="edit">編輯</button></div>`}
          <div class="group-title">相關訊息 · ${(d.messageIds || []).length}</div>
          ${msgs || '<p class="muted small">還沒有關聯訊息。</p>'}
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
      if (form.status.disabled) delete data.status;
      if (data.type !== '決策') for (const k of ['question', 'recommendation', 'options', 'impact', 'deciderId', 'afterNext']) delete data[k];
      else { delete data.waitForId; if (!data.options) data.options = []; else data.options = data.options.split('\n'); }
      if (!data.ownerId) delete data.ownerId;
      if (!data.waitForId) delete data.waitForId;
      try {
        const c = sg ? await api(`/api/suggestions/${encodeURIComponent(sg.suggestionId)}/apply`, { method: 'POST', body: { title: data.title, reason: data.reason, ownerId: data.ownerId ?? null, next: data.next, criteria: data.criteria, type: data.type, waitForId: data.waitForId ?? null } })
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
  function authHtml(m) {
    if (!myAiMsg(m)) return '';
    const text = m.text, mineR = repliesOf(m.messageId).filter(isMine);
    const pend = authPending.get(m.messageId);
    const rows = [];
    const shas = [...new Set(text.match(SHA40) || [])];
    for (const sha of shas) {
      const sent = mineR.find(r => r.text.includes('同意 push：' + sha));
      if (sent) rows.push(`<div class="auth-row sent"><b>已授權 Push · ${shortTime(sent.createdAt)}</b><span class="muted small">僅限 ${sha.slice(0, 7)}…${sha.slice(-4)}</span></div>`);
      else if (pend && pend.key === 'push:' + sha) rows.push(authConfirm(m, pend));
      else rows.push(`<div class="auth-row"><span class="auth-title">授權此 SHA（${sha.slice(0, 7)}…${sha.slice(-4)}）</span>${authBtn(m, 'push', '同意 Push', sha)}</div>`);
    }
    if (!shas.length && /push/i.test(text) && /\b(?=[0-9a-f]*\d)[0-9a-f]{7,39}\b/.test(text) && !mineR.some(r => /同意 push/.test(r.text))) {
      rows.push('<div class="auth-row hint">訊息沒有完整 40 碼 SHA，無法一鍵授權 push。請要求 AI 補上，或手動回覆。</div>');
    }
    if (!shas.length && /^\s*\[需確認\]/.test(text)) {
      const sent = mineR.find(r => /^\[回覆\] (同意 commit|同意照辦|暫緩處理)/.test(r.text));
      const answered = sent || repliesOf(m.messageId).some(r => !isMine(r) && poRole(r));
      const hasCommit = /commit/i.test(text);
      if (sent) rows.push(`<div class="auth-row sent"><b>已回覆 · ${shortTime(sent.createdAt)}</b><span class="muted small">${esc(sent.text.slice(5, 40))}</span></div>`);
      else if (pend && pend.key === 'need') rows.push(authConfirm(m, pend));
      else if (!answered) rows.push(hasCommit
        ? `<div class="auth-row"><span class="auth-title">授權 Commit</span>${authBtn(m, 'commit', '同意 Commit')}</div>`
        : `<div class="auth-row">${authBtn(m, 'ok', '同意照辦', '', true)}${authBtn(m, 'hold', '暫緩處理', '', true)}</div>`);
    }
    return rows.length ? `<div class="auth-box">${rows.join('')}</div>` : '';
  }
  function refreshMsg(id) {
    const el = document.getElementById('msg-' + id);
    if (el && state.byId.has(id)) el.outerHTML = messageHtml(state.byId.get(id));
    document.getElementById('msg-' + id)?.querySelector('[data-auth-send]')?.focus();
  }
  function authClick(e) {
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

  const openers = { members: openMembers, 'my-ai': openMyAi, inbox: openInbox, files: openFiles, api: openApi, settings: openSettings, qr: openQr };
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
  const myDecisions = t => t.decisions.filter(d => !d.cardId || d.deciderId === meId());
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
    if (!t) { bar.hidden = true; $('#team-list').innerHTML = ''; return; }
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
    const dec = mdec.length ? `<button type="button" class="chip decide" data-team>等你決定 ${mdec.length}</button>` : '';
    bar.innerHTML = dec + chips;
    bar.hidden = false;
    // 側欄：兩行清單（名稱／最後上線 · 環境），狀態靠右
    const rows = t.members.map(mb => {
      const h = health(mb);
      const st = mb.status ? STATE_LABEL[mb.status.state] : '';
      const sub = [mb.memberType === 'ai' || !mb.isOnline ? (h.cls === 'green' || h.cls === 'grey' ? agoText(mb.lastSeenAt) : h.text) : '在線', mb.environment].filter(Boolean).join(' · ');
      return `<button type="button" class="team-row h-${h.cls}" data-team title="${esc(mb.status ? `${st}：${mb.status.title}` : mb.name)}">
        <span class="dot"></span><span class="team-row-main"><b>${esc(mb.name)}</b><span>${esc(sub)}</span></span>
        ${st ? `<span class="st st-${mb.status.state}">${st}</span>` : ''}
      </button>`;
    }).join('');
    $('#team-list').innerHTML = (mdec.length ? `<button type="button" class="decide-row" data-team><span>等你決定</span><b>${mdec.length}</b></button>` : '') + rows;
  }
  for (const el of [$('#team-bar'), $('#team-list'), $('.side-title')]) el.addEventListener('click', e => { if (e.target.closest('[data-team]')) openTeam(); });

  async function openTeam() {
    await loadTeam();
    const t = state.team;
    if (!t) return toast('無法取得團隊狀態');
    const rows = t.members.map(mb => {
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
        <p>有負責未完成卡片的人，取自卡片（受阻 > 待確認 > 進行中 > 待處理，並標「取自卡片」）；沒有卡片的人，依最新一則訊息的開頭標籤推斷：[接單]／[進度]＝進行中，[完成]／[回覆]／[交接]＝空閒，[受阻]＝卡住，[需確認]＝等人決定。沒照標籤發文時可能不準。AI 超過 ${t.staleMinutes} 分鐘沒出現會標示「可能斷線」（用 watcher 待命的 AI 放寬到 60 分鐘，並顯示「待命中」）；指派超過 ${t.unansweredMinutes} 分鐘沒讀取會列入「尚未回應」。</p>
      </details>
      <div class="group-title">等你決定 · ${myDecisions(t).length}</div>
      ${myDecisions(t).length ? myDecisions(t).map(d => `
        <div class="note-card yellow">
          <div class="note-main"><button type="button" class="link strong" ${d.cardId ? `data-open-card="${esc(d.cardId)}"` : `data-jump-team="${esc(d.messageId)}"`}>${esc(d.title || '（無標題）')}</button>
            <span class="muted small">${esc(d.author.name)} · ${agoText(d.createdAt)}${d.replyCount ? ` · 後續回覆 ${d.replyCount} 則` : ''}</span></div>
          ${d.cardId ? `<button type="button" class="btn small" data-open-card="${esc(d.cardId)}">去決定</button>` : `<button type="button" class="btn small" data-resolve="${esc(d.messageId)}" title="已經決定了，從清單移出">已處理</button>`}
        </div>`).join('') : '<p class="muted small">目前沒有待決定的事項。</p>'}
      ${t.unanswered.length ? `<div class="group-title">尚未回應的指派 · ${t.unanswered.length}</div>
        ${t.unanswered.map(u => `<div class="note-card red">
          <div class="note-main"><span><b>${esc(u.name)}</b> <span class="red-text">· 已等 ${agoText(u.since).replace('前', '')}</span></span></div>
          <button type="button" class="link small" data-jump-team="${esc(u.messageId)}">查看訊息</button></div>`).join('')}` : ''}
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
          toast('已從「等你決定」移出');
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
      <div id="ai-list" class="stack"></div>`, { sub: '每位 AI 有獨立身分、專屬 Token 與通知收件匣。' });
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
          const { text } = await api(`/api/my-ais/${ai.participantId}/onboarding`);
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
        } else if (b.dataset.act === 'enable') {
          await api(`/api/my-ais/${ai.participantId}/enable`, { method: 'POST' });
          await draw();
        }
      } catch (err) { toast(err.message); }
    });
    await draw();
  }

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
      const { text } = await api(`/api/my-ais/${ai.participantId}/onboarding`);
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
          <p class="muted small">版本 v${ai.version} · 更新時間 ${fmtTime(ai.updatedAt)}</p>
        </div>` : ''}
      </div>`;
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
          <select name="roleKey">${roles.map(r => `<option value="${r.key}">${esc(r.option)}</option>`).join('')}</select>
          <span class="field-hint" id="role-hint">選取後自動預填下方六題，可再修改。</span>
        </label>
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
      for (const [k, v] of Object.entries(data)) data[k] = v.trim();
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
  async function refreshInboxCount() {
    try {
      const { pending } = await api('/api/notifications/count');
      document.title = (pending ? `(${pending > 99 ? '99+' : pending}) ` : '') + BASE_TITLE;
      document.querySelectorAll('.inbox-badge').forEach(b => {
        b.hidden = !pending;
        b.textContent = pending > 99 ? '99+' : pending;
      });
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

  function openUpload(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    let problem = '';
    if (!FILE_EXTS.includes(ext)) problem = `不允許的檔案類型「.${ext}」，只接受 pdf、docx、xlsx、pptx、md、txt、png、jpg。`;
    else if (file.size > MAX_FILE) problem = `檔案 ${fmtBytes(file.size)} 超過 2 MB 上限。`;
    const body = openModal('上傳文件', `
      <div class="file-box"><span class="file-icon">${fileIcon(ext)}</span>
        <div class="file-info"><b class="file-name">${esc(file.name)}</b><span class="muted small">${fmtBytes(file.size)}</span></div></div>
      ${problem ? `<div class="warn-box red">${esc(problem)}</div>` : `
      <div class="warn-box">上傳到平台等同把資料送到行外，所有群組成員都能下載，1 小時後自動刪除。</div>
      <label>附註<span class="field-hint">選填，可用 @ 指定對象</span><textarea id="up-note" rows="3" maxlength="1500" placeholder="例如：@劉昱志的程式開發助手 這是今天的會議紀錄"></textarea></label>
      <label class="declare-box"><input type="checkbox" id="up-declare"><span>我確認此檔案不含任何程式碼（原始碼、打包檔、設定檔）與客戶個資</span></label>
      <p class="error" id="up-error" role="alert"></p>`}`, problem ? {} : {
      foot: `<button class="btn" type="button" data-close>取消</button>
             <button class="btn primary" type="button" id="up-go" disabled>上傳</button>`,
    });
    if (problem) return;
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
        <div class="file-list">${d.items.length ? d.items.map(f => `
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
