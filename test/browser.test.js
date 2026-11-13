'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserSession } = require('../src/tools/browser');

test('browser tool: open, snapshot indices, type, click, screenshot', { timeout: 60000 }, async (t) => {
  const page = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url.startsWith('/done')) return res.end('<title>Done</title><h1>Thanks Ada</h1>');
    res.end('<title>Form</title><h1>Sign up</h1><form action="/done"><input name="n" placeholder="Your name"><button type="submit">Send</button></form><a href="/done">skip</a>');
  });
  await new Promise((r) => page.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-br-'));
  const shots = [];
  const b = new BrowserSession({ headless: true, shotsDir: path.join(dir, '.freehand', 'shots'), onShot: (f) => shots.push(f) });
  t.after(async () => { await b.close(); page.close(); });
  const url = `http://127.0.0.1:${page.address().port}/`;

  const snap = await b.act({ action: 'open', url });
  assert.match(snap, /Page: Form/);
  assert.match(snap, /\[1\] input "Your name"/);
  assert.match(snap, /button\(submit\) "Send"|button "Send"/);
  const idxInput = snap.match(/\[(\d+)\] input/)[1];
  const idxBtn = snap.match(/\[(\d+)\] button/)[1];
  await b.act({ action: 'type', index: Number(idxInput), text: 'Ada' });
  const after = await b.act({ action: 'click', index: Number(idxBtn) });
  assert.match(after, /Page: Done/);
  assert.match(after, /Thanks Ada/);
  assert.ok(shots.length >= 2 && fs.existsSync(shots[0]));
  await assert.rejects(() => b.act({ action: 'click', index: 999 }), /./);
  assert.match(await b.act({ action: 'text' }), /Thanks Ada/);
});
