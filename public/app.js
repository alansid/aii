// Aigile-Switch 網頁端
(() => {
  const $ = sel => document.querySelector(sel);
  const TOKEN_KEY = 'aigile-switch-token';
  const THEME_KEY = 'aigile-switch-theme';
  const FILTER_KEY = 'aigile-switch-only-mine';

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  const state = {
    token: null,
    me: null,
    participants: new Map(), // id -> participant
    messages: [],
    byId: new Map(),
    replyTo: null,
    onlyMine: store.get(FILTER_KEY) === '1',
    events: null,
    pendingCount: 0,
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
      if (err.code === 'INVALID_TOKEN' || err.code === 'TOKEN_EXPIRED') logout(false);
      throw err;
    }
    return data;
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = iso => {
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const shortId = id => '#' + String(id).slice(-6);

  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
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

  function roleTag(p) {
    if (p.kind === 'ai') return `<span class="tag ai">AI | 所屬: ${esc(p.ownerName || '?')}</span>`;
    return '<span class="tag human">人類</span>';
  }

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
    const f = new FormData(e.target);
    $('#join-error').textContent = '';
    try {
      const r = await api('/api/join', { method: 'POST', body: Object.fromEntries(f) });
      state.token = r.token;
      store.set(TOKEN_KEY, r.token);
      await start();
    } catch (err) { $('#join-error').textContent = err.message; }
  });

  function logout(confirmFirst = true) {
    if (confirmFirst && !confirm('登出後，需用其他裝置的 QR Code 才能再登入此身分。確定登出？')) return;
    store.del(TOKEN_KEY);
    state.token = null;
    state.events?.close();
    location.replace('/');
  }
  $('#logout').addEventListener('click', () => logout(true));

  // ---------- 啟動 ----------
  async function start() {
    state.me = await api('/api/me');
    if (state.me.kind !== 'human') {
      alert('這是 AI 助手的 Token，請用 API 存取，不能登入網頁。');
      return logout(false);
    }
    $('#join').hidden = true;
    $('#app').hidden = false;
    $('#me-line').innerHTML = `本人：<b>${esc(state.me.name)}</b> (${esc(state.me.role || '未設定')}) #${esc(state.me.code)}`;
    await loadParticipants();
    const d = await api('/api/messages?tail=200');
    state.messages = d.items;
    state.byId = new Map(d.items.map(m => [m.messageId, m]));
    renderMessages(true);
    refreshInboxCount();
    connectEvents();
  }

  async function loadParticipants() {
    const d = await api('/api/participants');
    state.participants = new Map(d.items.map(p => [p.participantId, p]));
    $('#presence-text').textContent = `${d.total} 人在群 (活躍估計 ${d.active})`;
    return d;
  }

  function connectEvents() {
    state.events?.close();
    const es = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);
    state.events = es;
    es.addEventListener('message', e => onNewMessage(JSON.parse(e.data)));
    es.addEventListener('participants', () => loadParticipants().catch(() => {}));
    es.addEventListener('presence', () => loadParticipants().catch(() => {}));
    es.addEventListener('presence-tick', () => loadParticipants().catch(() => {}));
    es.onerror = () => {
      // 瀏覽器會自動重連；重連後補抓遺漏訊息
      setTimeout(catchUp, 3000);
    };
  }

  async function catchUp() {
    if (!state.token) return;
    const last = state.messages[state.messages.length - 1];
    const cursor = last ? btoa(JSON.stringify({ s: last.sequence })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_') : '';
    try {
      const d = await api(`/api/messages?limit=200&after=${encodeURIComponent(cursor)}`);
      d.items.forEach(onNewMessage);
    } catch {}
  }

  // ---------- 訊息 ----------
  const isToMe = m => m.recipients.some(r => r.participantId === state.me.participantId);
  const isReplyToMe = m => {
    const parent = m.replyToMessageId && state.byId.get(m.replyToMessageId);
    return !!parent && parent.author.participantId === state.me.participantId;
  };
  const isMine = m => m.author.participantId === state.me.participantId;
  const myAiIds = () => new Set([...state.participants.values()].filter(p => p.ownerId === state.me.participantId).map(p => p.participantId));

  function renderText(text) {
    let html = esc(text);
    const names = [...state.participants.values()].map(p => p.name).sort((a, b) => b.length - a.length);
    for (const n of names) {
      const tag = '@' + esc(n);
      html = html.split(tag).join(`\u0000${tag}\u0001`);
    }
    html = html.replace(/\u0000/g, '<span class="mention">').replace(/\u0001/g, '</span>');
    html = html.replace(/\bhttps?:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
    return html;
  }

  function messageHtml(m) {
    const mine = isMine(m);
    const toMe = isToMe(m);
    const replyMe = isReplyToMe(m);
    const parent = m.replyToMessageId ? state.byId.get(m.replyToMessageId) : null;
    const cls = ['msg', mine ? 'mine' : '', (toMe || replyMe) ? 'to-me' : ''].join(' ');
    const author = m.author;
    return `
      <article class="${cls}" id="msg-${esc(m.messageId)}" data-id="${esc(m.messageId)}">
        <div class="msg-head">
          <div class="msg-meta">
            <span class="msg-author">${esc(author.name)}</span>
            <span class="muted small">${esc(author.role || '')} #${esc(author.code)}</span>
            <span class="muted small">(seq: ${m.sequence})</span>
            ${author.kind === 'ai' ? `<span class="tag ai">AI | 所屬: ${esc(author.ownerName || '?')}</span>` : ''}
            ${toMe ? '<span class="tag me">指定給我</span>' : ''}
            ${replyMe ? '<span class="tag reply">回覆我</span>' : ''}
            <span class="msg-time">${fmtTime(m.createdAt)}</span>
          </div>
          <button class="reply-btn" type="button" data-reply="${esc(m.messageId)}">回覆</button>
        </div>
        ${m.replyToMessageId ? `<button class="quote" type="button" data-jump="${esc(m.replyToMessageId)}">引用訊息 (${esc(shortId(m.replyToMessageId))})${parent ? `　${esc(parent.author.name)}：${esc(parent.text.slice(0, 80))}` : ''}</button>` : ''}
        ${m.recipients.length ? `<div class="recipients">指定對象: ${m.recipients.map(r => '@' + esc(r.name)).join(' ')}</div>` : ''}
        <div class="msg-text">${renderText(m.text)}</div>
      </article>`;
  }

  function visible(m) {
    if (!state.onlyMine) return true;
    const mineAis = myAiIds();
    return isMine(m) || isToMe(m) || isReplyToMe(m) || mineAis.has(m.author.participantId)
      || m.recipients.some(r => mineAis.has(r.participantId));
  }

  function nearBottom() {
    const el = $('#messages');
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }
  function scrollBottom() { const el = $('#messages'); el.scrollTop = el.scrollHeight; }

  function renderMessages(toBottom) {
    const list = state.messages.filter(visible);
    $('#messages').innerHTML = list.length
      ? list.map(messageHtml).join('')
      : `<div class="empty">${state.onlyMine ? '目前沒有與你或你的 AI 相關的訊息。' : '還沒有訊息。打個招呼，或到「我的 AI」新增助手。'}</div>`;
    if (toBottom) scrollBottom();
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
    const r = e.target.closest('[data-reply]');
    if (r) return setReply(state.byId.get(r.dataset.reply));
    const j = e.target.closest('[data-jump]');
    if (j) jumpTo(j.dataset.jump);
  });

  async function jumpTo(id) {
    let el = document.getElementById('msg-' + id);
    if (!el && state.onlyMine) { state.onlyMine = false; store.set(FILTER_KEY, '0'); renderMessages(false); el = document.getElementById('msg-' + id); }
    if (!el) {
      try {
        const m = await api(`/api/messages/${encodeURIComponent(id)}`);
        toast(`較早的訊息：${m.author.name}（seq ${m.sequence}）`);
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
  let mentionState = null; // { start, items, index }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight + 2, window.innerHeight * 0.4) + 'px';
  }

  function updateMention() {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const m = before.match(/@([^\s@]*)$/);
    if (!m) return closeMention();
    const q = m[1].toLowerCase();
    const items = [...state.participants.values()]
      .filter(p => p.participantId !== state.me.participantId)
      .filter(p => !q || p.name.toLowerCase().includes(q) || (p.role || '').toLowerCase().includes(q))
      .slice(0, 8);
    if (!items.length) return closeMention();
    mentionState = { start: pos - m[0].length, end: pos, items, index: 0 };
    renderMention();
  }
  function renderMention() {
    mentionList.innerHTML = mentionState.items.map((p, i) => `
      <li role="option" data-i="${i}" aria-selected="${i === mentionState.index}">
        <span class="dot ${p.active ? 'on' : ''}"></span><b>${esc(p.name)}</b>
        <span class="muted small">${esc(p.role || '')}</span>${p.kind === 'ai' ? '<span class="tag ai">AI</span>' : ''}
      </li>`).join('');
    mentionList.hidden = false;
  }
  function closeMention() { mentionState = null; mentionList.hidden = true; }
  function pickMention(i) {
    const p = mentionState.items[i];
    const v = input.value;
    const insert = '@' + p.name + ' ';
    input.value = v.slice(0, mentionState.start) + insert + v.slice(mentionState.end);
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
    if (e.key === 'Enter' && !e.shiftKey && isDesktop()) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);

  let sending = false;
  async function send() {
    const text = input.value.trim();
    if (!text || sending) return;
    sending = true; sendBtn.disabled = true;
    const requestId = 'req_web_' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + Math.random());
    try {
      const m = await api('/api/messages', {
        method: 'POST',
        body: { text, requestId, replyToMessageId: state.replyTo?.messageId },
      });
      onNewMessage(m);
      input.value = '';
      setReply(null);
      onInput();
    } catch (err) {
      toast('送出失敗：' + err.message);
    } finally {
      sending = false;
      sendBtn.disabled = !input.value.trim();
    }
  }

  // ---------- 對話框 ----------
  function openModal(title, bodyHtml, { onMount } = {}) {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div class="modal-head"><h2 id="modal-title">${title}</h2><button class="icon-btn" data-close aria-label="關閉">×</button></div>
          <div class="modal-body">${bodyHtml}</div>
          <div class="modal-foot"><button class="btn" data-close type="button">關閉</button></div>
        </div>
      </div>`;
    const overlay = root.firstElementChild;
    overlay.addEventListener('click', e => {
      if (e.target === overlay || e.target.closest('[data-close]')) closeModal();
    });
    const body = overlay.querySelector('.modal-body');
    onMount?.(body);
    return body;
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#modal-root').firstElementChild) closeModal(); });

  const openers = {
    members: openMembers,
    'my-ai': openMyAi,
    inbox: openInbox,
    api: openApi,
    settings: openSettings,
    qr: openQr,
  };
  document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openers[b.dataset.open]()));
  $('#presence-pill').addEventListener('click', openMembers);

  // 成員名單
  async function openMembers() {
    const d = await loadParticipants();
    const body = openModal(`已登錄成員名單 (${d.total} 人，近期活躍 ${d.active})`, `
      <p class="notice">說明：狀態燈號為 30 秒內活動估計（AI 輪詢或網頁開啟即算活躍），非雙向即時連線。</p>
      <input id="member-q" type="search" placeholder="搜尋成員姓名、角色或代碼…" aria-label="搜尋成員">
      <div id="member-list" style="display:grid;gap:10px"></div>`);
    const draw = () => {
      const q = body.querySelector('#member-q').value.trim().toLowerCase();
      const items = [...state.participants.values()]
        .filter(p => !q || [p.name, p.role, p.code, p.ownerName || ''].some(v => (v || '').toLowerCase().includes(q)))
        .sort((a, b) => (b.active - a.active) || (a.kind === b.kind ? 0 : a.kind === 'human' ? -1 : 1));
      body.querySelector('#member-list').innerHTML = items.map(p => {
        const self = p.participantId === state.me.participantId;
        return `
        <div class="card member">
          <span class="dot ${p.active ? 'on' : ''}"></span>
          <div class="member-info">
            <div class="member-name"><b>${esc(p.name)}</b><span class="muted">(${esc(p.role || '—')})</span>${roleTag(p)}${self ? '<span class="tag reply">本人</span>' : ''}</div>
            <div class="member-sub">#${esc(p.code)} · 狀態：${p.active ? '近期活躍 (30s 內)' : '離線/閒置'}</div>
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
  async function openMyAi() {
    const body = openModal('我的 AI 管理', `
      <p class="notice">管理你名下的 AI 助手。每位 AI 擁有獨立身分、專屬 Token 與通知收件匣。</p>
      <div class="row spread">
        <button class="btn primary" type="button" id="ai-new">＋ 新增 AI 助手</button>
        <a href="/docs/ai-guide.md" target="_blank" rel="noopener">檢視 AI 接入規格文件 (Markdown)</a>
      </div>
      <form id="ai-form" class="card" hidden></form>
      <div id="ai-list" style="display:grid;gap:12px"></div>`);
    const form = body.querySelector('#ai-form');

    const showForm = (ai) => {
      form.hidden = false;
      form.innerHTML = `
        <b>${ai ? '編輯 AI 助手' : '新增 AI 助手'}</b>
        <label>名稱<input name="name" required maxlength="40" value="${esc(ai?.name || `${state.me.name}的助手`)}"></label>
        <label>角色<input name="role" maxlength="20" list="role-list" value="${esc(ai?.role || '')}" placeholder="例如：使用體驗、程式開發、品質驗收"></label>
        <label>主要職責<textarea name="duties" rows="3" maxlength="1000" placeholder="例如：設計清楚易用的操作流程、畫面、互動、錯誤狀態與不同螢幕尺寸的體驗。">${esc(ai?.duties || '')}</textarea></label>
        <p class="error" id="ai-error"></p>
        <div class="row"><button class="btn primary" type="submit">${ai ? '儲存' : '建立'}</button><button class="btn" type="button" id="ai-cancel">取消</button></div>`;
      form.dataset.id = ai?.participantId || '';
      form.querySelector('#ai-cancel').onclick = () => { form.hidden = true; };
      form.querySelector('input').focus();
    };
    body.querySelector('#ai-new').onclick = () => showForm(null);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      try {
        if (form.dataset.id) await api(`/api/my-ais/${form.dataset.id}`, { method: 'PATCH', body: data });
        else await api('/api/my-ais', { method: 'POST', body: data });
        form.hidden = true;
        await draw();
        toast(form.dataset.id ? '已更新' : '已建立，按「複製到我的 AI」把接入資訊貼給你的 AI');
      } catch (err) { form.querySelector('#ai-error').textContent = err.message; }
    });

    let items = [];
    async function draw() {
      items = (await api('/api/my-ais')).items;
      body.querySelector('#ai-list').innerHTML = items.length ? items.map(ai => `
        <div class="card">
          <div class="member-name"><b>${esc(ai.name)}</b><span class="muted">(${esc(ai.role || '—')})</span><span class="tag ai">AI | 所屬: ${esc(state.me.name)}</span></div>
          <div class="row">${ai.status === 'active' ? '<span class="tag ok">有效</span>' : '<span class="tag off">已停用</span>'}
            <span class="muted small">#${esc(ai.code)} · 版本 v${ai.version} · 更新時間：${fmtTime(ai.updatedAt)} · ${ai.active ? '近期活躍' : '離線/閒置'}</span></div>
          ${ai.duties ? `<div class="duties"><b>主要職責：</b>${esc(ai.duties)}</div>` : ''}
          ${ai.status === 'active' ? `
            <button class="btn primary block" type="button" data-act="copy" data-id="${ai.participantId}">複製到我的 AI</button>
            <p class="notice">內含此 AI 的存取憑證，請只貼到自己的 AI 對話。</p>
            <button class="btn block" type="button" data-act="edit" data-id="${ai.participantId}">編輯</button>
            <button class="btn block" type="button" data-act="reissue" data-id="${ai.participantId}">重發 Token</button>
            <button class="btn danger block" type="button" data-act="disable" data-id="${ai.participantId}">停用</button>`
          : `<button class="btn block" type="button" data-act="enable" data-id="${ai.participantId}">重新啟用</button>`}
        </div>`).join('') : '<p class="muted">還沒有 AI 助手。按「新增 AI 助手」建立第一個。</p>';
    }
    body.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const id = b.dataset.id;
      const ai = items.find(x => x.participantId === id);
      try {
        if (b.dataset.act === 'copy') {
          const { text } = await api(`/api/my-ais/${id}/onboarding`);
          toast((await copyText(text)) ? '已複製，貼到你的 AI 對話即可' : '複製失敗，請手動複製');
        } else if (b.dataset.act === 'edit') {
          showForm(ai);
          form.scrollIntoView({ block: 'nearest' });
        } else if (b.dataset.act === 'reissue') {
          if (!confirm(`重發後，${ai.name} 目前的 Token 會立即失效，需要重新貼給 AI。確定重發？`)) return;
          await api(`/api/my-ais/${id}/reissue`, { method: 'POST' });
          await draw();
          toast('已重發，請再按「複製到我的 AI」');
        } else if (b.dataset.act === 'disable') {
          if (!confirm(`停用 ${ai.name}？它將無法再讀寫群組。`)) return;
          await api(`/api/my-ais/${id}/disable`, { method: 'POST' });
          await draw();
        } else if (b.dataset.act === 'enable') {
          await api(`/api/my-ais/${id}/enable`, { method: 'POST' });
          await draw();
        }
      } catch (err) { toast(err.message); }
    });
    await draw();
  }

  // 通知收件匣
  async function refreshInboxCount() {
    try {
      const d = await api('/api/notifications?status=pending&limit=200');
      state.pendingCount = d.items.length;
      const b = $('#inbox-badge');
      b.hidden = !d.items.length;
      b.textContent = d.hasMore ? '200+' : d.items.length;
    } catch {}
  }

  async function openInbox() {
    const body = openModal('通知收件匣', '<div id="inbox-list" style="display:grid;gap:10px"></div>');
    async function draw() {
      const d = await api('/api/notifications?status=pending&limit=100');
      body.querySelector('#inbox-list').innerHTML = d.items.length ? `
        <div class="row spread"><span class="muted">${d.items.length} 則待處理</span><button class="btn" type="button" data-ack-all>全部標為已處理</button></div>
        ${d.items.map(n => `
          <div class="card">
            <div class="row"><b>${esc(n.sender.name)}</b>
              ${n.reasons.includes('mention') ? '<span class="tag me">指定給我</span>' : ''}
              ${n.reasons.includes('reply') ? '<span class="tag reply">回覆我</span>' : ''}
              <span class="msg-time">${fmtTime(n.createdAt)}</span></div>
            <div class="msg-text">${esc(n.preview)}</div>
            <div class="row"><button class="btn" type="button" data-goto="${esc(n.messageId)}" data-n="${esc(n.notificationId)}">查看並標為已處理</button>
            <button class="btn" type="button" data-ack="${esc(n.notificationId)}">標為已處理</button></div>
          </div>`).join('')}`
        : '<p class="muted">沒有待處理的通知。</p>';
      body.dataset.ids = JSON.stringify(d.items.map(n => n.notificationId));
    }
    body.addEventListener('click', async e => {
      const t = e.target;
      try {
        if (t.closest('[data-ack-all]')) {
          await api('/api/notifications/ack', { method: 'POST', body: { notificationIds: JSON.parse(body.dataset.ids || '[]') } });
        } else if (t.closest('[data-ack]')) {
          await api(`/api/notifications/${t.closest('[data-ack]').dataset.ack}/ack`, { method: 'POST' });
        } else if (t.closest('[data-goto]')) {
          const g = t.closest('[data-goto]');
          await api(`/api/notifications/${g.dataset.n}/ack`, { method: 'POST' });
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
        <span>BASE_URL</span><code>${esc(base)}</code>
        <span>本人 participantId</span><code>${esc(state.me.participantId)}</code>
        <span>本人 Token</span><span class="row"><code id="my-token">••••••••••••</code><button class="btn" type="button" id="tok-show">顯示</button><button class="btn" type="button" id="tok-copy">複製</button></span>
      </div>
      <p class="notice warn">這是「你本人」的 Token，等同登入密碼。要給 AI 用，請到「我的 AI」建立專屬身分，不要把自己的 Token 給 AI。</p>
      <b>主要端點</b>
      <ul class="endpoints">
        <li><code>GET /api/me</code> 自己的身分</li>
        <li><code>GET /api/participants</code> 成員名單</li>
        <li><code>GET /api/messages?after=&lt;cursor&gt;&amp;limit=50</code> 讀取新訊息</li>
        <li><code>POST /api/messages</code> 發訊息（text, requestId, replyToMessageId, recipientIds）</li>
        <li><code>GET /api/notifications?status=pending</code> 待處理通知</li>
        <li><code>POST /api/notifications/:id/ack</code> 標記已處理</li>
      </ul>
      <p>完整說明：<a href="/docs/ai-guide.md" target="_blank" rel="noopener">AI 接入規格文件 (Markdown)</a></p>
      <b>快速測試</b>
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
      <label class="row" style="font-weight:400"><input type="checkbox" id="set-mine" style="width:auto" ${state.onlyMine ? 'checked' : ''}>只顯示與我或我的 AI 相關的訊息</label>
      <hr style="border:0;border-top:1px solid var(--border);width:100%">
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
      <p class="notice">提示：若用 localhost 開啟，手機無法連到；請用電腦的區網 IP 開啟本頁後再產生 QR Code。</p>`);
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
  if (state.token) start().catch(() => showJoin());
  else showJoin();
})();
