// Runner: the hero runs on its own; Space, Up or a tap jumps (press again in the air to double jump).
// Jump over blocks, duck under nothing; it gets faster the further you go. Built on kit.js.
// Tune the numbers in TUNING; change looks in draw(). The hero is drawn from assets/player.png:
// to change how it looks, make a new assets/player.png with make_sprite (no code change needed).
const TUNING = {
  gravity: 2200,      // px/s²
  jump: -720,         // upward speed of a jump
  doubleJump: true,
  speed: 260,         // ground speed at the start (px/s)
  speedUp: 6,         // extra speed per point
  minGap: 260,        // shortest distance between obstacles (px)
  maxGap: 520,
  groundY: 480,       // top of the ground
};

const W = 800;
const H = 600;
let hero;
let obstacles;
let distance;
let nextAt;
let hills;
const playerImg = Kit.image('assets/player.png');

function init(g) {
  hero = { x: 120, y: TUNING.groundY - 48, w: 36, h: 48, vy: 0, onGround: true, jumps: 0 };
  obstacles = [];
  distance = 0;
  nextAt = 500;
  hills = [];
  for (let i = 0; i < 6; i++) hills.push({ x: i * 180, h: Kit.rand(60, 140) });
}

function addObstacle() {
  const tall = Math.random() < 0.35;
  const w = tall ? 26 : Kit.rand(28, 60);
  const h = tall ? 70 : Kit.rand(30, 46);
  obstacles.push({ x: W + 20, y: TUNING.groundY - h, w, h, passed: false });
}

function update(g, dt) {
  const speed = TUNING.speed + g.score * TUNING.speedUp;
  distance += speed * dt;

  // Jump (and double jump)
  if (Kit.pressed('jump') || Kit.pressed('up')) {
    if (hero.onGround || (TUNING.doubleJump && hero.jumps < 2)) {
      hero.vy = TUNING.jump;
      hero.onGround = false;
      hero.jumps += 1;
      Kit.sfx('jump');
    }
  }
  hero.vy += TUNING.gravity * dt;
  hero.y += hero.vy * dt;
  if (hero.y + hero.h >= TUNING.groundY) {
    hero.y = TUNING.groundY - hero.h;
    hero.vy = 0;
    hero.onGround = true;
    hero.jumps = 0;
  }

  // Obstacles scroll left; one point for each one cleared
  nextAt -= speed * dt;
  if (nextAt <= 0) {
    addObstacle();
    nextAt = Kit.rand(TUNING.minGap, TUNING.maxGap) + speed * 0.3;
  }
  for (const o of obstacles) {
    o.x -= speed * dt;
    if (!o.passed && o.x + o.w < hero.x) {
      o.passed = true;
      Kit.addScore(1);
      Kit.sfx('coin');
    }
  }
  obstacles = obstacles.filter((o) => o.x + o.w > -20);
  for (const h of hills) { h.x -= speed * 0.2 * dt; if (h.x < -200) { h.x += 6 * 180; h.h = Kit.rand(60, 140); } }

  const hit = { x: hero.x + 6, y: hero.y + 4, w: hero.w - 12, h: hero.h - 6 };
  if (obstacles.some((o) => Kit.overlap(hit, o))) {
    Kit.burst(hero.x + hero.w / 2, hero.y + hero.h / 2, '#ff7043');
    Kit.gameOver();
  }
}

function draw(g, ctx) {
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#ffb74d');
  sky.addColorStop(1, '#ffe0b2');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Far hills move slowly (parallax)
  ctx.fillStyle = '#d7a86e';
  for (const h of hills) {
    ctx.beginPath();
    ctx.moveTo(h.x, TUNING.groundY);
    ctx.lineTo(h.x + 110, TUNING.groundY - h.h);
    ctx.lineTo(h.x + 220, TUNING.groundY);
    ctx.fill();
  }

  // Ground with moving stripes
  ctx.fillStyle = '#795548';
  ctx.fillRect(0, TUNING.groundY, W, H - TUNING.groundY);
  ctx.fillStyle = '#8d6e63';
  for (let x = -(distance % 40); x < W; x += 40) ctx.fillRect(x, TUNING.groundY + 10, 20, 6);

  ctx.fillStyle = '#4e342e';
  for (const o of obstacles) ctx.fillRect(o.x, o.y, o.w, o.h);

  // Hero: assets/player.png, bobbing while it runs
  const bob = hero.onGround ? Math.abs(Math.sin(g.time * 14)) * -3 : 0;
  Kit.drawImage(ctx, playerImg, hero.x, hero.y + bob, hero.w, hero.h, '#26a69a');
}

Kit.start({
  width: W,
  height: H,
  title: document.title,
  hint: 'Space, Up or tap to jump (twice for a double jump)',
  init,
  update,
  draw,
  debug: () => ({ heroY: Math.round(hero.y), onGround: hero.onGround, obstacles: obstacles.length }),
});
