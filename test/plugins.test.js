'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mockProvider, toolCall, text, tempHome } = require('./helpers');

const home = tempHome();
const { defaultSettings } = require('../src/core/config');
const { Agent } = require('../src/core/agent');
const plugins = require('../src/core/plugins');

/** A plugin installed the way Claude Code installs them, plus one of the user's own skills. */
function fakeClaude() {
  const claude = process.env.CLAUDE_CONFIG_DIR;
  const root = path.join(claude, 'plugins', 'cache', 'mk', 'game-polish', '1.0.0');
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'game-polish', version: '1.0.0', description: 'Juice for games' }));
  fs.mkdirSync(path.join(root, 'skills', 'screen-shake'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'screen-shake', 'SKILL.md'), '---\nname: screen-shake\ndescription: Add screen shake and hit pause to make a game feel punchy\n---\nShake the camera 0.2 on every hit.');
  fs.mkdirSync(path.join(root, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, 'commands', 'polish.md'), '---\ndescription: Polish a game\n---\nMake this game feel better: $ARGUMENTS');
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ tester: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] } }));
  fs.writeFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'game-polish@mk': [{ installPath: root, version: '1.0.0' }] } }));
  fs.mkdirSync(path.join(claude, 'skills', 'haiku'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'skills', 'haiku', 'SKILL.md'), '---\nname: haiku\ndescription: Write haiku poems\n---\nFive, seven, five.');
  return root;
}

test('plugins: reads Claude Code plugins and skills, expands commands, can be turned off', () => {
  const root = fakeClaude();
  const all = plugins.listAll();
  const p = all.find((x) => x.id === 'game-polish@mk');
  assert.equal(p.skills[0].id, 'game-polish:screen-shake');
  assert.equal(p.commands[0].name, 'polish');
  assert.equal(p.mcp[0].command, `node ${root}/server.js`);
  assert.ok(all.some((x) => x.id === 'claude-skills' && x.skills[0].name === 'haiku'));
  const s = defaultSettings();
  assert.equal(plugins.expandCommand(s, '/polish the snake game'), 'Make this game feel better: the snake game');
  assert.equal(plugins.expandCommand(s, '/nope'), null);
  assert.deepEqual(plugins.relevantSkills(plugins.active(s).skills, 'add screen shake to my game').map((k) => k.name), ['screen-shake']);
  s.plugins = { off: ['game-polish@mk'] };
  assert.equal(plugins.expandCommand(s, '/polish x'), null, 'a plugin that is off does nothing');
});

test('plugins: the agent sees matching skills and loads one with use_skill', async () => {
  fakeClaude();
  let first = null;
  const mock = await mockProvider((body) => {
    if (!body.tools) return { message: text('{"title":"Shake","steps":["Add shake"]}') };
    if (!first) { first = body; return { message: toolCall('use_skill', { name: 'screen-shake' }) }; }
    return { message: toolCall('finish', { message: 'Done' }) };
  });
  const s = defaultSettings();
  s.active = 'ollama'; s.providers.ollama.baseUrl = mock.url; s.providers.ollama.model = 'm'; s.fallback = []; s.effort = 'low';
  const events = [];
  const agent = new Agent({ settings: s, workspace: fs.mkdtempSync(path.join(home, 'ws-')), signal: new AbortController().signal, history: [], emit: (t, d) => events.push({ type: t, ...d }), ask: async () => '', approve: async () => true });
  await agent.run('add screen shake to my game');
  mock.close();
  assert.match(first.messages[0].content, /game-polish:screen-shake/);
  assert.match(events.find((e) => e.type === 'tool_result').preview, /Shake the camera 0\.2/);
});

test('memory: remember saves a fact that later tasks see, and memory can be switched off', async () => {
  const { saveSettings, loadSettings, applyPatch } = require('../src/core/config');
  const prompts = [];
  let n = 0;
  const mock = await mockProvider((body) => {
    if (!body.tools) return { message: text('{"title":"T","steps":["Do it"]}') };
    prompts.push(body.messages[0].content);
    n++;
    if (n === 1) return { message: toolCall('remember', { fact: 'The user makes games in Godot' }) };
    return { message: toolCall('finish', { message: 'Done' }) };
  });
  const base = defaultSettings();
  base.active = 'ollama'; base.providers.ollama.baseUrl = mock.url; base.providers.ollama.model = 'm'; base.fallback = []; base.effort = 'low';
  base.memory = { on: true, instructions: 'Keep answers short.', facts: [] };
  saveSettings(base);
  const make = () => new Agent({ settings: loadSettings(), workspace: fs.mkdtempSync(path.join(home, 'ws-')), signal: new AbortController().signal, history: [], emit: () => {}, ask: async () => '', approve: async () => true });
  await make().run('I use Godot, remember that');
  assert.match(prompts[0], /Keep answers short\./);
  assert.equal(loadSettings().memory.facts[0].text, 'The user makes games in Godot');
  await make().run('make a menu');
  assert.match(prompts.at(-1), /The user makes games in Godot/, 'the next task knows it');
  saveSettings(applyPatch(loadSettings(), { memory: { on: false } }));
  await make().run('make another menu');
  mock.close();
  assert.doesNotMatch(prompts.at(-1), /Godot/, 'memory off leaves it out');
});
