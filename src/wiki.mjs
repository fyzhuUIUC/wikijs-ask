// Everything here runs with the asking user's own Wiki.js JWT, so Wiki.js
// itself decides what they may see: pages.list / pages.search filter by
// read:pages, and a page they cannot read comes back as 403.

const WIKI = process.env.WIKI_INTERNAL_URL || 'http://wiki:3000';

async function gql(jwt, query, variables = {}) {
  const r = await fetch(`${WIKI}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `jwt=${jwt}` },
    body: JSON.stringify({ query, variables }),
  });
  const out = await r.json();
  if (out.errors?.length) throw new Error(out.errors[0].message);
  return out.data;
}

// null for guests / expired tokens. admin = has manage:system (the query below requires it).
export async function whoami(jwt) {
  if (!jwt) return null;
  let profile;
  try {
    const d = await gql(jwt, '{users{profile{id email name}}}');
    profile = d.users.profile?.id ? d.users.profile : null;
  } catch {
    return null;
  }
  if (!profile) return null;
  let admin = false;
  try { await gql(jwt, '{system{info{currentVersion}}}'); admin = true; } catch { /* not an admin */ }
  return { ...profile, admin };
}

// pages.list checks access by path only (Wiki.js 2.5), so pages opened up by a tag rule, which
// is how Guests usually get read access, never appear in it. pages.search passes the tags along;
// with an empty query the basic search engine returns every page, up to its "max hits" setting.
export async function listPages(jwt) {
  const [list, found] = await Promise.all([
    gql(jwt, '{pages{list(limit:5000,orderBy:PATH){id locale path title description updatedAt}}}').then(d => d.pages.list),
    gql(jwt, '{pages{search(query:""){results{id locale path title description}}}}').then(d => d.pages.search.results).catch(() => []),
  ]);
  const seen = new Set(list.map(p => `${p.locale}/${p.path}`));
  const extra = found.filter(p => !seen.has(`${p.locale}/${p.path}`)).map(p => ({ ...p, updatedAt: null }));
  return [...list, ...extra].sort((a, b) => `${a.locale}/${a.path}`.localeCompare(`${b.locale}/${b.path}`));
}

// Page text cache keyed by locale/path@updatedAt. Content does not depend on
// who fetched it; access is enforced by only searching pages in this
// user's own listPages() result.
const textCache = new Map();

// Pages found only through search have no updatedAt; their text is refetched every 5 minutes.
async function pageText(jwt, p) {
  const key = `${p.locale}/${p.path}@${p.updatedAt ?? `t${Math.floor(Date.now() / 300_000)}`}`;
  if (!textCache.has(key)) {
    for (const k of textCache.keys()) if (k.startsWith(`${p.locale}/${p.path}@`)) textCache.delete(k);
    textCache.set(key, (await readPage(jwt, p.locale, p.path)).text);
  }
  return textCache.get(key);
}

// Wiki.js' default search engine only matches title/description, so search the
// full text of every page the user can read.
export async function searchPages(jwt, query, locale, limit = 10) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const pages = (await listPages(jwt)).filter(p => !locale || p.locale === locale);
  const hits = [];
  for (let i = 0; i < pages.length; i += 8) {
    await Promise.all(pages.slice(i, i + 8).map(async p => {
      let text;
      try { text = await pageText(jwt, p); } catch { return; }
      const hay = `${p.title}\n${p.description}\n${text}`.toLowerCase();
      let score = 0, first = -1;
      for (const t of terms) {
        let at = hay.indexOf(t), n = 0;
        if (at >= 0 && (first < 0 || at < first)) first = at;
        while (at >= 0) { n++; at = hay.indexOf(t, at + t.length); }
        if (n === 0) return;                       // every term must occur
        score += n;
      }
      const snippet = `${p.title}\n${p.description}\n${text}`.slice(Math.max(0, first - 80), first + 160).replace(/\s+/g, ' ');
      hits.push({ locale: p.locale, path: p.path, title: p.title, snippet, score });
    }));
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function readPage(jwt, locale, path) {
  // accept "some/page", "/some/page" or "/<locale>/some/page"
  let clean = String(path).replace(/^\/+/, '');
  if (clean.startsWith(`${locale}/`)) clean = clean.slice(locale.length + 1);
  const r = await fetch(`${WIKI}/${encodeURIComponent(locale)}/${clean.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { cookie: `jwt=${jwt}` },
    redirect: 'manual',
  });
  if (r.status === 403) throw new Error('no permission to read this page');
  if (r.status !== 200) throw new Error(`page not found (${r.status})`);
  const html = await r.text();
  const m = html.match(/<template slot="contents">([\s\S]*?)<\/template>/);
  if (!m) throw new Error('page not found');
  const title = (html.match(/<page\b[^>]*\btitle="([^"]*)"/) || [])[1] || clean;
  return { locale, path: clean, title: decode(title), text: htmlToText(m[1]) };
}

function decode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
}

// Rendered page HTML -> compact markdown-ish text for the model.
function htmlToText(html) {
  let s = html
    .replace(/<table[\s\S]*?<\/table>/g, t => '\n' + t.replace(/>\s+</g, '><') + '\n')
    .replace(/<a class="toc-anchor"[^>]*>.*?<\/a>\s*/g, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_, n, t) => `\n\n${'#'.repeat(+n)} ${t}\n`)
    .replace(/<\/(td|th)>\s*/g, ' | ')
    .replace(/<tr[^>]*>/g, '\n| ')
    .replace(/<li[^>]*>/g, '\n- ')
    .replace(/<pre[^>]*>/g, '\n```\n').replace(/<\/pre>/g, '\n```\n')
    .replace(/<code[^>]*>/g, '`').replace(/<\/code>/g, '`')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)')
    .replace(/<(br|\/p|\/div|\/blockquote)[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, '');
  s = decode(s).replace(/```\n`([\s\S]*?)`\n```/g, '```\n$1\n```');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
