'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempHome } = require('./helpers');

const home = tempHome();
const setup = require('../src/core/setup');

test('a connector lists the programs it is missing', () => {
  const empty = path.join(home, 'empty-path');
  const names = (command) => setup.missing({ type: 'command', command }, empty).map((m) => m.name);
  assert.deepEqual(names('uvx some-server'), ['uv']);
  assert.deepEqual(names('npx -y some-server'), ['Node.js']);
  assert.deepEqual(names('my-own-server --port 1'), []);
  assert.deepEqual(setup.missing({ type: 'url', url: 'https://x.dev/mcp' }, empty), []);
  assert.ok(names('uvx blender-mcp').includes('the Blender add-on'));
});

test('programs Freehand installed count as installed', () => {
  const bin = setup.binDirs()[0];
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'uvx.exe' : 'uvx'), '');
  assert.deepEqual(setup.missing({ type: 'command', command: 'uvx some-server' }, path.join(home, 'empty-path')), []);
  assert.ok(bin.startsWith(home));
});
