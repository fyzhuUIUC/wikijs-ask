// Web tools: search via Exa, fetch via Exa /contents or directly.
//
// Direct fetch runs next to the wiki and its database, so every connection is
// checked at connect time (not just at DNS lookup, which a rebinding host could
// change): only public unicast addresses, http(s), ports 80/443, capped size.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const EXA = 'https://api.exa.ai';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 4;

async function exa(key, path, body, signal) {
  const r = await fetch(`${EXA}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Exa ${r.status}: ${out.error || out.message || 'request failed'}`);
  return out;
}

export async function webSearch(settings, query, signal) {
  if (!settings.exa_api_key) throw new Error('web search is not configured (no Exa API key)');
  const out = await exa(settings.exa_api_key, '/search', {
    query, type: 'auto', numResults: settings.web_search_results,
    contents: { text: { maxCharacters: 1200 } },
  }, signal);
  return (out.results || []).map(r => ({
    title: r.title || r.url, url: r.url, published: r.publishedDate || null,
    text: (r.text || '').replace(/\s+/g, ' ').trim(),
  }));
}

export async function webFetch(settings, url, maxChars, signal) {
  let u;
  try { u = new URL(url); } catch { throw new Error('not a valid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs');
  if (settings.web_fetch_via === 'exa') {
    if (!settings.exa_api_key) throw new Error('web fetch via Exa is not configured (no Exa API key)');
    const out = await exa(settings.exa_api_key, '/contents', { urls: [u.href], text: { maxCharacters: maxChars } }, signal);
    const st = (out.statuses || [])[0];
    const r = (out.results || [])[0];
    if (!r || (st && st.status !== 'success')) throw new Error(`could not fetch page${st?.error ? `: ${st.error.tag || st.error}` : ''}`);
    return { url: r.url || u.href, title: r.title || u.href, text: r.text || '' };
  }
  const page = await directFetch(u, signal);
  return { url: page.url, title: page.title || page.url, text: page.text.slice(0, maxChars) };
}

// ---------- direct fetch with connect-time address checks ----------

function publicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||        // CGNAT / tailnets
      (a === 169 && b === 254) ||                  // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)));
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return publicAddress(v.slice(7));
  return !(v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') ||
    v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff'));
}

function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    const ok = addrs.filter(a => publicAddress(a.address));
    if (!ok.length) return callback(new Error('blocked: address is not public'));
    if (options.all) return callback(null, ok);
    callback(null, ok[0].address, ok[0].family);
  });
}

function get(u, signal) {
  return new Promise((resolve, reject) => {
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && !publicAddress(u.hostname.replace(/^\[|\]$/g, ''))) {
      return reject(new Error('blocked: address is not public'));
    }
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (port !== '80' && port !== '443') return reject(new Error('blocked: only ports 80 and 443'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, {
      lookup: guardedLookup,
      signal,
      timeout: FETCH_TIMEOUT_MS,
      headers: { 'user-agent': 'wikijs-ask/1.0 (+web_fetch)', accept: 'text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.5' },
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(new Error('page too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

async function directFetch(u, signal) {
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const r = await get(u, signal);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      u = new URL(r.headers.location, u);
      if (!/^https?:$/.test(u.protocol)) throw new Error('redirect to a non-http URL');
      continue;
    }
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    const type = String(r.headers['content-type'] || '');
    const body = r.body.toString('utf8');
    if (/html|xml/.test(type) || /^\s*</.test(body)) {
      return { url: u.href, title: (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || '', text: htmlText(body) };
    }
    if (/^text\/|json/.test(type)) return { url: u.href, title: '', text: body };
    throw new Error(`unsupported content type ${type || 'unknown'}`);
  }
  throw new Error('too many redirects');
}

function htmlText(html) {
  const main = (html.match(/<(main|article)\b[\s\S]*?<\/\1>/i) || [html])[0];
  return main
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(+n)} `)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}
