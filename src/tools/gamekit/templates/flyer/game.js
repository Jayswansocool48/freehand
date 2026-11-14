// Flyer: tap to flap through gaps between obstacles. Built on kit.js.
// Tune the numbers in TUNING; change looks in draw(). The player is drawn from assets/player.png:
// to change how it looks, make a new assets/player.png with make_sprite (no code change needed).
const TUNING = {
  gravity: 1100,      // px/s² pulling the player down
  flap: -380,         // upward speed after a flap
  speed: 150,         // how fast obstacles move left (px/s)
  speedUp: 4,         // extra speed per point scored
  gap: 165,           // vertical opening between top and bottom obstacle
  spacing: 220,       // horizontal distance between obstacles
  obstacleWidth: 64,
  groundHeight: 70,
};

const W = 400;
const H = 600;
let player;
let obstacles;
let groundX;
let clouds;
let city;
const playerImg = Kit.image('assets/player.png');

function init(g) {
  player = { x: 90, y: H / 2 - 40, w: 34, h: 24, vy: TUNING.flap, angle: 0 }; // the press that starts the game is the first flap
  obstacles = [];
  groundX = 0;
  for (let i = 0; i < 3; i++) addObstacle(W + 120 + i * TUNING.spacing);
  // Background layers scroll slower than the obstacles, which makes the world feel deep
  clouds = [];
  for (let i = 0; i < 5; i++) clouds.push({ x: i * 110 + Kit.rand(0, 60), y: Kit.rand(40, 220), s: Kit.rand(0.7, 1.3) });
  city = [];
  for (let x = 0; x < W + 60; x += Kit.rand(26, 44)) city.push({ x, w: Kit.rand(24, 40), h: Kit.rand(50, 130) });
}

function addObstacle(x) {
  const minTop = 50;
  const maxTop = H - TUNING.groundHeight - TUNING.gap - 50;
  obstacles.push({ x, top: Kit.rand(minTop, maxTop), passed: false });
}

// Each obstacle is two boxes: one from the ceiling down to the gap, one from below the gap to the ground.
function boxesOf(o) {
  return [
    { x: o.x, y: 0, w: TUNING.obstacleWidth, h: o.top },
    { x: o.x, y: o.top + TUNING.gap, w: TUNING.obstacleWidth, h: H - TUNING.groundHeight - (o.top + TUNING.gap) },
  ];
}

function update(g, dt) {
  const speed = TUNING.speed + g.score * TUNING.speedUp;

  if (Kit.pressed('jump') || Kit.pressed('up')) {
    player.vy = TUNING.flap;
    Kit.sfx('jump');
  }
  player.vy += TUNING.gravity * dt;
  player.y += player.vy * dt;
  player.angle = Kit.clamp(player.vy / 600, -0.5, 1.2);

  for (const o of obstacles) {
    o.x -= speed * dt;
    // Score once per obstacle, when the player has fully passed it.
    if (!o.passed && o.x + TUNING.obstacleWidth < player.x) {
      o.passed = true;
      Kit.addScore(1);
      Kit.sfx('coin');
    }
  }
  if (obstacles[0].x + TUNING.obstacleWidth < 0) {
    obstacles.shift();
    addObstacle(obstacles[obstacles.length - 1].x + TUNING.spacing);
  }
  groundX = (groundX - speed * dt) % 24;
  for (const c of clouds) { c.x -= speed * 0.15 * dt; if (c.x < -90) { c.x = W + 20; c.y = Kit.rand(40, 220); } }
  for (const b of city) { b.x -= speed * 0.35 * dt; if (b.x + b.w < 0) { b.x += W + 60; b.h = Kit.rand(50, 130); } }

  // A slightly smaller hitbox feels fair.
  const hit = { x: player.x + 4, y: player.y + 4, w: player.w - 8, h: player.h - 8 };
  const hitObstacle = obstacles.some((o) => boxesOf(o).some((b) => Kit.overlap(hit, b)));
  const hitGround = player.y + player.h >= H - TUNING.groundHeight;
  if (player.y < -40) player.y = -40; // flying off the top is allowed briefly; the obstacles still block
  if (hitObstacle || hitGround) {
    if (hitGround) player.y = H - TUNING.groundHeight - player.h;
    Kit.burst(player.x + player.w / 2, player.y + player.h / 2, '#ffd23f');
    Kit.gameOver();
  }
}

function draw(g, ctx) {
  // Sky
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#4ec0ca');
  sky.addColorStop(1, '#bde9ee');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Clouds, then a city skyline, both behind the obstacles
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (const c of clouds) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, 18 * c.s, 0, Math.PI * 2);
    ctx.arc(c.x + 22 * c.s, c.y - 8 * c.s, 22 * c.s, 0, Math.PI * 2);
    ctx.arc(c.x + 46 * c.s, c.y, 17 * c.s, 0, Math.PI * 2);
    ctx.fill();
  }
  const base = H - TUNING.groundHeight;
  for (const b of city) {
    ctx.fillStyle = '#9fd8c9';
    ctx.fillRect(b.x, base - b.h, b.w, b.h);
    ctx.fillStyle = '#c9ece2';
    for (let wy = base - b.h + 8; wy < base - 8; wy += 14) ctx.fillRect(b.x + 5, wy, b.w - 10, 4);
  }

  // Obstacles
  for (const o of obstacles) {
    for (const b of boxesOf(o)) {
      ctx.fillStyle = '#5bbd2b';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = '#3d8c1c';
      ctx.fillRect(b.x + b.w - 8, b.y, 8, b.h);
    }
    // Lips at the gap edges
    ctx.fillStyle = '#4aa521';
    ctx.fillRect(o.x - 4, o.top - 22, TUNING.obstacleWidth + 8, 22);
    ctx.fillRect(o.x - 4, o.top + TUNING.gap, TUNING.obstacleWidth + 8, 22);
  }

  // Ground
  const gy = H - TUNING.groundHeight;
  ctx.fillStyle = '#ded895';
  ctx.fillRect(0, gy, W, TUNING.groundHeight);
  ctx.fillStyle = '#73bf2e';
  ctx.fillRect(0, gy, W, 12);
  ctx.fillStyle = '#5a9e22';
  for (let x = groundX; x < W; x += 24) ctx.fillRect(x, gy, 12, 12);

  // Player: assets/player.png, tilted by its speed
  ctx.save();
  ctx.translate(player.x + player.w / 2, player.y + player.h / 2);
  ctx.rotate(g.state === 'title' ? Math.sin(g.time * 3) * 0.1 : player.angle);
  Kit.drawImage(ctx, playerImg, -player.w / 2, -player.h / 2, player.w, player.h, '#ffd23f');
  ctx.restore();
}

Kit.start({
  width: W,
  height: H,
  title: document.title,
  hint: 'Space, click or tap to flap',
  init,
  update,
  draw,
  debug: () => ({ playerY: Math.round(player.y), obstacles: obstacles.length }),
});
