// Shooter: fly left and right, hold Space to fire, shoot the enemies before they reach you. Built on kit.js.
// Tune the numbers in TUNING; change looks in draw(). The ship is drawn from assets/player.png:
// to change how it looks, make a new assets/player.png with make_sprite (no code change needed).
const TUNING = {
  shipSpeed: 300,     // px/s
  fireDelay: 0.22,    // seconds between shots while Space is held
  bulletSpeed: 520,
  enemySpeed: 70,     // how fast enemies fall at the start (px/s)
  speedUp: 2,         // extra enemy speed per point
  spawnEvery: 1.1,    // seconds between enemies at the start
  minSpawn: 0.35,
  lives: 3,
};

const W = 400;
const H = 600;
let ship;
let bullets;
let enemies;
let stars;
let lives;
let fireTimer;
let spawnTimer;
let hurtTimer;
const playerImg = Kit.image('assets/player.png');

function init(g) {
  ship = { x: W / 2 - 16, y: H - 80, w: 32, h: 32 };
  bullets = [];
  enemies = [];
  lives = TUNING.lives;
  fireTimer = 0;
  spawnTimer = 1;
  hurtTimer = 0;
  stars = [];
  for (let i = 0; i < 60; i++) stars.push({ x: Kit.rand(0, W), y: Kit.rand(0, H), s: Kit.rand(20, 120) });
}

function spawnEnemy(g) {
  const size = Kit.rand(24, 36);
  enemies.push({ x: Kit.rand(10, W - 10 - size), y: -size, w: size, h: size, wobble: Kit.rand(0, Math.PI * 2), hp: size > 32 ? 2 : 1 });
}

function update(g, dt) {
  for (const s of stars) { s.y += s.s * dt; if (s.y > H) { s.y = 0; s.x = Kit.rand(0, W); } }

  // Ship: arrow keys, or follow the mouse/finger
  if (Kit.down('left')) ship.x -= TUNING.shipSpeed * dt;
  if (Kit.down('right')) ship.x += TUNING.shipSpeed * dt;
  if (g.pointer) ship.x += Kit.clamp(g.pointer.x - (ship.x + ship.w / 2), -TUNING.shipSpeed * dt, TUNING.shipSpeed * dt);
  ship.x = Kit.clamp(ship.x, 0, W - ship.w);

  // Fire while Space (or the mouse button) is held
  fireTimer -= dt;
  if ((Kit.down('jump') || Kit.down('action')) && fireTimer <= 0) {
    bullets.push({ x: ship.x + ship.w / 2 - 2, y: ship.y - 8, w: 4, h: 12 });
    fireTimer = TUNING.fireDelay;
    Kit.sfx('jump');
  }
  for (const b of bullets) b.y -= TUNING.bulletSpeed * dt;
  bullets = bullets.filter((b) => b.y + b.h > 0);

  // Enemies come faster as the score goes up
  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawnEnemy(g);
    spawnTimer = Math.max(TUNING.minSpawn, TUNING.spawnEvery - g.score * 0.02);
  }
  const fall = TUNING.enemySpeed + g.score * TUNING.speedUp;
  for (const e of enemies) {
    e.y += fall * dt;
    e.wobble += dt * 2;
    e.x = Kit.clamp(e.x + Math.sin(e.wobble) * 40 * dt, 0, W - e.w);
  }

  // Bullets hit enemies. Each bullet is used up once.
  for (const b of bullets) {
    const e = enemies.find((en) => en.hp > 0 && Kit.overlap(b, en));
    if (!e) continue;
    b.y = -100;
    e.hp -= 1;
    if (e.hp <= 0) {
      Kit.addScore(1);
      Kit.sfx('boom');
      Kit.burst(e.x + e.w / 2, e.y + e.h / 2, '#ff7043');
    }
  }

  // Enemies that touch the ship or get past it cost a life
  hurtTimer -= dt;
  for (const e of enemies) {
    if (e.hp <= 0) continue;
    const touched = hurtTimer <= 0 && Kit.overlap({ x: ship.x + 4, y: ship.y + 4, w: ship.w - 8, h: ship.h - 8 }, e);
    if (touched || e.y > H) {
      e.hp = 0;
      lives -= 1;
      hurtTimer = 1;
      Kit.sfx('hit');
      Kit.shake(8);
      if (lives <= 0) Kit.gameOver();
    }
  }
  enemies = enemies.filter((e) => e.hp > 0);
}

function draw(g, ctx) {
  ctx.fillStyle = '#05061a';
  ctx.fillRect(0, 0, W, H);
  for (const s of stars) {
    ctx.fillStyle = s.s > 80 ? '#fff' : '#7986cb';
    ctx.fillRect(s.x, s.y, s.s > 80 ? 2 : 1, s.s > 80 ? 2 : 1);
  }

  ctx.fillStyle = '#ffee58';
  for (const b of bullets) ctx.fillRect(b.x, b.y, b.w, b.h);

  for (const e of enemies) {
    ctx.fillStyle = e.hp > 1 ? '#ab47bc' : '#ef5350';
    ctx.beginPath();
    ctx.moveTo(e.x, e.y);
    ctx.lineTo(e.x + e.w, e.y);
    ctx.lineTo(e.x + e.w / 2, e.y + e.h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(e.x + e.w / 2 - 3, e.y + e.h / 3, 6, 6);
  }

  // Ship: assets/player.png, blinking while it can't be hurt
  if (hurtTimer <= 0 || Math.floor(g.time * 10) % 2) {
    Kit.drawImage(ctx, playerImg, ship.x, ship.y, ship.w, ship.h, '#4fc3f7');
    ctx.fillStyle = '#ff9800';
    ctx.fillRect(ship.x + ship.w / 2 - 3, ship.y + ship.h, 6, 3 + Math.random() * 6);
  }

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Lives ' + lives, 12, 26);
}

Kit.start({
  width: W,
  height: H,
  title: document.title,
  hint: 'Arrows to move, hold Space to fire',
  init,
  update,
  draw,
  debug: () => ({ lives, enemies: enemies.length }),
});
