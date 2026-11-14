// Platformer: run and jump across a tile level, collect coins, avoid enemies, reach the flag.
// Built on kit.js. Edit LEVEL to change the map (one character per 32 px tile).
//   #  solid ground    =  floating platform    o  coin    e  enemy (walks back and forth)
//   P  player start    F  flag (win)           .  empty
const LEVEL = [
  '......................................................',
  '......................................................',
  '......................................................',
  '...................ooo................................',
  '..................=====..............o.o.o............',
  '.........o...........................=====.......F....',
  '........===.....................................###...',
  '..P..........o.o.........e.........e.....e....#####...',
  '#########...######...#########...#########...#########',
  '#########...######...#########...#########...#########',
];
const TILE = 32;
const TUNING = { run: 220, accel: 1800, friction: 1600, gravity: 1700, jump: -620, coyote: 0.1, enemySpeed: 60 };

const W = 640;
const H = LEVEL.length * TILE;
let player;
let coins;
let enemies;
let flag;
let camX;
let won;

function init() {
  coins = [];
  enemies = [];
  camX = 0;
  won = false;
  LEVEL.forEach((row, ty) => {
    [...row].forEach((c, tx) => {
      const x = tx * TILE;
      const y = ty * TILE;
      if (c === 'P') player = { x, y, w: 22, h: 28, vx: 0, vy: 0, onGround: false, coyote: 0 };
      if (c === 'o') coins.push({ x: x + 8, y: y + 8, w: 16, h: 16, taken: false });
      if (c === 'e') enemies.push({ x, y: y + 8, w: 28, h: 24, vx: 0, dir: -1, alive: true });
      if (c === 'F') flag = { x: x + 12, y: y - TILE * 2, w: 8, h: TILE * 3 };
    });
  });
}

function solidAt(px, py) {
  const tx = Math.floor(px / TILE);
  const ty = Math.floor(py / TILE);
  if (ty < 0) return false;
  if (ty >= LEVEL.length) return false;
  const c = (LEVEL[ty] || '')[tx];
  return c === '#' || c === '=';
}

// Move one axis at a time and push out of solid tiles, so the body never ends up inside a wall.
function moveBody(b, dt) {
  b.x += b.vx * dt;
  for (const y of [b.y + 1, b.y + b.h - 1]) {
    if (b.vx > 0 && solidAt(b.x + b.w, y)) { b.x = Math.floor((b.x + b.w) / TILE) * TILE - b.w - 0.01; b.vx = 0; b.bumped = true; }
    if (b.vx < 0 && solidAt(b.x, y)) { b.x = Math.floor(b.x / TILE + 1) * TILE + 0.01; b.vx = 0; b.bumped = true; }
  }
  b.vy += TUNING.gravity * dt;
  b.y += b.vy * dt;
  b.onGround = false;
  for (const x of [b.x + 1, b.x + b.w - 1]) {
    if (b.vy > 0 && solidAt(x, b.y + b.h)) { b.y = Math.floor((b.y + b.h) / TILE) * TILE - b.h; b.vy = 0; b.onGround = true; }
    if (b.vy < 0 && solidAt(x, b.y)) { b.y = Math.floor(b.y / TILE + 1) * TILE; b.vy = 0; }
  }
}

function update(g, dt) {
  if (won) return;
  const dir = (Kit.down('right') ? 1 : 0) - (Kit.down('left') ? 1 : 0);
  if (dir) player.vx = Kit.clamp(player.vx + dir * TUNING.accel * dt, -TUNING.run, TUNING.run);
  else player.vx -= Math.sign(player.vx) * Math.min(Math.abs(player.vx), TUNING.friction * dt);

  player.coyote = player.onGround ? TUNING.coyote : player.coyote - dt;
  if ((Kit.pressed('jump') || Kit.pressed('up')) && player.coyote > 0) {
    player.vy = TUNING.jump;
    player.coyote = 0;
    Kit.sfx('jump');
  }
  // Let go early for a short hop.
  if (!Kit.down('jump') && !Kit.down('up') && player.vy < -200) player.vy = -200;

  moveBody(player, dt);
  player.x = Math.max(0, player.x);
  if (player.y > H) { Kit.gameOver(); return; }

  for (const c of coins) {
    if (!c.taken && Kit.overlap(player, c)) { c.taken = true; Kit.addScore(1); Kit.sfx('coin'); Kit.burst(c.x + 8, c.y + 8, '#ffd23f', 8); }
  }

  for (const e of enemies) {
    if (!e.alive) continue;
    e.vx = e.dir * TUNING.enemySpeed;
    e.bumped = false;
    moveBody(e, dt);
    // Turn around at walls and ledges.
    const ahead = e.dir < 0 ? e.x - 2 : e.x + e.w + 2;
    if (e.bumped || !solidAt(ahead, e.y + e.h + 4)) e.dir = -e.dir;
    if (Kit.overlap(player, e)) {
      if (player.vy > 0 && player.y + player.h - e.y < 14) {
        e.alive = false;
        player.vy = TUNING.jump * 0.6;
        Kit.addScore(5);
        Kit.sfx('boom');
        Kit.burst(e.x + e.w / 2, e.y, '#c0392b');
      } else {
        Kit.burst(player.x + player.w / 2, player.y + player.h / 2, '#fff');
        Kit.gameOver();
        return;
      }
    }
  }

  if (Kit.overlap(player, flag)) {
    won = true;
    Kit.addScore(20);
    Kit.sfx('power');
    Kit.gameOver('You win!');
  }

  camX = Kit.clamp(player.x - W / 3, 0, LEVEL[0].length * TILE - W);
}

function draw(g, ctx) {
  ctx.fillStyle = '#87ceeb';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(-Math.round(camX), 0);

  LEVEL.forEach((row, ty) => {
    [...row].forEach((c, tx) => {
      if (c === '#') { ctx.fillStyle = '#8b5a2b'; ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE); ctx.fillStyle = '#5cb85c'; if (!solidAt(tx * TILE, (ty - 1) * TILE)) ctx.fillRect(tx * TILE, ty * TILE, TILE, 8); }
      if (c === '=') { ctx.fillStyle = '#b5651d'; ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE / 2); }
    });
  });
  for (const c of coins) {
    if (c.taken) continue;
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.ellipse(c.x + 8, c.y + 8, 6 + Math.sin(g.time * 6) * 2, 8, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const e of enemies) {
    if (!e.alive) continue;
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(e.x, e.y, e.w, e.h);
    ctx.fillStyle = '#fff';
    ctx.fillRect(e.x + 5, e.y + 5, 6, 6);
    ctx.fillRect(e.x + e.w - 11, e.y + 5, 6, 6);
  }
  ctx.fillStyle = '#eee';
  ctx.fillRect(flag.x, flag.y, 4, flag.h);
  ctx.fillStyle = '#e74c3c';
  ctx.fillRect(flag.x + 4, flag.y, 26, 18);

  ctx.fillStyle = '#3366ff';
  ctx.fillRect(player.x, player.y, player.w, player.h);
  ctx.fillStyle = '#fff';
  ctx.fillRect(player.x + (player.vx < 0 ? 3 : 13), player.y + 6, 6, 6);
  ctx.restore();
}

Kit.start({
  width: W,
  height: H,
  title: document.title,
  hint: 'Arrows or A/D to move, Space to jump',
  init,
  update,
  draw,
  debug: () => ({ playerX: Math.round(player.x), playerY: Math.round(player.y), coinsLeft: coins.filter((c) => !c.taken).length, won }),
});
