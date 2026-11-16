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

test('game_template writes a working starter and will not overwrite a game by accident', async () => {
  const ws = fs.mkdtempSync(path.join(home, 'ws-'));
  const { ctx, events } = ctxFor(ws);
  const out = await tool('game_template').run({ template: 'flyer', title: 'Sky <Hop>' }, ctx);
  assert.match(out, /Wrote index\.html, kit\.js, game\.js/);
  assert.match(fs.readFileSync(path.join(ws, 'index.html'), 'utf8'), /<title>Sky Hop<\/title>[\s\S]*kit\.js[\s\S]*game\.js/);
  assert.match(fs.readFileSync(path.join(ws, 'game.js'), 'utf8'), /passed/);
  assert.ok(events.some((e) => e.type === 'file' && e.path === 'game.js'));
  await assert.rejects(tool('game_template').run({ template: 'platformer' }, ctx), /already exist[\s\S]*overwrite/);
  await tool('game_template').run({ template: 'platformer', overwrite: true }, ctx);
  assert.match(fs.readFileSync(path.join(ws, 'game.js'), 'utf8'), /LEVEL/);
  await assert.rejects(tool('game_template').run({ template: 'racing' }, ctx), /Unknown template "racing"/);

  const ws3 = fs.mkdtempSync(path.join(home, 'ws-'));
  await tool('game_template').run({ template: '3d' }, ctxFor(ws3).ctx);
  assert.ok(fs.existsSync(path.join(ws3, 'assets/player.glb')), 'the 3d template ships the models it loads');
  assert.ok(fs.existsSync(path.join(ws3, 'assets/enemy.glb')));
  assert.match(fs.readFileSync(path.join(ws3, 'index.html'), 'utf8'), /importmap[\s\S]*type="module" src="game\.js"/);
});

test('every 3D template is a kit3d.js game with the models it loads', () => {
  const { TEMPLATES, installTemplate } = require('../src/tools/gamekit');
  const kinds = Object.keys(TEMPLATES).filter((k) => TEMPLATES[k].three);
  assert.ok(kinds.length >= 7);
  for (const kind of kinds) {
    const ws = fs.mkdtempSync(path.join(home, 'ws-'));
    installTemplate(ws, kind, { title: kind });
    const game = fs.readFileSync(path.join(ws, 'game.js'), 'utf8');
    assert.match(game, /import \{ Kit, THREE \} from '\.\/kit3d\.js'/, kind);
    assert.match(game, /Kit\.start\(/, kind);
    assert.match(game, /const TUNING/, kind);
    for (const m of game.matchAll(/'(assets\/\w+\.glb)'/g)) assert.ok(fs.existsSync(path.join(ws, m[1])), `${kind} ships ${m[1]}`);
  }
  // kit3d.js parses as a module (it imports three, so only check the syntax here; scripts/check-3d.js plays them)
  const src = fs.readFileSync(require.resolve('../src/tools/gamekit/kit3d.js'), 'utf8');
  assert.doesNotThrow(() => new Function(src.replace(/^import .*$/gm, '').replace(/^export (const|\{[^}]*\};)/gm, (m, k) => (k === 'const' ? 'const' : ''))));
});

test('game_recipe gives the 3D version in a 3D game', async () => {
  const ws = fs.mkdtempSync(path.join(home, 'ws-'));
  const { ctx } = ctxFor(ws);
  assert.match(await tool('game_recipe').run({ recipe: 'coins' }, ctx), /ctx\.ellipse/);
  require('../src/tools/gamekit').installTemplate(ws, '3d-blank');
  const three = await tool('game_recipe').run({ recipe: 'coins' }, ctx);
  assert.match(three, /kit3d\.js game/);
  assert.match(three, /Kit\.cylinder/);
  assert.match(await tool('game_recipe').run({ recipe: 'shooting' }, ctx), /Kit\.sphere/);
  await assert.rejects(tool('game_recipe').run({ recipe: 'shooting' }, ctxFor(fs.mkdtempSync(path.join(home, 'ws-'))).ctx), /Unknown recipe "shooting"/);
});

test('make_sprite saves a PNG, makes sprite sheets and reports colours missing from the palette', async () => {
  const ws = fs.mkdtempSync(path.join(home, 'ws-'));
  const { ctx } = ctxFor(ws);
  const out = await tool('make_sprite').run({ path: 'assets/coin', pixels: ['.YY.', 'YXYY', '.YY.'], palette: { Y: 'yellow' }, scale: 2 }, ctx);
  assert.match(out, /Saved assets\/coin\.png \(8×6 px\)/);
  assert.match(out, /not in the palette[^\n]*X/);
  const png = fs.readFileSync(path.join(ws, 'assets/coin.png'));
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 8);
  assert.equal(png.readUInt32BE(20), 6);
  const sheet = await tool('make_sprite').run({ path: 'assets/walk.png', frames: [['AB'], ['BA'], ['AA']], palette: { A: '#f00', B: '#00ff0080' } }, ctx);
  assert.match(sheet, /24×4 px\)\. Sprite sheet: 3 frames, each 8 px wide/);
  await assert.rejects(tool('make_sprite').run({ path: 'x.png', pixels: ['A'], palette: { A: 'blurple' } }, ctx), /not a hex color/);
});

test('game_engine copies only the engine, so the model writes the game itself', async () => {
  const ws = fs.mkdtempSync(path.join(home, 'ws-'));
  const out = await tool('game_engine').run({ kind: '3d', title: 'Knight <Run>' }, ctxFor(ws).ctx);
  assert.deepEqual(fs.readdirSync(ws).sort(), ['index.html', 'kit3d.js']);
  assert.match(fs.readFileSync(path.join(ws, 'index.html'), 'utf8'), /<title>Knight Run<\/title>[\s\S]*importmap/);
  assert.match(out, /write game\.js yourself/);
  assert.match(out, /Kit\.start\(\{ init, update, title, hint, camera/, 'the model gets the engine API');
  const ws2 = fs.mkdtempSync(path.join(home, 'ws-'));
  await tool('game_engine').run({ kind: '2d' }, ctxFor(ws2).ctx);
  assert.deepEqual(fs.readdirSync(ws2).sort(), ['index.html', 'kit.js']);
});

test('agent does not install a starter game for a game request', async () => {
  let firstAgentCall = null;
  const mock = await mockProvider((body) => {
    if (!body.tools) return { message: text('{"title":"Flappy","steps":["Write the game"]}') };
    if (!firstAgentCall) firstAgentCall = body.messages;
    return { message: toolCall('finish', { message: 'Done' }) };
  });
  const s = settingsFor(mock.url, { effort: 'low' });
  const workspace = fs.mkdtempSync(path.join(home, 'ws-'));
  const events = [];
  const agent = new Agent({ settings: s, workspace, signal: new AbortController().signal, history: [], emit: (t, d) => events.push({ type: t, ...d }), ask: async () => '', approve: async () => true });
  await agent.run('make a 3d flappy bird game');
  mock.close();
  assert.deepEqual(fs.readdirSync(workspace), [], 'no files appear before the model writes them');
  assert.ok(!events.some((e) => e.type === 'tool' && e.name === 'game_template'));
  assert.ok(!firstAgentCall.some((m) => m.role === 'assistant' && m.tool_calls), 'the model starts with no tool calls made for it');
});

test('agent refuses a file_write that would throw away a working kit game', async () => {
  const workspace = fs.mkdtempSync(path.join(home, 'ws-'));
  require('../src/tools/gamekit').installTemplate(workspace, 'flyer');
  const agent = new Agent({ settings: settingsFor('http://127.0.0.1:1'), workspace, signal: new AbortController().signal, history: [], emit: () => {}, ask: async () => '', approve: async () => true });
  const w = (p, content) => agent.guardWrite({ name: 'file_write', args: { path: p, content } });
  assert.match(w('index.html', '<html><script>let bird;</script></html>'), /throw away the working game/);
  assert.match(w('kit.js', '//'), /tested engine/);
  assert.match(w('game.js', 'function loop() {}'), /does not call Kit\.start/);
  assert.equal(w('game.js', 'Kit.start({ init, update, draw });'), null);
  assert.equal(w('notes.md', 'hi'), null);
  assert.match(agent.guardWrite({ name: 'file_edit', args: { path: 'kit.js' } }), /tested engine/);
  assert.equal(agent.guardWrite({ name: 'file_edit', args: { path: 'game.js' } }), null);

  const ws3 = fs.mkdtempSync(path.join(home, 'ws-'));
  require('../src/tools/gamekit').installTemplate(ws3, '3d-fps');
  const agent3 = new Agent({ settings: settingsFor('http://127.0.0.1:1'), workspace: ws3, signal: new AbortController().signal, history: [], emit: () => {}, ask: async () => '', approve: async () => true });
  const w3 = (p, content) => agent3.guardWrite({ name: 'file_write', args: { path: p, content } });
  assert.match(w3('kit3d.js', '//'), /kit3d\.js is the tested engine/);
  assert.match(w3('index.html', '<html><script type="module">import * as THREE from "three";</script></html>'), /throw away the working game/);
  assert.match(w3('game.js', 'const scene = new THREE.Scene();'), /does not call Kit\.start/);
  assert.equal(w3('game.js', "import { Kit, THREE } from './kit3d.js';\nKit.start({ init, update });"), null);
  assert.match(agent3.guardWrite({ name: 'web_search', args: { query: 'free gold coin glb model download' } }), /make_model/);
  assert.equal(agent3.guardWrite({ name: 'web_search', args: { query: 'how fast does a cheetah run' } }), null);
  assert.equal(agent.guardWrite({ name: 'web_fetch', args: { url: 'https://example.com/a.png' } }) === null, false);

  const ws4 = fs.mkdtempSync(path.join(home, 'ws-'));
  require('../src/tools/gamekit').installEngine(ws4, '3d');
  const agent4 = new Agent({ settings: settingsFor('http://127.0.0.1:1'), workspace: ws4, signal: new AbortController().signal, history: [], emit: () => {}, ask: async () => '', approve: async () => true });
  assert.match(agent4.guardWrite({ name: 'file_write', args: { path: 'game.js', content: 'let x;' } }), /End it with Kit\.start\(\{ title/, 'a first game.js gets told how to end, not to edit');
});

test('every game recipe runs inside a kit game without errors', () => {
  const vm = require('vm');
  const { RECIPES, recipeText } = require('../src/tools/gamekit/recipes');
  const blank = fs.readFileSync(path.join(__dirname, '../src/tools/gamekit/templates/blank/game.js'), 'utf8');
  const anyCtx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => ({ addColorStop() {} })), set: (o, k, v) => { o[k] = v; return true; } });
  for (const [name, r] of Object.entries(RECIPES)) {
    assert.match(recipeText(name), /top of game\.js/);
    const code = blank
      .replace('let player;', `let player;\n${r.top}`)
      .replace(/(function init\(\) \{\n[^\n]*\n)/, `$1${r.init}\n`)
      .replace(/(if \(Kit\.pressed\('jump'\)\)[^\n]*\n)/, `$1${r.update}\n`)
      .replace(/(ctx\.fillRect\(player\.x, player\.y, player\.w, player\.h\);\n)/, `$1${r.draw}\n`)
      .replace(/Kit\.start\(\{([^}]*)\}\);/, 'globalThis.game = {$1};');
    for (const part of [r.top, r.init, r.update, r.draw]) assert.ok(code.includes(part), `${name}: every part was pasted in`);
    assert.match(code, /globalThis\.game/);
    const kit = { down: () => false, pressed: () => false, overlap: () => true, clamp: (v, a, b) => Math.max(a, Math.min(b, v)), rand: (a, b) => a + Math.random() * (b - a), addScore: () => { g.score++; }, gameOver: () => { g.over = true; }, sfx() {}, shake() {}, burst() {}, image: () => ({ complete: false }), drawImage() {} };
    const g = { score: 0, time: 0, state: 'play', pointer: null };
    const sandbox = { Kit: kit, Math, document: { title: 't' } };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: `${name}.js` });
    const game = sandbox.game;
    game.init(g);
    for (let i = 0; i < 600; i++) { g.time += 1 / 60; game.update(g, 1 / 60); if (i % 10 === 0) game.draw(g, anyCtx); }
  }
  assert.throws(() => recipeText('jetpack'), /Unknown recipe "jetpack"/);
});

test('templates ship a player sprite, and file_edit warns about edits inside comments', async () => {
  const ws = fs.mkdtempSync(path.join(home, 'ws-'));
  const { ctx } = ctxFor(ws);
  const out = await tool('game_template').run({ template: 'flyer' }, ctx);
  assert.match(out, /assets\/player\.png/);
  assert.equal(fs.readFileSync(path.join(ws, 'assets/player.png')).toString('hex', 1, 4), '504e47');
  assert.match(fs.readFileSync(path.join(ws, 'game.js'), 'utf8'), /^const playerImg = Kit\.image\('assets\/player\.png'\);/m);
  fs.writeFileSync(path.join(ws, 'extra.js'), "let a = 1;\n// const img = Kit.image('a.png');\n");
  assert.match(await tool('file_edit').run({ path: 'extra.js', find: "Kit.image('a.png')", replace: "Kit.image('b.png')" }, ctx), /inside a \/\/ comment/);
  assert.equal(await tool('file_edit').run({ path: 'extra.js', find: 'let a = 1;', replace: 'let a = 2;' }, ctx), 'Edited extra.js');
});

test('agent says it is stuck when play_test keeps reporting the same error', () => {
  const agent = new Agent({ settings: settingsFor('http://127.0.0.1:1'), workspace: home, signal: new AbortController().signal, history: [], emit: () => {}, ask: async () => '', approve: async () => true });
  const report = 'Played ./index.html\nERRORS (1), fix these:\n[uncaught] ReferenceError: playerImg is not defined\n    at ./game.js:20:1\nFailed loads: none';
  assert.equal(agent.repeatedError(report), '');
  assert.equal(agent.repeatedError(report), '');
  assert.match(agent.repeatedError(report), /STUCK[\s\S]*file_read game\.js[\s\S]*line 20/);
  assert.equal(agent.repeatedError('Played ./index.html\nErrors: none'), '');
});

test('file_edit refuses an edit that only adds lines the file already has', async () => {
  const ws = fs.mkdtempSync(path.join(home, 'ws-'));
  fs.writeFileSync(path.join(ws, 'game.js'), "const knight = Kit.model('a.glb');\ng.player = knight;\n");
  const { ctx } = ctxFor(ws);
  await assert.rejects(tool('file_edit').run({ path: 'game.js', find: "const knight = Kit.model('a.glb');", replace: "const knight = Kit.model('a.glb');\ng.player = knight;" }, ctx), /already in game\.js/);
  await tool('file_edit').run({ path: 'game.js', find: 'g.player = knight;', replace: 'g.player = knight;\ng.player.vel = new THREE.Vector3();' }, ctx);
  // A find that stops mid-word comes from a model that thinks the file was cut off there.
  await assert.rejects(tool('file_edit').run({ path: 'game.js', find: 'g.player = kn', replace: 'g.player = null;' }, ctx), /middle of a word[\s\S]*not cut off/);
  assert.match(fs.readFileSync(path.join(ws, 'game.js'), 'utf8'), /vel = new THREE/);
});

test('game design: a "rust like" request becomes a survival brief, and finishing checks it was built', async () => {
  const { designBrief, missingFeatures } = require('../src/core/gamedesign');
  const b = designBrief('make a 3d rust like game thats simple');
  assert.deepEqual(b.features, ['gather', 'craft', 'build', 'hunger']);
  assert.match(b.text, /survival game like Rust/);
  assert.equal(designBrief('make a game like Hollow Knight').like, 'Hollow Knight');
  assert.equal(designBrief('write a python script'), null);
  assert.equal(designBrief('make a rust like game').three, true, 'Rust is a 3D game, so it is built in 3D');
  assert.equal(designBrief('make a 2d rust like game').three, false);
  assert.equal(missingFeatures(b, 'g.coins = []; // a coin collector').length, 4, 'a coin collector is not a survival game');
  const { RECIPES_3D } = require('../src/tools/gamekit/recipes');
  const all = ['gather', 'craft', 'build', 'hunger'].map((n) => RECIPES_3D[n].top + RECIPES_3D[n].update).join('\n');
  assert.deepEqual(missingFeatures(b, all), [], 'the survival recipes satisfy the brief');

  // The agent will not finish a coin collector when a Rust-like game was asked for.
  let tries = 0;
  const mock = await mockProvider((body) => {
    if (!body.tools) return { message: text('{"title":"Rust","steps":["Write the game"]}') };
    if (/game design for/i.test(body.messages[0].content)) tries++;
    return { message: toolCall('finish', { message: 'Done' }) };
  });
  const workspace = fs.mkdtempSync(path.join(home, 'ws-'));
  fs.writeFileSync(path.join(workspace, 'game.js'), 'g.coins = [];');
  fs.writeFileSync(path.join(workspace, 'index.html'), '<script src="game.js"></script>');
  const events = [];
  const agent = new Agent({ settings: settingsFor(mock.url, { effort: 'high' }), workspace, signal: new AbortController().signal, history: [], emit: (t, d) => events.push({ type: t, ...d }), ask: async () => '', approve: async () => true });
  agent.game.changed = false;
  await agent.run('make a 3d rust like game thats simple');
  mock.close();
  assert.ok(tries > 0, 'the brief is in the instructions');
  assert.ok(events.some((e) => e.type === 'notice' && /testing its work/.test(e.text)) || agent.history.some((h) => /does not do what was asked/.test(h.content || '')));
});
