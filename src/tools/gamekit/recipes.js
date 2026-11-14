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

/** One recipe as text the model can paste in, section by section. */
function recipeText(name) {
  const r = RECIPES[name];
  if (!r) throw new Error(`Unknown recipe "${name}". Choose one of: ${Object.keys(RECIPES).join(', ')}.`);
  const part = (title, code) => (code ? `\n--- ${title} ---\n${code}\n` : '');
  return `Recipe "${name}": ${r.about}.\nPaste each part into game.js with file_edit. It uses \`player\`; if your hero has another name (ship, hero, paddle), use that name.\n` +
    part('1. top of game.js, after the other let/const lines', r.top) +
    part('2. inside init(g), at the end', r.init) +
    part('3. inside update(g, dt), at the end', r.update) +
    part('4. inside draw(g, ctx), at the end (after the world, so it draws on top)', r.draw) +
    '\nThen play_test.';
}

module.exports = { RECIPES, recipeText };
