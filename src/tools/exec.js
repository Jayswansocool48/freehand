'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_OUTPUT = 20000;

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/** Runs a shell command in cwd. Resolves with { code, output, timedOut }. Never rejects on non-zero exit. */
function runCommand(command, { cwd, timeoutMs = 120000, signal, onData }) {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const child = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
    const push = (d) => {
      const s = d.toString('utf8');
      out += s;
      if (out.length > MAX_OUTPUT * 2) out = out.slice(-MAX_OUTPUT * 2);
      if (onData) onData(s);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => killTree(child);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { out += `\n[spawn error] ${e.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const trimmed = out.length > MAX_OUTPUT ? `...[earlier output omitted]\n${out.slice(-MAX_OUTPUT)}` : out;
      resolve({ code, output: trimmed, timedOut });
    });
  });
}

let pythonCmd;
function findPython() {
  if (pythonCmd !== undefined) return pythonCmd;
  for (const c of process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    const r = spawnSync(c, ['--version'], { windowsHide: true });
    if (!r.error && r.status === 0) { pythonCmd = c; return c; }
  }
  pythonCmd = null;
  return null;
}

let counter = 0;
async function runPython(code, { workspace, timeoutMs, signal, onData }) {
  const py = findPython();
  if (!py) return { code: 127, output: 'Python is not installed on this machine. Use the shell tool with another runtime (node), or ask the user to install Python 3.', timedOut: false };
  const dir = path.join(workspace, '.freehand', 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `run-${Date.now()}-${++counter}.py`);
  fs.writeFileSync(file, code, 'utf8');
  return runCommand(`${py} "${file}"`, { cwd: workspace, timeoutMs, signal, onData });
}

module.exports = { runCommand, runPython, findPython };
