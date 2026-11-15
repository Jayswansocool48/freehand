'use strict';
const fs = require('fs');
const path = require('path');
const { chat } = require('./providers');
const { buildTools, listDir } = require('../tools');
const { BrowserSession } = require('../tools/browser');
const { stripThinking, extractJson, truncate, safePath } = require('./util');
const { TEMPLATES } = require('../tools/gamekit');
const mcp = require('./mcp');
const memory = require('./memory');

const TOOL_RESULT_FOR_MODEL = 6000;
const TOOL_RESULT_FOR_UI = 3500;
const WRITES = ['file_write', 'file_edit', 'game_engine', 'game_template', 'make_sprite', 'make_model'];

/**
 * Effort levels, like Claude's: how much work Freehand puts into one request.
 * steps: plan length the planner may use; turns: share of the "most tool steps" setting; context: share of contextChars.
 */
const EFFORT = {
  low: { steps: '1-3', turns: 0.4, context: 0.6, work: 'Effort: LOW. Be quick. One good source is enough. Skip extra checks and finish as soon as the request is answered.' },
  medium: { steps: '2-5', turns: 0.7, context: 0.8, work: 'Effort: MEDIUM. Check important facts against a second source when it is cheap to do so.' },
  high: { steps: '2-7', turns: 1, context: 1, work: 'Effort: HIGH. Check more than one source for facts that matter, and run or read back what you make before finishing.' },
  max: { steps: '3-10', turns: 2.5, context: 1.6, work: 'Effort: MAX. Be thorough. Confirm every important fact in at least two independent sources, test every script you write, read back every file you save, and before finish review the whole result against the request and fix anything missing.' },
};
const effortOf = (settings) => EFFORT[settings.effort] || EFFORT.high;

function plannerPrompt(effort, apps = '') {
  return `You are the planning module of Freehand, an autonomous agent that can search the web, browse, read/write files and run code on the user's computer.
Given the user's request, reply with ONLY a JSON object, no other text:
- If the request needs real work: {"title": "<3-6 word title>", "steps": ["<imperative step>", ...]} with ${effort.steps} concrete steps.
- If it is a simple question or chat that needs no tools: {"title": "<3-6 word title>", "answer": "<your complete answer in Markdown>"}.
Prefer the fewest steps that get a verified result. Do not include a "write the final answer" step; finishing is automatic.
Games: you build them yourself. Start with "Set up the 2D or 3D engine with game_engine", then steps that make the game's parts (3D models with make_model or sprites with make_sprite), "Write game.js: <the world, player, rules and goal>", and end with "Play-test with play_test and fix everything it reports". Use game_template only when the user asks to start from a template or starter. Do not plan web searches for how to code a game.
${apps ? `Connected apps the agent can use through their tools: ${apps}. When the request is about one of them (a Blender scene, a Figma design), plan steps that use that app.\n` : ''}${effort.work}`;
}

function systemPrompt({ plan, mode, tools, effort, files, apps }) {
  const lines = [
    `You are Freehand, an autonomous agent that completes tasks end to end on the user's own computer. Today is ${new Date().toDateString()}. Platform: ${process.platform}.`,
    `Your workspace folder is the current directory; every file path you use is relative to it. Save deliverables (reports, code, data, HTML) as files there, not just in chat.`,
    '',
    'How you work:',
    '- Follow the plan below, one step at a time. After finishing a step call step_done, then continue with the next. When every step is done call finish.',
    '- Call exactly one tool per turn. Look at the result before deciding the next move.',
    '- Research: web_search to find sources, web_fetch (or browser) to read them. Check more than one source for facts that matter. Cite URLs in your final answer.',
    '- Never invent facts, numbers, quotes or URLs. If you could not find something, say so.',
    '- If a tool fails, read the error, change your approach, and try again. Do not repeat the same failing call.',
    '- Keep tool inputs small. Write big files with file_write rather than printing them.',
    '- Use ask_user only when you are genuinely blocked.',
    '- The final answer (finish.message) should be clear, concise Markdown that answers the request and points to the files you made.',
    `- ${effort.work}`,
    '',
    'Games, 3D and web pages:',
    '- New game? You make it yourself. Call game_engine ("2d" or "3d") to copy index.html and the engine, make the models or sprites the game needs, then write game.js with file_write: the world, the player, the rules, the goal. After that, change game.js with small file_edit calls. Do not copy games from the web.',
    `- Use game_template (${Object.keys(TEMPLATES).join(', ')}) only when the user asks to start from a template or starter game.`,
    '- Need a common feature (lives, power-ups, coins, enemies that chase, shooting, moving platforms, levels, a timer)? game_recipe gives tested code for both 2D and 3D games; paste it in with file_edit.',
    '- 3D games run on kit3d.js: game.js does `import { Kit, THREE } from \'./kit3d.js\'`, init(g) builds the world and sets g.player, update(g, dt) moves things. Shapes stand on their y: Kit.box(w, h, d, color, x, y, z), Kit.sphere, Kit.cylinder, Kit.cone, Kit.gem; Kit.model(\'assets/x.glb\', fallbackShape) for models; Kit.moveInput(), Kit.move(obj, dt) for walking with gravity and walls (Kit.solid(obj)), Kit.near(a, b, dist) and Kit.hit(a, b) for touching, Kit.hud(text) for info. Never rewrite kit3d.js.',
    '- 3D looks: make the player, enemies and props with make_model (for example assets/player.glb) and load them with Kit.model. Parts named leg_l, leg_r, arm_l, arm_r swing when Kit.walk moves the hero.',
    '- Build them as files in the workspace: index.html plus .js/.css files and an assets/ folder. Use relative paths ("./assets/tree.glb") so they run anywhere.',
    '- 2D art: draw sprites with make_sprite (pixel art saved as PNG) and load them with Kit.image. Sound effects: Kit.sfx("jump" | "coin" | "hit" | "boom" | "power").',
    '- Bugs small models often write: an obstacle pair checked with || so the player dies at once; score added every frame instead of once per obstacle; a second game loop started on restart; listeners added inside functions that run again; drawing an object at a different place than its hitbox; a start button the inputs never reach. Check for these when a game misbehaves.',
    '- 3D without the kit: three.js from a CDN with an import map: {"imports": {"three": "https://unpkg.com/three@0.180.0/build/three.module.js", "three/addons/": "https://unpkg.com/three@0.180.0/examples/jsm/"}}. Load models with GLTFLoader (and OBJLoader/FBXLoader for those formats). For 2D, a plain <canvas> is enough.',
    '- Need a model nobody gave you? Make it with make_model (low-poly shapes, saved as .glb). Models the user attached are in assets/; run model_info on them first to learn their size and animation names.',
    '- Test like a player: after writing or changing a game, run play_test (with inputs such as "click Start", "key Space", "tap Space 8 350", "key ArrowRight 800") and read "What happened", the game state and WATCH OUT, not just Errors. Fix what it reports, then test again. Do not finish while play_test still shows errors or warnings.',
    '- Only say you fixed or changed something after a file_write or file_edit actually did it. Reading code and testing is not fixing.',
    '- Make the controls and goal clear on screen, and let the player restart.',
    '- If a model or file you need is missing, make it or use a simple shape. Never leave a game broken because an asset failed to load.',
    ...(apps ? [
      '',
      'Connected apps:',
      `- Tools named <app>__<tool> come from apps the user connected (${apps}). Use them when the request is about that app. They act on the real app, so check what is there (scene or file info) before changing it.`,
      '- To use a model made in Blender in a game, export it as .glb into the workspace assets/ folder (use the absolute workspace path for the export), then load it with Kit.model.',
    ] : []),
    '',
    'Files already in the workspace:',
    files || '(none yet)',
    '',
    'PLAN (status in brackets):',
    ...plan.map((s, i) => `${i + 1}. [${s.status}] ${s.text}`),
  ];
  if (mode === 'json') {
    lines.push(
      '',
      'TOOLS. You have no native tool calling, so reply with ONE JSON object and nothing else:',
      '{"thought": "<one short sentence>", "tool": "<tool name>", "args": { ... }}',
      'Available tools:',
      ...tools.map((t) => `- ${t.name}: ${t.description} Args schema: ${JSON.stringify(t.parameters.properties)} required: ${JSON.stringify(t.parameters.required || [])}`)
    );
  }
  return lines.join('\n');
}

/** Models copy the "[pending]" status tags from the prompt into new steps; drop them. */
const cleanStep = (t) => String(t).replace(/^\s*(\d+\.\s*)?(\[(pending|active|done)\]\s*)+/i, '').trim();

/** Recognises {"tool": "...", "args": {...}} inside free text (for models without native tool calling). */
function parseAction(text, toolNames) {
  // Small models sometimes write a call as code: step_done({"summary": "..."}) or `finish {...}`.
  const m = String(text || '').match(/(?:^|\n)\s*`?(\w+)`?\s*\(?\s*(\{[\s\S]*\})\s*\)?/);
  if (m && toolNames.includes(m[1])) {
    const args = extractJson(m[2]);
    if (args && !(args.tool || args.name)) return { thought: '', call: { id: '', name: m[1], args } };
  }
  const j = extractJson(text);
  if (!j) return null;
  const name = j.tool || j.name || j.action || (j.function && j.function.name);
  if (typeof name !== 'string' || !toolNames.includes(name)) return null;
  let args = j.args || j.arguments || j.parameters || j.input || (j.function && j.function.arguments) || {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
  return { thought: typeof j.thought === 'string' ? j.thought : '', call: { id: '', name, args } };
}

class Agent {
  /**
   * @param {object} o
   * @param {object} o.settings   current settings
   * @param {string} o.workspace  absolute workspace dir
   * @param {(type:string, data:object)=>void} o.emit
   * @param {AbortSignal} o.signal
   * @param {(q:string)=>Promise<string>} o.ask
   * @param {(req:object)=>Promise<boolean>} o.approve
   * @param {Array} o.history     prior conversation (mutated)
   */
  constructor({ settings, workspace, emit, signal, ask, approve, history, connectors }) {
    this.settings = settings;
    this.workspace = workspace;
    this.emit = emit;
    this.signal = signal;
    this.askUser = ask;
    this.approve = approve;
    this.history = history || [];
    this.tools = buildTools();
    this.connectors = connectors || mcp.manager;
    this.toolByName = Object.fromEntries(this.tools.map((t) => [t.name, t]));
    this.plan = [];
    this.nativeBroken = new Set(); // provider ids that rejected native tools
    this.callCounter = 0;
    this.browserSession = null;
    this.lastCalls = [];
    this.effort = effortOf(settings);
    this.game = { changed: false, errors: false, nudges: 0 }; // tracks whether the game was play-tested since it last changed
    this.stepWrites = 0; // files changed during the current plan step
    this.writes = 0; // files changed during the whole task, to tell progress from going round in circles
    this.claimNudges = 0;
    this.failStreak = 0;
    this.lastError = '';
    this.sameError = 0;
  }

  browser() {
    if (!this.browserSession) {
      this.browserSession = new BrowserSession({
        headless: this.settings.browserHeadless,
        shotsDir: path.join(this.workspace, '.freehand', 'shots'),
        onShot: (file) => this.emit('shot', { path: path.relative(this.workspace, file).replace(/\\/g, '/') }),
      });
    }
    return this.browserSession;
  }

  toolMode() {
    const id = this.settings.active;
    const pref = this.settings.providers[id].toolMode;
    if (pref === 'json') return 'json';
    if (pref === 'native') return 'native';
    return this.nativeBroken.has(id) ? 'json' : 'native';
  }

  notice(text, level = 'info') { this.emit('notice', { text, level }); }

  setPlan(steps) {
    this.plan = steps.map((text) => ({ text: cleanStep(text), status: 'pending' }));
    this.advance();
  }

  advance() {
    if (!this.plan.some((s) => s.status === 'active')) {
      const next = this.plan.find((s) => s.status === 'pending');
      if (next) next.status = 'active';
    }
    this.emit('plan', { steps: this.plan.map((s) => ({ ...s })) });
  }

  render(mode) {
    // Trim old tool output when the conversation outgrows the context budget (keep newest, keep first user turn).
    const budget = Math.round(this.settings.contextChars * this.effort.context);
    let used = 0;
    const items = this.history.map((h) => ({ ...h }));
    for (let i = items.length - 1; i >= 0; i--) {
      used += (items[i].content || '').length + 40;
      if (used > budget && items[i].role === 'tool' && i > 0) items[i].content = '[older tool output trimmed to save context]';
      else if (used > budget * 1.6 && i > 0 && items[i].role !== 'user') items[i].content = truncate(items[i].content, 200, false);
    }
    const out = [];
    for (const h of items) {
      if (h.role === 'user') out.push({ role: 'user', content: h.content });
      else if (h.role === 'assistant') {
        if (h.call && mode === 'native') {
          out.push({ role: 'assistant', content: h.content || null, tool_calls: [{ id: h.call.id, type: 'function', function: { name: h.call.name, arguments: JSON.stringify(h.call.args || {}) } }] });
        } else if (h.call) {
          out.push({ role: 'assistant', content: JSON.stringify({ thought: h.content || '', tool: h.call.name, args: h.call.args || {} }) });
        } else out.push({ role: 'assistant', content: h.content });
      } else if (h.role === 'tool') {
        if (mode === 'native') out.push({ role: 'tool', tool_call_id: h.id, content: h.content });
        else out.push({ role: 'user', content: `TOOL RESULT (${h.name}):\n${h.content}` });
      }
    }
    return out;
  }

  async callModel(messages, tools) {
    if (memory.isLow()) await this.freeMemory();
    return chat({
      settings: this.settings, messages, tools, signal: this.signal, onNotice: (t) => this.notice(t, 'warn'),
      onRetry: async () => { await this.freeMemory(); await memory.waitForMemory(60000, this.signal); },
    });
  }

  /** Closes the test browser when memory runs low, so the local model has room. It reopens on the next play_test. */
  async freeMemory() {
    if (!this.browserSession || !this.browserSession.browser) return;
    await this.browserSession.close();
    this.notice(`Memory is low (${memory.availableMB()} MB free), so Freehand closed its test browser to make room. It reopens for the next play-test.`, 'warn');
  }

  /** Planning call: returns { title, steps } or { title, answer }. */
  async planTask(userText) {
    const recent = this.history.slice(-6).map((h) => `${h.role}: ${truncate(h.content, 600, false)}`).join('\n');
    const messages = [
      { role: 'system', content: plannerPrompt(this.effort, this.appNames()) },
      { role: 'user', content: (recent ? `Earlier in this conversation:\n${recent}\n\n` : '') + `Request:\n${userText}` },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.callModel(messages, null);
      const j = extractJson(stripThinking(r.content));
      if (j && (Array.isArray(j.steps) || typeof j.answer === 'string')) return j;
      messages.push({ role: 'assistant', content: r.content }, { role: 'user', content: 'That was not valid JSON in the required shape. Reply with ONLY the JSON object.' });
    }
    return { title: truncate(userText, 40, false), steps: ['Work on the request using the available tools'] };
  }

  /**
   * Small models "fix" a working kit game by rewriting it from scratch, which breaks it.
   * Returns an error for a file_write that would throw the kit away, or null.
   */
  guardWrite(call) {
    if (['web_search', 'web_fetch', 'browser'].includes(call.name) && this.isKitGame()) {
      const asked = JSON.stringify(call.args || {});
      if (/\b(models?|glb|gltf|obj|fbx|sprites?|assets?|textures?|download|sketchfab|3d|png)\b/i.test(asked)) {
        return 'Models and art for this game are made here, not downloaded (download sites need a login and the files never arrive). Make a 3D model with make_model, or a sprite with make_sprite, saved in assets/. To restyle the player or enemies, make_model to assets/player.glb or assets/enemy.glb.';
      }
    }
    if (call.name !== 'file_write') return null;
    const three = fs.existsSync(path.join(this.workspace, 'kit3d.js'));
    if (!three && !fs.existsSync(path.join(this.workspace, 'kit.js'))) return null;
    const engine = three ? 'kit3d.js' : 'kit.js';
    const file = String((call.args && call.args.path) || '').replace(/^\.\//, '');
    const text = String((call.args && call.args.content) || '');
    if (file === engine) return `${engine} is the tested engine; do not rewrite it. Change game.js instead, with small file_edit calls.`;
    if (/^index\.html?$/i.test(file) && !(three ? /game\.js/.test(text) && /importmap/.test(text) : /kit\.js/.test(text))) return `This index.html no longer loads ${three ? 'game.js with the three.js import map' : 'kit.js and game.js'}, so it would throw away the working game. Keep index.html as it is and change game.js with file_edit.`;
    if (file === 'game.js' && !/Kit\.start\s*\(/.test(text)) {
      return fs.existsSync(path.join(this.workspace, 'game.js'))
        ? 'This game.js does not call Kit.start, so the game would not run. Change the existing game.js with small file_edit calls instead of rewriting it (file_read it first if you need the exact text).'
        : `This game.js does not call Kit.start, so the game would not run. End it with Kit.start({ ${three ? "title: document.title, hint: '...', camera: 'third', init, update" : 'width, height, init, update, draw'} }).`;
    }
    return null;
  }

  /** Adds the tools of every enabled connector (Blender, Figma...) for this request. */
  async addConnectorTools() {
    if (!(this.settings.connectors || []).some((c) => c.enabled !== false)) return;
    const extra = await this.connectors.toolsFor(this.settings, (t) => this.notice(t, 'warn'));
    for (const t of extra) {
      if (this.toolByName[t.name]) continue;
      this.tools.push(t);
      this.toolByName[t.name] = t;
    }
  }

  appNames() {
    return [...new Set(this.tools.filter((t) => t.connector).map((t) => t.connector))].join(', ');
  }

  /** Saves an image a connector returned (a Blender viewport shot, a Figma frame) into the workspace. */
  saveImage(base, img) {
    const ext = /jpe?g/.test(img.mimeType) ? 'jpg' : /webp/.test(img.mimeType) ? 'webp' : 'png';
    const rel = `connector-images/${base.replace(/[^\w.-]/g, '_')}-${Date.now()}.${ext}`;
    const file = safePath(this.workspace, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
    this.emit('file', { path: rel });
    return rel;
  }

  isKitGame() {
    return ['kit.js', 'kit3d.js'].some((f) => fs.existsSync(path.join(this.workspace, f)));
  }

  async decide() {
    const mode = this.toolMode();
    const names = this.tools.map((t) => t.name);
    let files = '';
    try { files = truncate(listDir(this.workspace, '.', 3), 1500); } catch { /* workspace not readable */ }
    const messages = [{ role: 'system', content: systemPrompt({ plan: this.plan, mode, tools: this.tools, effort: this.effort, files, apps: this.appNames() }) }, ...this.render(mode)];
    let r;
    try {
      r = await this.callModel(messages, mode === 'native' ? this.tools : null);
    } catch (e) {
      if (e.toolsUnsupported) {
        this.nativeBroken.add(e.providerId || this.settings.active);
        this.notice(`${e.providerId || this.settings.active} does not support native tool calling; switching to JSON tool mode.`);
        return this.decide();
      }
      throw e;
    }
    const content = stripThinking(r.content);
    const call = r.toolCalls.find((c) => this.toolByName[c.name]) || null;
    if (r.toolCalls.length && !call) return { retry: `Unknown tool "${r.toolCalls[0].name}". Available tools: ${names.join(', ')}.` };
    if (call) {
      if (call.parseError) return { retry: 'Your tool call arguments were not valid JSON. Call the tool again with valid JSON arguments.' };
      return { thought: content, call: { ...call, id: call.id || `call_${++this.callCounter}` } };
    }
    const act = parseAction(content, names);
    if (act) return { thought: act.thought, call: { ...act.call, id: `call_${++this.callCounter}` } };
    if (!content) return { retry: 'You sent an empty reply. Call a tool, or call finish with your answer.' };
    if (mode === 'json' && /"tool"\s*:/.test(content)) return { retry: 'Your reply looked like a tool call but was not valid JSON. Reply with ONLY one valid JSON object: {"thought": "...", "tool": "...", "args": {...}}' };
    return { text: content };
  }

  loopGuard(call) {
    const sig = call.name + JSON.stringify(call.args);
    this.lastCalls.push(sig);
    if (this.lastCalls.length > 6) this.lastCalls.shift();
    return this.lastCalls.filter((s) => s === sig).length >= 3;
  }

  /** Runs one user request to completion. Returns { status, message }. */
  /** Drops dangling tool calls (e.g. after a stop) so the history stays valid for native tool APIs. */
  sanitizeHistory() {
    const h = this.history;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].role === 'assistant' && h[i].call) {
        const nxt = h[i + 1];
        if (!nxt || nxt.role !== 'tool' || nxt.id !== h[i].call.id) h.splice(i, 1);
      }
    }
  }

  /** `turn` tags the history entry so the chat can be rewound to this message later. */
  async run(userText, turn) {
    this.sanitizeHistory();
    this.history.push({ role: 'user', content: userText, ...(turn === undefined ? {} : { turn }) });
    this.emit('status', { status: 'running' });
    try {
      await this.addConnectorTools();
      const planned = await this.planTask(userText);
      if (planned.title) this.emit('title', { title: String(planned.title).slice(0, 80) });
      if (typeof planned.answer === 'string' && !Array.isArray(planned.steps)) {
        this.history.push({ role: 'assistant', content: planned.answer });
        this.emit('final', { message: planned.answer, files: [] });
        this.emit('status', { status: 'done' });
        return { status: 'done', message: planned.answer };
      }
      this.setPlan((planned.steps || []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 10));
      return await this.loop();
    } catch (e) {
      if (this.signal.aborted) {
        this.emit('status', { status: 'stopped' });
        return { status: 'stopped', message: '' };
      }
      this.emit('error', { message: e.message });
      this.emit('status', { status: 'error' });
      return { status: 'error', message: e.message };
    } finally {
      if (this.browserSession) await this.browserSession.close();
    }
  }

  /**
   * Runs tool steps until the task finishes. The "most tool steps" setting is a checkpoint, not a stop:
   * at each one Freehand keeps going by itself while it is still getting somewhere (files changed or plan
   * steps done since the last checkpoint), and stops only when a whole stretch made no progress.
   */
  async loop() {
    const max = Math.max(5, Math.min(250, Math.round(this.settings.maxSteps * this.effort.turns)));
    const ceiling = max * 8; // a runaway guard, far past any real task
    let retries = 0;
    let textNudges = 0;
    let mark = this.progress();
    for (let turn = 0; turn < ceiling; turn++) {
      if (this.signal.aborted) throw new Error('Aborted');
      if (turn && turn % max === 0) {
        const now = this.progress();
        if (now === mark) break;
        mark = now;
        this.notice(`Freehand has used ${turn} steps and is still making progress, so it keeps going.`);
      }
      const d = await this.decide();

      if (d.retry) {
        if (++retries > 4) throw new Error('The model kept returning unusable replies. Try a larger model or switch tool mode in Settings.');
        this.history.push({ role: 'assistant', content: '(invalid reply)' }, { role: 'user', content: d.retry });
        continue;
      }
      retries = 0;

      if (d.text !== undefined) {
        // A plain reply ends the task only when the plan is done; otherwise the model forgot to call a tool.
        const open = this.plan.find((s) => s.status !== 'done');
        const unchecked = open ? null : this.uncheckedGame();
        if ((open || unchecked) && textNudges++ < 2) {
          this.history.push({ role: 'assistant', content: d.text }, { role: 'user', content: unchecked || `You replied with text, but the plan is not finished (current step: "${open.text}"). Do the work by calling a tool. Call step_done when a step is complete, and finish only at the end.` });
          continue;
        }
        return this.finish(d.text, []);
      }

      const { call, thought } = d;
      if (thought) this.emit('thought', { text: thought });
      this.history.push({ role: 'assistant', content: thought || '', call });
      const tool = this.toolByName[call.name];

      if (call.name === 'finish') {
        const unchecked = this.uncheckedGame();
        if (unchecked) {
          this.history.push({ role: 'tool', id: call.id, name: call.name, content: unchecked });
          this.notice('Freehand is testing its work before finishing.');
          continue;
        }
        this.history.pop(); // the final answer is recorded as a plain assistant message
        return this.finish(String(call.args.message || ''), Array.isArray(call.args.files) ? call.args.files : []);
      }
      if (call.name === 'step_done') {
        const claim = this.unbackedClaim(String(call.args.summary || ''));
        if (claim) {
          this.history.push({ role: 'tool', id: call.id, name: call.name, content: claim });
          this.notice('Freehand claimed a change it had not made, so it is going back to do it.');
          continue;
        }
        this.stepWrites = 0;
        const active = this.plan.find((s) => s.status === 'active');
        if (active) active.status = 'done';
        this.advance();
        this.emit('step_note', { text: String(call.args.summary || '') });
        this.history.push({ role: 'tool', id: call.id, name: call.name, content: this.plan.some((s) => s.status !== 'done') ? 'Step marked done. Continue with the next step.' : 'All steps done. Call finish with the final answer.' });
        continue;
      }
      if (call.name === 'revise_plan') {
        const done = this.plan.filter((s) => s.status === 'done');
        const rest = (Array.isArray(call.args.steps) ? call.args.steps : []).map((t) => ({ text: cleanStep(t), status: 'pending' }));
        this.plan = [...done, ...rest];
        this.advance();
        this.history.push({ role: 'tool', id: call.id, name: call.name, content: 'Plan updated.' });
        continue;
      }

      const label = tool.label(call.args || {});
      this.emit('tool', { id: call.id, name: call.name, label, icon: tool.icon, args: call.args });

      let output;
      let ok = true;
      try {
        if (this.loopGuard(call)) throw new Error('You have made this exact call several times already. Try a different approach or finish with what you have.');
        const blocked = this.guardWrite(call);
        if (blocked) throw new Error(blocked);
        if (tool.approval && this.settings.approval !== 'auto') {
          const req = tool.approval(call.args || {});
          const allowed = await this.approve({ ...req, tool: call.name });
          if (!allowed) throw new Error('The user denied this action. Choose another approach or explain what you need.');
        }
        output = await tool.run(call.args || {}, this.context());
      } catch (e) {
        if (this.signal.aborted) throw e;
        ok = false;
        output = `ERROR: ${e.message}`;
      }
      this.emit('tool_result', { id: call.id, ok, preview: truncate(output, TOOL_RESULT_FOR_UI) });
      if (ok && call.name === 'play_test') output += this.repeatedError(output);
      this.trackGame(call, ok, output);
      if (ok && WRITES.includes(call.name)) { this.stepWrites++; this.writes++; }
      if (ok && ['file_write', 'file_edit'].includes(call.name)) this.lastCalls = []; // the files changed, so repeating a test or run is new work
      this.failStreak = ok ? 0 : this.failStreak + 1;
      if (this.failStreak === 3) {
        output += '\n\nThree tool calls in a row have failed. Stop and think: re-read the errors, check your assumptions (file names, paths, what is installed), and try a different approach or call revise_plan.';
      }
      this.history.push({ role: 'tool', id: call.id, name: call.name, content: truncate(output, TOOL_RESULT_FOR_MODEL) });
    }
    const msg = `I stopped because the last ${max} steps changed nothing: no file was written and no plan step was finished, so I was going round in circles. What I made so far is in the workspace. Tell me what to change or try, and I will pick it up from there.`;
    this.emit('final', { message: msg, files: [] });
    this.emit('status', { status: 'stopped' });
    return { status: 'stopped', message: msg };
  }

  /** A count that grows whenever the task gets somewhere: a file written or a plan step finished. */
  progress() {
    return this.writes + this.plan.filter((s) => s.status === 'done').length;
  }

  /**
   * Small models keep patching the wrong spot while play_test reports the same error.
   * After the same first error survives two fixes, tell the model to look before editing again.
   */
  repeatedError(output) {
    const m = output.match(/^ERRORS \(\d+\), fix these:\n(.+)/m);
    const first = m ? m[1].trim() : '';
    this.sameError = first && first === this.lastError ? this.sameError + 1 : 0;
    this.lastError = first;
    if (this.sameError < 2) return '';
    const at = output.match(/\.\/([\w./-]+\.m?js):(\d+)/);
    return `\n\nSTUCK: this same error has come back after your last ${this.sameError} fixes, so they did not touch the real cause. ` +
      (at ? `file_read ${at[1]} and look closely at line ${at[2]} and the lines that declare what it uses (a line starting with // does not run). ` : 'file_read the file the error names and look at the line it gives. ') +
      'Then make one different fix.';
  }

  /** Notes game edits and play-test results, so the agent cannot finish with an untested or broken game. */
  trackGame(call, ok, output) {
    const p = String((call.args && call.args.path) || '');
    if (['file_write', 'file_edit'].includes(call.name) && ok && /\.(html?|m?js|css)$/i.test(p)) this.game.changed = true;
    if (['game_engine', 'game_template', 'make_sprite'].includes(call.name) && ok) this.game.changed = true;
    if (call.name === 'play_test' && ok) { this.game.changed = false; this.game.errors = /^(ERRORS|FILES THAT FAILED|WATCH OUT)/m.test(output); }
  }

  /**
   * Small models mark a step "fixed the collision bug" after only reading the code.
   * A summary that claims a change is sent back when nothing was written during the step.
   */
  unbackedClaim(summary) {
    if (this.stepWrites > 0 || this.claimNudges >= 3) return null;
    if (!/\b(fix(ed|es)?|implement(ed|s)?|add(ed|s)?|creat(ed|es)|wrote|writ(ten|es)|updat(ed|es)|improv(ed|es)|chang(ed|es)|refactor(ed)?|replac(ed|es)|built|made|correct(ed)?|adjust(ed)?|tun(ed|es)|optimi[sz](ed|es)?)\b/i.test(summary)) return null;
    this.claimNudges++;
    return 'Not marked done: your summary says you changed something, but no file was written or edited during this step. Make the change now with file_edit or file_write (or game_engine, make_sprite, make_model), then call step_done. If this step really needed no change, call step_done again and say what you checked instead.';
  }

  uncheckedGame() {
    if (this.effort === EFFORT.low || this.game.nudges >= 2) return null;
    let hasPage = false;
    try { hasPage = fs.readdirSync(this.workspace).some((f) => /\.html?$/i.test(f)); } catch { /* no workspace */ }
    if (!hasPage) return null;
    if (this.game.changed) { this.game.nudges++; return 'Not finished yet: you changed the game or page since it was last tested. Run play_test on it (with a few inputs), fix anything it reports, then finish.'; }
    if (this.game.errors) { this.game.nudges++; return 'Not finished yet: the last play_test reported errors, warnings or files that failed to load. Fix them and run play_test again, then finish.'; }
    return null;
  }

  context() {
    return {
      settings: this.settings,
      workspace: this.workspace,
      signal: this.signal,
      emit: this.emit,
      ask: (q) => this.askUser(q),
      browser: () => this.browser(),
      saveImage: (base, img) => this.saveImage(base, img),
    };
  }

  finish(message, files) {
    for (const s of this.plan) s.status = 'done';
    this.emit('plan', { steps: this.plan.map((s) => ({ ...s })) });
    const existing = [];
    for (const f of files) {
      try { const p = safePath(this.workspace, f); if (fs.existsSync(p) && fs.statSync(p).isFile()) existing.push(path.relative(this.workspace, p).replace(/\\/g, '/')); } catch { /* skip */ }
    }
    this.history.push({ role: 'assistant', content: message });
    this.emit('final', { message, files: existing });
    this.emit('status', { status: 'done' });
    return { status: 'done', message };
  }
}

module.exports = { Agent, parseAction, EFFORT };
