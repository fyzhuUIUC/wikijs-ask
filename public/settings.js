// wikijs-ask settings page (admins only; the API enforces it).
const zh = /^zh/i.test(navigator.language);
const L = zh ? {
  title: '问答设置', back: '← 回到 wiki', save: '保存', test: '测试连接', saving: '保存中…', saved: '已保存,立即生效',
  testing: '测试中…', denied: '只有 wiki 管理员能打开这一页。', login: '请先登录 wiki。',
  src: { default: '默认', env: '环境变量', saved: '已保存' }, reset: '恢复默认', keep: '留空则不修改', set: '已设置', unset: '未设置',
  clear: '清除', stats: '用量', conversations: '对话', messages: '消息', users: '用户', answers7d: '近 7 天回答',
  tokens: 'token(输入 / 输出)', running: '进行中 / 排队', guest1d: '游客提问 24h', guest7d: '游客提问 7 天', guestIps: '游客 IP 7 天',
  guestLog: '游客提问记录', more: '更多', none: '还没有记录', time: '时间', question: '问题', answer: '回答 / 错误', tools: '工具',
  sections: { model: '模型', web: '联网', behavior: '回答行为', limits: '并发与限制', guest: '游客', switch: '开关' },
} : {
  title: 'Q&A settings', back: '← back to wiki', save: 'Save', test: 'Test connection', saving: 'Saving…', saved: 'Saved, in effect now',
  testing: 'Testing…', denied: 'Only wiki administrators can open this page.', login: 'Please log in to the wiki first.',
  src: { default: 'default', env: 'environment', saved: 'saved' }, reset: 'reset', keep: 'leave empty to keep', set: 'set', unset: 'not set',
  clear: 'clear', stats: 'Usage', conversations: 'chats', messages: 'messages', users: 'users', answers7d: 'answers, last 7 days',
  tokens: 'tokens (in / out)', running: 'running / queued', guest1d: 'guest questions, 24h', guest7d: 'guest questions, 7 days', guestIps: 'guest IPs, 7 days',
  guestLog: 'Guest questions', more: 'More', none: 'Nothing yet', time: 'Time', question: 'Question', answer: 'Answer / error', tools: 'Tools',
  sections: { model: 'Model', web: 'Web tools', behavior: 'Answering', limits: 'Concurrency and limits', guest: 'Guests', switch: 'On / off' },
};

const F = zh ? {
  api_format: ['API 协议', 'anthropic = Messages 协议;openai = chat/completions 协议(如 OpenCode Go 上的 GLM)。'],
  base_url: ['API 地址', '留空 = Anthropic 官方。openai 协议填到 /v1 即可,会自动补 /chat/completions。'],
  session_header: ['会话头', '每个对话带一个固定 id 的请求头名,例如 OpenCode Go 要求的 x-opencode-session;留空 = 不发。'],
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
  guest_enabled: ['允许游客提问', '未登录也能问,只依据 Guests 组能看的页面。游客没有历史对话;每次提问连同 IP、UA、工具调用和回答都记在后台。'],
  guest_web: ['游客可用联网工具', '默认关:游客只能查 wiki。'],
  guest_per_ip_day: ['每 IP 每天', '同一 IP 24 小时内最多提问次数。'],
  guest_total_day: ['游客每天总量', '所有游客 24 小时内合计上限,控制花费。'],
  guest_history_turns: ['游客追问轮数', '同一个打开的面板里带入最近几轮;刷新页面即清空。'],
  guest_max_question_chars: ['游客问题字数上限', ''],
  guest_log_days: ['游客记录保留天数', '超过的自动删除。'],
} : {
  api_format: ['API format', 'anthropic = Messages API; openai = chat/completions (e.g. GLM on OpenCode Go).'],
  base_url: ['API base URL', 'Empty = Anthropic API. For openai, the /v1 base is enough; /chat/completions is added.'],
  session_header: ['Session header', 'Header carrying a stable id per chat, e.g. x-opencode-session for OpenCode Go; empty = none.'],
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
  guest_enabled: ['Allow guests', 'Visitors who are not logged in can ask, from pages the Guests group can read. No chat history for them; every question is logged here with IP, user agent, tool calls and answer.'],
  guest_web: ['Web tools for guests', 'Off by default: guests only get the wiki.'],
  guest_per_ip_day: ['Per IP per day', 'Questions one IP may ask in 24 hours.'],
  guest_total_day: ['Guest total per day', 'All guests together in 24 hours, to bound cost.'],
  guest_history_turns: ['Guest follow-up turns', 'Previous turns in the same open panel; a reload starts over.'],
  guest_max_question_chars: ['Guest max question length', ''],
  guest_log_days: ['Keep guest log (days)', 'Older rows are deleted.'],
};
const SECTIONS = {
  model: ['api_format', 'base_url', 'api_key', 'model', 'session_header', 'effort'],
  web: ['web_search', 'exa_api_key', 'web_search_results', 'web_fetch', 'web_fetch_via'],
  behavior: ['wiki_name', 'extra_instructions', 'max_turns', 'history_turns', 'page_char_cap'],
  limits: ['max_concurrent', 'max_queue', 'max_question_chars'],
  guest: ['guest_enabled', 'guest_web', 'guest_per_ip_day', 'guest_total_day', 'guest_history_turns', 'guest_max_question_chars', 'guest_log_days'],
  switch: ['enabled'],
};
const PRESETS = [
  ['Anthropic', { api_format: 'anthropic', base_url: '', session_header: '' }],
  ['z.ai (智谱)', { api_format: 'anthropic', base_url: 'https://api.z.ai/api/anthropic', session_header: '' }],
  ['OpenCode Go', { api_format: 'openai', base_url: 'https://opencode.ai/zen/go/v1', session_header: 'x-opencode-session' }],
];

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
      const extra = key === 'base_url' ? `<div class="presets">${PRESETS.map(([n], i) => `<button type="button" data-preset="${i}">${esc(n)}</button>`).join('')}</div>` : '';
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
    for (const [k, v] of Object.entries(PRESETS[b.dataset.preset][1])) { $(`#f-${k}`).value = v; patch[k] = v; }
    dirty();
  });
  main.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => { patch[b.dataset.reset] = null; save(); });
  main.querySelectorAll('[data-clear]').forEach(b => b.onclick = () => { patch[b.dataset.clear] = null; save(); });
  const log = document.createElement('div');
  log.className = 'card';
  log.innerHTML = `<h2>${L.guestLog}</h2><div class="glog" id="glog"></div>`;
  main.append(log);
  loadStats();
  loadGuestLog();
}

let guestBefore = null;
async function loadGuestLog(more) {
  const box = $('#glog');
  try {
    const { rows } = await api(`admin/guest-log${more && guestBefore ? `?before=${guestBefore}` : ''}`);
    if (!more) box.innerHTML = rows.length ? `<table><thead><tr><th>${L.time}</th><th>IP</th><th>${L.question}</th><th>${L.tools}</th><th>${L.answer}</th></tr></thead><tbody></tbody></table>` : `<p class="empty">${L.none}</p>`;
    const tb = box.querySelector('tbody');
    for (const r of rows) {
      const tools = r.tools.map(t => `${t.name}(${Object.values(t.input || {}).join(', ')})${t.ok === false ? ' ✗' : ''}`).join('\n');
      tb?.insertAdjacentHTML('beforeend', `<tr${r.error ? ' class="err"' : ''}>
        <td>${esc(new Date(r.created_at).toLocaleString())}<br><small>${esc(r.page || '')}</small></td>
        <td title="${esc(r.user_agent)}">${esc(r.ip)}<br><small>${esc(r.conversation_id.slice(0, 8))}</small></td>
        <td><div class="clip">${esc(r.question)}</div></td><td><div class="clip">${esc(tools)}</div></td>
        <td><div class="clip">${esc(r.error || r.answer || '')}</div></td></tr>`);
    }
    guestBefore = rows.length ? rows[rows.length - 1].id : guestBefore;
    box.querySelector('.more')?.remove();
    if (rows.length === 100) {
      box.insertAdjacentHTML('beforeend', `<button type="button" class="more">${L.more}</button>`);
      box.querySelector('.more').onclick = () => loadGuestLog(true);
    }
  } catch { /* optional */ }
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
      [s.guest_1d, L.guest1d], [s.guest_7d, L.guest7d], [s.guest_ips_7d, L.guestIps],
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
