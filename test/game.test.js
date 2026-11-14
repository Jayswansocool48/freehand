'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mockProvider, toolCall, text, tempHome, writeSettings } = require('./helpers');

const home = tempHome();
const { defaultSettings } = require('../src/core/config');
const { Agent } = require('../src/core/agent');
const { buildTools } = require('../src/tools');
const { buildGlb, modelInfo } = require('../src/tools/model3d');
const { previewUrl } = require('../src/server/preview');
const { startServer } = require('../src/server');

function settingsFor(url, extra = {}) {
  const s = defaultSettings();
  s.active = 'custom';
  s.providers.custom.baseUrl = url;
  s.providers.custom.model = 'mock';
  s.approval = 'auto';
  return Object.assign(s, extra);
}

const tool = (name) => buildTools().find((t) => t.name === name);
function ctxFor(workspace) {
  const events = [];
  return { events, ctx: { workspace, settings: defaultSettings(), signal: new AbortController().signal, emit: (type, d) => events.push({ type, ...d }) } };
}

test('make_model writes a valid .glb that model_info can read back', async () => {
  const ws = fs.mkdtempSync(path.join(home, 'ws-'));
  const { ctx, events } = ctxFor(ws);
  const out = await tool('make_model').run({ path: 'assets/tree', parts: [
    { shape: 'cylinder', size: [0.3, 1.2, 0.3], position: [0, 0.6, 0], color: 'wood' },
    { shape: 'cone', size: [1.4, 1.8, 1.4], position: [0, 2.1, 0], color: '#3f8f3a', flat: true, segments: 8 },
  ] }, ctx);
  assert.match(out, /Saved assets\/tree\.glb: 2 parts/);
  assert.match(out, /size 1\.40 × 3\.00 × 1\.40 m \(bottom at y = 0\)\. The user/);
  const buf = fs.readFileSync(path.join(ws, 'assets/tree.glb'));
  assert.equal(buf.readUInt32LE(0), 0x46546c67, 'glTF magic');
  assert.equal(buf.readUInt32LE(8), buf.length, 'header length matches file');
  assert.ok(events.some((e) => e.type === 'model' && e.path === 'assets/tree.glb'));
  const info = await tool('model_info').run({ path: 'assets/tree.glb' }, ctx);
  assert.match(info, /Meshes: 2/);
  assert.match(info, /Size .*1\.4 × 3 × 1\.4/);
  assert.match(info, /Node names: cylinder_1, cone_2, tree/);
});

test('make_model rejects bad input with a useful message', () => {
  assert.throws(() => buildGlb({ parts: [] }), /at least one shape/);
  assert.throws(() => buildGlb({ parts: [{ shape: 'blob' }] }), /unknown shape "blob"/);
  assert.throws(() => buildGlb({ parts: [{ shape: 'box', color: 'not-a-colour' }] }), /hex color/);
});

test('model_info reads OBJ files and reports animations in glTF', () => {
  const dir = fs.mkdtempSync(path.join(home, 'm-'));
  fs.writeFileSync(path.join(dir, 'a.obj'), 'o Crate\nv 0 0 0\nv 2 0 0\nv 2 1 0\nv 0 1 3\nf 1 2 3\nf 1 3 4\n');
  assert.match(modelInfo(path.join(dir, 'a.obj')), /Vertices: 4 · triangles: ~2[\s\S]*Size: 2 × 1 × 3[\s\S]*Crate/);
  const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Hero', mesh: 0, translation: [0, 1, 0] }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ count: 3, type: 'VEC3', componentType: 5126, min: [-1, -1, 0], max: [1, 1, 0] }, { count: 2, type: 'SCALAR', componentType: 5126, min: [0], max: [1.5] }],
    animations: [{ name: 'Run', samplers: [{ input: 1, output: 0 }], channels: [] }] };
  fs.writeFileSync(path.join(dir, 'h.gltf'), JSON.stringify(gltf));
  const info = modelInfo(path.join(dir, 'h.gltf'));
  assert.match(info, /Size .*: 2 × 2 × 0/);
  assert.match(info, /Bottom sits at y = 0\.000/);
  assert.match(info, /0: "Run" 1\.50s/);
});

test('agent will not finish a game it has not play-tested (and gives up nudging after two tries)', async () => {
  const mock = await mockProvider((body) => {
    if (!body.tools) return { message: text('{"title":"Game","steps":["Build it"]}') };
    const n = body.messages.filter((m) => m.role === 'tool').length;
    if (n === 0) return { message: toolCall('file_write', { path: 'index.html', content: '<canvas></canvas>' }) };
    return { message: toolCall('finish', { message: 'Game ready', files: ['index.html'] }) };
  });
  const ws = fs.mkdtempSync(path.join(home, 'ws-'));
  const events = [];
  const agent = new Agent({ settings: settingsFor(mock.url), workspace: ws, signal: new AbortController().signal, history: [], emit: (t, d) => events.push({ type: t, ...d }), ask: async () => '', approve: async () => true });
  const result = await agent.run('make a game');
  mock.close();
  assert.equal(result.status, 'done');
  const nudges = agent.history.filter((h) => h.role === 'tool' && /Not finished yet/.test(h.content));
  assert.equal(nudges.length, 2, 'asked to play-test twice, then allowed to finish');
  assert.match(nudges[0].content, /play_test/);
  assert.ok(events.some((e) => e.type === 'notice' && /testing its work/.test(e.text)));
});

test('agent at low effort finishes a game without the play-test check', async () => {
  const prompts = [];
  const mock = await mockProvider((body) => {
    if (!body.tools) return { message: text('{"title":"Game","steps":["Build it"]}') };
    prompts.push(body.messages[0].content);
    const n = body.messages.filter((m) => m.role === 'tool').length;
    if (n === 0) return { message: toolCall('file_write', { path: 'index.html', content: '<canvas></canvas>' }) };
    return { message: toolCall('finish', { message: 'Game ready', files: ['index.html'] }) };
  });
  const ws = fs.mkdtempSync(path.join(home, 'ws-'));
  const agent = new Agent({ settings: settingsFor(mock.url, { effort: 'low' }), workspace: ws, signal: new AbortController().signal, history: [], emit: () => {}, ask: async () => '', approve: async () => true });
  const result = await agent.run('make a game');
  mock.close();
  assert.equal(result.status, 'done');
  assert.equal(agent.history.filter((h) => /Not finished yet/.test(h.content || '')).length, 0);
  assert.match(prompts[0], /Files already in the workspace:\n\(empty\)/);
  assert.match(prompts[1], /index\.html \(17 bytes\)/, 'the system prompt lists workspace files');
});

test('preview server: runs workspace pages as real HTML, serves three.js, blocks escapes', async () => {
  const ws = fs.mkdtempSync(path.join(home, 'ws-'));
  fs.mkdirSync(path.join(ws, 'game'));
  fs.writeFileSync(path.join(ws, 'game', 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(home, 'secret.txt'), 'nope');
  const url = await previewUrl(ws, 'game/index.html');
  const r = await fetch(url);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.equal(await r.text(), '<h1>hi</h1>');
  assert.equal((await fetch(url.replace(/index\.html$/, ''))).status, 200, 'folders serve their index.html');
  const base = url.replace(/\/w\/.*$/, '');
  assert.equal((await fetch(`${base}/lib/three/build/three.module.js`)).status, 200);
  assert.equal((await fetch(`${base}/viewer`)).status, 200);
  assert.equal((await fetch(`${base}/lib/three/examples/jsm/loaders/GLTFLoader.js`)).status, 200, 'viewer add-ons are served');
  // Raw paths: fetch() would normalise the ../ away before sending.
  const raw = (p) => new Promise((resolve) => require('http').get(new URL(base).origin + p, (res) => { res.resume(); resolve(res.statusCode); }));
  const prefix = new URL(url).pathname.split('/').slice(0, 4).join('/');
  assert.equal(await raw(`${prefix}/..%2f..%2fsecret.txt`), 404, 'cannot escape the workspace');
  assert.equal(await raw('/wrong-token/viewer'), 404, 'needs the per-launch token');
  const model = await previewUrl(ws, 'assets/a b.glb');
  assert.match(model, /\/viewer\?src=.*a%2520b\.glb$/, 'models open in the viewer');
});

test('server: uploads go to assets/, preview URLs, and cross-origin API calls are refused', async () => {
  writeSettings(home, settingsFor('http://127.0.0.1:9/v1'));
  const srv = await startServer({ port: 0, token: 'tok' });
  const base = `http://127.0.0.1:${srv.port}`;
  const H = { 'x-freehand-token': 'tok' };
  const created = await (await fetch(base + '/api/tasks', { method: 'POST', headers: H, body: '{}' })).json();
  assert.equal(srv.store.get(created.id).status, 'idle', 'a task can exist before its first message (to hold attachments)');

  const up = async (name, body) => (await fetch(`${base}/api/tasks/${created.id}/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: H, body })).json();
  assert.deepEqual(await up('hero.glb', Buffer.from('glTF')), { path: 'assets/hero.glb' });
  assert.deepEqual(await up('hero.glb', Buffer.from('glTF2')), { path: 'assets/hero-2.glb' }, 'never overwrites');
  assert.deepEqual(await up('../../evil.sh', 'x'), { path: 'assets/evil.sh' }, 'names cannot leave assets/');
  assert.ok(fs.existsSync(path.join(srv.store.get(created.id).workspace, 'assets', 'hero-2.glb')));

  const pv = await (await fetch(`${base}/api/tasks/${created.id}/preview?path=assets/hero.glb`, { headers: H })).json();
  assert.match(pv.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/viewer\?src=/);
  assert.notEqual(new URL(pv.url).port, String(srv.port), 'previews run on another origin');

  const evil = await fetch(`${base}/api/tasks/${created.id}/message`, { method: 'POST', headers: { ...H, origin: new URL(pv.url).origin, 'content-type': 'text/plain' }, body: '{"text":"rm -rf"}' });
  assert.equal(evil.status, 403, 'a page on the preview origin cannot drive the agent');
  const same = await fetch(`${base}/api/tasks`, { headers: { ...H, origin: base } });
  assert.equal(same.status, 200, 'the app itself still works');
  srv.close();
});

test('ollama: status reports when Ollama is not running', async () => {
  const { status } = require('../src/core/ollama');
  const s = defaultSettings();
  s.providers.ollama.baseUrl = 'http://127.0.0.1:9/v1';
  const st = await status(s);
  assert.equal(st.running, false);
  assert.equal(st.freehandName, 'freehand-v2');
  assert.ok(st.recommended.includes('qwen3:4b-instruct'));
});

test('ollama: builds freehand-v2 from a base model through the native API', async () => {
  const seen = [];
  const http = require('http');
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3:4b-instruct', size: 1, details: {} }] }));
      if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.0.0' }));
      if (req.url === '/api/create') { res.write('{"status":"creating"}\n'); return res.end('{"status":"success"}\n'); }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const { createFreehand } = require('../src/core/ollama');
  const s = defaultSettings();
  s.providers.ollama.baseUrl = `http://127.0.0.1:${fake.address().port}/v1`;
  const lines = [];
  await createFreehand(s, 'qwen3:4b-instruct', (l) => lines.push(l));
  fake.close();
  const create = seen.find((x) => x.url === '/api/create');
  assert.equal(create.body.model, 'freehand-v2');
  assert.equal(create.body.from, 'qwen3:4b-instruct');
  assert.match(create.body.system, /make_model/);
  assert.equal(create.body.parameters.num_ctx, 16384);
  assert.ok(!seen.some((x) => x.url === '/api/pull'), 'no download when the base is already there');
  assert.deepEqual(lines.map((l) => l.status), ['creating', 'success']);
});

test('ui: Play tab, attach button and frame permissions are wired', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  assert.match(html, /frame-src http:\/\/127\.0\.0\.1:\*/);
  assert.match(html, /data-cp="play"/);
  assert.match(html, /id="attach"/);
  for (const i of ['game-controller', 'cube', 'paperclip', 'arrows-out', 'arrow-square-out']) assert.ok(fs.existsSync(path.join(__dirname, '..', 'ui', 'icons', i + '.svg')), i);
});

test('make_model stacks parts with "on", lifts models onto the ground, and flags floating or buried parts', () => {
  const r = buildGlb({ parts: [
    { name: 'walls', shape: 'box', size: [2, 1.6, 2], position: [0, 0.3, 0] },
    { name: 'roof', shape: 'pyramid', size: [2.4, 1.1, 2.4], on: 'walls' },
    { name: 'lamp', shape: 'sphere', size: 0.3, position: [0, 4, 0] },
    { name: 'gem', shape: 'box', size: 0.2, position: [0, 0.3, 0] },
  ] });
  assert.ok(Math.abs(r.lifted - 0.5) < 1e-9, 'walls went 0.5 below the ground');
  assert.deepEqual(r.bounds.min.map((v) => +v.toFixed(3)), [-1.2, 0, -1.2]);
  const house = buildGlb({ parts: [{ name: 'walls', shape: 'box', size: [2, 1.6, 2], position: [0, 0.8, 0] }, { name: 'roof', shape: 'pyramid', size: [2.4, 1.1, 2.4], on: 'walls' }] });
  assert.equal(+house.bounds.max[1].toFixed(3), 2.7, 'roof rests exactly on the walls (1.6 + 1.1)');
  assert.deepEqual(house.warnings, []);
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /"lamp" floats/);
  assert.match(r.warnings[1], /"gem" is completely inside "walls"/);
  assert.throws(() => buildGlb({ parts: [{ name: 'a', shape: 'box', on: 'nothing' }] }), /no earlier part/);
  const rot = buildGlb({ parts: [{ shape: 'box', size: [2, 1, 1], rotation: 90 }] });
  assert.ok(Math.abs(rot.bounds.max[2] - 1) < 1e-6, 'a single rotation number turns the part around y');
});

test('agent recovers tool calls written as text and does not stop early on a plain reply', async () => {
  const mock = await mockProvider((body) => {
    if (!body.tools) return { message: text('{"title":"Notes","steps":["Write notes.md","Check it"]}') };
    const n = body.messages.filter((m) => m.role === 'tool').length;
    const said = body.messages.filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('All good')).length;
    if (n === 0) return { message: toolCall('file_write', { path: 'notes.md', content: 'hi' }) };
    if (n === 1) return { message: text('step_done({"summary": "wrote notes.md"})') }; // a call written as text
    if (n === 2 && !said) return { message: text('All good, nothing else to do.') }; // plain reply with a step still open
    if (n === 2) return { message: toolCall('step_done', { summary: 'checked' }) };
    return { message: toolCall('finish', { message: 'Done', files: ['notes.md'] }) };
  });
  const ws = fs.mkdtempSync(path.join(home, 'ws-'));
  const events = [];
  const agent = new Agent({ settings: settingsFor(mock.url), workspace: ws, signal: new AbortController().signal, history: [], emit: (t, d) => events.push({ type: t, ...d }), ask: async () => '', approve: async () => true });
  const result = await agent.run('write notes');
  mock.close();
  assert.equal(result.status, 'done');
  assert.equal(result.message, 'Done', 'the plain reply did not end the task');
  assert.deepEqual(events.filter((e) => e.type === 'step_note').map((e) => e.text), ['wrote notes.md', 'checked']);
  assert.ok(agent.history.some((h) => h.role === 'user' && /plan is not finished \(current step: "Check it"\)/.test(h.content)));
});

test('agent may repeat play_test after changing a file (loop guard resets on edits)', async () => {
  const mock = await mockProvider((body) => {
    if (!body.tools) return { message: text('{"title":"Game","steps":["Build it"]}') };
    const n = body.messages.filter((m) => m.role === 'tool').length;
    const seq = [
      toolCall('file_write', { path: 'a.txt', content: '1' }), toolCall('file_list', {}),
      toolCall('file_write', { path: 'a.txt', content: '2' }), toolCall('file_list', {}),
      toolCall('file_write', { path: 'a.txt', content: '3' }), toolCall('file_list', {}),
      toolCall('finish', { message: 'ok' }),
    ];
    return { message: seq[n] };
  });
  const ws = fs.mkdtempSync(path.join(home, 'ws-'));
  const agent = new Agent({ settings: settingsFor(mock.url), workspace: ws, signal: new AbortController().signal, history: [], emit: () => {}, ask: async () => '', approve: async () => true });
  await agent.run('go');
  mock.close();
  assert.equal(agent.history.filter((h) => h.role === 'tool' && /exact call several times/.test(h.content)).length, 0);
});
