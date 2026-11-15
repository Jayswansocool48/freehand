'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { mockProvider, toolCall, text, tempHome } = require('./helpers');

const home = tempHome();
const { defaultSettings } = require('../src/core/config');
const { Agent } = require('../src/core/agent');
const { ConnectorManager, parseImport, splitCommand, normalize } = require('../src/core/mcp');
const { handle } = require('./fixtures/fake-mcp');

const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp.js');
const stdioCfg = (extra = {}) => ({ id: 'blender', name: 'Blender', type: 'command', command: `"${process.execPath}" "${FAKE}"`, enabled: true, disabledTools: [], ...extra });

/** The fake server over Streamable HTTP, answering with an event stream like real servers do. */
function httpServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const msg = JSON.parse(raw);
      seen.push({ method: msg.method, session: req.headers['mcp-session-id'] });
      const out = handle(msg);
      if (!out) { res.writeHead(202); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\n\n`);
      res.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
      // Leave the stream open: the client must stop reading once its answer arrived.
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ seen, url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => server.closeAllConnections() || server.close() })));
}

test('connectors: stdio server lists tools across pages and runs them', async () => {
  const m = new ConnectorManager();
  try {
    const tools = await m.toolsFor({ connectors: [stdioCfg({ disabledTools: ['fail'] })] });
    assert.deepEqual(tools.map((t) => t.name), ['blender__get_scene_info', 'blender__create_object', 'blender__screenshot']);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.blender__get_scene_info.approval, null, 'read-only tools do not ask');
    assert.equal(byName.blender__create_object.approval({ type: 'cube' }).title, 'Blender: create object');
    assert.deepEqual(byName.blender__create_object.parameters.required, ['type']);
    const ctx = { signal: new AbortController().signal };
    assert.equal(await byName.blender__create_object.run({ type: 'cube', name: 'Crate' }, ctx), 'Created Crate');
    assert.equal(await byName.blender__get_scene_info.run({}, ctx), 'Objects: Crate');
    assert.equal(m.statusOf('blender').state, 'connected');
    assert.equal(m.statusOf('blender').server, 'FakeBlender');
  } finally { m.closeAll(); }
});

test('connectors: HTTP server with event-stream replies keeps its session', async () => {
  const srv = await httpServer();
  const m = new ConnectorManager();
  try {
    const tools = await m.toolsFor({ connectors: [{ id: 'figma', name: 'Figma', type: 'url', url: srv.url, enabled: true }] });
    assert.equal(tools.length, 4);
    const fail = tools.find((t) => t.name === 'figma__fail');
    await assert.rejects(fail.run({}, { signal: new AbortController().signal }), /Blender is not connected/);
    assert.equal(srv.seen[0].session, undefined);
    assert.ok(srv.seen.slice(1).every((s) => s.session === 'sess-1'), 'session id sent after initialize');
  } finally { m.closeAll(); srv.close(); }
});

test('connectors: a broken connector is reported, not fatal', async () => {
  const m = new ConnectorManager();
  const notes = [];
  const tools = await m.toolsFor({ connectors: [
    { id: 'nope', name: 'Nope', type: 'command', command: 'definitely-not-a-real-program-xyz', enabled: true },
    { id: 'down', name: 'Down', type: 'url', url: 'http://127.0.0.1:9/mcp', enabled: true },
    { id: 'off', name: 'Off', type: 'command', command: 'whatever', enabled: false },
  ] }, (t) => notes.push(t));
  assert.equal(tools.length, 0);
  assert.equal(notes.length, 2);
  assert.match(notes.join('\n'), /Nope: "definitely-not-a-real-program-xyz" is not installed/);
  assert.match(notes.join('\n'), /Down: Nothing is answering at http:\/\/127\.0\.0\.1:9\/mcp/);
  assert.equal(m.statusOf('nope').state, 'error');
});

test('connectors: config import and command parsing', () => {
  assert.deepEqual(splitCommand('uvx "my server" --flag \'a b\''), ['uvx', 'my server', '--flag', 'a b']);
  const list = parseImport(JSON.stringify({ mcpServers: { blender: { command: 'uvx', args: ['blender-mcp'] }, figma: { url: 'http://127.0.0.1:3845/mcp' }, ctx: { command: 'npx', args: ['-y', 'x'], env: { KEY: 'v' } } } }));
  assert.deepEqual(list.map((c) => [c.name, c.type, c.command || c.url]), [['blender', 'command', 'uvx blender-mcp'], ['figma', 'url', 'http://127.0.0.1:3845/mcp'], ['ctx', 'command', 'npx -y x']]);
  assert.throws(() => parseImport('{nope'), /not valid JSON/);
  assert.throws(() => parseImport('{"a": 1}'), /No servers found/);
  const a = normalize({ name: 'Blender', command: 'uvx blender-mcp' });
  const b = normalize({ name: 'Blender', command: 'uvx blender-mcp' }, [a]);
  assert.equal(a.id, 'blender');
  assert.notEqual(b.id, 'blender');
  assert.deepEqual(normalize({ name: 'F', type: 'url', url: 'https://x.dev/mcp', token: 'abc' }).headers, { Authorization: 'Bearer abc' });
  assert.throws(() => normalize({ type: 'url', url: 'ftp://x' }), /http/);
});

test('agent: uses a connected app\'s tools, asks before changing things, saves returned images', async () => {
  const ws = fs.mkdtempSync(path.join(home, 'ws-'));
  const prov = await mockProvider((body, i) => {
    if (i === 0) return { message: text(JSON.stringify({ title: 'Blender crate', steps: ['Add a crate in Blender'] })) };
    const names = (body.tools || []).map((t) => t.function.name);
    if (i === 1) { assert.ok(names.includes('blender__create_object')); assert.match(body.messages[0].content, /Connected apps:[\s\S]*Blender/); return { message: toolCall('blender__create_object', { type: 'cube', name: 'Crate' }) }; }
    if (i === 2) return { message: toolCall('blender__screenshot', {}) };
    return { message: toolCall('finish', { message: 'Added a crate.' }) };
  });
  const s = defaultSettings();
  s.active = 'custom'; s.providers.custom.baseUrl = prov.url; s.providers.custom.model = 'mock'; s.providers.custom.toolMode = 'native';
  s.connectors = [stdioCfg()];
  const m = new ConnectorManager();
  const events = [];
  const approvals = [];
  try {
    const agent = new Agent({ settings: s, workspace: ws, signal: new AbortController().signal, history: [], connectors: m,
      emit: (type, d) => events.push({ type, ...d }), ask: async () => '', approve: async (req) => { approvals.push(req); return true; } });
    const r = await agent.run('add a crate to my blender scene');
    assert.equal(r.status, 'done');
    assert.deepEqual(approvals.map((a) => a.title), ['Blender: create object', 'Blender: screenshot']);
    const results = events.filter((e) => e.type === 'tool_result');
    assert.ok(results.every((e) => e.ok), JSON.stringify(results));
    const img = fs.readdirSync(path.join(ws, 'connector-images'));
    assert.equal(img.length, 1);
    assert.equal(fs.readFileSync(path.join(ws, 'connector-images', img[0]), 'utf8'), 'png!');
  } finally { m.closeAll(); prov.close(); }
});

test('connectors: signs in to a web app with OAuth and refreshes the token', async () => {
  const oauth = require('../src/core/oauth');
  let issued = 0;
  let live = '';
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const base = `http://127.0.0.1:${srv.address().port}`;
    const json = (code, o, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
    if (req.url === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (req.url === '/.well-known/oauth-authorization-server') return json(200, { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
    if (req.url === '/register') return json(201, { client_id: 'fh-client', redirect_uris: JSON.parse(body).redirect_uris });
    if (req.url === '/token') {
      const f = new URLSearchParams(body);
      if (f.get('grant_type') === 'authorization_code' && (f.get('code') !== 'abc' || !f.get('code_verifier'))) return json(400, { error: 'invalid_grant' });
      live = `tok${++issued}`;
      return json(200, { access_token: live, refresh_token: 'r1', expires_in: 3600 });
    }
    if (req.url === '/mcp') {
      if (req.headers.authorization !== `Bearer ${live}` || !live) {
        return json(401, {}, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      }
      const m = JSON.parse(body);
      if (m.id === undefined) { res.writeHead(202); return res.end(); }
      return json(200, { jsonrpc: '2.0', id: m.id, result: m.method === 'initialize' ? { serverInfo: { name: 'fake' } } : { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/mcp`;
  // The "browser" follows the sign-in link and the app sends it back to Freehand with a code.
  const auth = await oauth.signIn(url, {
    open: (link) => {
      const u = new URL(link);
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(u.searchParams.get('resource'), url);
      fetch(`${u.searchParams.get('redirect_uri')}?code=abc&state=${u.searchParams.get('state')}`);
    },
  });
  assert.equal(auth.access_token, 'tok1');
  assert.equal(auth.client_id, 'fh-client');

  const m = new ConnectorManager();
  const saved = [];
  m.saveAuth = (id, a) => saved.push([id, a.access_token]);
  live = 'tok-new-on-server'; // the stored token has been revoked, so the first request gets 401
  issued = 5;
  const conn = await m.get({ id: 'fake', name: 'Fake', type: 'url', url, oauth: auth });
  assert.equal(conn.tools[0].name, 'ping');
  assert.deepEqual(saved, [['fake', 'tok6']], 'refreshed once and saved the new token');
  m.closeAll();
  srv.close();
});
