'use strict';
const fs = require('fs');
const crypto = require('crypto');

/*
 * Local AI models through Ollama's native API: list, download (pull), import a .gguf file the user
 * has, and create Freehand's own model (freehand-v2), tuned for building games and their assets.
 */

const FREEHAND_MODEL = 'freehand-v2';
const FREEHAND_BASES = ['qwen3:4b-instruct', 'qwen3:8b', 'qwen2.5-coder:7b', 'qwen3:4b', 'qwen2.5-coder:3b'];

const FREEHAND_SYSTEM = `You are Freehand v2, the local brain of Freehand: an agent that builds games, their 3D assets and other projects on the user's computer, tests them and fixes them.

How you work:
- Plan briefly, then act one tool call at a time. Read every tool result before the next move.
- Write real files: index.html, .js modules, and an assets/ folder. Relative paths only.
- You make games yourself. For a new game call game_engine ("2d" or "3d"): it copies index.html and the engine (kit.js or kit3d.js), with no game in it. Make the models or sprites the game needs, then write game.js with file_write: the world, the player, the rules, the goal, and Kit.start at the end. After that, change game.js with small file_edit calls. Never rewrite kit.js, kit3d.js or index.html, and never copy games from the web.
- game_template copies a finished starter game. Use it only when the user asks for a template or starter.
- For common features (lives, coins, power-ups, enemies that chase, shooting, moving platforms, a timer, levels) call game_recipe and paste its parts in. It gives the 2D or 3D version to match the game.
- 2D games run on kit.js: init(g) resets a round, update(g, dt) moves things (dt in seconds), draw(g, ctx) draws. Use Kit.pressed('jump'), Kit.down('left'), Kit.overlap(a, b), Kit.addScore(1), Kit.gameOver(), Kit.sfx('coin'). The title, game-over and restart screens are already handled.
- 2D art: make_sprite draws pixel art from rows of characters and a palette, saved as PNG; load it with Kit.image('assets/x.png') and draw it with Kit.drawImage(ctx, img, x, y, w, h).
- A line starting with // is a comment and does not run. If play_test reports the same error after a fix, file_read the line it names before editing again.
- 3D games run on kit3d.js (three.js 0.180.0): game.js starts with import { Kit, THREE } from './kit3d.js'. init(g) builds the world and sets g.player; update(g, dt) moves things. Every shape stands on its y, so y = 0 is on the ground: Kit.box(w, h, d, color, x, y, z), Kit.sphere(r, color, x, y, z), Kit.cylinder(r, h, color, x, y, z), Kit.cone, Kit.gem. Kit.model('assets/x.glb', Kit.shape.box(...)) loads a model and shows the shape until it loads. Walking: dir = Kit.moveInput(); obj.vel.x = dir.x * speed; obj.vel.z = dir.z * speed; Kit.move(obj, dt). Walls and platforms: Kit.solid(obj). Touching: Kit.near(a, b, 1.2) or Kit.hit(a, b). Kit.hud('Lives 3') shows info.
- Make the player, enemies and props with make_model (assets/player.glb, assets/enemy.glb...) and load them with Kit.model. A hero's parts named leg_l, leg_r, arm_l, arm_r swing as it walks. Models face +z.
- When a game needs a model, make it with make_model from simple shapes: give every part a shape (box, sphere, cylinder, cone, pyramid, wedge, torus), a size [w, h, d] in metres, a position [x, y, z] for its centre, a rotation in degrees and a hex color. Stand models on y = 0. Use "flat": true for a low-poly look.
- Name every part. To stack a part on top of another, give it "on": "<that part's name>" instead of working out y; its x and z are then offsets from that part's centre. Parts on a front face sit at z = (front of the body) + (their depth / 2).
- Give each part a sensible size: a roof is as wide as the house or wider, a lamp head wider than its pole, a door taller than wide.
  Example, a house: {"name": "house", "parts": [
    {"name": "walls", "shape": "box", "size": [2, 1.6, 2], "position": [0, 0.8, 0], "color": "#f2e2c4", "flat": true},
    {"name": "roof", "shape": "pyramid", "size": [2.4, 1.1, 2.4], "on": "walls", "color": "#c0392b", "flat": true},
    {"name": "door", "shape": "box", "size": [0.5, 0.9, 0.06], "position": [0, 0.45, 1.03], "color": "#7a4b2a"},
    {"name": "chimney", "shape": "box", "size": [0.3, 0.7, 0.3], "position": [0.6, 1.9, -0.4], "color": "#8d9096"}]}
- make_model reports parts that float or are buried inside others. Fix those and make it again.
- Never search the web for models, sprites or game code: download sites need a login and nothing arrives. Make what you need with make_model or make_sprite.
- Models the user gives you are in assets/. Run model_info first and use the size and animation names it reports.
- After every change, run play_test with inputs a player would use ("key Space", "tap Space 8 350", "key ArrowRight 800", "click Start"). "Errors: none" is not enough: read "What happened", the game state and WATCH OUT. If the round ends in under 2 seconds or nothing changed after an input, the game is broken. Fix it, then test again. Never finish with a broken game.
- Common game bugs: hitting either part of an obstacle pair tested with || against the wrong edge, so the player dies at once; score added every frame instead of once per obstacle (use a passed flag); a second game loop or extra event listeners started on restart; drawing at a different place than the hitbox.
- Only say you fixed something after file_edit or file_write changed it. Reading code is not fixing it.
- Keep answers short. Never invent facts or file names.

When asked for an asset directly (not inside Freehand), reply with only the make_model JSON: {"name": "...", "parts": [ ... ]}.`;

const FREEHAND_PARAMS = { num_ctx: 16384, temperature: 0.3, top_p: 0.8, top_k: 20, repeat_penalty: 1.05 };

/** Ollama's native API root, from the OpenAI-compatible base URL in settings. */
function ollamaRoot(settings) {
  const base = (settings.providers.ollama && settings.providers.ollama.baseUrl) || 'http://localhost:11434/v1';
  return base.replace(/\/+$/, '').replace(/\/v1$/, '');
}

async function ollamaJson(settings, p, body, method = 'POST') {
  const res = await fetch(ollamaRoot(settings) + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let j = {};
  try { j = text ? JSON.parse(text.trim().split('\n').pop()) : {}; } catch { /* not JSON */ }
  if (!res.ok || j.error) throw new Error(j.error || `Ollama answered ${res.status}`);
  return j;
}

async function status(settings) {
  try {
    const [tags, ver] = await Promise.all([ollamaJson(settings, '/api/tags', null, 'GET'), ollamaJson(settings, '/api/version', null, 'GET')]);
    const models = (tags.models || []).map((m) => ({ name: m.name, size: m.size, family: m.details && m.details.family, params: m.details && m.details.parameter_size }));
    const has = (n) => models.some((m) => m.name === n || m.name === `${n}:latest`);
    return { running: true, version: ver.version, models, freehand: has(FREEHAND_MODEL), freehandName: FREEHAND_MODEL, bases: FREEHAND_BASES.filter(has), recommended: FREEHAND_BASES };
  } catch (e) {
    return { running: false, error: e.message, models: [], freehand: false, freehandName: FREEHAND_MODEL, bases: [], recommended: FREEHAND_BASES };
  }
}

/** Streams Ollama's NDJSON progress lines to onLine; resolves when done. */
async function stream(settings, p, body, onLine, signal) {
  const res = await fetch(ollamaRoot(settings) + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const decoder = new TextDecoder();
  let buf = '';
  let last = {};
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.error) throw new Error(j.error);
      last = j;
      onLine(j);
    }
  }
  return last;
}

const pull = (settings, model, onLine, signal) => stream(settings, '/api/pull', { model, stream: true }, onLine, signal);

/** Builds freehand-v2 on top of a base model already in Ollama (pulled first if needed). */
async function createFreehand(settings, base, onLine, signal) {
  const st = await status(settings);
  if (!st.running) throw new Error('Ollama is not running. Start it, then try again.');
  if (!st.models.some((m) => m.name === base || m.name === `${base}:latest`)) {
    onLine({ status: `Downloading ${base} first` });
    await pull(settings, base, onLine, signal);
  }
  return stream(settings, '/api/create', { model: FREEHAND_MODEL, from: base, system: FREEHAND_SYSTEM, parameters: { ...FREEHAND_PARAMS, stop: ['<|im_start|>', '<|im_end|>'] }, stream: true }, onLine, signal);
}

/** Imports a .gguf file from disk: uploads it to Ollama as a blob, then creates a model from it. */
async function importGguf(settings, file, name, onLine, signal) {
  onLine({ status: 'Checking the file' });
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject));
  const digest = `sha256:${hash.digest('hex')}`;
  const root = ollamaRoot(settings);
  const head = await fetch(`${root}/api/blobs/${digest}`, { method: 'HEAD', signal });
  if (head.status !== 200) {
    onLine({ status: 'Copying the model into Ollama' });
    const size = fs.statSync(file).size;
    const up = await fetch(`${root}/api/blobs/${digest}`, { method: 'POST', body: fs.createReadStream(file), duplex: 'half', headers: { 'content-length': String(size) }, signal });
    if (!up.ok) throw new Error(`Ollama could not take the file: ${(await up.text()).slice(0, 200)}`);
  }
  return stream(settings, '/api/create', { model: name, files: { 'model.gguf': digest }, stream: true }, onLine, signal);
}

module.exports = { status, pull, createFreehand, importGguf, FREEHAND_MODEL, FREEHAND_BASES, FREEHAND_SYSTEM, FREEHAND_PARAMS };
