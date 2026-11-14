'use strict';
const fs = require('fs');
const path = require('path');
const { safePath, truncate } = require('../core/util');
const { webSearch, fetchPage } = require('./web');
const { runCommand, runPython } = require('./exec');
const { buildGlb, modelInfo, SHAPES } = require('./model3d');
const { previewUrl } = require('../server/preview');
const { TEMPLATES, RECIPES, installTemplate, makeSprite } = require('./gamekit');
const { recipeText } = require('./gamekit/recipes');

/**
 * Small models edit text inside a "// ..." comment and then wonder why nothing changed.
 * Returns a warning when every changed line of a .js file is commented out.
 */
function commentedOut(text, start, length, file) {
  if (!/\.(m?js|ts)$/i.test(file) || !length) return '';
  const from = text.lastIndexOf('\n', start) + 1;
  const to = text.indexOf('\n', start + length);
  const lines = text.slice(from, to === -1 ? undefined : to).split('\n').filter((l) => l.trim());
  if (!lines.length || !lines.every((l) => /^\s*\/\//.test(l))) return '';
  return '\nWARNING: the text you changed is inside a // comment, so it does not run. Remove the // at the start of the line if you want the code to run.';
}

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

function listDir(root, rel, depth = 2) {
  const base = safePath(root, rel);
  const lines = [];
  const walk = (dir, d, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        lines.push(`${prefix}${e.name}/`);
        if (d < depth) walk(full, d + 1, prefix + '  ');
      } else {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* ignore */ }
        lines.push(`${prefix}${e.name} (${size} bytes)`);
      }
      if (lines.length > 300) return;
    }
  };
  walk(base, 1, '');
  return lines.length ? lines.join('\n') : '(empty)';
}

/** Small models write line breaks inside "find" as a literal \\n, or change the indentation. */
const unescape = (t) => t.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(["'`\\])/g, '$1');

/** Finds the one place "find" matches: exactly, then with escapes undone, then ignoring differences in spaces and indentation. */
function locateEdit(txt, find, replace) {
  if (!find) throw new Error('"find" is empty.');
  // A literal \n after ; { } or before indentation is a line break the model escaped by mistake, not a string escape.
  const fixReplace = /[;{}]\\n|\\n {2,}|\\n\\n/.test(replace) ? unescape(replace) : replace;
  const tries = [[find, fixReplace]];
  if (/\\[nt"'`\\]/.test(find)) tries.push([unescape(find), unescape(replace)]);
  for (const [f, r] of tries) {
    const count = txt.split(f).length - 1;
    if (count === 1) { const start = txt.indexOf(f); return { start, end: start + f.length, replace: r }; }
    if (count > 1) throw new Error(`"find" matches ${count} times; include more surrounding text so it matches once.`);
  }
  const [f, r] = tries[tries.length - 1];
  const words = f.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const hits = [...txt.matchAll(new RegExp(words.join('\\s+'), 'g'))];
  if (hits.length === 1) return { start: hits[0].index, end: hits[0].index + hits[0][0].length, replace: r.trim() === r ? r : r.trim() };
  if (hits.length > 1) throw new Error(`"find" matches ${hits.length} times; include more surrounding text so it matches once.`);
  throw new Error('"find" text not found. Read the file again and copy a few whole lines exactly (use real line breaks, not \\n). For big changes, file_write the whole file.');
}

function buildTools() {
  const tools = [
    {
      name: 'web_search',
      icon: 'magnifying-glass',
      description: 'Search the web. Returns titles, URLs and snippets. Follow up with web_fetch on promising URLs.',
      parameters: obj({ query: str('Search query'), max_results: num('1-10, default 6') }, ['query']),
      label: (a) => `Searching: ${a.query}`,
      async run(a, ctx) {
        const r = await webSearch(String(a.query || ''), { settings: ctx.settings, signal: ctx.signal, max: Math.min(10, Number(a.max_results) || 6) });
        return r.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n');
      },
    },
    {
      name: 'web_fetch',
      icon: 'globe',
      description: 'Download a web page and return its readable text (links are shown as (url)). Pages longer than max_chars can be paged with offset.',
      parameters: obj({ url: str('http(s) URL'), max_chars: num('default 8000'), offset: num('character offset, default 0') }, ['url']),
      label: (a) => `Reading ${a.url}`,
      async run(a, ctx) {
        const r = await fetchPage(String(a.url || ''), { signal: ctx.signal, maxChars: Math.min(20000, Number(a.max_chars) || 8000), offset: Number(a.offset) || 0 });
        return `URL: ${r.url}\n\n${r.text}`;
      },
    },
    {
      name: 'browser',
      icon: 'browser',
      description:
        'Control a real browser. Actions: open{url}, snapshot, click{index}, type{index,text,submit?}, press{key}, scroll{direction:"up"|"down",amount?}, back, screenshot{full_page?}, text{offset?,max_chars?}, close. ' +
        'Every action except screenshot/text/close returns the page state with numbered interactive elements; use those numbers as "index". Prefer web_fetch for plain reading; use the browser for pages that need JavaScript, clicks or forms.',
      parameters: obj(
        {
          action: { type: 'string', enum: ['open', 'snapshot', 'click', 'type', 'press', 'scroll', 'back', 'screenshot', 'text', 'close'] },
          url: str('for open'),
          index: num('element number from the last snapshot'),
          text: str('for type'),
          submit: { type: 'boolean', description: 'press Enter after typing' },
          key: str('for press, e.g. Enter, Escape, PageDown'),
          direction: str('up or down'),
          amount: num('pixels'),
          full_page: { type: 'boolean' },
          offset: num('for text'),
          max_chars: num('for text'),
        },
        ['action']
      ),
      label: (a) => ({ open: `Opening ${a.url}`, click: `Clicking element ${a.index}`, type: `Typing into element ${a.index}`, scroll: `Scrolling ${a.direction || 'down'}`, back: 'Going back', press: `Pressing ${a.key}`, screenshot: 'Taking a screenshot', snapshot: 'Looking at the page', text: 'Reading page text', close: 'Closing browser' }[a.action] || `Browser: ${a.action}`),
      async run(a, ctx) {
        return ctx.browser().act(a);
      },
    },
    {
      name: 'file_list',
      icon: 'folder-open',
      description: 'List files in the workspace (relative paths only).',
      parameters: obj({ path: str('directory, default "."') }),
      label: (a) => `Listing ${a.path || '.'}`,
      async run(a, ctx) { return listDir(ctx.workspace, a.path || '.'); },
    },
    {
      name: 'file_read',
      icon: 'file-text',
      description: 'Read a text file from the workspace.',
      parameters: obj({ path: str('relative path'), max_chars: num('default 12000'), offset: num('default 0') }, ['path']),
      label: (a) => `Reading ${a.path}`,
      async run(a, ctx) {
        const p = safePath(ctx.workspace, a.path);
        if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) throw new Error(`No such file: ${a.path}`);
        const buf = fs.readFileSync(p);
        if (buf.includes(0)) throw new Error('That looks like a binary file; use the shell or python tool to inspect it.');
        const txt = buf.toString('utf8');
        const off = Number(a.offset) || 0;
        const max = Number(a.max_chars) || 12000;
        return txt.slice(off, off + max) + (txt.length > off + max ? `\n...[${txt.length} chars total; use offset=${off + max}]` : '');
      },
    },
    {
      name: 'file_write',
      icon: 'pencil-simple',
      description: 'Create or overwrite a file in the workspace (parent folders are created). Use this for deliverables: reports, code, CSV, HTML.',
      parameters: obj({ path: str('relative path'), content: str('full file content') }, ['path', 'content']),
      label: (a) => `Writing ${a.path}`,
      async run(a, ctx) {
        const p = safePath(ctx.workspace, a.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(a.content == null ? '' : a.content), 'utf8');
        ctx.emit('file', { path: path.relative(ctx.workspace, p).replace(/\\/g, '/') });
        return `Wrote ${a.path} (${Buffer.byteLength(String(a.content || ''))} bytes)`;
      },
    },
    {
      name: 'file_edit',
      icon: 'pencil-simple',
      description: 'Replace one exact piece of text in a workspace file. "find" must match exactly once.',
      parameters: obj({ path: str('relative path'), find: str('exact text to replace'), replace: str('replacement text') }, ['path', 'find', 'replace']),
      label: (a) => `Editing ${a.path}`,
      async run(a, ctx) {
        const p = safePath(ctx.workspace, a.path);
        if (!fs.existsSync(p)) throw new Error(`No such file: ${a.path}`);
        const txt = fs.readFileSync(p, 'utf8');
        const m = locateEdit(txt, String(a.find), String(a.replace == null ? '' : a.replace));
        const out = txt.slice(0, m.start) + m.replace + txt.slice(m.end);
        fs.writeFileSync(p, out, 'utf8');
        ctx.emit('file', { path: path.relative(ctx.workspace, p).replace(/\\/g, '/') });
        return `Edited ${a.path}${commentedOut(out, m.start, m.replace.length, p)}`;
      },
    },
    {
      name: 'shell',
      icon: 'terminal-window',
      description: `Run a shell command in the workspace folder (${process.platform === 'win32' ? 'Windows cmd.exe' : 'sh'}). Use for installing packages, running scripts, git, downloads. Output is capped; long-running servers will time out.`,
      parameters: obj({ command: str('command line'), timeout_s: num('default 120, max 600') }, ['command']),
      label: (a) => `Running: ${truncate(a.command, 80, false)}`,
      approval: (a) => ({ kind: 'shell', title: 'Run shell command', detail: String(a.command) }),
      async run(a, ctx) {
        const r = await runCommand(String(a.command), { cwd: ctx.workspace, timeoutMs: Math.min(600, Number(a.timeout_s) || 120) * 1000, signal: ctx.signal, onData: (s) => ctx.emit('terminal', { data: s }) });
        return `${r.timedOut ? '[timed out and was killed]\n' : ''}exit code: ${r.code}\n${r.output}`;
      },
    },
    {
      name: 'python',
      icon: 'code',
      description: 'Run a Python 3 script (saved and executed in the workspace). Print results to stdout. Good for data processing, charts (matplotlib if installed), converting files.',
      parameters: obj({ code: str('Python source'), timeout_s: num('default 120, max 600') }, ['code']),
      label: () => 'Running Python',
      approval: (a) => ({ kind: 'python', title: 'Run Python code', detail: String(a.code) }),
      async run(a, ctx) {
        const r = await runPython(String(a.code), { workspace: ctx.workspace, timeoutMs: Math.min(600, Number(a.timeout_s) || 120) * 1000, signal: ctx.signal, onData: (s) => ctx.emit('terminal', { data: s }) });
        return `${r.timedOut ? '[timed out and was killed]\n' : ''}exit code: ${r.code}\n${r.output}`;
      },
    },
    {
      name: 'play_test',
      icon: 'game-controller',
      description:
        'Run a game or web page from the workspace in a real browser and test it like a player. Returns uncaught errors, console errors, files that failed to load, visible text and a screenshot. ' +
        'Optional "actions" are inputs played in order: "click" (centre), "click X Y", "click Start Game" (a button by its text), "click #start" (CSS selector), "key ArrowLeft 500" (hold ms), "key Space", "tap Space 8 350" (8 quick presses 350 ms apart, for flapping or jumping games), "type hello", "mouse X Y", "wait 1000". ' +
        'After each input it says whether the screen changed, and it reports window.__game (state and score) for games built on the game kit. "Errors: none" does not mean the game works: read "What happened" and WATCH OUT. ' +
        'Run it after every change to a game and fix everything it reports. The user can play the same file in the Play tab.',
      parameters: obj({ path: str('HTML file in the workspace, default index.html'), actions: { type: 'array', items: { type: 'string' }, description: 'inputs to play, e.g. ["click", "key ArrowRight 800", "key Space"]' }, seconds: num('extra seconds to let it run before the screenshot, default 3') }),
      label: (a) => `Play-testing ${a.path || 'index.html'}`,
      async run(a, ctx) {
        const rel = String(a.path || 'index.html');
        const p = safePath(ctx.workspace, rel);
        if (!fs.existsSync(p)) throw new Error(`No such file: ${rel}. Write the game first.`);
        const page = path.relative(ctx.workspace, fs.statSync(p).isDirectory() ? path.join(p, 'index.html') : p).replace(/\\/g, '/');
        const url = await previewUrl(ctx.workspace, page);
        ctx.emit('play', { path: page });
        return ctx.browser().playTest({ url, actions: a.actions, seconds: a.seconds == null ? 3 : Number(a.seconds) });
      },
    },
    {
      name: 'game_template',
      icon: 'game-controller',
      description:
        'Start a game from a tested starter that already works (title screen, game loop, controls, collisions, score, game over, restart, sounds, high score). ' +
        `Templates: ${Object.entries(TEMPLATES).map(([k, t]) => `"${k}" (${t.about})`).join('; ')}. ` +
        'Use it first for any new game, then change game.js (or main.js for 3d) to match the request: rules, numbers in TUNING, drawing, sprites. Much safer than writing a game from scratch.',
      parameters: obj({ template: { type: 'string', enum: Object.keys(TEMPLATES) }, title: str('game title shown on the title screen'), overwrite: { type: 'boolean', description: 'replace existing index.html/game files' } }, ['template']),
      label: (a) => `Starting from the ${a.template} game template`,
      async run(a, ctx) {
        const kind = String(a.template || '');
        const files = installTemplate(ctx.workspace, kind, { title: a.title, overwrite: !!a.overwrite });
        for (const f of files) ctx.emit('file', { path: f });
        const main = kind === '3d' ? 'main.js' : 'game.js';
        const text = fs.readFileSync(path.join(ctx.workspace, main), 'utf8');
        return `Wrote ${files.join(', ')}. This is a working game; play_test it, then change ${main} to fit the request. ` +
          (kind === '3d' ? '' : 'Do not edit kit.js: it runs the loop, input, title and game-over screens. In game.js, init() resets a round, update(g, dt) moves things (dt in seconds), draw(g, ctx) draws. Kit.gameOver() ends a round; Kit.addScore(n) scores. ') +
          `\n\n${main}:\n${truncate(text, 7000)}`;
      },
    },
    {
      name: 'game_recipe',
      icon: 'book-open',
      description:
        'Tested code to add a feature to a kit.js game, in four parts (top of game.js, init, update, draw) to paste in with file_edit. ' +
        `Recipes: ${Object.entries(RECIPES).map(([k, r]) => `"${k}" (${r.about})`).join('; ')}.`,
      parameters: obj({ recipe: { type: 'string', enum: Object.keys(RECIPES) } }, ['recipe']),
      label: (a) => `Looking up the ${a.recipe} recipe`,
      async run(a) {
        return recipeText(String(a.recipe || ''));
      },
    },
    {
      name: 'make_sprite',
      icon: 'paint-brush',
      description:
        'Draw pixel-art and save it as a PNG for a 2D game. "pixels" is a list of strings, one per row; each character is one pixel and "." is transparent. "palette" maps each character to a color ("#rrggbb" or a name like red, yellow). ' +
        '"scale" makes each pixel bigger (default 4). For animation give "frames" (a list of pixel lists, same size) to get a sprite sheet with frames side by side. ' +
        'Example bird 8x6: {"path":"assets/bird.png","pixels":["..YYYY..",".YYYYWB.","YYYYYYOO","OYYYYYY.",".YYYYY..","..Y..Y.."],"palette":{"Y":"#ffd23f","W":"white","B":"black","O":"orange"}}. Draw it with Kit.image("assets/bird.png") and Kit.drawImage.',
      parameters: obj({ path: str('where to save, e.g. assets/hero.png'), pixels: { type: 'array', items: { type: 'string' }, description: 'rows of characters' }, palette: { type: 'object', description: 'character -> color' }, scale: num('pixel size, default 4'), frames: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'several pixel grids for an animation sheet' } }, ['path', 'palette']),
      label: (a) => `Drawing sprite ${a.path}`,
      async run(a, ctx) {
        let rel = String(a.path || 'assets/sprite.png');
        if (!/\.png$/i.test(rel)) rel = rel.replace(/\.[a-z0-9]+$/i, '') + '.png';
        const r = makeSprite({ pixels: a.pixels, palette: a.palette || {}, scale: a.scale == null ? 4 : a.scale, frames: a.frames });
        const p = safePath(ctx.workspace, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, r.png);
        const out = path.relative(ctx.workspace, p).replace(/\\/g, '/');
        ctx.emit('file', { path: out });
        const sheet = r.frames > 1 ? ` Sprite sheet: ${r.frames} frames, each ${r.frameWidth} px wide.` : '';
        const warn = r.missing.length ? `\nPROBLEM: these characters are not in the palette and were left transparent: ${r.missing.join(' ')}. Add them to the palette and make it again.` : '';
        return `Saved ${out} (${r.width}×${r.height} px).${sheet} Load it with Kit.image("${out}").${warn}`;
      },
    },
    {
      name: 'make_model',
      icon: 'cube',
      description:
        `Build a low-poly 3D model (.glb, loads with three.js GLTFLoader) out of simple shapes. Shapes: ${SHAPES.join(', ')}. ` +
        'Each part: {"shape", "size": [width, height, depth] (the box the shape fills), "position": [x, y, z] (its centre), "on": "<name of an earlier part>" to rest it on top of that part (then x and z are offsets from that part\'s centre and y is ignored), "rotation": [x, y, z] degrees, "color": "#rrggbb", optional "name", "flat": true for a faceted look, "roughness", "metalness", "emissive": "#rrggbb", "opacity", "segments"}. ' +
        'Units are metres and y is up; put the model\'s base at y = 0 so it stands on the ground. Wedge is a ramp sloping down toward +z. Torus lies flat; size [outer width, tube thickness, outer depth]. ' +
        'Example: a tree is a "cylinder" trunk {"size":[0.3,1.2,0.3],"position":[0,0.6,0],"color":"#8b5a2b"} and a "cone" top {"size":[1.4,1.8,1.4],"position":[0,2.1,0],"color":"#3f8f3a","flat":true,"segments":7}.',
      parameters: obj({ path: str('where to save, e.g. assets/tree.glb'), name: str('model name'), parts: { type: 'array', items: { type: 'object' }, description: 'the shapes that make up the model' } }, ['path', 'parts']),
      label: (a) => `Making 3D model ${a.path}`,
      async run(a, ctx) {
        let rel = String(a.path || 'assets/model.glb');
        if (!/\.glb$/i.test(rel)) rel = rel.replace(/\.[a-z0-9]+$/i, '') + '.glb';
        const p = safePath(ctx.workspace, rel);
        const r = buildGlb({ name: a.name || path.basename(rel, '.glb'), parts: a.parts });
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, r.glb);
        const out = path.relative(ctx.workspace, p).replace(/\\/g, '/');
        ctx.emit('file', { path: out });
        ctx.emit('model', { path: out });
        const size = r.bounds.max.map((v, k) => (v - r.bounds.min[k]).toFixed(2)).join(' × ');
        const lifted = r.lifted ? ` It went below the ground, so it was lifted ${r.lifted.toFixed(2)} m to stand on y = 0.` : '';
        const saved = `Saved ${out}: ${r.parts} parts, ${r.triangles} triangles, size ${size} m (bottom at y = 0).${lifted} The user can see it in the viewer. Load it with GLTFLoader from "./${out}".`;
        return r.warnings.length ? `${saved}\nPROBLEMS, fix them and call make_model again:\n- ${r.warnings.join('\n- ')}` : saved;
      },
    },
    {
      name: 'model_info',
      icon: 'cube',
      description: 'Describe a 3D model file in the workspace (.glb, .gltf, .obj, .stl, .fbx): size, parts, materials, rig and animation names. Use it on models the user attached before putting them in a game, so you scale and animate them correctly.',
      parameters: obj({ path: str('model file, e.g. assets/hero.glb') }, ['path']),
      label: (a) => `Inspecting model ${a.path}`,
      async run(a, ctx) {
        const p = safePath(ctx.workspace, a.path);
        if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) throw new Error(`No such file: ${a.path}`);
        ctx.emit('model', { path: path.relative(ctx.workspace, p).replace(/\\/g, '/') });
        return modelInfo(p);
      },
    },
    {
      name: 'ask_user',
      icon: 'question',
      description: 'Ask the user a question and wait for the answer. Only when you are truly blocked or a choice is theirs to make (credentials, ambiguous goal). Do not use it for things you can decide or look up.',
      parameters: obj({ question: str('one clear question') }, ['question']),
      label: (a) => `Asking: ${truncate(a.question, 80, false)}`,
      async run(a, ctx) { return `User answered: ${await ctx.ask(String(a.question))}`; },
    },
    {
      name: 'step_done',
      icon: 'check-circle',
      description: 'Mark the current plan step complete (with a one-line result) and move to the next step.',
      parameters: obj({ summary: str('what was accomplished') }, ['summary']),
      control: true,
      label: () => 'Step complete',
      async run() { return 'ok'; },
    },
    {
      name: 'revise_plan',
      icon: 'list-checks',
      description: 'Replace the remaining plan steps if the situation changed. Provide the full new list of remaining steps.',
      parameters: obj({ steps: { type: 'array', items: { type: 'string' }, description: 'remaining steps' } }, ['steps']),
      control: true,
      label: () => 'Updating the plan',
      async run() { return 'ok'; },
    },
    {
      name: 'finish',
      icon: 'flag-checkered',
      description: 'Finish the task. "message" is the final answer shown to the user (Markdown; include key findings, sources as URLs, and what files you created). List deliverable files in "files".',
      parameters: obj({ message: str('final answer in Markdown'), files: { type: 'array', items: { type: 'string' }, description: 'workspace-relative paths of deliverables' } }, ['message']),
      control: true,
      label: () => 'Finishing',
      async run() { return 'ok'; },
    },
  ];
  return tools;
}

module.exports = { buildTools, listDir, locateEdit };
