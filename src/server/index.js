'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { homeDir, loadSettings, saveSettings, publicSettings, applyPatch, PROVIDER_PRESETS } = require('../core/config');
const { version } = require('../../package.json');
const { listModels } = require('../core/providers');
const { listDir } = require('../tools');
const { safePath } = require('../core/util');
const { TaskStore } = require('./tasks');
const { previewUrl, ensurePreview } = require('./preview');
const ollama = require('../core/ollama');
const mcp = require('../core/mcp');

const UI_DIR = path.join(__dirname, '..', '..', 'ui');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

/** Streams a raw request body to a file (uploads), refusing anything over the limit. */
function saveBody(req, file, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = fs.createWriteStream(file);
    const fail = (e) => { out.destroy(); fs.rm(file, { force: true }, () => reject(e)); };
    req.on('data', (c) => { size += c.length; if (size > limit) { req.destroy(); fail(new Error('File too large')); } });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => resolve(size));
    req.pipe(out);
  });
}

/** Keeps a file name readable but safe: no folders, no hidden files. */
const safeName = (n) => path.basename(String(n || 'file')).replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/^\.+/, '').slice(0, 120) || 'file';

/** Sends Ollama progress lines to the browser as newline-delimited JSON. */
async function streamJob(res, job) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  try {
    await job((line) => res.write(JSON.stringify(line) + '\n'));
    res.end(JSON.stringify({ status: 'success', done: true }) + '\n');
  } catch (e) {
    res.end(JSON.stringify({ error: e.message }) + '\n');
  }
}

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

/**
 * Starts the local server. A random per-launch token (cookie, SameSite=Strict) plus Host checks stop
 * other websites or local processes from driving the agent, since it can run commands on this machine.
 */
function startServer({ port = 0, host = '127.0.0.1', token = crypto.randomBytes(24).toString('hex') } = {}) {
  const store = new TaskStore();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const hostHeader = (req.headers.host || '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostHeader)) return send(res, 403, 'Bad host');

      const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
      if (url.searchParams.get('token') === token && !url.pathname.startsWith('/api/')) {
        res.writeHead(302, { 'set-cookie': `fh_token=${token}; Path=/; HttpOnly; SameSite=Strict`, location: url.pathname });
        return res.end();
      }
      if (cookies.fh_token !== token && req.headers['x-freehand-token'] !== token) return send(res, 401, 'Open Freehand from the app (or the URL printed in the terminal).');

      // Pages the agent builds run on the preview server, a different origin. The cookie still reaches us from
      // there (same site), so refuse any API call that a page from another origin starts.
      if (url.pathname.startsWith('/api/') && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, 'Bad origin');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return serveStatic(res, url.pathname);
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
    const method = req.method;

    if (parts[0] === 'settings') {
      if (method === 'PUT') {
        const next = applyPatch(loadSettings(), await readBody(req));
        saveSettings(next);
      }
      return send(res, 200, { settings: publicSettings(loadSettings()), presets: PROVIDER_PRESETS, platform: process.platform });
    }
    if (parts[0] === 'connectors') {
      const settings = loadSettings();
      const list = settings.connectors || [];
      const view = () => ({
        presets: mcp.PRESETS,
        connectors: publicSettings(loadSettings()).connectors.map((c) => ({ ...c, status: mcp.manager.statusOf(c.id) })),
      });
      const save = (next) => saveSettings({ ...settings, connectors: next });
      if (!parts[1]) {
        if (method === 'GET') return send(res, 200, view());
        if (method !== 'POST') return send(res, 405, { error: 'Use GET or POST' });
        const body = await readBody(req);
        let added;
        try {
          const incoming = typeof body.import === 'string' ? mcp.parseImport(body.import) : [body];
          added = [];
          for (const c of incoming) added.push(mcp.normalize(c, [...list, ...added]));
        } catch (e) { return send(res, 400, { error: e.message }); }
        save([...list, ...added]);
        return send(res, 200, { ...view(), added: added.map((c) => c.id) });
      }
      const i = list.findIndex((c) => c.id === parts[1]);
      if (i < 0) return send(res, 404, { error: 'No such connector' });
      if (method === 'DELETE') {
        mcp.manager.drop(parts[1]);
        save(list.filter((c) => c.id !== parts[1]));
        return send(res, 200, view());
      }
      if (method === 'PUT') {
        const p = await readBody(req);
        const c = { ...list[i] };
        for (const k of ['enabled', 'trust']) if (typeof p[k] === 'boolean') c[k] = p[k];
        if (Array.isArray(p.disabledTools)) c.disabledTools = p.disabledTools.map(String).slice(0, 500);
        if (typeof p.name === 'string' && p.name.trim()) c.name = p.name.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40) || c.name;
        if (c.enabled === false) mcp.manager.drop(c.id);
        save(list.map((x, j) => (j === i ? c : x)));
        return send(res, 200, view());
      }
      if (method === 'POST' && parts[2] === 'test') {
        try { await mcp.manager.test(list[i]); } catch { /* the status carries the error */ }
        return send(res, 200, view());
      }
      return send(res, 405, { error: 'Not allowed' });
    }
    if (parts[0] === 'info') return send(res, 200, { version, dataDir: homeDir(), platform: process.platform, desktop: !!process.versions.electron });
    if (parts[0] === 'ollama') {
      const settings = loadSettings();
      if (!parts[1] && method === 'GET') return send(res, 200, await ollama.status(settings));
      if (method !== 'POST') return send(res, 405, { error: 'Use POST' });
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); });
      if (parts[1] === 'pull') {
        const { model } = await readBody(req);
        if (!/^[\w.\-/:]+$/.test(String(model || ''))) return send(res, 400, { error: 'Type a model name like qwen3:8b' });
        return streamJob(res, (on) => ollama.pull(settings, String(model), on, ac.signal));
      }
      if (parts[1] === 'freehand') {
        const { base } = await readBody(req);
        if (!/^[\w.\-/:]+$/.test(String(base || ''))) return send(res, 400, { error: 'Pick a base model' });
        return streamJob(res, (on) => ollama.createFreehand(settings, String(base), on, ac.signal));
      }
      if (parts[1] === 'import') {
        const name = String(url.searchParams.get('name') || '').toLowerCase().replace(/[^a-z0-9._\-:]/g, '-').replace(/^-+/, '');
        if (!name) return send(res, 400, { error: 'Give the model a name' });
        const dir = path.join(homeDir(), 'models');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `import-${Date.now()}.gguf`);
        try { await saveBody(req, file, 64 * 1024 ** 3); } catch (e) { return send(res, 400, { error: e.message }); }
        return streamJob(res, async (on) => { try { await ollama.importGguf(settings, file, name, on, ac.signal); } finally { fs.rm(file, { force: true }, () => {}); } });
      }
      return send(res, 404, { error: 'Not found' });
    }
    if (parts[0] === 'models') {
      try { return send(res, 200, { models: await listModels(loadSettings(), url.searchParams.get('provider') || 'ollama') }); }
      catch (e) { return send(res, 200, { models: [], error: e.message }); }
    }
    if (parts[0] === 'tasks') {
      if (parts.length === 1) {
        if (method === 'GET') return send(res, 200, { tasks: store.list() });
        if (method === 'POST') {
          const body = await readBody(req);
          const t = store.create();
          if (body.text) t.start(String(body.text));
          return send(res, 200, t.summary());
        }
      }
      const task = store.get(parts[1]);
      if (!task) return send(res, 404, { error: 'No such task' });
      const sub = parts[2];
      if (!sub && method === 'DELETE') { store.delete(task.id); return send(res, 200, { ok: true }); }
      if (sub === 'events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const from = Number(url.searchParams.get('from')) || 0;
        for (const ev of task.events.slice(from)) res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
        task.subscribers.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clearInterval(ping); task.subscribers.delete(res); });
        return;
      }
      if (sub === 'message' && method === 'POST') {
        const body = await readBody(req);
        if (!String(body.text || '').trim()) return send(res, 400, { error: 'Empty message' });
        try { task.start(String(body.text)); } catch (e) { return send(res, 409, { error: e.message }); }
        return send(res, 200, { ok: true });
      }
      if (sub === 'rewind' && method === 'POST') {
        const body = await readBody(req);
        if (!String(body.text || '').trim()) return send(res, 400, { error: 'Empty message' });
        try { task.rewind(Number(body.seq), String(body.text)); } catch (e) { return send(res, 409, { error: e.message }); }
        return send(res, 200, { ok: true });
      }
      if (sub === 'respond' && method === 'POST') {
        const body = await readBody(req);
        return send(res, task.respond(String(body.id), body.value) ? 200 : 404, { ok: true });
      }
      if (sub === 'stop' && method === 'POST') { task.stop(); return send(res, 200, { ok: true }); }
      if (sub === 'preview') {
        try { return send(res, 200, { url: await previewUrl(task.workspace, url.searchParams.get('path') || 'index.html') }); }
        catch (e) { return send(res, 500, { error: e.message }); }
      }
      if (sub === 'upload' && method === 'POST') {
        const dir = path.join(task.workspace, 'assets');
        fs.mkdirSync(dir, { recursive: true });
        const name = safeName(url.searchParams.get('name'));
        let target = path.join(dir, name);
        for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${path.parse(name).name}-${i}${path.extname(name)}`);
        try { await saveBody(req, target, 512 * 1024 * 1024); } catch (e) { return send(res, 400, { error: e.message }); }
        const rel = path.relative(task.workspace, target).replace(/\\/g, '/');
        task.emit('file', { path: rel });
        return send(res, 200, { path: rel });
      }
      if (sub === 'files') return send(res, 200, { tree: listDir(task.workspace, url.searchParams.get('path') || '.', 4) });
      if (sub === 'file') {
        const rel = url.searchParams.get('path') || '';
        let p;
        try { p = safePath(task.workspace, rel); } catch { return send(res, 400, { error: 'Bad path' }); }
        if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return send(res, 404, { error: 'Not found' });
        const ext = path.extname(p).toLowerCase();
        const dl = url.searchParams.get('download') === '1';
        // Files made by the agent are untrusted: never render HTML/SVG inline in our origin.
        const type = MIME[ext] && !['.html', '.svg'].includes(ext) ? MIME[ext] : 'text/plain; charset=utf-8';
        res.writeHead(200, {
          'content-type': dl ? 'application/octet-stream' : type,
          'content-disposition': dl ? `attachment; filename="${path.basename(p).replace(/"/g, '')}"` : 'inline',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
          'cache-control': 'no-store',
        });
        return fs.createReadStream(p).pipe(res);
      }
    }
    return send(res, 404, { error: 'Not found' });
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(UI_DIR, rel);
    if (!file.startsWith(UI_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }

  ensurePreview().catch(() => { /* started again on first use */ });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, store, token, port: addr.port, url: `http://127.0.0.1:${addr.port}/?token=${token}`, close: () => { for (const t of store.tasks.values()) t.stop(); mcp.manager.closeAll(); server.close(); } });
    });
  });
}

module.exports = { startServer };

if (require.main === module) {
  const port = Number(process.env.FREEHAND_PORT) || 4173;
  startServer({ port }).then((s) => {
    console.log(`\nFreehand is running. Open this link in your browser:\n\n  ${s.url}\n`);
  }).catch((e) => { console.error('Could not start:', e.message); process.exit(1); });
}
