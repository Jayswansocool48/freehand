'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { homeDir } = require('./config');

/*
 * Claude plugins in Freehand. Reads the same files Claude Code uses: plugins installed with /plugin
 * (~/.claude/plugins), the user's own skills (~/.claude/skills), and plugins added to Freehand from
 * GitHub (<data>/plugins). A plugin brings:
 *   skills    folders with SKILL.md: instructions the model loads with the use_skill tool
 *   commands  commands/*.md: prompts the user runs as /name in the message box
 *   MCP       .mcp.json: app servers, added as connectors
 * Hooks are specific to Claude Code and are not run.
 */

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const ownDir = () => path.join(homeDir(), 'plugins');

const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };

/** Splits "---\nname: x\ndescription: y\n---\nbody" into its fields and body. */
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const fields = {};
  if (m) {
    let key = null;
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([\w-]+):\s*(.*)$/.exec(line);
      if (kv) { key = kv[1]; fields[key] = kv[2].replace(/^["']|["']$/g, ''); } else if (key && /^\s+\S/.test(line)) fields[key] += ' ' + line.trim();
    }
  }
  return { fields, body: m ? text.slice(m[0].length) : text };
}

function skillsIn(dir, plugin) {
  const out = [];
  if (!isDir(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'SKILL.md');
    const text = readText(file);
    if (!text) continue;
    const { fields } = frontMatter(text);
    out.push({ id: plugin ? `${plugin}:${fields.name || name}` : (fields.name || name), name: fields.name || name, description: String(fields.description || '').slice(0, 400), file, plugin: plugin || '' });
  }
  return out;
}

function commandsIn(dir, plugin) {
  const out = [];
  if (!isDir(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const { fields } = frontMatter(readText(path.join(dir, f)));
    const name = f.replace(/\.md$/, '');
    out.push({ name, description: String(fields.description || '').slice(0, 200), file: path.join(dir, f), plugin });
  }
  return out;
}

/** The MCP servers a plugin's .mcp.json declares, as connector configs. */
function mcpIn(root, plugin) {
  const j = readJson(path.join(root, '.mcp.json'));
  if (!j) return [];
  const servers = j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : j;
  const fill = (v) => String(v).split('${CLAUDE_PLUGIN_ROOT}').join(root);
  return Object.entries(servers).filter(([, s]) => s && typeof s === 'object').map(([name, s]) => (s.url
    ? { name, type: 'url', url: fill(s.url), headers: s.headers || {}, plugin }
    : { name, type: 'command', command: [s.command, ...(s.args || [])].map(fill).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), env: s.env || {}, plugin }));
}

function pluginAt(root, id, source, version = '') {
  const meta = readJson(path.join(root, '.claude-plugin', 'plugin.json')) || {};
  return {
    id,
    name: meta.name || id.split('@')[0],
    description: String(meta.description || '').slice(0, 300),
    version: meta.version || version,
    source,
    root,
    skills: skillsIn(path.join(root, 'skills'), meta.name || id.split('@')[0]),
    commands: commandsIn(path.join(root, 'commands'), meta.name || id.split('@')[0]),
    mcp: mcpIn(root, meta.name || id.split('@')[0]),
    hooks: isDir(path.join(root, 'hooks')),
  };
}

/** Every plugin Freehand can see, plus the user's own skills as one group. */
function listAll() {
  const out = [];
  const installed = readJson(path.join(claudeDir(), 'plugins', 'installed_plugins.json'));
  for (const [id, entries] of Object.entries((installed && installed.plugins) || {})) {
    const e = Array.isArray(entries) ? entries[0] : entries;
    if (e && isDir(e.installPath)) out.push(pluginAt(e.installPath, id, 'claude', e.version));
  }
  if (isDir(ownDir())) {
    for (const d of fs.readdirSync(ownDir())) if (isDir(path.join(ownDir(), d))) out.push(pluginAt(path.join(ownDir(), d), `${d}@freehand`, 'github'));
  }
  const own = skillsIn(path.join(claudeDir(), 'skills'), '');
  if (own.length) out.push({ id: 'claude-skills', name: 'Your Claude skills', description: 'Skills in ~/.claude/skills', version: '', source: 'claude', root: path.join(claudeDir(), 'skills'), skills: own, commands: [], mcp: [], hooks: false });
  return out;
}

const isOn = (settings, id) => !((settings.plugins && settings.plugins.off) || []).includes(id);

/** Skills and commands from the plugins that are on. */
function active(settings) {
  const plugins = listAll().filter((p) => isOn(settings, p.id));
  return { plugins, skills: plugins.flatMap((p) => p.skills), commands: plugins.flatMap((p) => p.commands) };
}

/** The skills worth showing the model for this request: the ones whose words match it best. */
function relevantSkills(skills, request, n = 6) {
  const words = new Set(String(request).toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  return skills
    .map((s) => ({ s, score: (`${s.name} ${s.description}`.toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((w) => words.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.s);
}

/** A skill's instructions, with the files in its folder listed so the model can read them. */
function skillText(skill) {
  const dir = path.dirname(skill.file);
  const { body } = frontMatter(readText(skill.file));
  const extra = fs.readdirSync(dir).filter((f) => f !== 'SKILL.md').slice(0, 30);
  return `Skill "${skill.name}"${skill.plugin ? ` from the ${skill.plugin} plugin` : ''}. Follow these instructions for this task.\n` +
    (extra.length ? `Its folder (${dir}) also has: ${extra.join(', ')}. Read them with the shell tool (cat) if the instructions mention them.\n` : '') +
    `\n${body.slice(0, 20000)}`;
}

/** "/name some words" -> the command's prompt with $ARGUMENTS filled in, or null. */
function expandCommand(settings, text) {
  const m = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!m) return null;
  const want = m[1].includes(':') ? m[1].split(':').pop() : m[1];
  const cmd = active(settings).commands.find((c) => c.name === want && (!m[1].includes(':') || m[1].startsWith(`${c.plugin}:`)));
  if (!cmd) return null;
  const args = (m[2] || '').trim();
  const { body } = frontMatter(readText(cmd.file));
  const filled = body.split('$ARGUMENTS').join(args).replace(/\$(\d)/g, (x, i) => args.split(/\s+/)[Number(i) - 1] || '');
  return `${filled.trim()}${!body.includes('$ARGUMENTS') && args ? `\n\n${args}` : ''}`;
}

/** Clones a plugin from GitHub into Freehand's plugin folder. */
function addFromGithub(url) {
  const m = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  if (!m) return Promise.reject(new Error('Give a GitHub repository, like owner/repo or https://github.com/owner/repo'));
  const dest = path.join(ownDir(), m[2]);
  if (fs.existsSync(dest)) return Promise.reject(new Error(`A plugin called ${m[2]} is already added.`));
  fs.mkdirSync(ownDir(), { recursive: true });
  return new Promise((resolve, reject) => {
    const git = spawn('git', ['clone', '--depth', '1', `https://github.com/${m[1]}/${m[2]}.git`, dest], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    git.stderr.on('data', (d) => { err += d; });
    git.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'git is not installed' : e.message)));
    git.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Could not download it: ${err.trim().split('\n').pop()}`));
      const p = pluginAt(dest, `${m[2]}@freehand`, 'github');
      if (!p.skills.length && !p.commands.length && !p.mcp.length) {
        fs.rmSync(dest, { recursive: true, force: true });
        return reject(new Error('That repository has no skills, commands or MCP servers, so it is not a Claude plugin.'));
      }
      resolve(p);
    });
  });
}

/** Removes a plugin added from GitHub. Plugins installed in Claude Code are only turned off. */
function removeOwn(id) {
  const p = listAll().find((x) => x.id === id);
  if (!p || p.source !== 'github') throw new Error('Only plugins added in Freehand can be removed here. Turn this one off instead.');
  fs.rmSync(p.root, { recursive: true, force: true });
}

module.exports = { listAll, active, relevantSkills, skillText, expandCommand, addFromGithub, removeOwn, frontMatter, isOn };
