// wikijs-ask settings page (admins only; the API enforces it).
const zh = /^zh/i.test(navigator.language);
const L = zh ? {
  title: '问答设置', back: '← 回到 wiki', save: '保存', test: '测试连接', saving: '保存中…', saved: '已保存,立即生效',
  testing: '测试中…', denied: '只有 wiki 管理员能打开这一页。', login: '请先登录 wiki。',
  src: { default: '默认', env: '环境变量', saved: '已保存' }, reset: '恢复默认', keep: '留空则不修改', set: '已设置', unset: '未设置',
  clear: '清除', stats: '用量', conversations: '对话', messages: '消息', users: '用户', answers7d: '近 7 天回答',
  tokens: 'token(输入 / 输出)', running: '进行中 / 排队',
  sections: { model: '模型', web: '联网', behavior: '回答行为', limits: '并发与限制', switch: '开关' },
} : {
  title: 'Q&A settings', back: '← back to wiki', save: 'Save', test: 'Test connection', saving: 'Saving…', saved: 'Saved, in effect now',
  testing: 'Testing…', denied: 'Only wiki administrators can open this page.', login: 'Please log in to the wiki first.',
  src: { default: 'default', env: 'environment', saved: 'saved' }, reset: 'reset', keep: 'leave empty to keep', set: 'set', unset: 'not set',
  clear: 'clear', stats: 'Usage', conversations: 'chats', messages: 'messages', users: 'users', answers7d: 'answers, last 7 days',
  tokens: 'tokens (in / out)', running: 'running / queued',
  sections: { model: 'Model', web: 'Web tools', behavior: 'Answering', limits: 'Concurrency and limits', switch: 'On / off' },
};

const F = zh ? {
  base_url: ['API 地址', 'Anthropic Messages 协议的端点。留空 = Anthropic 官方。'],
  api_key: ['API key', '保存在数据库里,只显示末四位。'],
  model: ['模型', '留空时,Anthropic 官方默认 claude-opus-5;其它端点必须填写。'],
  effort: ['思考强度', '只有 Anthropic 官方模型支持;留空 = 模型默认。'],
  web_search: ['网络搜索', '开启后模型可用 web_search 工具(Exa)。'],
  exa_api_key: ['Exa API key', 'web_search 必需;web_fetch 选 Exa 时也用它。'],
  web_search_results: ['每次搜索结果数', ''],
  web_fetch: ['打开网页', '开启后模型可用 web_fetch 工具读取网页。'],
  web_fetch_via: ['打开网页的方式', 'exa = 经 Exa 内容接口(不从本机发请求);direct = 本机直接抓取(只允许公网地址)。'],
  wiki_name: ['wiki 名称', '写进提示词,例如「某某实验室 wiki」。'],
  extra_instructions: ['附加提示词', '追加在系统提示词末尾。'],
  max_turns: ['最多轮数', '模型最多调用工具的轮数(最后一轮不给工具)。'],
  history_turns: ['带入的历史轮数', '同一对话里,最近多少轮问答一起发给模型。'],
  page_char_cap: ['单页字数上限', '读 wiki 页或网页时最多给模型多少字。'],
  max_question_chars: ['问题字数上限', ''],
  max_concurrent: ['全局并发', '同时进行的问答数,其余排队。'],
  max_queue: ['最大排队数', '排满后新问题直接提示稍后再试。'],
  enabled: ['启用问答', '关闭后挂件仍在,但不回答。'],
} : {
  base_url: ['API base URL', 'An Anthropic Messages endpoint. Empty = Anthropic API.'],
  api_key: ['API key', 'Stored in the database; only the last four characters are shown.'],
  model: ['Model', 'Empty = claude-opus-5 on the Anthropic API; required for other endpoints.'],
  effort: ['Effort', 'Anthropic models only; empty = model default.'],
  web_search: ['Web search', 'Lets the model use the web_search tool (Exa).'],
  exa_api_key: ['Exa API key', 'Required for web_search, and for web_fetch via Exa.'],
  web_search_results: ['Results per search', ''],
  web_fetch: ['Web fetch', 'Lets the model read web pages with the web_fetch tool.'],
  web_fetch_via: ['Fetch method', 'exa = through Exa contents API (no request from this server); direct = this server fetches (public addresses only).'],
  wiki_name: ['Wiki name', 'Used in the system prompt, e.g. "the ACME lab wiki".'],
  extra_instructions: ['Extra instructions', 'Appended to the system prompt.'],
  max_turns: ['Max turns', 'Tool-use rounds per answer (the last one has no tools).'],
  history_turns: ['History turns', 'Previous Q&A pairs of the same chat sent to the model.'],
  page_char_cap: ['Characters per page', 'Maximum text of one wiki or web page given to the model.'],
  max_question_chars: ['Max question length', ''],
  max_concurrent: ['Concurrency', 'Answers running at once; the rest wait.'],
  max_queue: ['Max queue', 'When full, new questions get "try again later".'],
  enabled: ['Enabled', 'When off the panel stays but does not answer.'],
};
const SECTIONS = {
  model: ['base_url', 'api_key', 'model', 'effort'],
  web: ['web_search', 'exa_api_key', 'web_search_results', 'web_fetch', 'web_fetch_via'],
  behavior: ['wiki_name', 'extra_instructions', 'max_turns', 'history_turns', 'page_char_cap'],
  limits: ['max_concurrent', 'max_queue', 'max_question_chars'],
  switch: ['enabled'],
};
const PRESETS = [['Anthropic', ''], ['z.ai (智谱)', 'https://api.z.ai/api/anthropic']];

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
document.title = L.title;
$('#h-title').textContent = L.title;
$('#h-back').textContent = L.back;
$('#btn-save').textContent = L.save;
$('#btn-test').textContent = L.test;

async function api(path, opts = {}) {
  const r = await fetch(`/_ask/${path}`, {
    ...opts, credentials: 'same-origin',
    headers: { 'x-wiki-ask': '1', ...(opts.body ? { 'content-type': 'application/json' } : {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || `HTTP ${r.status}`), { status: r.status });
  return body;
}

let settings = {};
const patch = {};          // key -> value, or null = reset

function control(key, s) {
  const id = `f-${key}`;
  const v = s.value;
  switch (s.type) {
    case 'bool': return `<label><input type="checkbox" id="${id}" ${v ? 'checked' : ''}></label>`;
    case 'enum': return `<select id="${id}">${s.options.map(o => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(o || '—')}</option>`).join('')}</select>`;
    case 'int': return `<input type="number" id="${id}" value="${esc(v)}" min="${s.min}" max="${s.max}">`;
    case 'text': return `<textarea id="${id}">${esc(v)}</textarea>`;
    case 'secret': return `<input type="password" id="${id}" placeholder="${esc(s.set ? `${L.set} ${s.hint} · ${L.keep}` : L.unset)}" autocomplete="new-password">`;
    default: return `<input type="text" id="${id}" value="${esc(v)}" spellcheck="false">`;
  }
}

function render() {
  const main = $('#main');
  main.innerHTML = '<div class="card"><h2>' + L.stats + '</h2><div class="stats" id="stats"></div></div>';
  for (const [sec, keys] of Object.entries(SECTIONS)) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h2>${L.sections[sec]}</h2>` + keys.map(key => {
      const s = settings[key];
      const [label, help] = F[key];
      const extra = key === 'base_url' ? `<div class="presets">${PRESETS.map(([n, u]) => `<button type="button" data-preset="${esc(u)}">${esc(n)}</button>`).join('')}</div>` : '';
      const clear = s.type === 'secret' && s.source === 'saved' ? `<button type="button" data-clear="${key}">${L.clear}</button>` : '';
      return `<div class="row"><div class="label"><b>${label}</b><small>${help}</small></div>
        <div class="ctl">${control(key, s)}${extra}
          <div class="meta"><span class="src ${s.source}">${L.src[s.source]}</span>
          ${s.source === 'saved' ? `<button type="button" data-reset="${key}">${L.reset}</button>` : ''}${clear}</div></div></div>`;
    }).join('');
    main.append(card);
  }

  main.querySelectorAll('input, select, textarea').forEach(el => {
    const key = el.id.slice(2);
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      const s = settings[key];
      patch[key] = s.type === 'bool' ? el.checked : s.type === 'int' ? Number(el.value) : el.value;
      dirty();
    });
  });
  main.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
    $('#f-base_url').value = b.dataset.preset; patch.base_url = b.dataset.preset; dirty();
  });
  main.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => { patch[b.dataset.reset] = null; save(); });
  main.querySelectorAll('[data-clear]').forEach(b => b.onclick = () => { patch[b.dataset.clear] = null; save(); });
  loadStats();
}

function dirty(keepMsg) {
  if (!keepMsg) $('#msg').textContent = '';
  $('#btn-save').disabled = !Object.keys(patch).length;
}

async function loadStats() {
  try {
    const s = await api('admin/stats');
    $('#stats').innerHTML = [
      [s.conversations, L.conversations], [s.messages, L.messages], [s.users, L.users], [s.answers_7d, L.answers7d],
      [`${Number(s.input_tokens).toLocaleString()} / ${Number(s.output_tokens).toLocaleString()}`, L.tokens],
      [`${s.running} / ${s.queued}`, L.running],
    ].map(([v, k]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
  } catch { /* stats are optional */ }
}

async function save() {
  const btn = $('#btn-save');
  btn.disabled = true;
  $('#msg').className = ''; $('#msg').textContent = L.saving;
  try {
    settings = (await api('admin/settings', { method: 'PUT', body: JSON.stringify({ settings: patch }) })).settings;
    for (const k of Object.keys(patch)) delete patch[k];
    render();
    $('#msg').className = 'ok'; $('#msg').textContent = L.saved;
  } catch (e) {
    $('#msg').className = 'bad'; $('#msg').textContent = e.message;
  } finally {
    dirty(true);
  }
}

async function test() {
  const out = $('#msg');
  out.className = ''; out.textContent = L.testing;
  try {
    const r = await api('admin/test', { method: 'POST', body: JSON.stringify({ settings: patch }) });
    out.className = r.ok ? 'ok' : 'bad';
    out.textContent = r.ok ? `✓ ${r.model} · ${r.ms} ms · "${r.text}"` : `✗ ${r.error}`;
  } catch (e) {
    out.className = 'bad'; out.textContent = e.message;
  }
}

(async () => {
  try {
    settings = (await api('admin/settings')).settings;
  } catch (e) {
    $('#main').innerHTML = `<div class="denied">${e.status === 401 ? L.login : L.denied}</div>`;
    return;
  }
  $('#bar').hidden = false;
  $('#btn-save').onclick = save;
  $('#btn-test').onclick = test;
  render();
  dirty(true);
})();
