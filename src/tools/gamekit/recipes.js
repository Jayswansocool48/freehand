'use strict';
/*
 * Tested add-ons for kit.js games. Each recipe is code for four places in game.js: the top of the
 * file, init(), update() and draw(). They use `player` ({x, y, w, h}); in templates where the hero
 * has another name (ship, hero, paddle) the agent renames it. test/game.test.js runs every recipe
 * inside the blank template, so they stay correct.
 */

const RECIPES = {
  lives: {
    about: 'three lives with a short invincible blink after each hit, hearts drawn in the corner',
    top: `let lives;
let hurtTimer;
// Call hurt() where the game used to call Kit.gameOver() for a hit.
function hurt() {
  if (hurtTimer > 0) return;
  lives -= 1;
  hurtTimer = 1.2;
  Kit.sfx('hit');
  Kit.shake(6);
  if (lives <= 0) Kit.gameOver();
}`,
    init: `lives = 3;
hurtTimer = 0;`,
    update: `hurtTimer -= dt;`,
    draw: `for (let i = 0; i < lives; i++) {
  ctx.fillStyle = '#e53935';
  ctx.beginPath();
  ctx.arc(20 + i * 22, 20, 7, 0, Math.PI * 2);
  ctx.fill();
}
// Blink the player while it cannot be hurt: wrap the player's drawing in
// if (hurtTimer <= 0 || Math.floor(g.time * 12) % 2) { ...draw player... }`,
  },

  coins: {
    about: 'coins that appear around the level and score when the player touches them',
    top: `let coins;
let coinTimer;
function addCoin() {
  coins.push({ x: Kit.rand(20, W - 40), y: Kit.rand(40, H - 60), w: 18, h: 18, spin: Kit.rand(0, 6) });
}`,
    init: `coins = [];
coinTimer = 0;
for (let i = 0; i < 3; i++) addCoin();`,
    update: `coinTimer += dt;
if (coinTimer > 2 && coins.length < 5) { coinTimer = 0; addCoin(); }
for (const c of coins) {
  c.spin += dt * 6;
  if (!c.taken && Kit.overlap(player, c)) {
    c.taken = true;
    Kit.addScore(1);
    Kit.sfx('coin');
    Kit.burst(c.x + c.w / 2, c.y + c.h / 2, '#ffc107', 8);
  }
}
coins = coins.filter((c) => !c.taken);`,
    draw: `for (const c of coins) {
  const squash = Math.abs(Math.cos(c.spin));
  ctx.fillStyle = '#ffc107';
  ctx.beginPath();
  ctx.ellipse(c.x + c.w / 2, c.y + c.h / 2, (c.w / 2) * squash + 1, c.h / 2, 0, 0, Math.PI * 2);
  ctx.fill();
}`,
  },

  powerup: {
    about: 'a shield power-up that floats in now and then; touching it makes the player safe for 5 seconds',
    top: `let powerup;
let shieldTime;
let powerTimer;`,
    init: `powerup = null;
shieldTime = 0;
powerTimer = 6;`,
    update: `powerTimer -= dt;
if (!powerup && powerTimer <= 0) powerup = { x: Kit.rand(20, W - 44), y: Kit.rand(60, H - 100), w: 24, h: 24 };
if (powerup && Kit.overlap(player, powerup)) {
  powerup = null;
  powerTimer = Kit.rand(8, 14);
  shieldTime = 5;
  Kit.sfx('power');
}
shieldTime = Math.max(0, shieldTime - dt);
// Where the player gets hit, skip the hit while shielded: if (shieldTime > 0) { ...ignore the hit... }`,
    draw: `if (powerup) {
  ctx.fillStyle = '#29b6f6';
  ctx.beginPath();
  ctx.arc(powerup.x + 12, powerup.y + 12 + Math.sin(g.time * 4) * 3, 12, 0, Math.PI * 2);
  ctx.fill();
}
if (shieldTime > 0) {
  ctx.strokeStyle = 'rgba(41,182,246,' + (shieldTime < 1.5 && Math.floor(g.time * 8) % 2 ? 0.2 : 0.8) + ')';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(player.x + player.w / 2, player.y + player.h / 2, Math.max(player.w, player.h) * 0.8, 0, Math.PI * 2);
  ctx.stroke();
}`,
  },

  sprite: {
    about: 'draw the player from a PNG made with make_sprite, with a walking or flapping animation from a sprite sheet',
    top: `// Make the sheet first, e.g. make_sprite {"path": "assets/player.png", "frames": [[...], [...]], ...}
const playerImg = Kit.image('assets/player.png');
const PLAYER_FRAMES = 2; // frames side by side in the sheet
// Draws one frame of a sprite sheet; falls back to a coloured box if the image is missing.
function drawFrame(ctx, img, frame, frames, x, y, w, h) {
  if (img.complete && img.naturalWidth && !img.failed) {
    const fw = img.naturalWidth / frames;
    ctx.drawImage(img, (frame % frames) * fw, 0, fw, img.naturalHeight, x, y, w, h);
  } else {
    ctx.fillStyle = '#f0c';
    ctx.fillRect(x, y, w, h);
  }
}`,
    init: '',
    update: '',
    draw: `// Replace the code that draws the player with this. 8 = frames per second.
drawFrame(ctx, playerImg, Math.floor(g.time * 8), PLAYER_FRAMES, player.x, player.y, player.w, player.h);`,
  },

  chaser: {
    about: 'enemies that appear at the edges and move toward the player; touching one ends the round (or calls hurt() from the lives recipe)',
    top: `let chasers;
let chaserTimer;
function addChaser() {
  const side = Math.floor(Kit.rand(0, 4));
  const x = side === 0 ? -20 : side === 1 ? W + 20 : Kit.rand(0, W);
  const y = side === 2 ? -20 : side === 3 ? H + 20 : Kit.rand(0, H);
  chasers.push({ x, y, w: 22, h: 22, speed: Kit.rand(50, 90) });
}`,
    init: `chasers = [];
chaserTimer = 2;`,
    update: `chaserTimer -= dt;
if (chaserTimer <= 0) { addChaser(); chaserTimer = Math.max(0.6, 2.5 - g.score * 0.05); }
for (const e of chasers) {
  const dx = player.x - e.x;
  const dy = player.y - e.y;
  const d = Math.hypot(dx, dy) || 1;
  e.x += (dx / d) * e.speed * dt;
  e.y += (dy / d) * e.speed * dt;
}
if (chasers.some((e) => Kit.overlap(player, e))) Kit.gameOver();`,
    draw: `ctx.fillStyle = '#ef5350';
for (const e of chasers) ctx.fillRect(e.x, e.y, e.w, e.h);`,
  },

  timer: {
    about: 'a countdown; when it reaches zero the round ends with "Time up!" and the score stays',
    top: `const TIME_LIMIT = 60; // seconds
let timeLeft;`,
    init: `timeLeft = TIME_LIMIT;`,
    update: `timeLeft -= dt;
if (timeLeft <= 0) { timeLeft = 0; Kit.gameOver('Time up!'); }`,
    draw: `ctx.fillStyle = timeLeft < 10 ? '#ff5252' : '#fff';
ctx.font = 'bold 18px system-ui, sans-serif';
ctx.textAlign = 'right';
ctx.fillText(Math.ceil(timeLeft) + 's', W - 12, 26);`,
  },

  levels: {
    about: 'a level number that goes up every 10 points, makes things faster and shows a "Level N" banner',
    top: `const POINTS_PER_LEVEL = 10;
let level;
let bannerTime;
// Multiply speeds by this to make each level harder, e.g. speed * levelSpeed()
function levelSpeed() { return 1 + (level - 1) * 0.15; }`,
    init: `level = 1;
bannerTime = 1.5;`,
    update: `const nextLevel = 1 + Math.floor(g.score / POINTS_PER_LEVEL);
if (nextLevel > level) { level = nextLevel; bannerTime = 1.5; Kit.sfx('power'); }
bannerTime -= dt;`,
    draw: `if (bannerTime > 0) {
  ctx.globalAlpha = Math.min(1, bannerTime);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 32px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Level ' + level, W / 2, H / 3);
  ctx.globalAlpha = 1;
}`,
  },

  background: {
    about: 'a scrolling starfield or snowfall behind everything (draw it first in draw())',
    top: `let specks;`,
    init: `specks = [];
for (let i = 0; i < 70; i++) specks.push({ x: Kit.rand(0, W), y: Kit.rand(0, H), speed: Kit.rand(20, 90), size: Kit.rand(1, 3) });`,
    update: `for (const s of specks) {
  s.y += s.speed * dt; // for sideways scrolling use s.x -= s.speed * dt and wrap x instead
  if (s.y > H) { s.y = -4; s.x = Kit.rand(0, W); }
}`,
    draw: `// Put this at the start of draw(), right after the background colour.
ctx.fillStyle = 'rgba(255,255,255,0.8)';
for (const s of specks) ctx.fillRect(s.x, s.y, s.size, s.size);`,
  },
};

/*
 * The same idea for kit3d.js games: code for three places in game.js (the top, init() and update()).
 * They use g.player. scripts/check-3d.js plays every one inside the blank 3D template in a real browser.
 */
const RECIPES_3D = {
  lives: {
    about: 'three lives with a blinking safe time after each hit; call hurt() where the game used to end the round',
    top: `let lives;
let hurtTimer;
// Call hurt() when something hits the player, instead of Kit.gameOver().
function hurt() {
  if (hurtTimer > 0) return;
  lives -= 1;
  hurtTimer = 1.5;
  Kit.sfx('hit');
  Kit.shake(0.3);
  if (lives <= 0) Kit.gameOver();
}`,
    init: `lives = 3;
hurtTimer = 0;`,
    update: `hurtTimer -= dt;
g.player.visible = hurtTimer <= 0 || Math.floor(g.time * 10) % 2 === 0;
Kit.hud('Lives ' + lives, 'lives');`,
  },

  coins: {
    about: 'spinning coins around the player that score when touched; new ones keep appearing',
    top: `let coins;
function addCoin(g) {
  const p = g.player.position;
  const c = Kit.cylinder(0.35, 0.08, '#ffc83d', p.x + Kit.rand(-15, 15), 0.8, p.z + Kit.rand(-15, 15));
  c.rotation.z = Math.PI / 2;
  coins.push(c);
}`,
    init: `coins = [];
for (let i = 0; i < 8; i++) addCoin(g);`,
    update: `for (const c of coins) {
  c.rotation.y += dt * 3;
  if (!c.taken && Kit.near(g.player, c, 1.4)) {
    c.taken = true;
    Kit.remove(c);
    Kit.addScore(1);
    Kit.sfx('coin');
    Kit.burst(c.position, '#ffc83d');
  }
}
coins = coins.filter((c) => !c.taken);
if (coins.length < 4) addCoin(g);`,
  },

  chaser: {
    about: 'enemies (assets/enemy.glb, a red ball until it exists) that appear around the player and chase it; touching one calls hurt() from the lives recipe, or ends the round',
    top: `let chasers;
let chaserTimer;
function addChaser(g) {
  const a = Kit.rand(0, Math.PI * 2);
  const e = Kit.model('assets/enemy.glb', Kit.shape.sphere(0.5, '#e53935'));
  e.position.set(g.player.position.x + Math.cos(a) * 18, 0, g.player.position.z + Math.sin(a) * 18);
  e.size = { w: 0.9, h: 0.9, d: 0.9 };
  e.vel = new THREE.Vector3();
  chasers.push(e);
}`,
    init: `chasers = [];
chaserTimer = 2;`,
    update: `chaserTimer -= dt;
if (chaserTimer <= 0 && chasers.length < 8) { addChaser(g); chaserTimer = 4; }
for (const e of chasers) {
  const to = new THREE.Vector3(g.player.position.x - e.position.x, 0, g.player.position.z - e.position.z).normalize();
  e.vel.x = to.x * 3;
  e.vel.z = to.z * 3;
  Kit.move(e, dt);
  Kit.face(e, to, dt);
}
if (chasers.some((e) => Kit.near(g.player, e, 1.1))) {
  if (typeof hurt === 'function') hurt(); else Kit.gameOver();
}`,
  },

  shooting: {
    about: 'click, Enter or F fires balls the way the player faces; they defeat chasers (from the chaser recipe) and score',
    top: `let shots;
let shotTimer;
// What the shots can hit: the chasers from the chaser recipe. Return your own enemy list here instead.
function targets() { return typeof chasers !== 'undefined' ? chasers : []; }`,
    init: `shots = [];
shotTimer = 0;`,
    update: `shotTimer -= dt;
if (Kit.down('action') && shotTimer <= 0) {
  shotTimer = 0.25;
  const p = g.player;
  const s = Kit.sphere(0.15, '#ffeb3b', p.position.x, p.position.y + 1, p.position.z);
  s.vel = new THREE.Vector3(Math.sin(p.rotation.y), 0, Math.cos(p.rotation.y)).multiplyScalar(25); // models face +z
  s.life = 1.5;
  shots.push(s);
  Kit.sfx('shoot');
}
for (const s of shots) {
  s.position.addScaledVector(s.vel, dt);
  s.life -= dt;
  const t = targets().find((e) => !e.dead && Kit.near(s, e, 1.3));
  if (t) {
    t.dead = true;
    Kit.remove(t);
    Kit.addScore(1);
    Kit.sfx('boom');
    Kit.burst(t.position, '#ff7043');
    s.life = 0;
  }
}
shots = shots.filter((s) => { if (s.life > 0) return true; Kit.remove(s); return false; });
if (typeof chasers !== 'undefined') chasers = chasers.filter((e) => !e.dead);`,
  },

  moving_platforms: {
    about: 'platforms that slide and bob; the player rides them (they are solid)',
    top: `let movers;`,
    init: `movers = [];
for (let i = 0; i < 3; i++) {
  const m = Kit.box(3, 0.5, 3, '#ff8a65', -6 + i * 6, 1 + i, -10 - i * 4);
  m.base = m.position.clone();
  m.phase = i * 2;
  Kit.solid(m, true); // true = it moves
  movers.push(m);
}`,
    update: `for (const m of movers) {
  m.position.x = m.base.x + Math.sin(g.time * 0.8 + m.phase) * 3;
  m.position.y = m.base.y + Math.sin(g.time * 1.2 + m.phase) * 0.8;
}`,
  },

  timer: {
    about: 'a countdown on screen; at zero the round ends with "Time up!" and the score stays',
    top: `const TIME_LIMIT = 60; // seconds
let timeLeft;`,
    init: `timeLeft = TIME_LIMIT;`,
    update: `timeLeft -= dt;
if (timeLeft <= 0) { timeLeft = 0; Kit.gameOver('Time up!'); }
Kit.hud('Time ' + Math.ceil(timeLeft), 'timer');`,
  },

  powerup: {
    about: 'a speed-boost gem appears now and then; touching it makes boostTime > 0 for 5 seconds (multiply the speed by boostTime > 0 ? 1.8 : 1)',
    top: `let boost;
let boostTime;
let boostTimer;`,
    init: `boost = null;
boostTime = 0;
boostTimer = 5;`,
    update: `boostTimer -= dt;
if (!boost && boostTimer <= 0) boost = Kit.gem(0.5, '#29b6f6', g.player.position.x + Kit.rand(-10, 10), 0.5, g.player.position.z + Kit.rand(-10, 10));
if (boost) {
  boost.rotation.y += dt * 3;
  if (Kit.near(g.player, boost, 1.5)) { Kit.remove(boost); boost = null; boostTimer = Kit.rand(8, 14); boostTime = 5; Kit.sfx('power'); }
}
boostTime = Math.max(0, boostTime - dt);
Kit.hud(boostTime > 0 ? 'Speed boost ' + Math.ceil(boostTime) : '', 'boost');
// Where the game sets the player's speed, use: TUNING.speed * (boostTime > 0 ? 1.8 : 1)`,
  },

  levels: {
    about: 'a level number that goes up every 10 points with a sound; multiply speeds by levelSpeed() to make it harder',
    top: `const POINTS_PER_LEVEL = 10;
let level;
// Multiply speeds by this to make each level harder, e.g. TUNING.enemySpeed * levelSpeed()
function levelSpeed() { return 1 + (level - 1) * 0.15; }`,
    init: `level = 1;`,
    update: `const nextLevel = 1 + Math.floor(g.score / POINTS_PER_LEVEL);
if (nextLevel > level) { level = nextLevel; Kit.sfx('power'); }
Kit.hud('Level ' + level, 'level');`,
  },

  scenery: {
    about: 'copies of a model made with make_model (trees, houses, rocks) placed around the world as solid scenery',
    top: `// Make the model first, e.g. make_model {"name": "tree", "path": "assets/tree.glb", "parts": [...]}
const SCENERY = 'assets/tree.glb';`,
    init: `for (let i = 0; i < 12; i++) {
  const s = Kit.model(SCENERY, Kit.shape.cone(1, 2.5, '#2e7d32'));
  s.position.set(Kit.rand(-25, 25), 0, Kit.rand(-25, 25));
  if (s.position.length() < 5) s.position.x += 8; // keep the start clear
  s.rotation.y = Kit.rand(0, Math.PI * 2);
  Kit.solid(s);
}`,
    update: ``,
  },
  gather: {
    about: 'survival gathering: trees and rocks around the world; press F, Enter or click next to one to hit it for wood or stone, shown in an inventory line (inv.wood, inv.stone)',
    top: `const NODES = []; // trees and rocks the player can hit
const inv = { wood: 0, stone: 0, food: 0 };
const power = { tree: 1, rock: 1 }; // the craft recipe raises these when tools are made
function showInv() { Kit.hud(\`Wood \${inv.wood}   Stone \${inv.stone}\`, 'inv'); }`,
    init: `NODES.length = 0;
inv.wood = 0; inv.stone = 0; inv.food = 0;
for (let i = 0; i < 18; i++) {
  const kind = i % 3 === 2 ? 'rock' : 'tree';
  const n = Kit.group(Kit.rand(-28, 28), 0, Kit.rand(-28, 28));
  if (n.position.length() < 5) n.position.x += 9; // keep the start clear
  if (kind === 'tree') {
    n.add(Kit.shape.cylinder(0.3, 2, '#6d4c2f'));
    const leaves = Kit.shape.cone(1.3, 2.6, '#2e7d32');
    leaves.position.y = 1.6;
    n.add(leaves);
  } else {
    n.add(Kit.shape.sphere(0.9, '#8d9096'));
  }
  n.kind = kind;
  n.hp = kind === 'tree' ? 4 : 5;
  Kit.solid(n);
  NODES.push(n);
}
showInv();`,
    update: `if (Kit.pressed('action')) {
  const n = NODES.find((o) => Kit.near(g.player, o, 2.4));
  if (n) {
    const res = n.kind === 'tree' ? 'wood' : 'stone';
    n.hp -= power[n.kind];
    inv[res] += power[n.kind];
    Kit.sfx('hit');
    Kit.burst(n.position.clone().setY(1), n.kind === 'tree' ? '#8d6e63' : '#b0b4ba');
    if (n.hp <= 0) { inv[res] += 2; Kit.remove(n); NODES.splice(NODES.indexOf(n), 1); Kit.sfx('coin'); }
    showInv();
  }
}`,
  },
  craft: {
    needs: ['gather'],
    about: 'crafting for the gather recipe: press 1 for a hatchet (5 wood, doubles wood) and 2 for a pickaxe (3 wood + 5 stone, doubles stone); a line shows the recipes and what you have',
    top: `const tools = { hatchet: false, pickaxe: false };
function showCraft() { Kit.hud(\`1 Hatchet (5 wood)\${tools.hatchet ? ' made' : ''}   2 Pickaxe (3 wood, 5 stone)\${tools.pickaxe ? ' made' : ''}\`, 'craft'); }`,
    init: `tools.hatchet = false; tools.pickaxe = false;
power.tree = 1; power.rock = 1;
showCraft();`,
    update: `if (Kit.key('Digit1') && !tools.hatchet && inv.wood >= 5) {
  inv.wood -= 5; tools.hatchet = true; power.tree = 2; Kit.sfx('power'); showInv(); showCraft();
}
if (Kit.key('Digit2') && !tools.pickaxe && inv.wood >= 3 && inv.stone >= 5) {
  inv.wood -= 3; inv.stone -= 5; tools.pickaxe = true; power.rock = 2; Kit.sfx('power'); showInv(); showCraft();
}`,
  },
  build: {
    needs: ['gather'],
    about: 'building for the gather recipe: press B to place a wooden wall in front of the player (2 wood) and V for a stone one (2 stone); walls are solid',
    top: `function placeWall(p, color) {
  const fx = Math.sin(p.rotation.y), fz = Math.cos(p.rotation.y);
  const w = Kit.box(2, 2, 0.3, color, p.position.x + fx * 2, 0, p.position.z + fz * 2);
  w.rotation.y = p.rotation.y;
  Kit.solid(w);
  Kit.sfx('click');
}`,
    init: `Kit.hud('B wood wall (2 wood)   V stone wall (2 stone)', 'build');`,
    update: `if (Kit.key('KeyB') && inv.wood >= 2) { inv.wood -= 2; placeWall(g.player, '#8d6e63'); showInv(); }
if (Kit.key('KeyV') && inv.stone >= 2) { inv.stone -= 2; placeWall(g.player, '#8d9096'); showInv(); }`,
  },
  hunger: {
    about: 'survival needs: health and hunger that run down; berry bushes to eat from (F, Enter or click next to one); starving hurts and at 0 health the round ends',
    top: `const stats = { health: 100, hunger: 100 };
const BUSHES = [];
function showStats() { Kit.hud(\`Health \${Math.ceil(stats.health)}   Hunger \${Math.ceil(stats.hunger)}\`, 'stats'); }`,
    init: `stats.health = 100; stats.hunger = 100;
BUSHES.length = 0;
for (let i = 0; i < 8; i++) {
  const b = Kit.group(Kit.rand(-25, 25), 0, Kit.rand(-25, 25));
  b.add(Kit.shape.sphere(0.6, '#3f8f3a'));
  for (let k = 0; k < 4; k++) { const berry = Kit.shape.sphere(0.12, '#c62828'); berry.position.set(Kit.rand(-0.4, 0.4), Kit.rand(0.5, 0.9), Kit.rand(-0.4, 0.4)); b.add(berry); }
  BUSHES.push(b);
}
showStats();`,
    update: `stats.hunger = Math.max(0, stats.hunger - dt * 1.5);
if (stats.hunger === 0) stats.health -= dt * 6;
if (Kit.pressed('action')) {
  const b = BUSHES.find((o) => Kit.near(g.player, o, 2));
  if (b) { stats.hunger = Math.min(100, stats.hunger + 35); Kit.remove(b); BUSHES.splice(BUSHES.indexOf(b), 1); Kit.sfx('coin'); }
}
showStats();
if (stats.health <= 0) Kit.gameOver('You starved');`,
  },
  daynight: {
    about: 'a day and night cycle (one day is 90 seconds): the sky and lights darken at night; g.night is true at night, so other code can spawn more enemies then',
    top: `const DAY = 90;
let clock = 0;
const daySky = new THREE.Color('#9fd3f5'), nightSky = new THREE.Color('#0b1324');`,
    init: `clock = 0;`,
    update: `clock += dt;
const sunUp = 0.5 + 0.5 * Math.cos((clock / DAY) * Math.PI * 2); // 1 at noon, 0 at midnight
g.night = sunUp < 0.3;
Kit.sun.intensity = 0.2 + 2 * sunUp;
Kit.hemi.intensity = 0.25 + 1.05 * sunUp;
const sky = nightSky.clone().lerp(daySky, sunUp);
Kit.scene.background = sky;
if (Kit.scene.fog) Kit.scene.fog.color.copy(sky);
Kit.hud(g.night ? 'Night' : 'Day', 'time');`,
  },
};

/** One recipe as text the model can paste in, part by part. */
function recipeText(name, three = false) {
  const set = three ? RECIPES_3D : RECIPES;
  const r = set[name];
  if (!r) throw new Error(`Unknown ${three ? '3D ' : ''}recipe "${name}". Choose one of: ${Object.keys(set).join(', ')}.`);
  const part = (title, code) => (code ? `\n--- ${title} ---\n${code}\n` : '');
  if (three) {
    return `Recipe "${name}" for this kit3d.js game: ${r.about}.\nPaste each part into game.js with file_edit. It uses g.player.` +
      (r.needs ? ` It builds on the ${r.needs.join(' and ')} recipe${r.needs.length > 1 ? 's' : ''}: add ${r.needs.length > 1 ? 'those' : 'that'} first.` : '') + '\n' +
      part('1. top of game.js, after the other let/const lines', r.top) +
      part('2. inside init(g), at the end (after g.player is made)', r.init) +
      part('3. inside update(g, dt), at the end', r.update) +
      '\nThen play_test.';
  }
  return `Recipe "${name}": ${r.about}.\nPaste each part into game.js with file_edit. It uses \`player\`; if your hero has another name (ship, hero, paddle), use that name.\n` +
    part('1. top of game.js, after the other let/const lines', r.top) +
    part('2. inside init(g), at the end', r.init) +
    part('3. inside update(g, dt), at the end', r.update) +
    part('4. inside draw(g, ctx), at the end (after the world, so it draws on top)', r.draw) +
    '\nThen play_test.';
}

module.exports = { RECIPES, RECIPES_3D, recipeText };
