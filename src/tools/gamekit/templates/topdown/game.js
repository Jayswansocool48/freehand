// Top-down: move in any direction, collect gems, dodge chasers. Built on kit.js.
const TUNING = { speed: 220, chaserSpeed: 60, chaserSpeedUp: 6, gems: 5, firstChasers: 2 };

const W = 640;
const H = 480;
let player;
let gems;
let chasers;
let wave;

function init() {
  player = { x: W / 2 - 12, y: H / 2 - 12, w: 24, h: 24 };
  wave = 0;
  chasers = [];
  nextWave();
}

function nextWave() {
  wave++;
  gems = [];
  for (let i = 0; i < TUNING.gems; i++) gems.push(spawnAwayFromPlayer(18));
  while (chasers.length < TUNING.firstChasers + wave - 1) chasers.push(spawnAwayFromPlayer(22));
}

// Spawn at least 220 px from the player so a new round never starts with a hit.
function spawnAwayFromPlayer(size) {
  let x;
  let y;
  do {
    x = Kit.rand(20, W - 20 - size);
    y = Kit.rand(20, H - 20 - size);
  } while (Math.hypot(x - player.x, y - player.y) < 220);
  return { x, y, w: size, h: size };
}

function update(g, dt) {
  let dx = (Kit.down('right') ? 1 : 0) - (Kit.down('left') ? 1 : 0);
  let dy = (Kit.down('down') ? 1 : 0) - (Kit.down('up') ? 1 : 0);
  const len = Math.hypot(dx, dy) || 1; // diagonals are not faster
  player.x = Kit.clamp(player.x + (dx / len) * TUNING.speed * dt, 0, W - player.w);
  player.y = Kit.clamp(player.y + (dy / len) * TUNING.speed * dt, 0, H - player.h);

  for (let i = gems.length - 1; i >= 0; i--) {
    if (Kit.overlap(player, gems[i])) {
      Kit.burst(gems[i].x + 9, gems[i].y + 9, '#4fc3f7', 8);
      gems.splice(i, 1);
      Kit.addScore(1);
      Kit.sfx('coin');
    }
  }
  if (gems.length === 0) { Kit.sfx('power'); nextWave(); }

  const speed = TUNING.chaserSpeed + wave * TUNING.chaserSpeedUp;
  for (const c of chasers) {
    const ax = player.x - c.x;
    const ay = player.y - c.y;
    const d = Math.hypot(ax, ay) || 1;
    c.x += (ax / d) * speed * dt;
    c.y += (ay / d) * speed * dt;
    if (Kit.overlap({ x: player.x + 3, y: player.y + 3, w: player.w - 6, h: player.h - 6 }, c)) {
      Kit.burst(player.x + 12, player.y + 12, '#fff');
      Kit.gameOver();
      return;
    }
  }
}

function draw(g, ctx) {
  ctx.fillStyle = '#1e2a38';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#26364a';
  for (let x = 0; x < W; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  for (const gem of gems) {
    ctx.fillStyle = '#4fc3f7';
    ctx.beginPath();
    ctx.moveTo(gem.x + 9, gem.y);
    ctx.lineTo(gem.x + 18, gem.y + 9);
    ctx.lineTo(gem.x + 9, gem.y + 18);
    ctx.lineTo(gem.x, gem.y + 9);
    ctx.fill();
  }
  for (const c of chasers) {
    ctx.fillStyle = '#ef5350';
    ctx.fillRect(c.x, c.y, c.w, c.h);
  }
  ctx.fillStyle = '#66bb6a';
  ctx.fillRect(player.x, player.y, player.w, player.h);
  ctx.fillStyle = '#fff';
  ctx.font = '16px system-ui, sans-serif';
  ctx.textAlign = 'left';
  if (g.state === 'play') ctx.fillText('Wave ' + wave, 12, 24);
}

Kit.start({
  width: W,
  height: H,
  title: document.title,
  hint: 'Arrows or WASD to move. Press Space to start',
  init,
  update,
  draw,
  debug: () => ({ wave, gemsLeft: gems.length, chasers: chasers.length }),
});
