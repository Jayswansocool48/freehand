'use strict';
// A tiny MCP server for tests. Run with no arguments it speaks stdio; require() it for the HTTP handler.
const TOOLS = [
  { name: 'get_scene_info', description: 'Lists the objects in the scene.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'create_object', description: 'Adds an object.', inputSchema: { type: 'object', properties: { type: { type: 'string' }, name: { type: 'string' } }, required: ['type'] } },
  { name: 'screenshot', description: 'Returns a picture of the viewport.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } },
];
const objects = [];

function handle(msg) {
  if (msg.id === undefined) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize': return ok({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'FakeBlender', version: '1' } });
    case 'tools/list':
      // Two pages, to exercise nextCursor.
      return msg.params && msg.params.cursor ? ok({ tools: TOOLS.slice(2) }) : ok({ tools: TOOLS.slice(0, 2), nextCursor: 'p2' });
    case 'tools/call': {
      const { name, arguments: a } = msg.params;
      if (name === 'get_scene_info') return ok({ content: [{ type: 'text', text: `Objects: ${objects.join(', ') || 'none'}` }] });
      if (name === 'create_object') { objects.push(a.name || a.type); return ok({ content: [{ type: 'text', text: `Created ${a.name || a.type}` }] }); }
      if (name === 'screenshot') return ok({ content: [{ type: 'text', text: 'Viewport:' }, { type: 'image', data: Buffer.from('png!').toString('base64'), mimeType: 'image/png' }] });
      return ok({ content: [{ type: 'text', text: 'Blender is not connected' }], isError: true });
    }
    default: return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown method' } };
  }
}

if (require.main === module) {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const out = handle(JSON.parse(line));
      if (out) process.stdout.write(JSON.stringify(out) + '\n');
    }
  });
  process.stderr.write('fake mcp ready\n');
}

module.exports = { handle };
