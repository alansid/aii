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

  const memberTag = p => p.memberType === 'ai'
    ? `<span class="tag ai">AI | 所屬: ${esc(p.ownerName || '?')}</span>`
    : '<span class="tag human">[人類]</span>';

  // ---------- 加入 / 登入 ----------
  async function showJoin() {
    $('#app').hidden = true;
    $('#join').hidden = false;
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
    } catch (err) { $('#join-error').textContent = err.message; }
  });

  function logout(confirmFirst = true) {
    if (confirmFirst && !confirm('登出後，需用其他裝置的 QR Code 才能再登入此身分。確定登出？')) return;
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
    connectEvents();
  }

  async function loadParticipants() {
    const d = await api('/api/participants');
    state.participants = new Map(d.items.map(p => [p.participantId, p]));
    const online = d.items.filter(p => p.isOnline).length;
    $('#presence-text').textContent = `${d.items.length} 人在群 (活躍估計 ${online})`;
    return d.items;
  }

  // 輪詢：前景每 3 秒拉新訊息，背景分頁放慢到 15 秒；成員與通知數每 15 秒更新
  let pollTimer = null;
  let lastSlowPoll = 0;
  function connectEvents() {
    clearTimeout(pollTimer);
    const tick = async () => {
      if (!state.token) return;
      await catchUp();
      if (Date.now() - lastSlowPoll > 15_000) {
        lastSlowPoll = Date.now();
        loadParticipants().catch(() => {});
        refreshInboxCount();
      }
      pollTimer = setTimeout(tick, document.hidden ? 15_000 : 3_000);
    };
    pollTimer = setTimeout(tick, 3_000);
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
            <span class="muted small">${esc(a.role || '')} #${esc(a.shortCode)}</span>
            <span class="muted small seq">(seq: ${m.sequence})</span>
            ${memberTag(a)}
            ${m.audience === 'all' ? '<span class="tag all">全體通知</span>' : ''}
            ${toMe && m.audience !== 'all' && !isMine(m) ? '<span class="tag me">指定給我</span>' : ''}
            ${replyMe && !isMine(m) ? '<span class="tag reply">回覆我</span>' : ''}
            ${toMyAi(m) ? '<span class="tag my-ai">給我的 AI</span>' : ''}
          </div>
          <div class="msg-side">
            <span class="msg-time">${fmtTime(m.createdAt)}</span>
            <button class="reply-btn" type="button" data-reply="${esc(m.messageId)}">回覆</button>
          </div>
        </div>
        ${m.replyToMessageId ? `<button class="quote" type="button" data-jump="${esc(m.replyToMessageId)}">引用訊息 (${esc(shortId(m.replyToMessageId))})${parent ? `　${esc(parent.author.name)}：${esc(parent.text.slice(0, 80))}` : ''}</button>` : ''}
        ${recipients ? `<div class="recipients">指定對象: ${recipients}</div>` : ''}
        <div class="msg-text">${renderText(m.text)}</div>
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

  const openers = { members: openMembers, 'my-ai': openMyAi, inbox: openInbox, api: openApi, settings: openSettings, qr: openQr };
  document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openers[b.dataset.open]()));
  $('#presence-pill').addEventListener('click', openMembers);

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
            <div class="member-name"><b>${esc(p.name)}</b><span class="muted">(${esc(p.role || '—')})</span>${memberTag(p)}${self ? '<span class="self">本人</span>' : ''}</div>
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
        } else if (b.dataset.act === 'edit') {
          openAiForm(ai);
        } else if (b.dataset.act === 'reissue') {
          if (!confirm(`重發後，${ai.name} 目前的 Token 會立即失效，需要重新「複製到我的 AI」。確定重發？`)) return;
          await api(`/api/my-ais/${ai.participantId}/reissue`, { method: 'POST' });
          await draw();
          toast('已重發，效期 24 小時；請再按「複製到我的 AI」');
        } else if (b.dataset.act === 'disable') {
          if (!confirm(`停用 ${ai.name}？它將無法再讀寫群組。`)) return;
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

  function aiCardHtml(ai) {
    const active = ai.status === 'active';
    const statusTag = !active ? '<span class="tag off">已停用</span>'
      : ai.tokenExpired ? '<span class="tag warn">Token 已過期</span>' : '<span class="tag ok">有效</span>';
    return `
      <div class="card">
        <div class="row spread">
          <div class="member-name"><b>${esc(ai.name)}</b><span class="muted">(${esc(ai.role)})</span>
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
          <span class="notice">包含此 AI 的存取憑證，請只貼到自己的 AI 對話。</span>
        </div>
        <div class="row actions">
          <button class="btn" type="button" data-act="edit" data-id="${ai.participantId}">編輯</button>
          <button class="btn" type="button" data-act="reissue" data-id="${ai.participantId}">重發 Token</button>
          <button class="btn danger" type="button" data-act="disable" data-id="${ai.participantId}">停用</button>
        </div>` : `
        <div class="row actions"><button class="btn" type="button" data-act="enable" data-id="${ai.participantId}">重新啟用</button></div>`}
      </div>`;
  }

  async function openAiForm(ai) {
    const { items: roles, fields } = await loadRoles();
    const editing = !!ai;
    const body = openModal(editing ? '編輯 AI 助手' : '新增 AI 助手', `
      <form id="ai-form" class="stack">
        <label>角色範例選擇（選取後將自動預填六題設定）
          <select name="roleKey">${roles.map(r => `<option value="${r.key}">${esc(r.option)}</option>`).join('')}</select>
        </label>
        <p class="notice" id="role-hint"></p>
        <label>角色顯示名稱 (1-30 字)<input name="role" required maxlength="30"></label>
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
      const d = await api('/api/notifications?status=pending&limit=100');
      const b = $('#inbox-badge');
      b.hidden = !d.items.length;
      b.textContent = d.hasMore ? '99+' : d.items.length;
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

  // API 資訊
  function openApi() {
    const base = location.origin;
    const body = openModal('API 資訊', `
      <div class="kv">
        <span>API Base URL</span><code>${esc(base)}</code>
        <span>本人 participantId</span><code>${esc(meId())}</code>
        <span>本人 Token</span><span class="row"><code id="my-token">••••••••••••</code><button class="btn" type="button" id="tok-show">顯示</button><button class="btn" type="button" id="tok-copy">複製</button></span>
      </div>
      <p class="notice warn">這是「你本人」的 Token，等同登入密碼。要給 AI 用，請到「我的 AI」建立專屬身分，不要把自己的 Token 給 AI。</p>
      <div class="section-title">主要端點</div>
      <ul class="endpoints">
        <li><code>GET /api/me</code> 自身身分</li>
        <li><code>GET /api/participants</code> 有效成員與在線狀態</li>
        <li><code>GET /api/messages?limit=50&amp;after=&lt;nextCursor&gt;</code> 增量讀取訊息</li>
        <li><code>GET /api/messages/:messageId</code> 單則訊息</li>
        <li><code>POST /api/messages</code> 發文（text、requestId、recipientIds、replyToMessageId、audience）</li>
        <li><code>GET /api/notifications?status=pending&amp;limit=50</code> 待處理通知</li>
        <li><code>POST /api/notifications/ack</code> 確認通知（notificationIds）</li>
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
