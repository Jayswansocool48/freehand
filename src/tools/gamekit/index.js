'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/*
 * Freehand's game kit: tested starter games the agent copies into a workspace and then changes,
 * so a small model edits working code instead of writing a game loop from scratch. Also makes
 * pixel-art sprites as PNG files.
 */

const { buildGlb } = require('../model3d');

const DIR = __dirname;

// The 3d template's player: a small car facing +z (the way main.js drives).
const PLAYER_CAR = [
  { name: 'body', shape: 'box', size: [1, 0.4, 1.6], position: [0, 0.35, 0], color: '#3366ff', flat: true },
  { name: 'cabin', shape: 'box', size: [0.8, 0.35, 0.8], on: 'body', position: [0, 0, -0.1], color: '#dfe9ff', flat: true },
  { name: 'wheel_fl', shape: 'cylinder', size: [0.3, 0.16, 0.3], position: [0.52, 0.15, 0.5], rotation: [0, 0, 90], color: '#222222' },
  { name: 'wheel_fr', shape: 'cylinder', size: [0.3, 0.16, 0.3], position: [-0.52, 0.15, 0.5], rotation: [0, 0, 90], color: '#222222' },
  { name: 'wheel_bl', shape: 'cylinder', size: [0.3, 0.16, 0.3], position: [0.52, 0.15, -0.5], rotation: [0, 0, 90], color: '#222222' },
  { name: 'wheel_br', shape: 'cylinder', size: [0.3, 0.16, 0.3], position: [-0.52, 0.15, -0.5], rotation: [0, 0, 90], color: '#222222' },
];

// Default player art for templates whose game.js draws assets/player.png. make_sprite on the same
// path replaces it with no code change.
const PLAYER_SPRITES = {
  flyer: { scale: 2, palette: { K: '#3b2a1a', Y: '#ffd23f', L: '#fff3b0', W: '#ffffff', B: '#222222', O: '#f5793a', D: '#e0a800' }, pixels: [
      "......KKKKKK....",
      "....KKYYYYKWWK..",
      "...KYYYYYKWWWWK.",
      "..KYYYYYYKWWWBK.",
      ".KKKKKYYYKWWWBK.",
      "KLLLLLKYYYKWWWK.",
      "KLLLLLKYYYYKKKKK",
      "KDLLLDKYYYKOOOOOK",
      ".KDDDKYYYKOKKKKK.",
      "..KKKYYYYYKOOOOK.",
      "....KKKKKKKKKKK..",
    ] },
  runner: { scale: 3, palette: { K: '#1b3b36', G: '#26a69a', D: '#00796b', W: '#ffffff', B: '#000000', S: '#ffcc80', R: '#e53935' }, pixels: [
      "...KKKKKK...",
      "..KRRRRRRK..",
      ".KRRRRRRRRK.",
      ".KSSSSWWBSK.",
      ".KSSSSWWBSK.",
      ".KSSSSSSSSK.",
      "..KKSSSSKK..",
      ".KGGGGGGGGK.",
      "KGGGGGGGGGGK",
      "KSKGGGGGGKSK",
      "KSKGGGGGGKSK",
      ".K.KDDDDK.K.",
      "...KDKKDK...",
      "...KDK.KDK..",
      "..KKDK.KDKK.",
      "..KKK...KKK.",
    ] },
  shooter: { scale: 3, palette: { K: '#0d2b45', C: '#4fc3f7', L: '#b3e5fc', R: '#ef5350', W: '#ffffff', O: '#ff9800' }, pixels: [
      ".....K.....",
      "....KCK....",
      "....KLK....",
      "...KCLCK...",
      "...KCWCK...",
      "..KCCCCCK..",
      ".KRKCCCKRK.",
      "KRRKCCCKRRK",
      "KRRCCCCCRRK",
      "KKKKOKOKKKK",
      "....O.O....",
    ] },
};

const TEMPLATES = {
  flyer: { about: 'tap/Space to flap through gaps between obstacles (gravity, scrolling pipes or walls, score per gap passed)', files: ['index.html', 'kit.js', 'game.js'] },
  platformer: { about: 'side-scrolling run and jump: tile level, coins, stompable enemies, a goal flag', files: ['index.html', 'kit.js', 'game.js'] },
  topdown: { about: 'move in 8 directions, collect items, dodge enemies that chase you, waves get harder', files: ['index.html', 'kit.js', 'game.js'] },
  snake: { about: 'grid snake: arrow keys steer, eat food to grow, walls and your own tail end the round', files: ['index.html', 'kit.js', 'game.js'] },
  breakout: { about: 'paddle and ball (arrow keys or mouse) breaking rows of bricks, 3 lives, win by clearing them', files: ['index.html', 'kit.js', 'game.js'] },
  shooter: { about: 'vertical space shooter: move left and right, hold Space to fire at enemies falling from the top, 3 lives', files: ['index.html', 'kit.js', 'game.js'] },
  runner: { about: 'endless runner: the hero runs by itself, Space jumps (double jump) over obstacles, speeds up over time', files: ['index.html', 'kit.js', 'game.js'] },
  blank: { about: 'empty kit.js game (a box that moves) for any other 2D game: puzzles, card games, rhythm, racing', files: ['index.html', 'kit.js', 'game.js'] },
  '3d': { about: 'three.js scene with a drivable player, collectibles, follow camera, and GLTF model loading with a fallback', files: ['index.html', 'main.js'], dir: 'three-3d' },
};

function source(kind, file) {
  const own = path.join(DIR, 'templates', TEMPLATES[kind].dir || kind, file);
  return fs.existsSync(own) ? own : path.join(DIR, file);
}

/** Copies a starter game into the workspace. Returns the list of files written. */
function installTemplate(workspace, kind, { title = 'My Game', overwrite = false } = {}) {
  const t = TEMPLATES[kind];
  if (!t) throw new Error(`Unknown template "${kind}". Choose one of: ${Object.keys(TEMPLATES).join(', ')}.`);
  const clash = t.files.filter((f) => fs.existsSync(path.join(workspace, f)));
  if (clash.length && !overwrite) {
    throw new Error(`${clash.join(', ')} already exist${clash.length === 1 ? 's' : ''}. Call again with "overwrite": true to replace them with the template (the old game will be lost), or edit the existing files instead.`);
  }
  const safeTitle = String(title).replace(/[<>&"]/g, '').slice(0, 60) || 'My Game';
  const written = [];
  for (const f of t.files) {
    let text = fs.readFileSync(source(kind, f), 'utf8');
    if (f === 'index.html') text = text.split('{{TITLE}}').join(safeTitle);
    fs.writeFileSync(path.join(workspace, f), text, 'utf8');
    written.push(f);
  }
  if (PLAYER_SPRITES[kind] && !fs.existsSync(path.join(workspace, 'assets', 'player.png'))) {
    fs.mkdirSync(path.join(workspace, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'assets', 'player.png'), makeSprite(PLAYER_SPRITES[kind]).png);
    written.push('assets/player.png');
  }
  if (kind === '3d' && !fs.existsSync(path.join(workspace, 'assets', 'player.glb'))) {
    fs.mkdirSync(path.join(workspace, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'assets', 'player.glb'), buildGlb({ name: 'player', parts: PLAYER_CAR }).glb);
    written.push('assets/player.glb');
  }
  return written;
}

/* ---------- sprites ---------- */

const NAMED = {
  black: '#000000', white: '#ffffff', red: '#e53935', green: '#43a047', blue: '#1e88e5', yellow: '#fdd835', orange: '#fb8c00',
  purple: '#8e24aa', pink: '#ec407a', brown: '#8d6e63', gray: '#9e9e9e', grey: '#9e9e9e', skin: '#f1c27d', gold: '#ffc107', sky: '#4fc3f7',
};

function parseColor(c, key) {
  const v = NAMED[String(c).toLowerCase()] || String(c);
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v.trim());
  if (!m) throw new Error(`palette "${key}": "${c}" is not a hex color like "#ff8800"`);
  let h = m[1];
  if (h.length === 3) h = [...h].map((x) => x + x).join('');
  if (h.length === 6) h += 'ff';
  return [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGBA pixels (width*height*4) -> PNG file bytes. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Pixel art from rows of characters. Each character is one pixel looked up in the palette;
 * "." and " " are transparent. Rows may differ in length (short rows are padded).
 * Several frames side by side make a sprite sheet.
 */
function makeSprite({ pixels, palette = {}, scale = 1, frames }) {
  const sheets = Array.isArray(frames) && frames.length ? frames : [pixels];
  if (!sheets.every((f) => Array.isArray(f) && f.length && f.every((r) => typeof r === 'string'))) {
    throw new Error('"pixels" must be a list of strings, one per row, e.g. ["..YY..", ".YYYY.", "..YY.."]');
  }
  const pal = {};
  for (const [k, v] of Object.entries(palette)) {
    if ([...k].length !== 1) throw new Error(`palette key "${k}" must be a single character`);
    pal[k] = parseColor(v, k);
  }
  const s = Math.max(1, Math.min(16, Math.round(Number(scale) || 1)));
  const fh = Math.max(...sheets.map((f) => f.length));
  const fw = Math.max(...sheets.map((f) => Math.max(...f.map((r) => [...r].length))));
  if (fw * sheets.length * s > 4096 || fh * s > 4096) throw new Error('sprite is too big; keep it under 4096 px');
  const width = fw * sheets.length * s;
  const height = fh * s;
  const rgba = Buffer.alloc(width * height * 4);
  const missing = new Set();
  sheets.forEach((rows, fi) => {
    rows.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (ch === '.' || ch === ' ') return;
        const c = pal[ch];
        if (!c) { missing.add(ch); return; }
        for (let dy = 0; dy < s; dy++) {
          for (let dx = 0; dx < s; dx++) {
            const o = ((y * s + dy) * width + (fi * fw + x) * s + dx) * 4;
            rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c[3];
          }
        }
      });
    });
  });
  return { png: encodePng(width, height, rgba), width, height, frameWidth: fw * s, frames: sheets.length, missing: [...missing] };
}

const { RECIPES } = require('./recipes');

module.exports = { TEMPLATES, RECIPES, installTemplate, makeSprite, encodePng };
