#!/usr/bin/env node
'use strict';
/*
 * Training data for Freehand's own model. A "teacher" stands in for the model and answers the real
 * agent with the ideal tool calls, while every tool runs for real (the engine, make_model, files,
 * play_test in Chromium). Each finished run is graded by playing the game, and only runs whose game
 * works are kept. A kept run becomes training rows in the exact shape Freehand sends the model:
 * its system prompt, its tools, and the real tool results.
 *
 *   node scripts/make-training-data.js [out.jsonl]      default training/freehand.jsonl
 *   ONLY=rust node scripts/make-training-data.js        only cases whose id contains "rust"
 *
 * Train on the output with Soup (training/soup.yaml).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.FREEHAND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'freehand-train-'));
process.env.CLAUDE_CONFIG_DIR = path.join(process.env.FREEHAND_HOME, 'claude'); // no plugins or skills from ~/.claude

const { Agent } = require('../src/core/agent');
const { defaultSettings } = require('../src/core/config');
const { mockProvider } = require('../test/helpers');
const kit = require('../src/tools/gamekit');
const { BrowserSession } = require('../src/tools/browser');
const { previewUrl } = require('../src/server/preview');

const OUT = process.argv[2] || path.join(__dirname, '..', 'training', 'freehand.jsonl');
const TEMPLATES = path.join(__dirname, '..', 'src', 'tools', 'gamekit', 'templates');
const tpl = (kind) => fs.readFileSync(path.join(TEMPLATES, kind, 'game.js'), 'utf8');
const pick = (arr, i) => arr[i % arr.length];

/* ---------- models ---------- */

const recolor = (parts, map) => parts.map((p) => ({ ...p, color: map[p.name] || map[p.color] || p.color }));
const HERO = kit.MODELS_3D['3d-blank'].player || kit.MODELS_3D['3d'].player;
const HEROES = {
  knight: { name: 'knight', parts: recolor(HERO, { body: '#9aa5b1', arm_l: '#9aa5b1', arm_r: '#9aa5b1', leg_l: '#5f6b78', leg_r: '#5f6b78', head: '#cfd6dd' }) },
  robot: { name: 'robot', parts: recolor(HERO, { body: '#5c7cfa', arm_l: '#adb5bd', arm_r: '#adb5bd', leg_l: '#495057', leg_r: '#495057', head: '#ced4da' }) },
  survivor: { name: 'survivor', parts: recolor(HERO, { body: '#6b8e23', leg_l: '#4e342e', leg_r: '#4e342e' }) },
  astronaut: { name: 'astronaut', parts: recolor(HERO, { body: '#f1f3f5', arm_l: '#f1f3f5', arm_r: '#f1f3f5', leg_l: '#dee2e6', leg_r: '#dee2e6', head: '#e9ecef' }) },
  hero: { name: 'hero', parts: HERO },
};
const MONSTER = { name: 'monster', parts: [{ name: 'body', shape: 'sphere', size: [1, 1, 1], position: [0, 0.5, 0], color: '#c62828', flat: true, segments: 8 }, { name: 'eye_l', shape: 'sphere', size: [0.2, 0.2, 0.1], position: [0.2, 0.7, 0.47], color: '#ffffff' }, { name: 'eye_r', shape: 'sphere', size: [0.2, 0.2, 0.1], position: [-0.2, 0.7, 0.47], color: '#ffffff' }] };
const ZOMBIE = { name: 'zombie', parts: recolor(HERO, { body: '#556b2f', arm_l: '#7cb342', arm_r: '#7cb342', head: '#8bc34a', leg_l: '#3e2723', leg_r: '#3e2723' }) };

// Props for "make a 3d model of ..." requests. make_model checks each one (floating or buried parts).
const PROPS = {
  tree: [{ name: 'trunk', shape: 'cylinder', size: [0.3, 1.2, 0.3], position: [0, 0.6, 0], color: '#8b5a2b' }, { name: 'leaves', shape: 'cone', size: [1.4, 1.8, 1.4], on: 'trunk', color: '#3f8f3a', flat: true, segments: 7 }],
  rock: [{ name: 'rock', shape: 'sphere', size: [1.2, 0.8, 1], position: [0, 0.4, 0], color: '#8d9096', flat: true, segments: 6 }, { name: 'chip', shape: 'sphere', size: [0.5, 0.4, 0.5], position: [0.55, 0.2, 0.2], color: '#7b7f84', flat: true, segments: 5 }],
  house: [{ name: 'walls', shape: 'box', size: [2, 1.6, 2], position: [0, 0.8, 0], color: '#f2e2c4', flat: true }, { name: 'roof', shape: 'pyramid', size: [2.4, 1.1, 2.4], on: 'walls', color: '#c0392b', flat: true }, { name: 'door', shape: 'box', size: [0.5, 0.9, 0.06], position: [0, 0.45, 1.03], color: '#7a4b2a' }, { name: 'window', shape: 'box', size: [0.45, 0.4, 0.06], position: [-0.6, 1, 1.03], color: '#9ad0ec' }],
  campfire: [{ name: 'log_a', shape: 'cylinder', size: [0.16, 1, 0.16], position: [0, 0.08, 0], rotation: [0, 0, 90], color: '#6d4c2f' }, { name: 'log_b', shape: 'cylinder', size: [0.16, 1, 0.16], position: [0, 0.08, 0], rotation: [90, 0, 0], color: '#5d4037' }, { name: 'flame', shape: 'cone', size: [0.5, 0.8, 0.5], position: [0, 0.56, 0], color: '#ffb300', emissive: '#ff6f00' }],
  chest: [{ name: 'box', shape: 'box', size: [1, 0.6, 0.6], position: [0, 0.3, 0], color: '#8d5524', flat: true }, { name: 'lid', shape: 'box', size: [1.04, 0.2, 0.64], on: 'box', color: '#a0522d', flat: true }, { name: 'lock', shape: 'box', size: [0.14, 0.18, 0.04], position: [0, 0.6, 0.32], color: '#ffc107', metalness: 0.6 }],
  lamp: [{ name: 'pole', shape: 'cylinder', size: [0.12, 2.4, 0.12], position: [0, 1.2, 0], color: '#37474f' }, { name: 'head', shape: 'sphere', size: [0.45, 0.45, 0.45], on: 'pole', color: '#fff59d', emissive: '#fff176' }],
  sword: [{ name: 'blade', shape: 'box', size: [0.12, 1.1, 0.03], position: [0, 0.9, 0], color: '#cfd8dc', metalness: 0.8 }, { name: 'guard', shape: 'box', size: [0.4, 0.07, 0.08], position: [0, 0.32, 0], color: '#8d6e63' }, { name: 'grip', shape: 'cylinder', size: [0.07, 0.3, 0.07], position: [0, 0.15, 0], color: '#4e342e' }],
  car: [{ name: 'body', shape: 'box', size: [1.6, 0.5, 3], position: [0, 0.55, 0], color: '#e53935', flat: true }, { name: 'cabin', shape: 'box', size: [1.3, 0.45, 1.4], on: 'body', z: -0.2, color: '#263238', flat: true }, { name: 'wheel_fl', shape: 'cylinder', size: [0.6, 0.3, 0.6], position: [0.85, 0.3, 1], rotation: [0, 0, 90], color: '#212121' }, { name: 'wheel_fr', shape: 'cylinder', size: [0.6, 0.3, 0.6], position: [-0.85, 0.3, 1], rotation: [0, 0, 90], color: '#212121' }, { name: 'wheel_bl', shape: 'cylinder', size: [0.6, 0.3, 0.6], position: [0.85, 0.3, -1], rotation: [0, 0, 90], color: '#212121' }, { name: 'wheel_br', shape: 'cylinder', size: [0.6, 0.3, 0.6], position: [-0.85, 0.3, -1], rotation: [0, 0, 90], color: '#212121' }],
  wall: [{ name: 'wall', shape: 'box', size: [2, 2, 0.3], position: [0, 1, 0], color: '#8d6e63', flat: true }, { name: 'beam', shape: 'box', size: [2.1, 0.2, 0.36], on: 'wall', color: '#6d4c41', flat: true }],
  crate: [{ name: 'crate', shape: 'box', size: [1, 1, 1], position: [0, 0.5, 0], color: '#b0793f', flat: true }, { name: 'band', shape: 'box', size: [1.02, 0.12, 1.02], position: [0, 0.5, 0], color: '#6d4c2f' }],
  mushroom: [{ name: 'stem', shape: 'cylinder', size: [0.3, 0.5, 0.3], position: [0, 0.25, 0], color: '#f5f5dc' }, { name: 'cap', shape: 'sphere', size: [0.9, 0.5, 0.9], on: 'stem', color: '#d32f2f' }],
};
const PROP_ASKS = ['make a 3d model of a {x}', 'can you make me a low poly {x}', 'I need a {x} model for my game', 'make a {x} asset', 'build a 3d {x}'];

/* ---------- games ---------- */

/** 3d-blank plus recipes, pasted at the RECIPE markers the way the recipe text says. */
function compose3d(recipes) {
  let code = tpl('3d-blank');
  const at = (marker, text, indent) => {
    if (!text) return;
    const body = text.split('\n').map((l) => (l ? indent + l : l)).join('\n');
    code = code.replace(`${indent}// ${marker}`, `${body}\n${indent}// ${marker}`);
  };
  for (const name of recipes) {
    const r = kit.RECIPES_3D[name];
    at('RECIPE TOP', r.top, '');
    at('RECIPE INIT', r.init, '  ');
    at('RECIPE UPDATE', r.update, '  ');
  }
  return code;
}
const withTuning = (code, speed, jump) => code.replace('speed: 6,', `speed: ${speed},`).replace('jump: 9,', `jump: ${jump},`);

const MOVE3D = ['key KeyW 800', 'key Space', 'key KeyD 600'];
const GAMES = [
  { id: 'rust', recipes: ['gather', 'craft', 'build', 'hunger', 'daynight', 'chaser'], hero: 'survivor', title: 'Rust Survival',
    asks: ['make a rust like game', 'make a 3d rust like game thats simple', 'make a game like rust', 'make a survival game where you chop trees, craft tools and build walls', 'make a 3d survival game', 'make me a simple rust game'],
    why: 'Rust is a 3D survival game: gather wood and stone, craft tools, build walls, eat, and survive enemies at night. I will use the 3D engine and the survival recipes.',
    extra: ['tap KeyF 4 250', 'key Digit1'] },
  { id: 'minecraft', recipes: ['gather', 'craft', 'build', 'daynight', 'chaser'], hero: 'hero', title: 'Block World',
    asks: ['make a minecraft like game', 'make a 3d block building game', 'make a game like minecraft where you mine and build'],
    why: 'A Minecraft-like game is 3D: mine trees and rocks, craft tools, place blocks, and survive monsters at night.', extra: ['tap KeyF 4 250', 'key KeyB'] },
  { id: 'knight-coins', recipes: ['coins', 'lives', 'chaser'], hero: 'knight', title: 'Knight Gold',
    asks: ['make a 3d game where a knight collects gold coins', 'make a knight game where you grab coins and avoid enemies', 'make a 3d coin collecting game with a knight'],
    why: 'A 3D knight that collects coins while enemies chase it, with three lives.' },
  { id: 'zombies', recipes: ['chaser', 'lives', 'shooting', 'daynight'], hero: 'survivor', enemy: ZOMBIE, title: 'Zombie Night',
    asks: ['make a zombie survival game', 'make a 3d game where you shoot zombies', 'make a game where zombies chase you and you have to survive'],
    why: 'A 3D zombie survival game: zombies chase you, you shoot them, and nights are more dangerous.', extra: ['key Enter', 'key Enter'] },
  { id: 'treasure', recipes: ['coins', 'timer', 'scenery'], hero: 'hero', title: 'Treasure Hunt', models: ['tree'],
    asks: ['make a 3d treasure hunt game with a time limit', 'make a game where you collect treasure before time runs out', 'make a 3d exploring game in a forest'],
    why: 'A 3D treasure hunt in a forest: collect the coins before the timer runs out.' },
  { id: 'arena', recipes: ['shooting', 'chaser', 'levels', 'lives'], hero: 'robot', title: 'Robot Arena',
    asks: ['make a 3d arena shooter with a robot', 'make a robot game where you shoot waves of enemies', 'make a wave survival shooter in 3d'],
    why: 'A 3D arena shooter: a robot shoots waves of enemies that get harder.', extra: ['key Enter', 'key Enter'] },
  { id: 'sky-platforms', recipes: ['moving_platforms', 'coins', 'lives'], hero: 'astronaut', title: 'Sky Hop',
    asks: ['make a 3d obby game', 'make a 3d game with moving platforms and coins', 'make a parkour game in 3d'],
    why: 'A 3D obby: jump across moving platforms, collect coins, and do not fall.' },
  { id: 'powerups', recipes: ['coins', 'powerup', 'chaser', 'lives'], hero: 'hero', title: 'Power Dash',
    asks: ['make a 3d game with power ups and enemies', 'make a 3d collecting game with a speed power up'],
    why: 'A 3D collecting game with a power-up and enemies that chase you.' },
];

// Finished games the user asked to start from a template, and 2D games, for variety.
const TEMPLATE_GAMES = [
  { id: 'tpl-3d-platformer', kind: '3d-platformer', three: true, asks: ['make a 3d platformer with a robot', 'make a 3d mario like game'], why: 'A 3D platformer: run and jump across platforms to the goal.', inputs: ['key KeyW 500', 'key Space', 'key KeyW 400'] },
  { id: 'tpl-3d-fps', kind: '3d-fps', three: true, asks: ['make a first person shooter with zombies', 'make an fps game', 'make a call of duty like game'], why: 'A first-person shooter: move through an arena and shoot the enemies that come for you.', inputs: ['key KeyW 800', 'key ArrowLeft 400', 'key Enter', 'key Enter'] },
  { id: 'tpl-3d-racer', kind: '3d-racer', three: true, asks: ['make a racing game with a red sports car', 'make a 3d driving game'], why: 'A 3D racing game: drive around the track against the clock.', inputs: ['key ArrowUp 2000', 'key ArrowLeft 500'] },
  { id: 'tpl-3d-runner', kind: '3d-runner', three: true, asks: ['make a subway surfers like game', 'make a 3d endless runner'], why: 'A 3D endless runner: switch lanes, jump obstacles, collect coins.', inputs: ['key ArrowLeft 100', 'key Space', 'key ArrowRight 100'] },
  { id: 'tpl-3d-flyer', kind: '3d-flyer', three: true, asks: ['make a 3d flying game', 'make a 3d flappy bird'], why: 'A 3D flying game: flap through the gaps.', inputs: ['tap Space 10 380'] },
  { id: 'tpl-flyer', kind: 'flyer', asks: ['make flappy bird', 'make a 2d flappy bird game'], why: 'Flappy Bird is a 2D game: tap to flap through gaps in pipes.', inputs: ['tap Space 10 380'] },
  { id: 'tpl-snake', kind: 'snake', asks: ['make a snake game', 'make the classic snake game'], why: 'Snake is a 2D grid game: eat food, grow, do not hit yourself.', inputs: ['key ArrowUp 100', 'wait 800', 'key ArrowLeft 100', 'wait 800'] },
  { id: 'tpl-breakout', kind: 'breakout', asks: ['make a breakout game with colourful bricks', 'make a brick breaker game'], why: 'Breakout is 2D: bounce the ball off the paddle to break bricks.', inputs: ['key ArrowLeft 600', 'key ArrowRight 900'] },
  { id: 'tpl-shooter', kind: 'shooter', asks: ['make a space shooter', 'make a 2d space invaders like game'], why: 'A 2D space shooter: move the ship and shoot enemies.', inputs: ['key ArrowLeft 500', 'key Space', 'key Space', 'key ArrowRight 700'] },
  { id: 'tpl-platformer', kind: 'platformer', asks: ['make a 2d platformer where a fox collects gems'], why: 'A 2D platformer: run and jump, collect gems.', inputs: ['key ArrowRight 1500', 'key Space', 'key ArrowRight 1500'] },
  { id: 'tpl-runner', kind: 'runner', asks: ['make a 2d endless runner like the chrome dino game'], why: 'A 2D runner: jump over obstacles as the speed rises.', inputs: ['tap Space 6 500'] },
];

// Bugs small models make, put into a working game.js; the fix replaces whole lines.
const BUGS = [
  { id: 'typo', break: (c) => c.replace('p.vel.x = dir.x * TUNING.speed;', 'p.vel.x = dir.x * TUNNING.speed;'), bad: '  p.vel.x = dir.x * TUNNING.speed;', good: '  p.vel.x = dir.x * TUNING.speed;' },
  { id: 'nostart', break: (c) => c.replace(/\nKit\.start\(\{[\s\S]*\}\);\n?$/, '\n'), bad: null },
  { id: 'brace', break: (c) => c.replace('  Kit.move(p, dt);\n', '  Kit.move(p, dt);\n  if (p.position.y < -20) {\n'), bad: '  if (p.position.y < -20) {', good: '  if (p.position.y < -20) Kit.gameOver();' },
  { id: 'import', break: (c) => c.replace("import { Kit, THREE } from './kit3d.js';", "import { Kit } from './kit3d.js';"), bad: "import { Kit } from './kit3d.js';", good: "import { Kit, THREE } from './kit3d.js';" },
];
const BUG_ASKS = ['the game is broken, fix it', 'nothing happens when I play, can you fix the game', 'my game has an error, fix it please', 'the game does not start'];

/* ---------- trajectories ---------- */

let callN = 0;
const call = (name, args, thought = '') => ({ role: 'assistant', content: thought || null, tool_calls: [{ id: `call_${++callN}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const plan = (title, steps) => ({ role: 'assistant', content: JSON.stringify({ title, steps }) });

function newGameRun(game, ask, i) {
  let g = game;
  const hero = HEROES[g.hero];
  if (!g.enemy && g.recipes.includes('chaser')) g = { ...g, enemy: MONSTER };
  const code = withTuning(compose3d(g.recipes), pick([6, 7, 6, 8], i), pick([9, 10, 9], i));
  const features = g.recipes.map((r) => `Add ${r.replace('_', ' ')} with game_recipe ${r}`);
  // Written whole, game.js gets every feature in one step; built up, each recipe is its own step.
  const whole = i % 2 === 0;
  const steps = ['Set up the 3D engine with game_engine', `Make the player model (${hero.name}) with make_model`, ...(g.enemy ? [`Make the enemy model (${g.enemy.name}) with make_model`] : []), ...(g.models || []).map((m) => `Make the ${m} model with make_model`), whole ? `Write game.js: the world, the player, ${g.recipes.map((r) => r.replace('_', ' ')).join(', ')}` : 'Write game.js: the world and the player', ...(whole ? [] : features.slice(0, 2)), 'Play-test with play_test and fix everything it reports'];
  const t = [plan(g.title, steps), call('game_engine', { kind: '3d', title: g.title }, g.why), call('step_done', { summary: 'The 3D engine (index.html and kit3d.js) is set up.' })];
  t.push(call('make_model', { path: 'assets/player.glb', name: hero.name, parts: hero.parts }, `The player is a ${hero.name}; the parts named leg_l, leg_r, arm_l, arm_r swing as it walks.`), call('step_done', { summary: `Made assets/player.glb (${hero.name}).` }));
  if (g.enemy) t.push(call('make_model', { path: 'assets/enemy.glb', name: g.enemy.name, parts: g.enemy.parts }), call('step_done', { summary: `Made assets/enemy.glb (${g.enemy.name}).` }));
  for (const m of g.models || []) t.push(call('make_model', { path: `assets/${m}.glb`, name: m, parts: PROPS[m] }), call('step_done', { summary: `Made assets/${m}.glb.` }));
  // Two ways to the same game: write it whole, or write the base and paste recipes in with file_edit.
  if (whole) {
    t.push(call('game_recipe', { recipe: g.recipes[0] }, `Getting the tested ${g.recipes[0]} code before writing game.js.`));
    t.push(call('file_write', { path: 'game.js', content: code }, 'Writing game.js with the world, the player and every feature in the design, ending with Kit.start.'));
    t.push(call('step_done', { summary: `Wrote game.js with ${g.recipes.join(', ')}.` }));
  } else {
    const base = withTuning(tpl('3d-blank'), pick([6, 7, 6, 8], i), pick([9, 10, 9], i));
    t.push(call('file_write', { path: 'game.js', content: base }, 'Writing the base game first: ground, player, walking and jumping, and Kit.start at the end. Features go in next.'));
    t.push(call('step_done', { summary: 'Wrote game.js with the world and the player.' }));
    let n = 0;
    for (const r of g.recipes) {
      const rec = kit.RECIPES_3D[r];
      t.push(call('game_recipe', { recipe: r }));
      const ind = (s, pre) => s.split('\n').map((l) => (l ? pre + l : l)).join('\n');
      if (rec.top) t.push(call('file_edit', { path: 'game.js', find: '// RECIPE TOP', replace: `${rec.top}\n// RECIPE TOP` }));
      if (rec.init) t.push(call('file_edit', { path: 'game.js', find: '  // RECIPE INIT', replace: `${ind(rec.init, '  ')}\n  // RECIPE INIT` }));
      if (rec.update) t.push(call('file_edit', { path: 'game.js', find: '  // RECIPE UPDATE', replace: `${ind(rec.update, '  ')}\n  // RECIPE UPDATE` }));
      if (n < 2) t.push(call('step_done', { summary: `Added ${r} to game.js.` }));
      n++;
    }
  }
  const inputs = ['click', ...MOVE3D, ...(g.extra || [])];
  t.push(call('play_test', { path: 'index.html', actions: inputs }, 'Testing it like a player: start, walk, jump' + (g.extra ? ' and use the features.' : '.')));
  t.push(call('step_done', { summary: 'Play-tested: the game starts, the player moves and the features work.' }));
  t.push(call('finish', { message: `Made **${g.title}**, a 3D game: ${g.why.replace(/^[^:]*: /, '').replace(/ I will use.*$/, '')}\n\nControls: WASD or arrows to move, Space to jump${g.recipes.includes('gather') ? ', F to hit trees and rocks, 1 and 2 to craft, B and V to build walls' : ''}${g.recipes.includes('shooting') ? ', Enter or click to shoot' : ''}. Open the Play tab to play it.`, files: ['index.html', 'game.js', 'assets/player.glb'] }));
  return { id: `${g.id}-${i}`, ask, turns: t, inputs, three: true };
}

function templateRun(g, ask, i) {
  const title = ask.replace(/^make (me )?(a |an |the )?/i, '').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40);
  const steps = [`Set up the ${g.three ? '3D' : '2D'} engine with game_engine`, `Write game.js: ${g.why.replace(/^[^:]*: /, '')}`, 'Play-test with play_test and fix everything it reports'];
  const t = [plan(title, steps), call('game_engine', { kind: g.three ? '3d' : '2d', title }, g.why), call('step_done', { summary: `The ${g.three ? '3D' : '2D'} engine is set up.` })];
  // The template's models and sprites come from make_model / make_sprite, so the run makes them itself.
  for (const [name, parts] of Object.entries(kit.MODELS_3D[g.kind] || {})) t.push(call('make_model', { path: `assets/${name}.glb`, name, parts }));
  if (kit.PLAYER_SPRITES[g.kind]) t.push(call('make_sprite', { path: 'assets/player.png', ...kit.PLAYER_SPRITES[g.kind] }, 'Drawing the player sprite.'));
  t.push(call('file_write', { path: 'game.js', content: tpl(g.kind) }, 'Writing the whole game in game.js, with Kit.start at the end.'));
  t.push(call('step_done', { summary: 'Wrote game.js.' }));
  t.push(call('play_test', { path: 'index.html', actions: ['click', ...g.inputs] }));
  t.push(call('step_done', { summary: 'Play-tested: it starts and reacts to the controls.' }));
  t.push(call('finish', { message: `Made **${title}**. ${g.why} Open the Play tab to play it.`, files: ['index.html', 'game.js'] }));
  return { id: `${g.id}-${i}`, ask, turns: t, inputs: g.inputs, three: !!g.three };
}

function bugRun(b, ask, i) {
  const good = withTuning(compose3d(pick([['coins'], ['coins', 'lives'], ['gather', 'craft'], ['coins', 'timer']], i)), 6, 9);
  const broken = b.break(good);
  const lines = good.split('\n');
  const t = [plan('Fix the Game', ['Play-test the game to see what is wrong', 'Fix game.js', 'Play-test again to check the fix'])];
  t.push(call('play_test', { path: 'index.html', actions: ['click', 'key KeyW 600', 'key Space'] }, 'First I will see what goes wrong when it is played.'));
  t.push(call('step_done', { summary: 'Found the error.' }));
  t.push(call('file_read', { path: 'game.js' }, 'Reading game.js to find the exact line before changing it.'));
  if (b.id === 'nostart') {
    const start = lines.slice(lines.findIndex((l) => l.startsWith('Kit.start({'))).join('\n');
    const lastFn = broken.trimEnd().split('\n').slice(-3).join('\n'); // the end of update(), enough lines to match once
    t.push(call('file_edit', { path: 'game.js', find: lastFn, replace: `${lastFn}\n\n${start.trimEnd()}` }, 'game.js never calls Kit.start, so the game never runs. Adding it at the end.'));
  } else {
    t.push(call('file_edit', { path: 'game.js', find: b.bad, replace: b.good }, 'Fixing the line the error names, copying the whole line.'));
  }
  t.push(call('step_done', { summary: 'Fixed game.js.' }));
  t.push(call('play_test', { path: 'index.html', actions: ['click', ...MOVE3D] }));
  t.push(call('step_done', { summary: 'The game starts and the player moves.' }));
  t.push(call('finish', { message: b.id === 'nostart' ? 'Fixed: game.js never called `Kit.start`, so nothing ran. It is added at the end and the game starts now.' : `Fixed the broken line in game.js (\`${b.bad.trim()}\` is now \`${b.good.trim()}\`). The game starts and the player moves.`, files: ['game.js'] }));
  return { id: `bug-${b.id}-${i}`, ask, turns: t, inputs: MOVE3D, three: true, setup: (ws) => { kit.installTemplate(ws, '3d-blank', { title: 'My Game' }); fs.writeFileSync(path.join(ws, 'game.js'), broken); } };
}

function propRun(name, ask, i) {
  const t = [plan(`${name[0].toUpperCase()}${name.slice(1)} Model`, [`Make the ${name} with make_model`])];
  t.push(call('make_model', { path: `assets/${name}.glb`, name, parts: PROPS[name] }, `A ${name} from simple shapes, standing on y = 0, parts stacked with "on".`));
  t.push(call('step_done', { summary: `Made assets/${name}.glb.` }));
  t.push(call('finish', { message: `Made a low-poly ${name}: assets/${name}.glb (${PROPS[name].length} parts). You can see it in the viewer.`, files: [`assets/${name}.glb`] }));
  return { id: `prop-${name}-${i}`, ask, turns: t, prop: true };
}

function allRuns() {
  const runs = [];
  for (const g of GAMES) g.asks.forEach((a, i) => runs.push(newGameRun(g, a, i)));
  for (const g of TEMPLATE_GAMES) g.asks.forEach((a, i) => runs.push(templateRun(g, a, i)));
  BUGS.forEach((b, i) => BUG_ASKS.forEach((a, j) => runs.push(bugRun(b, a, i + j))));
  Object.keys(PROPS).forEach((p, i) => runs.push(propRun(p, pick(PROP_ASKS, i).replace('{x}', p), i)));
  return runs.filter((r) => !process.env.ONLY || r.id.includes(process.env.ONLY));
}

/* ---------- running ---------- */

async function grade(ws, inputs) {
  const b = new BrowserSession({ headless: true, shotsDir: path.join(ws, '.freehand', 'grade') });
  try {
    const text = await b.playTest({ url: await previewUrl(ws, 'index.html'), actions: ['click', ...inputs], seconds: 1 });
    const m = text.match(/Game state \(window\.__game\): (\{.*\})/);
    const state = m ? JSON.parse(m[1]) : null;
    const errors = /^ERRORS/m.test(text) || /^FILES THAT FAILED/m.test(text);
    const started = state ? state.state !== 'title' : /changed/i.test(text);
    return { ok: !errors && started, text };
  } finally { await b.close(); }
}

async function runOne(r) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-ws-'));
  if (r.setup) r.setup(ws);
  const rows = [];
  let k = 0;
  const prov = await mockProvider((body) => {
    const reply = r.turns[k++] || call('finish', { message: 'Done.' });
    rows.push({ messages: [...body.messages, reply], tools: body.tools });
    return { message: reply };
  });
  const s = defaultSettings();
  s.active = 'custom'; s.providers.custom.baseUrl = prov.url; s.providers.custom.model = 'teacher'; s.providers.custom.toolMode = 'native';
  s.providers.custom.contextTokens = 16384; // the same fitting freehand-v2 gets
  s.approval = 'auto'; s.browserHeadless = true; s.effort = 'high';
  const results = [];
  const agent = new Agent({ settings: s, workspace: ws, signal: new AbortController().signal, history: [], connectors: { toolsFor: async () => [] },
    emit: (type, e) => { if (type === 'tool_result') results.push(e); }, ask: async () => '', approve: async () => true });
  let status;
  try { status = (await agent.run(r.ask)).status; } finally { prov.close(); }
  // A play_test that reports errors counts as a failure too (only a bug run's first one may).
  const seen = new Map(); // tool_call_id -> the fullest text of that result the model was shown
  for (const row of rows) for (const m of row.messages) if (m.role === 'tool' && (!seen.has(m.tool_call_id) || m.content.length > seen.get(m.tool_call_id).length)) seen.set(m.tool_call_id, m.content);
  const refused = [...seen.values()].filter((c) => /^(Not marked done|Not changed|ERROR)/.test(c));
  if (refused.length) return { ok: false, why: `refused: ${refused[0].slice(0, 200)}` };
  const plays = [...seen.values()].filter((c) => /^Played/.test(c) && /^(ERRORS|FILES THAT FAILED)/m.test(c));
  const failed = results.filter((e) => !e.ok).map((e) => e.preview).concat(plays.slice(r.id.startsWith('bug-') ? 1 : 0).map(() => 'play_test reported errors'));
  // A bug run is meant to see one failing play_test first; everything else must succeed.
  const unexpected = r.id.startsWith('bug-') ? failed.filter((p) => !/^Played/.test(p)) : failed;
  if (process.env.DEBUG) for (const [, c] of seen) console.log("TOOL>", c.slice(0, 700));
  if (status !== 'done' || unexpected.length || k < r.turns.length) return { ok: false, why: `status ${status}, used ${k}/${r.turns.length} turns, errors: ${unexpected.join(' | ').slice(0, 300)}` };
  if (!r.prop) {
    const g = await grade(ws, r.inputs);
    if (!g.ok) return { ok: false, why: `game does not work: ${g.text.slice(0, 3000)}` };
  }
  return { ok: true, rows };
}

(async () => {
  const runs = allRuns();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, '');
  let kept = 0;
  for (const r of runs) {
    try {
      const res = await runOne(r);
      if (!res.ok) { console.log(`DROP ${r.id}: ${res.why}`); continue; }
      // The last request holds the whole run; the first is the planner. Earlier requests add nothing new.
      const last = res.rows[res.rows.length - 1];
      fs.appendFileSync(OUT, `${JSON.stringify(res.rows[0])}\n${JSON.stringify(last)}\n`);
      kept++;
      console.log(`keep ${r.id} (${JSON.stringify(last).length} chars)`);
    } catch (e) { console.log(`DROP ${r.id}: ${e.message}`); }
  }
  console.log(`\n${kept}/${runs.length} runs kept -> ${OUT}`);
  process.exit(0);
})();
