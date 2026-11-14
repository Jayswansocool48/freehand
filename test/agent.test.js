'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mockProvider, toolCall, text, tempHome, writeSettings, waitFor } = require('./helpers');

const home = tempHome();
const { defaultSettings } = require('../src/core/config');
const { Agent } = require('../src/core/agent');
const { extractJson, stripThinking, htmlToText, safePath } = require('../src/core/util');
const { parseDuckDuckGo, parseBing } = require('../src/tools/web');
const { startServer } = require('../src/server');

function settingsFor(url, extra = {}) {
  const s = defaultSettings();
  s.active = 'custom';
  s.providers.custom.baseUrl = url;
  s.providers.custom.model = 'mock';
  s.approval = 'auto';
  return Object.assign(s, extra);
}

async function runAgent(settings, userText, { approve = async () => true, ask = async () => 'blue' } = {}) {
  const workspace = fs.mkdtempSync(path.join(home, 'ws-'));
  const events = [];
  const ac = new AbortController();
  const agent = new Agent({ settings, workspace, signal: ac.signal, history: [], emit: (t, d) => events.push({ type: t, ...d }), ask, approve });
  const result = await agent.run(userText);
  return { result, events, workspace, agent };
}

test('util: json extraction and thinking removal', () => {
  assert.deepEqual(extractJson('sure!\n```json\n{"a": 1, "b": [1,2,],}\n```'), { a: 1, b: [1, 2] });
  assert.deepEqual(extractJson('x {"s": "}{"} y'), { s: '}{' });
  assert.equal(stripThinking('<think>hmm</think>answer'), 'answer');
  assert.equal(extractJson('no json here'), null);
});

test('util: html to text keeps links, drops scripts', () => {
  const t = htmlToText('<html><head><title>x</title></head><body><script>evil()</script><h1>Hi</h1><p>See <a href="/a">this page</a> &amp; more</p></body></html>', 'https://ex.com/');
  assert.match(t, /# Hi/);
  assert.match(t, /this page \(https:\/\/ex\.com\/a\) & more/);
  assert.doesNotMatch(t, /evil/);
});

test('util: safePath blocks traversal and symlink escape', () => {
  const root = fs.mkdtempSync(path.join(home, 'sp-'));
  assert.ok(safePath(root, 'a/b.txt').startsWith(fs.realpathSync(root)) || safePath(root, 'a/b.txt').startsWith(root));
  assert.throws(() => safePath(root, '../x'), /outside/);
  assert.throws(() => safePath(root, '/etc/passwd'), /outside/);
  const outside = fs.mkdtempSync(path.join(home, 'out-'));
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => safePath(root, 'link/secret.txt'), /outside/);
});

test('search parsers', () => {
  const ddg = '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fp&amp;rut=1">Example <b>Title</b></a><a class="result__snippet" href="x">A snippet &amp; more</a>';
  assert.deepEqual(parseDuckDuckGo(ddg), [{ title: 'Example Title', url: 'https://example.com/p', snippet: 'A snippet & more' }]);
  const bing = '<li class="b_algo"><h2><a href="https://example.org/x">Org</a></h2><p>Desc</p></li>';
  assert.deepEqual(parseBing(bing), [{ title: 'Org', url: 'https://example.org/x', snippet: 'Desc' }]);
});

test('agent: plan -> write file -> run python -> finish (native tool calling)', async () => {
  const mock = await mockProvider((body, n) => {
    if (!body.tools) return { message: text('{"title":"Fibonacci","steps":["Write the script","Run it"]}') };
    const step = body.messages.filter((m) => m.role === 'tool').length;
    return { message: [
      toolCall('file_write', { path: 'fib.py', content: 'print(sum(range(10)))' }),
      toolCall('step_done', { summary: 'script written' }),
      toolCall('python', { code: 'print("hello from python", 6*7)' }),
      toolCall('step_done', { summary: 'ran it' }),
      toolCall('finish', { message: 'All **done**. Result 42.', files: ['fib.py', 'missing.txt'] }),
    ][step] };
  });
  const { result, events, workspace } = await runAgent(settingsFor(mock.url), 'make a fib script');
  mock.close();
  assert.equal(result.status, 'done');
  assert.ok(fs.existsSync(path.join(workspace, 'fib.py')));
  const py = events.find((e) => e.type === 'tool_result' && e.preview.includes('hello from python 42'));
  assert.ok(py, 'python output reached the model/UI');
  const fin = events.find((e) => e.type === 'final');
  assert.deepEqual(fin.files, ['fib.py'], 'only existing files are listed');
  const plans = events.filter((e) => e.type === 'plan');
  assert.ok(plans[plans.length - 1].steps.every((s) => s.status === 'done'));
});

test('agent: simple chat answers directly without tools', async () => {
  const mock = await mockProvider(() => ({ message: text('{"title":"Greeting","answer":"Hello there!"}') }));
  const { result, events } = await runAgent(settingsFor(mock.url), 'hi');
  mock.close();
  assert.equal(result.message, 'Hello there!');
  assert.ok(!events.some((e) => e.type === 'tool'));
});

test('effort: changes the plan size, the step budget and the instructions', async () => {
  const { applyPatch } = require('../src/core/config');
  assert.equal(applyPatch(defaultSettings(), { effort: 'max' }).effort, 'max');
  assert.equal(applyPatch(defaultSettings(), { effort: 'turbo' }).effort, 'high');
  const seen = [];
  const mock = await mockProvider((body) => {
    seen.push(body.messages[0].content);
    if (!body.tools) return { message: text('{"title":"Loop","steps":["Keep listing files"]}') };
    return { message: toolCall('file_list', { path: '.', n: seen.length }) };
  });
  const { result, events } = await runAgent(settingsFor(mock.url, { effort: 'low', maxSteps: 20 }), 'list files forever');
  mock.close();
  assert.match(seen[0], /1-3 concrete steps/);
  assert.match(seen[1], /Effort: LOW/);
  assert.equal(result.status, 'stopped');
  assert.equal(events.filter((e) => e.type === 'tool').length, 8, 'low effort gets 40% of 20 steps');
});

test('agent: falls back to JSON tool mode when the model rejects native tools', async () => {
  const mock = await mockProvider((body) => {
    if (!body.tools && body.messages[0].content.includes('planning module')) return { message: text('<think>ok</think>{"title":"T","steps":["do it"]}') };
    if (body.tools) return { status: 400, error: 'registry.ollama.ai/library/tiny does not support tools' };
    const results = body.messages.filter((m) => m.role === 'user' && m.content.startsWith('TOOL RESULT')).length;
    return { message: text([
      '```json\n{"thought":"write","tool":"file_write","args":{"path":"a.txt","content":"hi"}}\n```',
      'Okay: {"tool":"finish","args":{"message":"wrote it","files":["a.txt"]}}',
    ][results]) };
  });
  const { result, events, workspace } = await runAgent(settingsFor(mock.url), 'write a.txt');
  mock.close();
  assert.equal(result.status, 'done');
  assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'hi');
  assert.ok(events.some((e) => e.type === 'notice' && /JSON tool mode/.test(e.text)));
});

test('agent: denied approval is reported to the model and nothing runs', async () => {
  const marker = path.join(home, 'should-not-exist');
  const mock = await mockProvider((body) => {
    if (!body.tools) return { message: text('{"title":"T","steps":["x"]}') };
    const tools = body.messages.filter((m) => m.role === 'tool');
    if (tools.length === 0) return { message: toolCall('shell', { command: `echo hi > "${marker}"` }) };
    return { message: toolCall('finish', { message: 'denied: ' + tools[0].content.slice(0, 40) }) };
  });
  const s = settingsFor(mock.url, { approval: 'ask' });
  let asked;
  const { result } = await runAgent(s, 'run something', { approve: async (r) => { asked = r; return false; } });
  mock.close();
  assert.equal(asked.kind, 'shell');
  assert.match(result.message, /denied/);
  assert.ok(!fs.existsSync(marker));
});

test('agent: path traversal through file tools is rejected', async () => {
  const mock = await mockProvider((body) => {
    if (!body.tools) return { message: text('{"title":"T","steps":["x"]}') };
    const tools = body.messages.filter((m) => m.role === 'tool');
    if (!tools.length) return { message: toolCall('file_write', { path: '../../escape.txt', content: 'x' }) };
    return { message: toolCall('finish', { message: tools[0].content }) };
  });
  const { result } = await runAgent(settingsFor(mock.url), 'escape');
  mock.close();
  assert.match(result.message, /outside the workspace/);
});

test('providers: falls through to the next provider on failure', async () => {
  const bad = await mockProvider(() => ({ status: 500, error: 'down' }));
  const good = await mockProvider(() => ({ message: text('{"title":"T","answer":"from fallback"}') }));
  const s = settingsFor(bad.url);
  s.providers.groq.baseUrl = good.url; s.providers.groq.model = 'g'; s.providers.groq.apiKey = 'k';
  s.fallback = ['groq'];
  const { result, events } = await runAgent(s, 'hello');
  bad.close(); good.close();
  assert.equal(result.message, 'from fallback');
  assert.ok(events.some((e) => e.type === 'notice' && /Switching to groq/.test(e.text)));
});

test('agent: stop aborts a running task cleanly', async () => {
  const mock = await mockProvider((body) => {
    if (!body.tools) return { message: text('{"title":"T","steps":["x"]}') };
    return { message: toolCall('shell', { command: process.platform === 'win32' ? 'ping -n 30 127.0.0.1' : 'sleep 30', timeout_s: 60 }) };
  });
  const workspace = fs.mkdtempSync(path.join(home, 'ws-'));
  const ac = new AbortController();
  const events = [];
  const agent = new Agent({ settings: settingsFor(mock.url), workspace, signal: ac.signal, history: [], emit: (t, d) => events.push({ type: t, ...d }), ask: async () => '', approve: async () => true });
  const p = agent.run('sleep');
  await waitFor(() => events.some((e) => e.type === 'tool'));
  const t0 = Date.now();
  ac.abort();
  const r = await p;
  mock.close();
  assert.equal(r.status, 'stopped');
  assert.ok(Date.now() - t0 < 4000, 'process killed promptly');
});

test('server: auth token, host check, full task over HTTP with approval + ask', async () => {
  const mock = await mockProvider((body) => {
    if (!body.tools) return { message: text('{"title":"HTTP task","steps":["ask","act"]}') };
    const tools = body.messages.filter((m) => m.role === 'tool');
    return { message: [
      toolCall('ask_user', { question: 'Favourite colour?' }),
      toolCall('shell', { command: 'echo approved-run' }),
      toolCall('finish', { message: 'colour was ' + tools.map((t) => t.content).join('|') }),
    ][tools.length] };
  });
  writeSettings(home, settingsFor(mock.url, { approval: 'ask' }));
  const srv = await startServer({ port: 0, token: 'tok123' });
  const base = `http://127.0.0.1:${srv.port}`;
  const H = { 'x-freehand-token': 'tok123', 'content-type': 'application/json' };

  assert.equal((await fetch(base + '/api/tasks')).status, 401, 'no token rejected');
  const rawGet = (reqPath, headers) => new Promise((resolve, reject) => {
    require('http').get({ host: '127.0.0.1', port: srv.port, path: reqPath, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  assert.equal(await rawGet('/api/tasks', { 'x-freehand-token': 'tok123', host: 'evil.example' }), 403, 'bad Host rejected (DNS rebinding)');
  assert.equal((await fetch(base + '/api/settings', { headers: H })).status, 200);
  const settingsJson = await (await fetch(base + '/api/settings', { headers: H })).json();
  assert.equal(JSON.stringify(settingsJson).includes('apiKey'), false, 'keys never sent to UI');

  const created = await (await fetch(base + '/api/tasks', { method: 'POST', headers: H, body: JSON.stringify({ text: 'go' }) })).json();
  const task = srv.store.get(created.id);
  const ask = await waitFor(() => task.events.find((e) => e.type === 'ask'));
  assert.equal(ask.question, 'Favourite colour?');
  await fetch(`${base}/api/tasks/${created.id}/respond`, { method: 'POST', headers: H, body: JSON.stringify({ id: ask.id, value: 'teal' }) });
  const appr = await waitFor(() => task.events.find((e) => e.type === 'approval'));
  assert.equal(appr.detail, 'echo approved-run');
  await fetch(`${base}/api/tasks/${created.id}/respond`, { method: 'POST', headers: H, body: JSON.stringify({ id: appr.id, value: true }) });
  const fin = await waitFor(() => task.events.find((e) => e.type === 'final'));
  assert.match(fin.message, /teal/);
  assert.match(fin.message, /approved-run/);

  // file endpoints
  fs.writeFileSync(path.join(task.workspace, 'note.html'), '<script>alert(1)</script>');
  const f = await fetch(`${base}/api/tasks/${created.id}/file?path=note.html`, { headers: H });
  assert.match(f.headers.get('content-type'), /text\/plain/, 'agent HTML never served as HTML');
  assert.equal((await fetch(`${base}/api/tasks/${created.id}/file?path=../../settings.json`, { headers: H })).status, 400);

  // static UI via token redirect + cookie
  const r = await fetch(`${base}/?token=tok123`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const page = await fetch(base + '/', { headers: { cookie } });
  assert.match(await page.text(), /Freehand/);
  assert.equal(await rawGet('/..%2fpackage.json', { cookie }), 404, 'static server cannot escape ui/');
  assert.equal(await rawGet('/%2e%2e/package.json', { cookie }), 404);

  srv.close(); mock.close();
});
