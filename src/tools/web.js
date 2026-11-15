'use strict';
const { htmlToText, decodeEntities, truncate } = require('../core/util');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function parseDuckDuckGo(html) {
  const out = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html))) {
    let href = decodeEntities(m[1]);
    const u = href.match(/[?&]uddg=([^&]+)/);
    if (u) href = decodeURIComponent(u[1]);
    else if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:/i.test(href)) continue;
    out.push({ title: stripTags(m[2]), url: href, snippet: stripTags(m[3] || '') });
  }
  return out;
}

function parseBing(html) {
  const out = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const b of blocks) {
    const a = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let href = decodeEntities(a[1]);
    const enc = href.match(/[?&]u=a1([^&]+)/);
    if (enc) {
      try { href = Buffer.from(enc[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { /* keep */ }
    }
    if (!/^https?:/i.test(href)) continue;
    const sn = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: stripTags(a[2]), url: href, snippet: sn ? stripTags(sn[1]) : '' });
  }
  return out;
}

async function searchDuckDuckGo(query, signal) {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: query }).toString(),
    signal: anySignal(signal, 15000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const results = parseDuckDuckGo(await res.text());
  if (!results.length) throw new Error('DuckDuckGo returned no results (possibly rate limited)');
  return results;
}

async function searchBing(query, signal) {
  const res = await fetch('https://www.bing.com/search?q=' + encodeURIComponent(query), { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }, signal: anySignal(signal, 15000) });
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  const results = parseBing(await res.text());
  if (!results.length) throw new Error('Bing returned no results');
  return results;
}

async function searchBrave(query, key, signal) {
  const res = await fetch('https://api.search.brave.com/res/v1/web/search?count=10&q=' + encodeURIComponent(query), { headers: { accept: 'application/json', 'x-subscription-token': key }, signal: anySignal(signal, 15000) });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const j = await res.json();
  return ((j.web && j.web.results) || []).map((r) => ({ title: r.title, url: r.url, snippet: stripTags(r.description || '') }));
}

function anySignal(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function webSearch(query, { settings, signal, max = 8 }) {
  const errors = [];
  const braveKey = settings.search.braveKey || process.env.BRAVE_API_KEY;
  const order = settings.search.provider === 'brave' && braveKey ? ['brave', 'duckduckgo', 'bing'] : ['duckduckgo', 'bing'];
  for (const p of order) {
    try {
      const r = p === 'brave' ? await searchBrave(query, braveKey, signal) : p === 'duckduckgo' ? await searchDuckDuckGo(query, signal) : await searchBing(query, signal);
      if (r.length) return r.slice(0, max);
    } catch (e) {
      if (signal && signal.aborted) throw e;
      errors.push(`${p}: ${e.message}`);
    }
  }
  throw new Error('Search failed. ' + errors.join('; '));
}

/**
 * GitHub pages are mostly menus once turned into text. Read the code itself instead:
 * a file (blob) becomes its raw text, and a repository or folder becomes a list of its files with raw links.
 */
function githubTarget(url) {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)(?:\/(blob|tree)\/([^/?#]+)(?:\/([^?#]*))?)?\/?(?:[?#].*)?$/i.exec(url);
  if (!m) return null;
  const [, owner, repo, kind, ref, rest = ''] = m;
  const name = repo.replace(/\.git$/, '');
  if (kind === 'blob') return { raw: `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${rest}` };
  return { api: `https://api.github.com/repos/${owner}/${name}/contents/${rest}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, page: url };
}

async function fetchGithub(t, { signal, maxChars, offset }) {
  if (t.raw) return fetchPage(t.raw, { signal, maxChars, offset });
  const res = await fetch(t.api, { headers: { 'user-agent': UA, accept: 'application/vnd.github+json' }, signal: anySignal(signal, 25000) });
  if (!res.ok) return null; // rate limited or private: fall back to the normal page
  const items = await res.json();
  if (!Array.isArray(items)) return null;
  const lines = items.map((i) => (i.type === 'dir' ? `${i.name}/  (folder: ${i.html_url})` : `${i.name} (${i.size} bytes): ${i.download_url}`));
  let text = `Files in this GitHub folder. web_fetch a raw link to read the code:\n${lines.join('\n')}`;
  const readme = items.find((i) => /^readme(\.md|\.txt)?$/i.test(i.name) && i.download_url);
  if (readme) {
    try { text += `\n\n${readme.name}:\n${(await fetchPage(readme.download_url, { signal, maxChars: 3000 })).text}`; } catch { /* README is optional */ }
  }
  const slice = text.slice(offset, offset + maxChars);
  return { url: t.page, text: slice + (offset + maxChars < text.length ? `\n...[call again with offset=${offset + maxChars} for more]` : ''), total: text.length };
}

async function fetchPage(url, { signal, maxChars = 8000, offset = 0 }) {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
  const gh = githubTarget(url);
  if (gh) {
    const r = await fetchGithub(gh, { signal, maxChars, offset });
    if (r) return r;
  }
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*', 'accept-language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: anySignal(signal, 25000) });
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  if (/pdf|image\/|audio\/|video\/|zip|octet-stream/.test(type)) {
    throw new Error(`Unsupported content type (${type}). Use the shell tool to download it, then read the file.`);
  }
  const raw = await res.text();
  const text = /html|xml/.test(type) || /^\s*</.test(raw) ? htmlToText(raw, res.url) : raw;
  const total = text.length;
  const slice = text.slice(offset, offset + maxChars);
  const more = offset + maxChars < total ? `\n...[showing ${offset}-${offset + slice.length} of ${total} characters; call again with offset=${offset + maxChars} for more]` : '';
  const t = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(raw);
  const title = t ? t[1].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim() : '';
  return { url: res.url, title, text: slice + more, total };
}

module.exports = { webSearch, fetchPage, githubTarget, parseDuckDuckGo, parseBing, truncate };
