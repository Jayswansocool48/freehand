'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Serves task workspaces so games and pages the agent builds can run: in the app's Play tab and in the
 * agent's own test browser. It listens on its own port, so it is a different origin from the app and
 * agent-made pages cannot read or drive the app's API. A random per-launch token in the path keeps
 * other local programs and websites from reading workspace files.
 */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.obj': 'text/plain; charset=utf-8', '.mtl': 'text/plain; charset=utf-8',
  '.fbx': 'application/octet-stream', '.stl': 'model/stl', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};
const MODEL_EXT = ['.glb', '.gltf', '.obj', '.fbx', '.stl'];
const THREE_DIR = path.dirname(path.dirname(require.resolve('three'))); // .../three (resolve gives build/three.cjs)
// Packaged builds lose node_modules/three/examples, so the viewer's add-ons come from vendor/ (npm run vendor).
const ADDONS_DIR = [path.join(__dirname, '..', '..', 'vendor', 'three-addons'), path.join(THREE_DIR, 'examples', 'jsm')].find((d) => fs.existsSync(d));
const VIEWER = path.join(__dirname, 'viewer.html');

const token = crypto.randomBytes(16).toString('hex');
const roots = new Map(); // id -> workspace dir
let started = null;

/** Stable id for a workspace folder, so the agent and the UI build the same URLs. */
const rootId = (workspace) => crypto.createHash('sha1').update(path.resolve(workspace)).digest('hex').slice(0, 16);

function within(root, rel) {
  const base = fs.realpathSync(root);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  try { const real = fs.realpathSync(target); return real === base || real.startsWith(base + path.sep) ? real : null; } catch { return null; }
}

function sendFile(res, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return notFound(res); }
  if (stat.isDirectory()) return sendFile(res, path.join(file, 'index.html'));
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}
function notFound(res) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); }

function handle(req, res) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost'].includes(host) || req.method !== 'GET') { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return ''; } });
  if (parts[0] !== token) return notFound(res);
  if (parts[1] === 'viewer') return sendFile(res, VIEWER);
  if (parts[1] === 'lib' && parts[2] === 'three' && parts[3] === 'examples' && parts[4] === 'jsm') {
    const f = within(ADDONS_DIR, parts.slice(5).join('/'));
    return f ? sendFile(res, f) : notFound(res);
  }
  if (parts[1] === 'lib' && parts[2] === 'three') {
    const f = within(THREE_DIR, parts.slice(3).join('/'));
    return f ? sendFile(res, f) : notFound(res);
  }
  if (parts[1] === 'w' && roots.has(parts[2])) {
    const f = within(roots.get(parts[2]), parts.slice(3).join('/') || '.');
    return f ? sendFile(res, f) : notFound(res);
  }
  return notFound(res);
}

/** Starts the preview server once (lazily). Resolves with its base URL. */
function ensurePreview() {
  if (!started) {
    started = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => { try { handle(req, res); } catch { res.writeHead(500); res.end(); } });
      server.on('error', (e) => { started = null; reject(e); });
      server.listen(0, '127.0.0.1', () => { server.unref(); resolve(`http://127.0.0.1:${server.address().port}/${token}`); });
    });
  }
  return started;
}

/** URL that runs a workspace file (an HTML page) or, for 3D models, opens it in the built-in viewer. */
async function previewUrl(workspace, rel = 'index.html') {
  const base = await ensurePreview();
  const id = rootId(workspace);
  roots.set(id, workspace);
  const clean = String(rel || 'index.html').replace(/\\/g, '/').replace(/^\.?\/+/, '');
  const enc = clean.split('/').map(encodeURIComponent).join('/');
  if (MODEL_EXT.includes(path.extname(clean).toLowerCase())) return `${base}/viewer?src=${encodeURIComponent(`${base}/w/${id}/${enc}`)}`;
  return `${base}/w/${id}/${enc}`;
}

module.exports = { ensurePreview, previewUrl, MODEL_EXT };
