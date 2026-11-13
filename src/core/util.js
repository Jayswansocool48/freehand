'use strict';
const fs = require('fs');
const path = require('path');

/** Removes <think>...</think> blocks emitted by reasoning models (qwen3, deepseek-r1...). */
function stripThinking(text) {
  return (text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

/** Finds the first balanced {...} object in text and parses it (tolerates code fences, trailing commas). */
function extractJson(text) {
  if (!text) return null;
  const t = text.replace(/```(?:json)?/gi, '');
  for (let start = t.indexOf('{'); start !== -1; start = t.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const slice = t.slice(start, i + 1);
          for (const candidate of [slice, slice.replace(/,\s*([}\]])/g, '$1')]) {
            try { const v = JSON.parse(candidate); if (v && typeof v === 'object') return v; } catch { /* try next */ }
          }
          break;
        }
      }
    }
  }
  return null;
}

function truncate(text, max, note = true) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, max) + (note ? `\n...[truncated ${s.length - max} more characters]` : '');
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };
  return s
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } })
    .replace(/&([a-z]+);/gi, (m, n) => (named[n.toLowerCase()] !== undefined ? named[n.toLowerCase()] : m));
}

/** Readable plain text from HTML; keeps link targets so the agent can follow them. */
function htmlToText(html, baseUrl) {
  let h = String(html || '');
  h = h.replace(/<!--[\s\S]*?-->/g, '');
  h = h.replace(/<(script|style|noscript|svg|head|template|iframe)[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    const label = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!label || /^(#|javascript:|mailto:)/i.test(href)) return label;
    let abs = href;
    try { abs = new URL(href, baseUrl).href; } catch { /* keep as is */ }
    return `${label} (${abs})`;
  });
  h = h.replace(/<(br|hr)\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|table|ul|ol|blockquote|pre)>/gi, '\n');
  h = h.replace(/<li[^>]*>/gi, '- ').replace(/<h([1-6])[^>]*>/gi, (m, n) => '\n' + '#'.repeat(Number(n)) + ' ');
  h = h.replace(/<\/t[dh]>/gi, ' | ');
  h = h.replace(/<[^>]+>/g, '');
  h = decodeEntities(h);
  return h.replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Resolves a user/model-supplied relative path inside root; throws if it escapes. */
function safePath(root, rel) {
  const target = path.resolve(root, String(rel || '.'));
  const rootReal = fs.realpathSync(root);
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const probeReal = fs.realpathSync(probe);
  const within = (p) => p === rootReal || p.startsWith(rootReal + path.sep);
  if (!within(probeReal) || !(target === path.resolve(root) || target.startsWith(path.resolve(root) + path.sep))) {
    throw new Error(`Path "${rel}" is outside the workspace`);
  }
  return target;
}

module.exports = { stripThinking, extractJson, truncate, htmlToText, decodeEntities, safePath };
