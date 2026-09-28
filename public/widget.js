// wikijs-ask floating panel. Load on every wiki page:  <script defer src="/_ask/widget.js"></script>
// Conversations live on the server; the browser remembers only which one is open and the panel size.
(() => {
  if (window.__wikiAsk || location.pathname.startsWith('/login') || location.pathname.startsWith('/_ask/')) return;
  window.__wikiAsk = true;

  const CDN = 'https://cdn.jsdelivr.net/npm';
  const zh = /^zh/i.test(document.documentElement.lang || navigator.language);
  const T = zh ? {
    title: '问问这个 wiki', history: '历史对话', new: '新对话', export: '导出 Markdown', max: '放大', restore: '还原',
    close: '关闭', settings: '设置', resize: '拖动调整大小', send: '发送',
    placeholder: '输入问题(Enter 发送,Shift+Enter 换行)',
    hint: '回答依据你有权限看的 wiki 页面,并附上出处。<br>对话会保存,点历史图标可以找回。',
    empty: '还没有对话', loading: '加载中…', rounds: '轮', del: q => `删除「${q}」?`, nothing: '当前对话还没有内容',
    sources: '出处', connecting: '连接中…', thinking: '思考中…', reading: '查阅中…', queued: '排队中…',
    tool: { search_pages: q => `搜索 wiki「${q.query}」`, read_page: q => `阅读 /${q.locale}/${q.path}`, web_search: q => `搜索网络「${q.query}」`, web_fetch: q => `打开 ${q.url}` },
    err: { login_required: '请先登录', too_long: '问题太长了', busy: '排队的人太多,稍后再试', disabled: '问答已关闭',
      not_configured: '问答还没配置好模型', rate_limited: '模型服务繁忙,稍后再试', model_unavailable: '模型服务暂时不可用',
      timeout: '超时或已取消', refusal: '模型拒绝回答这个问题', too_long_answer: '回答超出长度上限', no_answer: '没有得到回答',
      not_found: '对话不存在', conversation_not_found: '对话不存在', failed: '出错了' },
  } : {
    title: 'Ask this wiki', history: 'History', new: 'New chat', export: 'Export Markdown', max: 'Maximize', restore: 'Restore',
    close: 'Close', settings: 'Settings', resize: 'Drag to resize', send: 'Send',
    placeholder: 'Ask a question (Enter to send, Shift+Enter for a new line)',
    hint: 'Answers come from wiki pages you can read, with sources.<br>Chats are saved; open them again from History.',
    empty: 'No chats yet', loading: 'Loading…', rounds: 'turns', del: q => `Delete "${q}"?`, nothing: 'This chat is empty',
    sources: 'Sources', connecting: 'Connecting…', thinking: 'Thinking…', reading: 'Reading…', queued: 'Queued…',
    tool: { search_pages: q => `Searching the wiki: ${q.query}`, read_page: q => `Reading /${q.locale}/${q.path}`, web_search: q => `Searching the web: ${q.query}`, web_fetch: q => `Opening ${q.url}` },
    err: { login_required: 'Please log in first', too_long: 'Question is too long', busy: 'Too many people waiting, try again later', disabled: 'Q&A is turned off',
      not_configured: 'No model is configured yet', rate_limited: 'Model service is busy, try again later', model_unavailable: 'Model service is unavailable',
      timeout: 'Timed out or cancelled', refusal: 'The model declined to answer', too_long_answer: 'Answer exceeded the length limit', no_answer: 'No answer',
      not_found: 'Chat not found', conversation_not_found: 'Chat not found', failed: 'Something went wrong' },
  };

  const store = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  let convId = store.get('wiki-ask-conv');
  let messages = [];
  let busy = false;

  // ---------- markdown + math + code ----------
  for (const href of [`${CDN}/katex@0.18.7/dist/katex.min.css`, `${CDN}/@highlightjs/cdn-assets@11/styles/github.min.css`, '/_ask/widget.css']) {
    document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
  }
  const libs = Promise.all([
    import(`${CDN}/marked@12/+esm`),
    import(`${CDN}/dompurify@3/+esm`),
    import(`${CDN}/marked-katex-extension@5/+esm`),
    import(`${CDN}/marked-highlight@2/+esm`),
    import(`${CDN}/@highlightjs/cdn-assets@11/es/highlight.min.js`),
  ]).then(([m, p, k, mh, h]) => {
    const hljs = h.default;
    const md = new m.Marked(
      mh.markedHighlight({
        langPrefix: 'hljs language-',
        highlight: (code, lang) => (lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }) : hljs.highlightAuto(code)).value,
      }),
      k.default({ throwOnError: false, nonStandard: true }),
      { gfm: true, breaks: false },
    );
    return { md, purify: p.default };
  }).catch(err => { console.warn('wikijs-ask: renderer failed to load', err); return null; });

  // \( \) and \[ \] -> $ / $$, outside code
  function normalizeMath(src) {
    return src.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map((part, i) => (i % 2 ? part
      : part.replace(/\\\[([\s\S]+?)\\\]/g, (_, x) => `\n$$\n${x.trim()}\n$$\n`).replace(/\\\(([\s\S]+?)\\\)/g, (_, x) => `$${x.trim()}$`))).join('');
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function render(el, src) {
    const l = await libs;
    el.innerHTML = l ? l.purify.sanitize(l.md.parse(normalizeMath(src))) : esc(src).replace(/\n/g, '<br>');
    el.querySelectorAll('a[href^="http"]').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  }

  // ---------- api ----------
  async function api(path, opts = {}) {
    const r = await fetch(`/_ask/${path}`, {
      ...opts, credentials: 'same-origin',
      headers: { 'x-wiki-ask': '1', ...(opts.body ? { 'content-type': 'application/json' } : {}), ...opts.headers },
    });
    if (!r.ok) {
      const code = (await r.json().catch(() => ({}))).error || 'failed';
      throw Object.assign(new Error(T.err[code] || `${T.err.failed} (${r.status})`), { code });
    }
    return r;
  }

  // ---------- DOM ----------
  const icon = d => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
  const I = {
    chat: 'M12 3C6.5 3 2 6.6 2 11c0 2.3 1.2 4.3 3.1 5.8L4 21l4.6-2.4c1.1.3 2.2.4 3.4.4 5.5 0 10-3.6 10-8s-4.5-8-10-8zm-4 9.2a1.2 1.2 0 110-2.4 1.2 1.2 0 010 2.4zm4 0a1.2 1.2 0 110-2.4 1.2 1.2 0 010 2.4zm4 0a1.2 1.2 0 110-2.4 1.2 1.2 0 010 2.4z',
    history: 'M13 3a9 9 0 00-9 9H1l3.9 3.9L9 12H6a7 7 0 112 4.9l-1.4 1.4A9 9 0 1013 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8z',
    add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
    download: 'M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z',
    max: 'M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z',
    min: 'M8 4h2v6H4V8h4V4zm6 0h2v4h4v2h-6V4zM4 14h6v6H8v-4H4v-2zm10 0h6v2h-4v4h-2v-6z',
    close: 'M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z',
    trash: 'M6 19a2 2 0 002 2h8a2 2 0 002-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    gear: 'M19.4 13a7.5 7.5 0 000-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 00-1.7-1L15 3h-4l-.4 2.9a7.4 7.4 0 00-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 000 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L11 21h4l.4-2.9c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5-2.2-1.6zM13 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z',
  };

  const fab = document.createElement('button');
  fab.className = 'wa-fab';
  fab.title = T.title;
  fab.innerHTML = icon(I.chat).replace(/18/g, '26');

  const panel = document.createElement('div');
  panel.className = 'wa-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="wa-grip" title="${T.resize}"></div>
    <div class="wa-head"><span class="wa-title"></span><span class="wa-tools">
      <a data-act="settings" href="/_ask/settings" target="_blank" title="${T.settings}" hidden>${icon(I.gear)}</a>
      <button data-act="history" title="${T.history}">${icon(I.history)}</button>
      <button data-act="new" title="${T.new}">${icon(I.add)}</button>
      <button data-act="export" title="${T.export}">${icon(I.download)}</button>
      <button data-act="max" title="${T.max}">${icon(I.max)}</button>
      <button data-act="close" title="${T.close}">${icon(I.close)}</button></span></div>
    <div class="wa-log"></div>
    <div class="wa-list" hidden></div>
    <form class="wa-form"><textarea rows="2" placeholder="${T.placeholder}"></textarea><button type="submit">${T.send}</button></form>`;
  document.body.append(fab, panel);

  const $ = s => panel.querySelector(s);
  const log = $('.wa-log'), list = $('.wa-list'), form = $('.wa-form'), input = form.querySelector('textarea');
  const titleEl = $('.wa-title');
  titleEl.textContent = T.title;

  // ---------- size: maximize + free resize from the top-right grip ----------
  function applySize() {
    const saved = JSON.parse(store.get('wiki-ask-size') || 'null');
    if (saved && !panel.classList.contains('wa-max')) {
      panel.style.width = `${Math.min(saved.w, innerWidth - 40)}px`;
      panel.style.height = `${Math.min(saved.h, innerHeight - 110)}px`;
    } else {
      panel.style.width = panel.style.height = '';
    }
  }
  function setMax(on) {
    panel.classList.toggle('wa-max', on);
    const b = $('[data-act="max"]');
    b.innerHTML = icon(on ? I.min : I.max);
    b.title = on ? T.restore : T.max;
    store.set('wiki-ask-max', on ? '1' : null);
    applySize();
  }
  setMax(store.get('wiki-ask-max') === '1');

  $('.wa-grip').addEventListener('pointerdown', e => {
    if (panel.classList.contains('wa-max')) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const r = panel.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY;
    const move = ev => {
      const w = Math.max(320, Math.min(innerWidth - r.left - 8, r.width + ev.clientX - x0));
      const h = Math.max(320, Math.min(r.bottom - 8, r.height - (ev.clientY - y0)));
      panel.style.width = `${w}px`;
      panel.style.height = `${h}px`;
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      const b = panel.getBoundingClientRect();
      store.set('wiki-ask-size', JSON.stringify({ w: Math.round(b.width), h: Math.round(b.height) }));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  $('.wa-grip').addEventListener('dblclick', () => { store.set('wiki-ask-size', null); applySize(); });

  // ---------- chat view ----------
  function sourcesHtml(sources) {
    if (!sources?.length) return '';
    return `<div class="wa-src">${T.sources}: ` + sources.map(s => s.url
      ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" class="wa-web">${esc(s.title || s.url)}</a>`
      : `<a href="/${esc(s.locale)}/${esc(s.path)}">${esc(s.title)}</a>`).join(' · ') + '</div>';
  }

  function bubble(m) {
    const d = document.createElement('div');
    d.className = `wa-msg wa-${m.role}`;
    const body = document.createElement('div');
    body.className = 'wa-body';
    d.append(body);
    if (m.role === 'user') body.textContent = m.content;
    else render(body, m.content).then(() => body.insertAdjacentHTML('beforeend', sourcesHtml(m.sources)));
    log.append(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  function showChat(title) {
    list.hidden = true; log.hidden = false; form.hidden = false;
    titleEl.textContent = title || T.title;
    log.innerHTML = messages.length ? '' : `<div class="wa-hint">${T.hint}</div>`;
    messages.forEach(bubble);
  }

  async function openConv(id) {
    try {
      const conv = await (await api(`conversations/${id}`)).json();
      convId = conv.id; store.set('wiki-ask-conv', convId);
      messages = conv.messages;
      showChat(conv.title);
    } catch (e) {
      if (e.code === 'not_found') { convId = null; store.set('wiki-ask-conv', null); messages = []; showChat(); }
      else { showChat(); log.innerHTML = `<div class="wa-hint wa-err">${esc(e.message)}</div>`; }
    }
  }

  function newConv() {
    if (busy) return;
    convId = null; store.set('wiki-ask-conv', null); messages = [];
    showChat(); input.focus();
  }

  async function showHistory() {
    if (busy) return;
    log.hidden = true; form.hidden = true; list.hidden = false;
    titleEl.textContent = T.history;
    list.innerHTML = `<div class="wa-hint">${T.loading}</div>`;
    try {
      const { conversations } = await (await api('conversations')).json();
      if (!conversations.length) { list.innerHTML = `<div class="wa-hint">${T.empty}</div>`; return; }
      list.innerHTML = '';
      for (const c of conversations) {
        const row = document.createElement('div');
        row.className = 'wa-row' + (c.id === convId ? ' wa-current' : '');
        row.innerHTML = `<div class="wa-row-main"><div class="wa-row-title">${esc(c.title)}</div>
          <div class="wa-row-meta">${new Date(c.updated_at).toLocaleString()} · ${c.messages / 2} ${T.rounds}</div></div>
          <button title="${T.del('')}">${icon(I.trash)}</button>`;
        row.querySelector('.wa-row-main').onclick = () => openConv(c.id);
        row.querySelector('button').onclick = async () => {
          if (!confirm(T.del(c.title))) return;
          await api(`conversations/${c.id}`, { method: 'DELETE' });
          if (c.id === convId) { convId = null; store.set('wiki-ask-conv', null); messages = []; }
          showHistory();
        };
        list.append(row);
      }
    } catch (e) {
      list.innerHTML = `<div class="wa-hint wa-err">${esc(e.message)}</div>`;
    }
  }

  async function exportMd() {
    if (!convId) { alert(T.nothing); return; }
    try {
      const r = await api(`conversations/${convId}/export`);
      const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'wiki-ask.md';
      const url = URL.createObjectURL(await r.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { alert(e.message); }
  }

  let meChecked = false;
  async function checkMe() {
    if (meChecked) return;
    meChecked = true;
    try { if ((await (await api('me')).json()).admin) $('[data-act="settings"]').hidden = false; } catch { /* not logged in */ }
  }

  fab.onclick = () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { checkMe(); convId ? openConv(convId) : showChat(); input.focus(); }
  };
  $('.wa-tools').onclick = e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') panel.hidden = true;
    else if (act === 'max') setMax(!panel.classList.contains('wa-max'));
    else if (act === 'new') newConv();
    else if (act === 'history') list.hidden ? showHistory() : (convId ? openConv(convId) : showChat());
    else if (act === 'export') exportMd();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  addEventListener('resize', () => { if (!panel.hidden) applySize(); });

  form.onsubmit = async e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || busy) return;
    busy = true;
    input.value = '';
    if (!messages.length) log.innerHTML = '';
    bubble({ role: 'user', content: q });

    const box = bubble({ role: 'assistant', content: '' });
    const body = box.querySelector('.wa-body');
    const status = document.createElement('div');
    status.className = 'wa-status';
    status.textContent = T.connecting;
    box.prepend(status);
    let answer = '', sources = [], pending = false;
    const paint = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(async () => { pending = false; await render(body, answer); log.scrollTop = log.scrollHeight; });
    };

    try {
      const r = await api('chat', { method: 'POST', body: JSON.stringify({ conversation_id: convId, question: q }) });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = (chunk.match(/^event: (.*)$/m) || [])[1];
          const data = JSON.parse((chunk.match(/^data: (.*)$/m) || [])[1] || '{}');
          if (ev === 'status') status.textContent = T[data.code] || T.thinking;
          else if (ev === 'tool') status.textContent = (T.tool[data.name] || (() => data.name))(data.input || {});
          else if (ev === 'text') { answer += data.delta; paint(); }
          else if (ev === 'sources') sources = data.pages;
          else if (ev === 'saved') { convId = data.conversation_id; store.set('wiki-ask-conv', convId); titleEl.textContent = data.title; }
          else if (ev === 'error') throw Object.assign(new Error(T.err[data.code] || T.err.failed), { code: data.code });
          else if (ev === 'done') status.remove();
        }
      }
      if (!answer) throw new Error(T.err.no_answer);
      messages.push({ role: 'user', content: q }, { role: 'assistant', content: answer, sources });
      await render(body, answer);
      body.insertAdjacentHTML('beforeend', sourcesHtml(sources));
    } catch (err) {
      status.remove();
      body.innerHTML = `<span class="wa-err">${esc(err.message)}</span>`;
      input.value = q;                        // unanswered questions are not saved; let the user retry
    } finally {
      busy = false;
    }
  };
})();
