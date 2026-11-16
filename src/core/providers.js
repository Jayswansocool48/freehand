'use strict';
const { PROVIDER_PRESETS, getApiKey } = require('./config');
const { isLow } = require('./memory');

class ProviderError extends Error {
  constructor(message, status = 0, opts = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = !!opts.retryable;
    this.toolsUnsupported = !!opts.toolsUnsupported;
    this.retryAfterMs = opts.retryAfterMs || 0;
    this.contextOverflow = !!opts.contextOverflow;
  }
}

// How many tokens each provider's model can take, learned from the server or from its errors.
const windows = new Map();
const windowKey = (settings, providerId) => `${providerId}|${(settings.providers[providerId] || {}).model}`;

/**
 * The model's context size in tokens. Ollama runs models with a fixed num_ctx (freehand-v2: 16384),
 * so ask it; hosted models are assumed to take 128k unless the provider sets contextTokens.
 */
async function contextTokens(settings, providerId = settings.active) {
  const p = settings.providers[providerId] || {};
  if (Number(p.contextTokens) > 0) return Number(p.contextTokens);
  const key = windowKey(settings, providerId);
  if (windows.has(key)) return windows.get(key);
  let n = 128000;
  if (providerId === 'ollama' || /:11434\b/.test(p.baseUrl || '')) {
    n = 4096; // Ollama's default when the model sets no num_ctx
    try {
      const res = await fetch(joinUrl(String(p.baseUrl).replace(/\/v1\/?$/, ''), 'api/show'), { method: 'POST', body: JSON.stringify({ model: p.model }), signal: AbortSignal.timeout(5000) });
      const m = /num_ctx\s+(\d+)/.exec((await res.json()).parameters || '');
      if (m) n = Number(m[1]);
    } catch { /* keep the default */ }
  }
  windows.set(key, n);
  return n;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('Aborted'));
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Aborted')); }, { once: true });
  });
}

function joinUrl(base, p) {
  return base.replace(/\/+$/, '') + '/' + p.replace(/^\/+/, '');
}

function authHeaders(settings, providerId) {
  const headers = { 'content-type': 'application/json' };
  const key = getApiKey(settings, providerId);
  if (key) headers.authorization = `Bearer ${key}`;
  if (providerId === 'openrouter') headers['X-Title'] = 'Freehand';
  return headers;
}

/** Folds an OpenAI-style SSE stream back into the shape of a non-streamed response. */
async function readStream(res) {
  const decoder = new TextDecoder();
  const message = { content: '', tool_calls: [] };
  let finishReason = null;
  let error = null;
  let buf = '';
  const onData = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    const chunk = JSON.parse(payload);
    if (chunk.error) { error = chunk.error; return; }
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const d = choice.delta || {};
    if (typeof d.content === 'string') message.content += d.content;
    for (const tc of d.tool_calls || []) {
      const i = Number.isInteger(tc.index) ? tc.index : message.tool_calls.length;
      const slot = message.tool_calls[i] || (message.tool_calls[i] = { id: '', function: { name: '', arguments: '' } });
      if (tc.id) slot.id = tc.id;
      if (tc.function && tc.function.name) slot.function.name += tc.function.name;
      const a = tc.function && tc.function.arguments;
      if (typeof a === 'string') slot.function.arguments += a;
      else if (a && typeof a === 'object') slot.function.arguments = a;
    }
  };
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      onData(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  }
  onData(buf.trim());
  if (error) return { error };
  message.tool_calls = message.tool_calls.filter(Boolean);
  return { choices: [{ message, finish_reason: finishReason }] };
}

/**
 * POST without fetch's time limits, for models on this PC (plain http). Ollama sends a tool call only
 * once it is complete, and on a slow PC that can take longer than the 5 minutes fetch waits between
 * parts of a response, so fetch would cut the reply off and the whole step would start again.
 */
function postNoTimeout(url, { headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const req = require('http').request(url, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) }, signal }, (res) => {
      const text = async () => { let t = ''; for await (const c of res) t += c; return t; };
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: { get: (k) => (res.headers[k.toLowerCase()] == null ? null : String(res.headers[k.toLowerCase()])) },
        body: res,
        text,
        json: async () => JSON.parse(await text()),
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** One request to one provider. Throws ProviderError. */
async function chatOnce({ settings, providerId, messages, tools, signal }) {
  const p = settings.providers[providerId];
  if (!p) throw new ProviderError(`Unknown provider "${providerId}"`);
  if (!p.baseUrl) throw new ProviderError(`Provider "${providerId}" has no base URL. Set one in Settings.`);
  if (!p.model) throw new ProviderError(`Provider "${providerId}" has no model selected. Pick one in Settings.`);
  const preset = PROVIDER_PRESETS[providerId];
  if (preset && preset.needsKey && !getApiKey(settings, providerId)) {
    throw new ProviderError(`${preset.label} needs an API key. Add it in Settings.`, 401);
  }

  // Streamed so headers arrive at the first token: Node's fetch drops a request whose
  // headers take over 5 minutes, which a slow local model writing a whole file can hit.
  const body = { model: p.model, messages, temperature: 0.3, stream: true };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }

  let res;
  try {
    const url = joinUrl(p.baseUrl, 'chat/completions');
    const req = { method: 'POST', headers: authHeaders(settings, providerId), body: JSON.stringify(body), signal };
    res = /^http:/i.test(url) ? await postNoTimeout(url, req) : await fetch(url, req);
  } catch (e) {
    if (signal && signal.aborted) throw e;
    const hint = providerId === 'ollama' ? ' Is Ollama running? (start it with "ollama serve")' : '';
    throw new ProviderError(`Cannot reach ${providerId} at ${p.baseUrl}: ${(e.cause && e.cause.code) || e.code || e.message}.${hint}`, 0, { retryable: true });
  }

  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 600);
    const ra = Number(res.headers.get('retry-after'));
    const retryable = [408, 425, 429, 500, 502, 503, 504].includes(res.status);
    const contextOverflow = [400, 413, 422].includes(res.status) && /exceeds? (the )?(available )?context|context (length|size|window)|too many tokens|maximum context/i.test(text);
    const toolsUnsupported = !contextOverflow && [400, 404, 422].includes(res.status) && /tool|function/i.test(text);
    const told = /context size \((\d+) tokens\)/i.exec(text);
    if (told) windows.set(windowKey(settings, providerId), Number(told[1]));
    let msg = `${providerId} returned HTTP ${res.status}`;
    try { const j = JSON.parse(text); msg += `: ${(j.error && (j.error.message || j.error)) || j.message || text}`; } catch { if (text) msg += `: ${text}`; }
    if (res.status === 401 || res.status === 403) msg += ' (check your API key)';
    throw new ProviderError(msg, res.status, { retryable, toolsUnsupported, contextOverflow, retryAfterMs: Number.isFinite(ra) ? ra * 1000 : 0 });
  }

  let data;
  try {
    data = /text\/event-stream/.test(res.headers.get('content-type') || '') ? await readStream(res) : await res.json();
  } catch (e) {
    if (signal && signal.aborted) throw e;
    throw new ProviderError(`${providerId} sent an unreadable response`, res.status, { retryable: true });
  }
  if (data.error) throw new ProviderError(`${providerId} error: ${data.error.message || data.error}`, res.status, { retryable: true });
  const choice = data.choices && data.choices[0];
  if (!choice || !choice.message) throw new ProviderError(`${providerId} returned no message`, res.status, { retryable: true });
  const m = choice.message;
  let content = m.content;
  if (Array.isArray(content)) content = content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('');
  const toolCalls = [];
  for (const tc of m.tool_calls || []) {
    if (!tc.function) continue;
    let args = {};
    let parseError = false;
    if (typeof tc.function.arguments === 'string') {
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { parseError = true; }
    } else if (tc.function.arguments && typeof tc.function.arguments === 'object') {
      args = tc.function.arguments;
    }
    toolCalls.push({ id: tc.id || '', name: tc.function.name, args, parseError });
  }
  return { content: content || '', toolCalls, finishReason: choice.finish_reason };
}

/**
 * Retries rate limits / transient errors with backoff. A local model gets longer: when the PC runs
 * low on memory Ollama's runner dies, and it comes back once onRetry has freed some memory.
 */
async function chatWithRetry(opts, onNotice, onRetry) {
  const scale = Number(process.env.FREEHAND_RETRY_SCALE) || 1; // tests shrink the waits
  const local = opts.providerId === 'ollama';
  const delays = (local ? [3000, 8000, 20000, 30000, 30000, 60000, 60000] : [3000, 8000, 20000]).map((d) => d * scale);
  for (let attempt = 0; ; attempt++) {
    try {
      return await chatOnce(opts);
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw e;
      if (!(e instanceof ProviderError) || !e.retryable || attempt >= delays.length) throw e;
      const wait = Math.min(60000 * scale, e.retryAfterMs ? e.retryAfterMs * scale : delays[attempt]);
      const why = e.status === 429 ? 'rate limited' : local && isLow() ? 'the PC is low on memory' : 'temporary error';
      if (onNotice) onNotice(`${opts.providerId}: ${why}, retrying in ${Math.round(wait / 1000)}s...`);
      if (onRetry) await onRetry(e);
      await sleep(wait, opts.signal);
    }
  }
}

/**
 * Tries the active provider, then each fallback provider. Free tiers rate-limit hard,
 * so falling through to the next free provider keeps long tasks alive.
 */
async function chat({ settings, messages, tools, signal, providerOrder, onNotice, onRetry }) {
  const order = providerOrder && providerOrder.length ? providerOrder : [settings.active, ...settings.fallback.filter((id) => id !== settings.active)];
  let lastErr;
  for (let i = 0; i < order.length; i++) {
    const providerId = order[i];
    try {
      const r = await chatWithRetry({ settings, providerId, messages, tools, signal }, onNotice, onRetry);
      return { ...r, providerId };
    } catch (e) {
      if (signal && signal.aborted) throw e;
      if (e.toolsUnsupported || e.contextOverflow) { e.providerId = providerId; throw e; }
      lastErr = e;
      if (i < order.length - 1 && onNotice) onNotice(`${providerId} failed (${e.message.slice(0, 140)}). Switching to ${order[i + 1]}.`);
    }
  }
  throw lastErr;
}

/** Lists model ids available at a provider (used by the settings model picker). */
async function listModels(settings, providerId) {
  const p = settings.providers[providerId];
  if (!p || !p.baseUrl) throw new ProviderError('No base URL set');
  const res = await fetch(joinUrl(p.baseUrl, 'models'), { headers: authHeaders(settings, providerId), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new ProviderError(`HTTP ${res.status} listing models${res.status === 401 ? ' (check your API key)' : ''}`, res.status);
  const j = await res.json();
  let items = j.data || j.models || [];
  let ids = items.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).map((id) => id.replace(/^models\//, ''));
  if (providerId === 'openrouter') {
    const free = items.filter((m) => m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0).map((m) => m.id);
    ids = free.length ? free : ids.filter((id) => id.endsWith(':free'));
  }
  return [...new Set(ids)].sort();
}

module.exports = { chat, chatOnce, listModels, contextTokens, ProviderError };
