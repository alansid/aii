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

  function logout(confirmFirst = true) {
    if (confirmFirst && !confirm('登出後，要用「API 資訊」裡的本人 Token（或其他裝置的 QR Code）才能再登入此身分。建議先複製 Token 保存。確定登出？')) return;
    store.del(TOKEN_KEY);
    state.token = null;
    state.me = null;
    clearTimeout(pollTimer);
    location.replace('/');
  }
  $('#logout').addEventListener('click', () => logout(true));

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
    $('#me-line').innerHTML = `本人：<b>${esc(state.me.name)}</b> (${esc(state.me.role || '未設定')}) #${esc(state.me.shortCode)}`;
    await loadParticipants();
    const d = await api('/api/messages?limit=100');
    state.messages = d.items;
    state.byId = new Map(d.items.map(m => [m.messageId, m]));
    state.nextCursor = d.nextCursor;
    state.olderCursor = d.olderCursor;
    renderMessages(true);
    refreshInboxCount();
    loadTeam();
    connectEvents();
  }

  async function loadParticipants() {
    const d = await api('/api/participants');
    state.participants = new Map(d.items.map(p => [p.participantId, p]));
    const online = d.items.filter(p => p.isOnline).length;
    $('#presence-text').textContent = `${d.items.length} 人在群 (活躍估計 ${online})`;
    drawTokenAlert(d.items);
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
    box.innerHTML = `🔑 你的 AI Token：${mine.map(x => `<b>${esc(x.p.name)}</b> ${word[x.level]}（${fmtTime(x.p.expiresAt)}）`).join('、')}
      <button type="button" class="btn mini">到「我的 AI」重發</button>`;
    box.querySelector('button').onclick = () => openMyAi();
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

  function renderText(text) {
    let html = esc(text);
    const names = [...state.participants.values()].map(p => p.name).concat(ALL.name).sort((a, b) => b.length - a.length);
    for (const n of names) html = html.split('@' + esc(n)).join(`\u0000@${esc(n)}\u0001`);
    html = html.replace(/\u0000/g, '<span class="mention">').replace(/\u0001/g, '</span>');
    return html.replace(/\bhttps?:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
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
          <div class="msg-meta">
            <span class="msg-author">${esc(a.name)}</span>
            <span class="muted small">${esc(a.role || '')} #${esc(a.shortCode)}</span>${envTag(a)}
            <span class="muted small seq">(seq: ${m.sequence})</span>
            ${memberTag(a)}
            ${m.audience === 'all' ? '<span class="tag all">全體通知</span>' : ''}
            ${toMe && m.audience !== 'all' && !isMine(m) ? '<span class="tag me">指定給我</span>' : ''}
            ${replyMe && !isMine(m) ? '<span class="tag reply">回覆我</span>' : ''}
            ${toMyAi(m) ? '<span class="tag my-ai">給我的 AI</span>' : ''}
            ${unansweredTag(m)}
          </div>
          <div class="msg-side">
            <span class="msg-time">${fmtTime(m.createdAt)}</span>
            <button class="reply-btn" type="button" data-reply="${esc(m.messageId)}">回覆</button>
          </div>
        </div>
        ${m.replyToMessageId ? `<button class="quote" type="button" data-jump="${esc(m.replyToMessageId)}">引用訊息 (${esc(shortId(m.replyToMessageId))})${parent ? `　${esc(parent.author.name)}：${esc(parent.text.slice(0, 80))}` : ''}</button>` : ''}
        ${recipients ? `<div class="recipients">指定對象: ${recipients}</div>` : ''}
        ${m.file ? fileNoteHtml(m.text) + fileCardHtml(m.file) : `<div class="msg-text">${renderText(m.text)}</div>`}
      </article>`;
  }

  function visible(m) {
    if (!state.onlyMine) return true;
    const mine = myAiIds();
    return isMine(m) || isToMe(m) || isReplyToMe(m) || mine.has(m.author.participantId)
      || m.recipients.some(r => mine.has(r.participantId));
  }

  const nearBottom = () => { const el = $('#messages'); return el.scrollHeight - el.scrollTop - el.clientHeight < 120; };
  const scrollBottom = () => { const el = $('#messages'); el.scrollTop = el.scrollHeight; };

  function renderMessages(toBottom) {
    const list = state.messages.filter(visible);
    const older = state.olderCursor ? '<button type="button" class="load-older" id="load-older">載入更早歷史訊息</button>' : '';
    $('#messages').innerHTML = older + (list.length
      ? list.map(messageHtml).join('')
      : `<div class="empty">${state.onlyMine ? '目前沒有與你或你的 AI 相關的訊息。' : '還沒有訊息。打個招呼，或到「我的 AI」新增助手。'}</div>`);
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
    if (j) jumpTo(j.dataset.jump);
  });

  async function jumpTo(id) {
    let el = document.getElementById('msg-' + id);
    if (!el && state.onlyMine) {
      state.onlyMine = false; store.set(FILTER_KEY, '0'); renderMessages(false);
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
  function openModal(title, bodyHtml, { foot = true } = {}) {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div class="modal-head"><h2 id="modal-title">${title}</h2><button class="icon-btn" data-close aria-label="關閉">×</button></div>
          <div class="modal-body">${bodyHtml}</div>
          ${foot ? '<div class="modal-foot"><button class="btn" data-close type="button">關閉</button></div>' : ''}
        </div>
      </div>`;
    const overlay = root.firstElementChild;
    overlay.addEventListener('click', e => {
      if (e.target === overlay || e.target.closest('[data-close]')) closeModal();
    });
    return overlay.querySelector('.modal-body');
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#modal-root').firstElementChild) closeModal(); });

  const openers = { members: openMembers, 'my-ai': openMyAi, inbox: openInbox, files: openFiles, api: openApi, settings: openSettings, qr: openQr };
  document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openers[b.dataset.open]()));
  $('#presence-pill').addEventListener('click', openMembers);

  // ---------- 團隊狀態 ----------
  const STATE_LABEL = { working: '進行中', idle: '空閒', blocked: '卡住', waiting: '等人決定' };
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
    return { cls: 'green', text: '正常' };
  }

  function unansweredTag(m) {
    const who = state.unansweredByMsg.get(m.messageId);
    return who?.length ? `<span class="tag unanswered" title="指派超過 ${state.team?.unansweredMinutes || 15} 分鐘仍未讀取">尚未回應：${who.map(esc).join('、')}</span>` : '';
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
    const dec = t.decisions.length ? `<button type="button" class="chip decide" data-team>📝 等你決定 ${t.decisions.length}</button>` : '';
    bar.innerHTML = dec + chips;
    bar.hidden = false;
  }
  $('#team-bar').addEventListener('click', e => { if (e.target.closest('[data-team]')) openTeam(); });

  async function openTeam() {
    await loadTeam();
    const t = state.team;
    if (!t) return toast('無法取得團隊狀態');
    const rows = t.members.map(mb => {
      const h = health(mb);
      return `<tr>
        <td><span class="dot h-${h.cls}"></span> <b>${esc(mb.name)}</b><div class="muted small">${esc(mb.role || '')}${mb.memberType === 'ai' ? ' · AI' : ''}</div></td>
        <td>${h.text}<div class="muted small">最後上線 ${agoText(mb.lastSeenAt)}</div></td>
        <td>${mb.status ? `<span class="st st-${mb.status.state}">${STATE_LABEL[mb.status.state]}</span> <button type="button" class="link" data-jump-team="${esc(mb.status.messageId)}">${esc(mb.status.title || '（無標題）')}</button>` : '<span class="muted">—</span>'}</td>
        <td>${mb.pendingCount ? `${mb.pendingCount} 則<div class="muted small">最久 ${agoText(mb.oldestPendingAt)}</div>` : '<span class="muted">0</span>'}</td>
        <td>${mb.memberType === 'ai' ? `${fmtTime(mb.tokenExpiresAt)}${mb.tokenExpired ? ' <span class="tag warn">已過期</span>' : mb.tokenExpiringSoon ? ' <span class="tag warn">快到期</span>' : ''}` : '<span class="muted">—</span>'}</td>
      </tr>`;
    }).join('');
    const body = openModal('團隊狀態', `
      <p class="notice">狀態依每人最新一則訊息的開頭標籤推斷：[接單]／[進度]＝進行中，[完成]／[回覆]／[交接]＝空閒，[受阻]＝卡住，[需確認]＝等人決定。沒照標籤發文時可能不準。AI 超過 ${t.staleMinutes} 分鐘沒出現標示「可能斷線」。</p>
      <div class="section-title">📝 等你決定（${t.decisions.length}）</div>
      ${t.decisions.length ? `<ul class="decisions">${t.decisions.map(d => `<li><button type="button" class="link" data-jump-team="${esc(d.messageId)}">${esc(d.title || '（無標題）')}</button> <span class="muted small">— ${esc(d.author.name)} · ${agoText(d.createdAt)}${d.replyCount ? ` · 後續回覆 ${d.replyCount} 則` : ''}</span> <button type="button" class="btn mini" data-resolve="${esc(d.messageId)}" title="已經決定了，從清單移出">已處理</button></li>`).join('')}</ul>` : '<p class="muted">目前沒有待決定的事項。</p>'}
      ${t.unanswered.length ? `<div class="section-title">⏰ 尚未回應的指派（${t.unanswered.length}）</div><ul class="decisions">${t.unanswered.map(u => `<li><b>${esc(u.name)}</b> <span class="muted small">已等 ${agoText(u.since).replace('前', '')}</span> <button type="button" class="link" data-jump-team="${esc(u.messageId)}">查看訊息</button></li>`).join('')}</ul>` : ''}
      <div class="section-title">成員</div>
      <div class="team-table-wrap"><table class="team-table"><thead><tr><th>成員</th><th>連線</th><th>目前狀態</th><th>待處理</th><th>Token 到期</th></tr></thead><tbody>${rows}</tbody></table></div>`);
    body.addEventListener('click', async e => {
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

  // 成員名單
  async function openMembers() {
    const items = await loadParticipants();
    const online = items.filter(p => p.isOnline).length;
    const body = openModal(`已登錄成員名單 (${items.length} 人，近期活躍 ${online})`, `
      <p class="notice">說明：狀態燈號為 30 秒內活動估計（AI 輪詢或網頁開啟即算活躍），非雙向即時連線。</p>
      <input id="member-q" type="search" placeholder="搜尋成員姓名、角色或代碼…" aria-label="搜尋成員">
      <div id="member-list" class="stack"></div>`);
    const draw = () => {
      const q = body.querySelector('#member-q').value.trim().toLowerCase();
      const list = [...state.participants.values()]
        .filter(p => !q || [p.name, p.role, p.shortCode, p.ownerName].some(v => (v || '').toLowerCase().includes(q)))
        .sort((a, b) => (b.isOnline - a.isOnline) || (a.memberType === b.memberType ? 0 : a.memberType === 'human' ? -1 : 1));
      body.querySelector('#member-list').innerHTML = list.map(p => {
        const self = p.participantId === meId();
        return `
        <div class="card member">
          <span class="dot ${p.isOnline ? 'on' : ''}"></span>
          <div class="member-info">
            <div class="member-name"><b>${esc(p.name)}</b><span class="muted">(${esc(p.role || '—')})</span>${memberTag(p)}${envTag(p)}${self ? '<span class="self">本人</span>' : ''}</div>
            <div class="member-sub">#${esc(p.shortCode)} · 狀態：${p.isOnline ? '近期活躍 (30s內)' : '離線/閒置'}</div>
            ${p.duties ? `<div class="member-sub">主要職責：${esc(p.duties)}</div>` : ''}
          </div>
          ${self ? '' : `<button class="btn" type="button" data-mention="${esc(p.name)}">@ 提及</button>`}
        </div>`;
      }).join('') || '<p class="muted">找不到符合的成員。</p>';
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
    const body = openModal('我的 AI 管理', `
      <p class="notice">管理您旗下的 AI 助手。每位 AI 擁有獨立身分、專屬 Token 與通知收件匣。</p>
      <div class="row spread">
        <button class="btn primary" type="button" id="ai-new">＋ 新增 AI 助手</button>
        <a href="/api/docs/ai-integration" target="_blank" rel="noopener">檢視 AI 接入規格文件 (Markdown)</a>
      </div>
      <div id="ai-list" class="stack"></div>`);
    let items = [];
    async function draw() {
      items = (await api('/api/my-ais')).items;
      body.querySelector('#ai-list').innerHTML = items.length ? items.map(aiCardHtml).join('')
        : '<p class="muted">還沒有 AI 助手。按「新增 AI 助手」選一個角色範例開始。</p>';
    }
    body.querySelector('#ai-new').onclick = () => openAiForm(null);
    body.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const ai = items.find(x => x.participantId === b.dataset.id);
      try {
        if (b.dataset.act === 'copy') {
          if (ai.tokenExpired) return toast('Token 已過期，請先按「重發 Token」');
          const { text } = await api(`/api/my-ais/${ai.participantId}/onboarding`);
          toast((await copyText(text)) ? '已複製，貼到你的 AI 對話即可' : '複製失敗，請手動複製');
        } else if (b.dataset.act === 'token') {
          if (ai.tokenExpired) return toast('Token 已過期，請先按「重發 Token」');
          toast((await copyText(ai.token)) ? '已複製 Token' : '複製失敗，請手動複製');
        } else if (b.dataset.act === 'edit') {
          openAiForm(ai);
        } else if (b.dataset.act === 'reissue') {
          if (!confirm(`重發後，${ai.name} 目前的 Token 會立即失效，需要重新「複製到我的 AI」。確定重發？`)) return;
          const r = await api(`/api/my-ais/${ai.participantId}/reissue`, { method: 'POST' });
          await draw();
          loadParticipants().catch(() => {});
          openTokenOnly(r);
        } else if (b.dataset.act === 'disable') {
          if (!confirm(`停用 ${ai.name}？Token 會立即失效，它將無法再讀寫群組。`)) return;
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
      <div class="row actions">
        <button class="btn primary" type="button" id="tok-copy">只複製 Token</button>
        <button class="btn" type="button" id="tok-full">複製完整接入設定</button>
      </div>
      <p class="notice">已接入的 AI：把新 Token 換進它的 Token 檔或環境變數（例如 <code>.token</code>、<code>AIGILE_TOKEN</code>）即可，不必重讀整份設定。也可以直接貼給它：「Token 已更新為 ……，請替換後繼續輪詢」。<br>第一次接入或 AI 已忘記設定時，才用「複製完整接入設定」。</p>`);
    body.querySelector('#tok-copy').onclick = async () => toast((await copyText(ai.token)) ? '已複製 Token' : '複製失敗，請手動複製');
    body.querySelector('#tok-full').onclick = async () => {
      const { text } = await api(`/api/my-ais/${ai.participantId}/onboarding`);
      toast((await copyText(text)) ? '已複製，貼到你的 AI 對話即可' : '複製失敗，請手動複製');
    };
  }

  function aiCardHtml(ai) {
    const active = ai.status === 'active';
    const level = tokenLevel(ai.expiresAt);
    const statusTag = !active ? '<span class="tag off">已停用</span>'
      : level === 'expired' ? '<span class="tag warn">Token 已過期</span>'
      : level === '2h' ? '<span class="tag warn">Token 2 小時內到期</span>'
      : level === '24h' ? '<span class="tag warn">Token 24 小時內到期</span>' : '<span class="tag ok">有效</span>';
    return `
      <div class="card">
        <div class="row spread">
          <div class="member-name"><b>${esc(ai.name)}</b><span class="muted">(${esc(ai.role)})</span>${envTag(ai)}
            <span class="tag ai">AI | 所屬: ${esc(state.me.name)}</span>${statusTag}</div>
          <span class="muted small">版本 v${ai.version} · 更新時間：${fmtTime(ai.updatedAt)}</span>
        </div>
        <div class="duties"><b>主要職責：</b>${esc(ai.duties)}</div>
        <details class="settings">
          <summary>完整角色設定</summary>
          <dl>
            <dt>溝通風格</dt><dd>${esc(ai.style)}</dd>
            <dt>可自主處理的事項</dt><dd>${esc(ai.autonomy)}</dd>
            <dt>必須確認的事項</dt><dd>${esc(ai.mustConfirm)}</dd>
            <dt>完成與交接條件</dt><dd>${esc(ai.handoff)}</dd>
          </dl>
        </details>
        <div class="muted small">#${esc(ai.shortCode)} · ${ai.isOnline ? '近期活躍' : '離線/閒置'} · Token 到期：${ai.expiresAt ? fmtTime(ai.expiresAt) : '—'}</div>
        ${active ? `
        <div class="row actions">
          <button class="btn primary" type="button" data-act="copy" data-id="${ai.participantId}">複製到我的 AI</button>
          <button class="btn" type="button" data-act="token" data-id="${ai.participantId}">只複製 Token</button>
          <span class="notice">包含此 AI 的存取憑證，請只貼到自己的 AI 對話。</span>
        </div>
        <div class="row actions">
          <button class="btn" type="button" data-act="edit" data-id="${ai.participantId}">編輯</button>
          <button class="btn" type="button" data-act="reissue" data-id="${ai.participantId}">重發 Token</button>
          <button class="btn danger" type="button" data-act="disable" data-id="${ai.participantId}" title="立即撤銷：Token 馬上失效，AI 無法再讀寫">停用（撤銷）</button>
        </div>` : `
        <div class="row actions"><button class="btn" type="button" data-act="enable" data-id="${ai.participantId}">重新啟用</button></div>`}
      </div>`;
  }

  async function openAiForm(ai) {
    const { items: roles, fields, environments = [] } = await loadRoles();
    const editing = !!ai;
    const body = openModal(editing ? '編輯 AI 助手' : '新增 AI 助手', `
      <form id="ai-form" class="stack">
        <label>角色範例選擇（選取後將自動預填六題設定）
          <select name="roleKey">${roles.map(r => `<option value="${r.key}">${esc(r.option)}</option>`).join('')}</select>
        </label>
        <p class="notice" id="role-hint"></p>
        <label>角色顯示名稱 (1-30 字)<input name="role" required maxlength="30"></label>
        <label>所在環境（選取後會在「必須確認的事項」帶入該環境的限制，可再修改）
          <input name="environment" maxlength="20" list="env-list" placeholder="行內／行外／投信，或自行輸入">
          <datalist id="env-list">${environments.map(e => `<option value="${esc(e.key)}">`).join('')}</datalist>
        </label>
        <div class="section-title">AI 設定六題（皆為必填，不可純空白，每題上限 1000 字）</div>
        <label>1. AI 名稱（人類名下此 AI 的識別名稱）<input name="name" required maxlength="40"></label>
        ${fields.map(f => `<label>${esc(f.label)}<textarea name="${f.key}" rows="3" required maxlength="1000"></textarea></label>`).join('')}
        <p class="error" id="ai-error" role="alert"></p>
        <div class="row end">
          <button class="btn" type="button" data-close>取消</button>
          <button class="btn primary" type="submit">${editing ? '儲存變更' : '建立 AI 助手'}</button>
        </div>
      </form>`, { foot: false });
    const form = body.querySelector('#ai-form');
    const fill = (src, includeName) => {
      form.role.value = src.role;
      if (src.environment !== undefined) form.environment.value = src.environment;
      if (includeName) form.name.value = src.name;
      for (const f of fields) form[f.key].value = src[f.key];
    };
    const roleHint = key => {
      const hint = body.querySelector('#role-hint');
      hint.textContent = editing ? '切換範例會覆蓋下方六題內容（名稱不變）。' : '';
      hint.hidden = !editing;
      return roles.find(r => r.key === key);
    };
    if (editing) {
      form.roleKey.value = ai.roleKey || 'custom';
      fill(ai, true);
      roleHint(form.roleKey.value);
    } else {
      const r = roleHint(roles[0].key);
      fill({ ...r, name: `${state.me.name}的${r.suffix}` }, true);
    }
    let lastAutoName = form.name.value;
    form.roleKey.addEventListener('change', () => {
      const r = roleHint(form.roleKey.value);
      const autoName = `${state.me.name}的${r.suffix}`;
      // 名稱若還是自動產生的就一起換；使用者改過就保留
      const keepName = editing || form.name.value !== lastAutoName;
      fill({ ...r, name: autoName }, !keepName);
      if (!keepName) lastAutoName = autoName;
    });
    const applyEnvNote = () => {
      let text = form.mustConfirm.value;
      for (const e of environments) text = text.split(e.note).join('');
      text = text.trim();
      const note = environments.find(e => e.key === form.environment.value.trim())?.note;
      form.mustConfirm.value = note ? (text ? text + '\n' + note : note) : text;
    };
    form.environment.addEventListener('change', applyEnvNote);
    form.roleKey.addEventListener('change', applyEnvNote); // 換角色範例後補回環境限制
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      for (const [k, v] of Object.entries(data)) data[k] = v.trim();
      try {
        if (editing) await api(`/api/my-ais/${ai.participantId}`, { method: 'PATCH', body: data });
        else await api('/api/my-ais', { method: 'POST', body: data });
        await openMyAi();
        toast(editing ? '已儲存' : '已建立。按「複製到我的 AI」把接入設定貼給你的 AI');
      } catch (err) { body.querySelector('#ai-error').textContent = err.message; }
    });
  }

  // 通知收件匣
  async function refreshInboxCount() {
    try {
      const { pending } = await api('/api/notifications/count');
      const b = $('#inbox-badge');
      b.hidden = !pending;
      b.textContent = pending > 99 ? '99+' : pending;
    } catch {}
  }

  async function openInbox() {
    const body = openModal('通知收件匣', '<div id="inbox-list" class="stack"></div>');
    const ack = ids => api('/api/notifications/ack', { method: 'POST', body: { notificationIds: ids } });
    let ids = [];
    async function draw() {
      const d = await api('/api/notifications?status=pending&limit=100');
      ids = d.items.map(n => n.notificationId);
      const reasonTag = { mention: '<span class="tag me">指定給我</span>', reply: '<span class="tag reply">回覆我</span>', all: '<span class="tag all">全體通知</span>' };
      body.querySelector('#inbox-list').innerHTML = d.items.length ? `
        <div class="row spread"><span class="muted">${d.items.length}${d.hasMore ? '+' : ''} 則待處理</span><button class="btn" type="button" data-ack-all>全部標為已處理</button></div>
        ${d.items.map(n => `
          <div class="card">
            <div class="row"><b>${esc(n.sender.name)}</b>${n.reasons.map(r => reasonTag[r] || '').join('')}
              <span class="msg-time">${fmtTime(n.createdAt)}</span></div>
            <div class="msg-text">${esc(n.preview)}</div>
            <div class="row"><button class="btn" type="button" data-goto="${esc(n.messageId)}" data-n="${esc(n.notificationId)}">查看並標為已處理</button>
            <button class="btn" type="button" data-ack="${esc(n.notificationId)}">標為已處理</button></div>
          </div>`).join('')}`
        : '<p class="muted">沒有待處理的通知。</p>';
    }
    body.addEventListener('click', async e => {
      try {
        if (e.target.closest('[data-ack-all]')) await ack(ids);
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
        ${canDeleteFile(f) ? `<button class="btn" type="button" data-delete-file="${esc(f.fileId)}">刪除</button>` : ''}
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
    if (!confirm('確定刪除這個文件？刪除後所有人都無法再下載。')) return false;
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
      <div class="file-card"><span class="file-icon">${fileIcon(ext)}</span>
        <div class="file-info"><b class="file-name">${esc(file.name)}</b><span class="muted small">${fmtBytes(file.size)}</span></div></div>
      ${problem ? `<p class="error">${esc(problem)}</p>` : `
      <p class="notice warn">上傳到平台等同把資料送到行外，所有群組成員都能下載，1 小時後自動刪除。</p>
      <label>附註（選填，可用 @ 指定對象）<textarea id="up-note" rows="2" maxlength="1500" placeholder="例如：@劉昱志的程式開發助手 這是今天的會議紀錄"></textarea></label>
      <label class="check declare"><input type="checkbox" id="up-declare">我確認此檔案不含任何程式碼（原始碼、打包檔、設定檔）與客戶個資</label>
      <p class="error" id="up-error" role="alert"></p>
      <div class="row end"><button class="btn" type="button" data-close>取消</button>
        <button class="btn primary" type="button" id="up-go" disabled>上傳</button></div>`}`, { foot: !!problem });
    if (problem) return;
    const go = body.querySelector('#up-go');
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

  // 文件分頁：目前檔案、容量、稽核
  async function openFiles() {
    const body = openModal('文件', '<div id="files-list" class="stack"></div>');
    try {
      const d = await api('/api/files');
      const pct = Math.min(100, d.usedBytes / d.limitBytes * 100);
      body.querySelector('#files-list').innerHTML = `
        <p class="notice">只能上傳文件類（pdf、docx、xlsx、pptx、md、txt、png、jpg，單檔 ≤ 2 MB），禁止程式碼與客戶個資；上傳 1 小時後自動刪除。</p>
        <div class="usage"><div class="usage-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
          <span class="muted small">已用 ${fmtBytes(d.usedBytes)} / ${fmtBytes(d.limitBytes)}</span></div>
        ${d.items.length ? d.items.map(f => `${fileCardHtml(f)}<div class="muted small file-by">上傳者：${esc(f.uploader?.name || '?')}${f.uploader?.memberType === 'ai' ? '（AI）' : ''} · ${fmtTime(f.createdAt)}</div>`).join('')
          : '<p class="muted">目前沒有文件。用輸入框旁的 📎 上傳。</p>'}
        <details class="audit"><summary>稽核紀錄</summary><div id="audit-list" class="muted small">載入中…</div></details>`;
      body.querySelector('details.audit').addEventListener('toggle', async e => {
        if (!e.target.open) return;
        const box = body.querySelector('#audit-list');
        try {
          const a = await api('/api/files/audit?limit=200');
          const label = { upload: '上傳', download: '下載', delete: '刪除', reject: '拒絕', expire: '到期清除' };
          box.innerHTML = a.items.length ? `<table class="audit-table"><thead><tr><th>時間</th><th>動作</th><th>操作者</th><th>檔名</th><th>大小</th><th>SHA-256</th><th>聲明</th><th>備註</th></tr></thead><tbody>${
            a.items.map(x => `<tr><td>${fmtTime(x.at)}</td><td>${label[x.action] || x.action}</td>
              <td>${esc(x.actor.name || x.actor.participantId || '')}${x.actor.memberType === 'ai' ? '（AI）' : x.actor.memberType === 'human' ? '（人類）' : ''}</td>
              <td>${esc(x.name || '')}</td><td>${x.size == null ? '' : fmtBytes(x.size)}</td>
              <td>${x.sha256 ? esc(x.sha256.slice(0, 12)) + '…' : ''}</td><td>${x.declared == null ? '' : x.declared ? '✓' : '✗'}</td>
              <td>${esc(x.detail || '')}</td></tr>`).join('')}</tbody></table>` : '沒有紀錄。';
        } catch (err) { box.textContent = err.message; }
      });
    } catch (err) {
      body.querySelector('#files-list').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  }

  // API 資訊
  function openApi() {
    const base = location.origin;
    const body = openModal('API 資訊', `
      <div class="kv">
        <span>API Base URL</span><code>${esc(base)}</code>
        <span>本人 participantId</span><code>${esc(meId())}</code>
        <span>本人 Token（登入用）</span><span class="row"><code id="my-token">••••••••••••</code><button class="btn" type="button" id="tok-show">顯示</button><button class="btn" type="button" id="tok-copy">複製</button></span>
      </div>
      <p class="notice warn">這是「你本人」的 Token，等同登入密碼：在其他瀏覽器或裝置的加入畫面選「用 Token 登入」貼上，就能用同一個身分登入。不要給 AI 用；AI 請到「我的 AI」建立專屬身分。</p>
      <div class="section-title">主要端點</div>
      <ul class="endpoints">
        <li><code>GET /api/me</code> 自身身分</li>
        <li><code>GET /api/participants</code> 有效成員與在線狀態</li>
        <li><code>GET /api/messages?limit=50&amp;after=&lt;nextCursor&gt;</code> 增量讀取訊息</li>
        <li><code>GET /api/messages/:messageId</code> 單則訊息</li>
        <li><code>POST /api/messages</code> 發文（text、requestId、recipientIds、replyToMessageId、audience）</li>
        <li><code>GET /api/notifications?status=pending&amp;limit=50</code> 待處理通知</li>
        <li><code>POST /api/notifications/ack</code> 確認通知（notificationIds）</li>
        <li><code>POST /api/files?name=&amp;declared=true</code> 上傳文件（原始位元組）；<code>GET /api/files</code>、<code>GET /api/files/:id</code> 清單與下載</li>
      </ul>
      <p>完整規格：<a href="/api/docs/ai-integration" target="_blank" rel="noopener">AI 代理人接入通訊協定指南 (Markdown)</a></p>
      <div class="section-title">快速測試</div>
      <code class="block">curl -H "Authorization: Bearer &lt;TOKEN&gt;" ${esc(base)}/api/me</code>`);
    body.querySelector('#tok-show').onclick = () => { body.querySelector('#my-token').textContent = state.token; };
    body.querySelector('#tok-copy').onclick = async () => toast((await copyText(state.token)) ? '已複製' : '複製失敗');
  }

  // 進階設定
  function openSettings() {
    const theme = store.get(THEME_KEY) || 'system';
    const body = openModal('進階設定', `
      <label>外觀
        <select id="set-theme">
          <option value="system" ${theme === 'system' ? 'selected' : ''}>跟隨系統</option>
          <option value="light" ${theme === 'light' ? 'selected' : ''}>淺色</option>
          <option value="dark" ${theme === 'dark' ? 'selected' : ''}>深色</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" id="set-mine" ${state.onlyMine ? 'checked' : ''}>只顯示與我或我的 AI 相關的訊息</label>
      <hr>
      <p class="notice">離開群組會停用你和你名下的所有 AI，其他成員將看不到你們。</p>
      <button class="btn danger" type="button" id="set-leave">離開群組</button>`);
    body.querySelector('#set-theme').onchange = e => {
      const v = e.target.value;
      if (v === 'system') store.del(THEME_KEY); else store.set(THEME_KEY, v);
      applyTheme(v);
    };
    body.querySelector('#set-mine').onchange = e => {
      state.onlyMine = e.target.checked;
      store.set(FILTER_KEY, state.onlyMine ? '1' : '0');
      renderMessages(true);
    };
    body.querySelector('#set-leave').onclick = async () => {
      if (!confirm('確定離開群組？你和名下 AI 的 Token 都會失效。')) return;
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
      <p class="notice">提示：用 localhost 開啟時手機連不到；請改用電腦的區網 IP 開啟本頁後再產生 QR Code。</p>`);
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
