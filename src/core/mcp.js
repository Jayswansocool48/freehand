'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { version } = require('../../package.json');

/**
 * Connectors: a small MCP (Model Context Protocol) client, so the agent can use tools from other apps
 * such as Blender or Figma. Speaks JSON-RPC 2.0 over a local program's stdin/stdout ("command") or over
 * Streamable HTTP ("url"). Connections stay open between tasks; Blender keeps its scene state that way.
 */

const PROTOCOL = '2025-06-18';
const CONNECT_TIMEOUT = 20000;
const CALL_TIMEOUT = 120000;

/** Ready-made connectors the settings page offers. */
const PRESETS = [
  {
    id: 'blender',
    name: 'Blender',
    type: 'command',
    command: 'uvx blender-mcp',
    help: 'Needs Blender with the blender-mcp add-on running (in Blender: N panel, BlenderMCP, Connect), and uv installed for the uvx command.',
  },
  {
    id: 'figma',
    name: 'Figma',
    type: 'url',
    url: 'http://127.0.0.1:3845/mcp',
    help: 'Needs the Figma desktop app with Dev Mode: Preferences, Enable Dev Mode MCP Server.',
  },
];

/** Splits a command line into words, keeping "quoted parts" together. */
function splitCommand(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(line || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Apps started from a desktop menu get a short PATH, so tools installed per user (uvx, npx from Homebrew)
 * would not be found. Adds the usual install folders after the existing PATH.
 */
function searchPath() {
  const home = os.homedir();
  const extra = process.platform === 'win32' ? [] : [
    `${home}/.local/bin`, `${home}/.cargo/bin`, `${home}/.bun/bin`, `${home}/.volta/bin`,
    '/home/linuxbrew/.linuxbrew/bin', '/opt/homebrew/bin', '/usr/local/bin',
  ];
  const parts = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return [...parts, ...extra.filter((d) => !parts.includes(d))].join(path.delimiter);
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'app';

/**
 * Reads a pasted connector config: Claude/Cursor style {"mcpServers": {name: {...}}}, {name: {...}},
 * or a single server {command, args, env} / {url, headers}. Returns connectors ready to save.
 */
function parseImport(text) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('That is not valid JSON. Paste the config exactly as the app\'s instructions show it.'); }
  if (j && typeof j === 'object' && (j.mcpServers || j.servers)) j = j.mcpServers || j.servers;
  const entries = j && (j.command || j.url || j.serverUrl) ? [['app', j]] : Object.entries(j || {});
  const out = [];
  for (const [name, s] of entries) {
    if (!s || typeof s !== 'object') continue;
    const url = s.url || s.serverUrl;
    if (url) out.push({ name, type: 'url', url: String(url), headers: s.headers || {} });
    else if (s.command) out.push({ name, type: 'command', command: [s.command, ...(s.args || [])].map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(' '), env: s.env || {} });
  }
  if (!out.length) throw new Error('No servers found. The config needs a "command" or a "url".');
  return out;
}

/** Turns a tools/call result into text for the model, plus any images it returned. */
function resultText(result) {
  const parts = [];
  const images = [];
  for (const c of (result && result.content) || []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'image') { images.push({ data: c.data, mimeType: c.mimeType || 'image/png' }); parts.push(`[image ${images.length}]`); }
    else if (c.type === 'resource' && c.resource) parts.push(c.resource.text || `[file ${c.resource.uri}]`);
    else if (c.type === 'resource_link') parts.push(`[link ${c.uri}]`);
    else if (c.type === 'audio') parts.push('[audio]');
  }
  if (!parts.length && result && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return { text: parts.join('\n') || '(no output)', images, isError: !!(result && result.isError) };
}

/** One open connection to an MCP server. */
class Connection {
  constructor(cfg) {
    this.cfg = cfg;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.session = null;
    this.tools = [];
    this.serverName = '';
    this.closed = false;
    this.stderr = '';
  }

  async open() {
    if (this.cfg.type === 'command') this.spawn();
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'freehand', version },
    }, CONNECT_TIMEOUT);
    this.serverName = (init && init.serverInfo && init.serverInfo.name) || '';
    this.instructions = (init && init.instructions) || '';
    await this.notify('notifications/initialized');
    this.tools = [];
    let cursor;
    do {
      const r = await this.request('tools/list', cursor ? { cursor } : {}, CONNECT_TIMEOUT);
      this.tools.push(...((r && r.tools) || []));
      cursor = r && r.nextCursor;
    } while (cursor && this.tools.length < 500);
    return this;
  }

  spawn() {
    const [cmd, ...args] = splitCommand(this.cfg.command);
    if (!cmd) throw new Error('No command set');
    this.child = spawn(cmd, args, {
      env: { ...process.env, PATH: searchPath(), ...(this.cfg.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // npx, uvx and friends are .cmd files on Windows
      windowsHide: true,
    });
    let buf = '';
    this.child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { try { this.receive(JSON.parse(line)); } catch { /* servers sometimes log to stdout */ } }
      }
    });
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d.toString('utf8')).slice(-4000); });
    const gone = (why) => {
      this.closed = true;
      const tail = this.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      this.failAll(new Error(`${why}${tail ? `: ${tail}` : ''}`));
    };
    this.child.on('error', (e) => gone(e.code === 'ENOENT' ? `"${cmd}" is not installed or not on PATH` : e.message));
    this.child.on('exit', (code) => gone(`The connector program stopped (exit code ${code})`));
    this.child.stdin.on('error', () => { /* reported through exit */ });
  }

  failAll(err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  receive(msg) {
    if (Array.isArray(msg)) { msg.forEach((m) => this.receive(m)); return; }
    if (!msg || msg.id === undefined || msg.id === null) return; // notifications and logs
    const p = this.pending.get(msg.id);
    if (!p) {
      // A request from the server (ping, roots, sampling): answer so it does not wait forever.
      if (msg.method) this.send({ jsonrpc: '2.0', id: msg.id, ...(msg.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Not supported' } }) }).catch(() => {});
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message || 'Connector error'));
    else p.resolve(msg.result);
  }

  async send(msg, signal) {
    if (this.cfg.type === 'command') {
      if (this.closed || !this.child) throw new Error('The connector is not running');
      this.child.stdin.write(JSON.stringify(msg) + '\n');
      return;
    }
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, ...(this.cfg.headers || {}) };
    if (this.session) headers['mcp-session-id'] = this.session;
    const res = await fetch(this.cfg.url, { method: 'POST', headers, body: JSON.stringify(msg), signal });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (res.status === 202 || res.status === 204) return;
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(res.status === 401 || res.status === 403 ? `The app refused the connection (${res.status}). It may need a sign-in token.` : `HTTP ${res.status} ${body}`);
    }
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
      // Each "data:" event is one JSON-RPC message; stop once the answer to this request has arrived.
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (data) { try { this.receive(JSON.parse(data)); } catch { /* not JSON */ } }
        }
        if (msg.id !== undefined && !this.pending.has(msg.id)) { reader.cancel().catch(() => {}); break; }
      }
    } else {
      const text = await res.text();
      if (text.trim()) this.receive(JSON.parse(text));
    }
  }

  request(method, params, timeout = CALL_TIMEOUT, signal) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The connector did not answer ${method} within ${Math.round(timeout / 1000)} s`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      if (signal) signal.addEventListener('abort', () => { if (this.pending.delete(id)) { clearTimeout(timer); reject(new Error('Aborted')); } }, { once: true });
      this.send({ jsonrpc: '2.0', id, method, params }, signal).catch((e) => {
        if (this.pending.delete(id)) { clearTimeout(timer); reject(e.message === 'fetch failed' ? new Error(`Nothing is answering at ${this.cfg.url}. Is the app open with its MCP server turned on?`) : e); }
      });
    });
  }

  notify(method, params) { return this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); }

  async call(name, args, signal) {
    return resultText(await this.request('tools/call', { name, arguments: args || {} }, CALL_TIMEOUT, signal));
  }

  close() {
    this.closed = true;
    this.failAll(new Error('Connector closed'));
    if (this.child) { try { this.child.kill(); } catch { /* already gone */ } }
    if (this.session && this.cfg.type === 'url') {
      fetch(this.cfg.url, { method: 'DELETE', headers: { 'mcp-session-id': this.session, ...(this.cfg.headers || {}) } }).catch(() => {});
    }
  }
}

/** Keeps one connection per connector for the life of the app, and reports their status to the settings page. */
class ConnectorManager {
  constructor() {
    this.conns = new Map(); // id -> { conn, key, promise }
    this.status = new Map(); // id -> { state, error, tools, server }
  }

  key(cfg) { return JSON.stringify([cfg.type, cfg.command, cfg.url, cfg.env, cfg.headers]); }

  /** Opens (or reuses) the connection for a connector. */
  async get(cfg) {
    const have = this.conns.get(cfg.id);
    if (have && have.key === this.key(cfg) && !have.conn.closed) return have.promise;
    if (have) have.conn.close();
    const conn = new Connection(cfg);
    const entry = { conn, key: this.key(cfg) };
    entry.promise = conn.open().then(
      (c) => { this.status.set(cfg.id, { state: 'connected', tools: c.tools.map((t) => ({ name: t.name, description: t.description || '' })), server: c.serverName }); return c; },
      (e) => { conn.close(); if (this.conns.get(cfg.id) === entry) this.conns.delete(cfg.id); this.status.set(cfg.id, { state: 'error', error: e.message, tools: (this.status.get(cfg.id) || {}).tools || [] }); throw e; }
    );
    this.conns.set(cfg.id, entry);
    this.status.set(cfg.id, { state: 'connecting', tools: (this.status.get(cfg.id) || {}).tools || [] });
    return entry.promise;
  }

  async test(cfg) { this.drop(cfg.id); return this.get(cfg); }

  drop(id) {
    const have = this.conns.get(id);
    if (have) have.conn.close();
    this.conns.delete(id);
    this.status.delete(id);
  }

  statusOf(id) { return this.status.get(id) || { state: 'idle', tools: [] }; }

  /**
   * Agent tools for every enabled connector, named "<connector>__<tool>". Connectors that fail to start
   * are skipped and reported through onNotice, so one broken app does not stop a task.
   */
  async toolsFor(settings, onNotice = () => {}) {
    const out = [];
    const list = (settings.connectors || []).filter((c) => c.enabled !== false);
    await Promise.all(list.map(async (cfg) => {
      let conn;
      try { conn = await this.get(cfg); } catch (e) { onNotice(`Could not connect to ${cfg.name}: ${e.message}`); return; }
      const off = new Set(cfg.disabledTools || []);
      for (const t of conn.tools) {
        if (off.has(t.name)) continue;
        out.push(agentTool(cfg, t, () => this.get(cfg)));
      }
    }));
    return out;
  }

  closeAll() { for (const id of [...this.conns.keys()]) this.drop(id); }
}

/** Wraps one MCP tool in the shape src/tools uses. */
function agentTool(cfg, t, connect) {
  const name = `${slug(cfg.name)}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const schema = t.inputSchema && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} };
  const readOnly = !!(t.annotations && t.annotations.readOnlyHint);
  const title = (t.annotations && t.annotations.title) || t.title || t.name.replace(/_/g, ' ');
  return {
    name,
    icon: 'plug',
    connector: cfg.name,
    description: `[${cfg.name}] ${String(t.description || title).replace(/\s+/g, ' ').trim().slice(0, 400)}`,
    parameters: { type: 'object', properties: schema.properties || {}, required: schema.required || [], ...(schema.$defs ? { $defs: schema.$defs } : {}) },
    label: () => `${cfg.name}: ${title}`,
    // Tools that only read never ask; the rest ask unless this connector is trusted.
    approval: readOnly || cfg.trust ? null : (a) => ({ kind: 'connector', title: `${cfg.name}: ${title}`, detail: JSON.stringify(a, null, 2).slice(0, 4000) }),
    async run(a, ctx) {
      const conn = await connect();
      const r = await conn.call(t.name, a, ctx.signal);
      let text = r.text;
      if (r.images.length && ctx.saveImage) {
        const saved = r.images.map((img, i) => ctx.saveImage(`${slug(cfg.name)}-${t.name}-${i + 1}`, img));
        text += `\n\nImages saved to the workspace: ${saved.join(', ')}`;
      }
      if (r.isError) throw new Error(text);
      return text;
    },
  };
}

const manager = new ConnectorManager();

/** A connector as saved in settings, from what the settings page or an import sent. */
function normalize(c, existing = []) {
  const type = c.type === 'url' || (!c.command && c.url) ? 'url' : 'command';
  const name = String(c.name || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40) || (type === 'url' ? 'Web app' : 'App');
  let id = slug(name);
  while (existing.some((e) => e.id === id)) id = `${slug(name)}_${crypto.randomBytes(2).toString('hex')}`;
  const clean = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([k]) => /^[\w.-]{1,80}$/.test(k)).map(([k, v]) => [k, String(v)]));
  const out = { id, name, type, enabled: true, trust: false, disabledTools: [] };
  if (type === 'url') {
    if (!/^https?:\/\//i.test(String(c.url || ''))) throw new Error('The address must start with http:// or https://');
    out.url = String(c.url).trim();
    out.headers = clean(c.headers);
    if (c.token) out.headers.Authorization = `Bearer ${String(c.token).trim()}`;
  } else {
    if (!String(c.command || '').trim()) throw new Error('Type the command that starts the connector, like: npx -y some-mcp-server');
    out.command = String(c.command).trim();
    out.env = clean(c.env);
  }
  return out;
}

module.exports = { PRESETS, manager, normalize, parseImport, splitCommand, resultText, Connection, ConnectorManager, agentTool };
