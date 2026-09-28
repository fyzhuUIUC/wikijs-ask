// wikijs-ask HTTP service, mounted at /_ask/* on the wiki's own origin.
//
//   GET    /_ask/widget.js, /_ask/widget.css      the floating panel (static)
//   GET    /_ask/settings                         settings page (static; data needs admin)
//   GET    /_ask/me                               {email, admin}
//   POST   /_ask/chat                             {conversation_id?, question} -> text/event-stream
//   GET    /_ask/conversations                    own conversations
//   GET    /_ask/conversations/:id                messages
//   DELETE /_ask/conversations/:id
//   GET    /_ask/conversations/:id/export         markdown download
//   GET    /_ask/admin/settings                   (admin) effective settings, secrets masked
//   PUT    /_ask/admin/settings                   (admin) save a patch
//   POST   /_ask/admin/test                       (admin) test model settings
//   GET    /_ask/admin/stats                      (admin) usage totals
//
// Only logged-in Wiki.js users (jwt cookie). API requests must come from the
// wiki page itself: Origin (when sent) must equal ASK_ORIGIN, the custom
// X-Wiki-Ask header forces a CORS preflight that nothing answers, and
// Sec-Fetch-Site must be same-origin. History is read from the database,
// never taken from the client.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { ask, testConnection, AskError } from './agent.mjs';
import { whoami } from './wiki.mjs';
import * as config from './config.mjs';
import * as db from './db.mjs';

const PORT = Number(process.env.PORT || 8080);
const ORIGIN = process.env.ASK_ORIGIN;
if (!ORIGIN) { console.error('ASK_ORIGIN is required, e.g. https://wiki.example.org'); process.exit(1); }
const TIMEOUT_MS = 180_000;
const MAX_BODY = 50_000;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/_ask/widget.js': ['widget.js', 'text/javascript; charset=utf-8'],
  '/_ask/widget.css': ['widget.css', 'text/css; charset=utf-8'],
  '/_ask/settings': ['settings.html', 'text/html; charset=utf-8'],
  '/_ask/settings.js': ['settings.js', 'text/javascript; charset=utf-8'],
};

// ---------- concurrency gate (limits read live from settings) ----------
let running = 0;
const waiting = [];
function acquire() {
  if (running < config.get().max_concurrent) { running++; return Promise.resolve(); }
  return new Promise(resolve => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}

// ---------- helpers ----------
function cookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sameOrigin(req) {
  if (req.headers.origin !== undefined && req.headers.origin !== ORIGIN) return false;
  if (req.method !== 'GET' && req.headers.origin !== ORIGIN) return false;
  if (req.headers['x-wiki-ask'] !== '1') return false;
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin';
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('body too large');
  }
  return body ? JSON.parse(body) : {};
}

function errorCode(err, aborted) {
  if (aborted) return 'timeout';
  if (err instanceof AskError) return err.code;
  if (err instanceof Anthropic.RateLimitError) return 'rate_limited';
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return 'not_configured';
  if (err instanceof Anthropic.AnthropicError) return 'model_unavailable';
  return 'failed';
}

// ---------- chat ----------
async function chat(req, res, user, jwt) {
  const s = config.get();
  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid_json' }); }
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question) return json(res, 400, { error: 'question_required' });
  if (question.length > s.max_question_chars) return json(res, 413, { error: 'too_long' });
  if (!s.enabled) return json(res, 503, { error: 'disabled' });

  let conv = null;
  if (body.conversation_id) {
    conv = await db.getConversation(user.id, String(body.conversation_id));
    if (!conv) return json(res, 404, { error: 'conversation_not_found' });
  }
  if (waiting.length >= s.max_queue) return json(res, 503, { error: 'busy' });

  const history = s.history_turns ? (conv?.messages || []).slice(-2 * s.history_turns).map(m => ({ role: m.role, content: m.content })) : [];
  const messages = [...history, { role: 'user', content: question }];

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  res.on('close', () => ac.abort());
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const started = Date.now();
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (running >= s.max_concurrent) send('status', { code: 'queued' });
  await acquire();
  let answer = '', sources = [];
  try {
    for await (const ev of ask({ jwt, messages, signal: ac.signal })) {
      const { type, ...rest } = ev;
      if (type === 'text') answer += rest.delta;
      if (type === 'sources') sources = rest.pages;
      if (type === 'done') {
        if (!answer.trim()) throw new AskError('no_answer');
        if (!conv) conv = await db.createConversation(user, question.replace(/\s+/g, ' ').slice(0, 60));
        await db.appendExchange(conv.id, question, answer, sources, rest.usage);
        send('saved', { conversation_id: conv.id, title: conv.title });
        console.log(JSON.stringify({ ts: new Date().toISOString(), user: user.email, ip, conv: conv.id, ms: Date.now() - started, ...rest.usage }));
      }
      send(type, rest);
    }
  } catch (err) {
    console.error('ask failed:', user.email, err);
    send('error', { code: errorCode(err, ac.signal.aborted) });   // details stay in the log
  } finally {
    release();
    clearTimeout(timer);
    res.end();
  }
}

// ---------- admin ----------
async function admin(req, res, user, route) {
  if (!user.admin) return json(res, 403, { error: 'admin_only' });
  if (route === 'settings' && req.method === 'GET') return json(res, 200, { settings: config.describe() });
  if (route === 'settings' && req.method === 'PUT') {
    try {
      await config.save((await readBody(req)).settings, user);
      return json(res, 200, { settings: config.describe() });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (route === 'test' && req.method === 'POST') {
    try {
      return json(res, 200, { ok: true, ...(await testConnection(config.preview((await readBody(req)).settings))) });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (route === 'stats' && req.method === 'GET') return json(res, 200, { ...(await db.stats()), running, queued: waiting.length });
  return json(res, 404, { error: 'not_found' });
}

// ---------- routing ----------
async function route(req, res) {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname === '/_ask/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=300' });
    return res.end(await readFile(path.join(PUBLIC, file)));
  }
  if (!sameOrigin(req)) return json(res, 403, { error: 'forbidden' });

  const jwt = cookie(req, 'jwt');
  const user = await whoami(jwt);
  if (!user) return json(res, 401, { error: 'login_required' });

  if (url.pathname === '/_ask/me' && req.method === 'GET') {
    return json(res, 200, { email: user.email, name: user.name, admin: user.admin, enabled: config.get().enabled });
  }
  if (url.pathname === '/_ask/chat' && req.method === 'POST') return chat(req, res, user, jwt);
  if (url.pathname === '/_ask/conversations' && req.method === 'GET') {
    return json(res, 200, { conversations: await db.listConversations(user.id) });
  }
  const a = url.pathname.match(/^\/_ask\/admin\/(settings|test|stats)$/);
  if (a) return admin(req, res, user, a[1]);
  const m = url.pathname.match(/^\/_ask\/conversations\/([0-9a-f-]{36})(\/export)?$/i);
  if (m) {
    if (req.method === 'DELETE' && !m[2]) {
      return (await db.deleteConversation(user.id, m[1])) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not_found' });
    }
    if (req.method === 'GET') {
      const conv = await db.getConversation(user.id, m[1]);
      if (!conv) return json(res, 404, { error: 'not_found' });
      if (!m[2]) return json(res, 200, conv);
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="wiki-ask-${conv.created_at.toISOString().slice(0, 10)}.md"`,
        'cache-control': 'no-store',
      });
      return res.end(db.toMarkdown(conv, ORIGIN));
    }
  }
  return json(res, 404, { error: 'not_found' });
}

await db.init();
await config.load();
http.createServer((req, res) => {
  route(req, res).catch(err => {
    console.error('request failed:', err);
    if (!res.headersSent) json(res, 500, { error: 'internal' }); else res.end();
  });
}).listen(PORT, () => console.log(`wikijs-ask on :${PORT}`));
