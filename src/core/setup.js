'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { homeDir } = require('./config');

/*
 * Installs what a connector needs the first time it starts, so adding one is a single click:
 *   uv / uvx   Python connectors (uvx blender-mcp). Downloaded from uv's GitHub releases.
 *   npx        Node connectors (npx -y some-server). Node's LTS release from nodejs.org.
 *   Blender    the blender-mcp add-on, installed and turned on in Blender; Blender itself from
 *              Flathub on Linux when it is missing. Blender is opened when a Blender tool is used.
 * Downloads are checked against the checksums their makers publish, and everything goes into
 * Freehand's own tools folder (or the user's Flatpak apps), never system folders.
 */

const toolsDir = () => path.join(homeDir(), 'tools');
const isWin = process.platform === 'win32';
const exe = (n) => (isWin ? `${n}.exe` : n);

/** Folders with programs Freehand installed, for the connector's PATH. */
function binDirs() {
  return [path.join(toolsDir(), 'bin'), isWin ? path.join(toolsDir(), 'node') : path.join(toolsDir(), 'node', 'bin')];
}

/** True when a program can be found on PATH (or in Freehand's tools folders). */
function has(cmd, searchPath) {
  const dirs = String(searchPath || process.env.PATH || '').split(path.delimiter).concat(binDirs());
  const names = isWin ? [`${cmd}.exe`, `${cmd}.cmd`, cmd] : [cmd];
  return dirs.some((d) => names.some((n) => { try { return fs.statSync(path.join(d, n)).isFile(); } catch { return false; } }));
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!res.ok) throw new Error(`Could not download ${url} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Unpacks a .tar.gz or .zip with the system tar (Linux, macOS and Windows 10+ all have it). */
function unpack(buf, name, dest, strip) {
  fs.mkdirSync(dest, { recursive: true });
  const file = path.join(toolsDir(), name);
  fs.writeFileSync(file, buf);
  try {
    const r = spawnSync('tar', [isWin ? '-xf' : '-xzf', file, '-C', dest, ...(strip ? ['--strip-components=1'] : [])], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`Could not unpack ${name}: ${(r.stderr || r.error || '').toString().trim()}`);
  } finally { fs.rmSync(file, { force: true }); }
}

/** uv and uvx, from uv's GitHub releases. */
async function installUv() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const target = { linux: `${arch}-unknown-linux-gnu`, darwin: `${arch}-apple-darwin`, win32: `${arch}-pc-windows-msvc` }[process.platform];
  if (!target) throw new Error(`uv has no download for ${process.platform}`);
  const name = `uv-${target}.${isWin ? 'zip' : 'tar.gz'}`;
  const base = 'https://github.com/astral-sh/uv/releases/latest/download';
  const [buf, sum] = await Promise.all([download(`${base}/${name}`), download(`${base}/${name}.sha256`)]);
  if (sha256(buf) !== sum.toString().trim().split(/\s+/)[0]) throw new Error('The uv download did not match its checksum, so it was not installed.');
  unpack(buf, name, path.join(toolsDir(), 'bin'), !isWin);
}

/** Node.js (for npx), the current LTS release from nodejs.org. */
async function installNode() {
  const index = JSON.parse((await download('https://nodejs.org/dist/index.json')).toString());
  const lts = index.find((r) => r.lts);
  if (!lts) throw new Error('Could not find a Node.js release to install.');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const os = { linux: 'linux', darwin: 'darwin', win32: 'win' }[process.platform];
  const name = `node-${lts.version}-${os}-${arch}.${isWin ? 'zip' : 'tar.gz'}`;
  const base = `https://nodejs.org/dist/${lts.version}`;
  const [buf, sums] = await Promise.all([download(`${base}/${name}`), download(`${base}/SHASUMS256.txt`)]);
  const want = sums.toString().split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === name);
  if (!want || sha256(buf) !== want[0]) throw new Error('The Node.js download did not match its checksum, so it was not installed.');
  const dest = path.join(toolsDir(), 'node');
  fs.rmSync(dest, { recursive: true, force: true });
  unpack(buf, name, dest, true);
}

/** How to start Blender here, or null when it is not installed. */
function blenderCommand() {
  if (has('blender')) return ['blender'];
  if (process.platform === 'linux' && spawnSync('flatpak', ['info', 'org.blender.Blender'], { stdio: 'ignore' }).status === 0) return ['flatpak', 'run', 'org.blender.Blender'];
  const mac = '/Applications/Blender.app/Contents/MacOS/Blender';
  if (process.platform === 'darwin' && fs.existsSync(mac)) return [mac];
  if (isWin) {
    const root = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Blender Foundation');
    try {
      const v = fs.readdirSync(root).filter((d) => /^Blender/.test(d)).sort().pop();
      if (v && fs.existsSync(path.join(root, v, 'blender.exe'))) return [path.join(root, v, 'blender.exe')];
    } catch { /* not installed */ }
  }
  return null;
}

/** Blender itself: Flathub on Linux; elsewhere the user installs it. */
function installBlender() {
  if (process.platform !== 'linux' || spawnSync('flatpak', ['--version'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('Blender is not installed. Get it from blender.org/download, then connect again.');
  }
  spawnSync('flatpak', ['remote-add', '--user', '--if-not-exists', 'flathub', 'https://dl.flathub.org/repo/flathub.flatpakrepo'], { stdio: 'ignore' });
  const r = spawnSync('flatpak', ['install', '--user', '-y', '--noninteractive', 'flathub', 'org.blender.Blender'], { encoding: 'utf8', timeout: 30 * 60 * 1000 });
  if (r.status !== 0) throw new Error(`Could not install Blender: ${(r.stderr || '').trim().split('\n').pop()}`);
}

const ADDON_URL = 'https://raw.githubusercontent.com/ahujasid/blender-mcp/main/addon.py';
const addonMarker = () => path.join(toolsDir(), 'blender-mcp-addon.json');

/** Puts the blender-mcp add-on in Blender's add-ons folder and turns it on, by running Blender without a window. */
async function installBlenderAddon(blender) {
  const src = path.join(toolsDir(), 'blender_mcp.py');
  fs.mkdirSync(toolsDir(), { recursive: true });
  fs.writeFileSync(src, await download(ADDON_URL));
  // A startup script turns the add-on back on at every launch: the first launch of a new Blender
  // version can replace the saved preferences, which would drop it.
  // It waits for Blender to finish starting, since add-ons cannot be found while startup scripts run.
  const startup = [
    'import bpy, addon_utils',
    'def _freehand_enable():',
    "    if not addon_utils.check('blender_mcp')[1]:",
    "        addon_utils.enable('blender_mcp', default_set=True, persistent=True)",
    '    return None',
    'def register():',
    '    bpy.app.timers.register(_freehand_enable, first_interval=0.5, persistent=True)',
    'def unregister():',
    '    pass',
  ].join('\n');
  const script = [
    'import bpy, os, shutil, addon_utils',
    "d = bpy.utils.user_resource('SCRIPTS', path='addons', create=True)",
    `shutil.copy(${JSON.stringify(src)}, os.path.join(d, 'blender_mcp.py'))`,
    "s = bpy.utils.user_resource('SCRIPTS', path='startup', create=True)",
    `open(os.path.join(s, 'freehand_blender_mcp.py'), 'w').write(${JSON.stringify(startup)})`,
    "addon_utils.enable('blender_mcp', default_set=True, persistent=True)",
    'bpy.ops.wm.save_userpref()',
    "print('FREEHAND_ADDON_OK', d)",
  ].join('\n');
  const r = spawnSync(blender[0], [...blender.slice(1), '-b', '--python-expr', script], { encoding: 'utf8', timeout: 3 * 60 * 1000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (!out.includes('FREEHAND_ADDON_OK')) throw new Error(`Could not turn on the Blender add-on: ${out.trim().split('\n').slice(-2).join(' ').slice(0, 300) || r.error}`);
  fs.writeFileSync(addonMarker(), JSON.stringify({ at: new Date().toISOString(), blender }));
}

const isBlender = (cfg) => /blender-mcp/.test(String((cfg && cfg.command) || ''));

/** What a connector still needs installed: a list of { name, install }. */
function missing(cfg, searchPath) {
  if (!cfg || cfg.type !== 'command') return [];
  const first = path.basename(String(cfg.command || '').trim().split(/\s+/)[0] || '').replace(/\.(exe|cmd)$/i, '');
  const out = [];
  if ((first === 'uvx' || first === 'uv') && !has(first, searchPath)) out.push({ name: 'uv', install: installUv });
  if (['npx', 'npm', 'node'].includes(first) && !has(first, searchPath)) out.push({ name: 'Node.js', install: installNode });
  if (isBlender(cfg)) {
    if (!blenderCommand()) out.push({ name: 'Blender', install: installBlender });
    if (!fs.existsSync(addonMarker())) out.push({ name: 'the Blender add-on', install: () => installBlenderAddon(blenderCommand()) });
  }
  return out;
}

const installing = new Map(); // name -> promise, so two connectors never install the same thing at once

/** Installs whatever the connector is missing. onStatus gets "Installing uv..." lines. */
async function ensure(cfg, { searchPath, onStatus = () => {} } = {}) {
  for (const need of missing(cfg, searchPath)) {
    if (!installing.has(need.name)) {
      onStatus(`Installing ${need.name}...`);
      installing.set(need.name, Promise.resolve().then(need.install).finally(() => installing.delete(need.name)));
    }
    await installing.get(need.name);
  }
}

const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.setTimeout(500);
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
  s.once('timeout', () => { s.destroy(); resolve(false); });
});

let opening = null;

/** Opens Blender (its add-on starts the connector server) unless it is already running. */
async function ensureBlenderOpen(port = 9876) {
  if (await portOpen(port)) return;
  if (!opening) {
    opening = (async () => {
      const blender = blenderCommand();
      if (!blender) throw new Error('Blender is not installed.');
      spawn(blender[0], blender.slice(1), { detached: true, stdio: 'ignore' }).unref();
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await portOpen(port)) return;
      }
      throw new Error('Blender opened but its MCP add-on did not start. In Blender press N, open the MCP for Blender tab and press Connect.');
    })().finally(() => { opening = null; });
  }
  return opening;
}

module.exports = { ensure, missing, binDirs, has, ensureBlenderOpen, isBlender, blenderCommand, installUv, installNode, installBlenderAddon };
