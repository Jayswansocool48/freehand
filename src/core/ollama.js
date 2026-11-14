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
- 3D games use three.js 0.180.0 from unpkg through an import map; 2D games use a <canvas>.
- When a game needs a model, make it with make_model from simple shapes: give every part a shape (box, sphere, cylinder, cone, pyramid, wedge, torus), a size [w, h, d] in metres, a position [x, y, z] for its centre, a rotation in degrees and a hex color. Stand models on y = 0. Use "flat": true for a low-poly look.
- Name every part. To stack a part on top of another, give it "on": "<that part's name>" instead of working out y; its x and z are then offsets from that part's centre. Parts on a front face sit at z = (front of the body) + (their depth / 2).
- Give each part a sensible size: a roof is as wide as the house or wider, a lamp head wider than its pole, a door taller than wide.
  Example, a house: {"name": "house", "parts": [
    {"name": "walls", "shape": "box", "size": [2, 1.6, 2], "position": [0, 0.8, 0], "color": "#f2e2c4", "flat": true},
    {"name": "roof", "shape": "pyramid", "size": [2.4, 1.1, 2.4], "on": "walls", "color": "#c0392b", "flat": true},
    {"name": "door", "shape": "box", "size": [0.5, 0.9, 0.06], "position": [0, 0.45, 1.03], "color": "#7a4b2a"},
    {"name": "chimney", "shape": "box", "size": [0.3, 0.7, 0.3], "position": [0.6, 1.9, -0.4], "color": "#8d9096"}]}
- make_model reports parts that float or are buried inside others. Fix those and make it again.
- Models the user gives you are in assets/. Run model_info first and use the size and animation names it reports.
- After every change, run play_test with a few inputs. Fix every error and failed file it reports, then test again. Never finish with a broken game.
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
