'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Fake OpenAI-compatible server. handler(body, callIndex) -> { status?, json? | message } */
function mockProvider(handler) {
  let n = 0;
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'm-a' }, { id: 'm-b' }] })); }
      calls.push(body);
      const out = handler(body, n++) || {};
      res.writeHead(out.status || 200, { 'content-type': 'application/json', ...(out.headers || {}) });
      if (out.json) return res.end(JSON.stringify(out.json));
      if (out.status && out.status >= 400) return res.end(JSON.stringify({ error: { message: out.error || 'boom' } }));
      res.end(JSON.stringify({ choices: [{ message: out.message, finish_reason: 'stop' }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() })));
}

const toolCall = (name, args, id) => ({ role: 'assistant', content: null, tool_calls: [{ id: id || 'c_' + Math.random().toString(36).slice(2, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const text = (content) => ({ role: 'assistant', content });

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freehand-test-'));
  process.env.FREEHAND_HOME = dir;
  process.env.FREEHAND_RETRY_SCALE = '0.001';
  return dir;
}

function writeSettings(home, patch) {
  const { defaultSettings } = require('../src/core/config');
  const s = defaultSettings();
  Object.assign(s, patch);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(s));
}

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('waitFor timed out');
}

module.exports = { mockProvider, toolCall, text, tempHome, writeSettings, waitFor };
