// A blank kit.js game: a box you move around. Replace this with your own game.
const W = 480;
const H = 360;
let player;

function init() {
  player = { x: W / 2 - 16, y: H / 2 - 16, w: 32, h: 32 };
}

function update(g, dt) {
  const speed = 200;
  if (Kit.down('left')) player.x -= speed * dt;
  if (Kit.down('right')) player.x += speed * dt;
  if (Kit.down('up')) player.y -= speed * dt;
  if (Kit.down('down')) player.y += speed * dt;
  player.x = Kit.clamp(player.x, 0, W - player.w);
  player.y = Kit.clamp(player.y, 0, H - player.h);
  if (Kit.pressed('jump')) { Kit.addScore(1); Kit.sfx('coin'); }
}

function draw(g, ctx) {
  ctx.fillStyle = '#20232a';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#61dafb';
  ctx.fillRect(player.x, player.y, player.w, player.h);
}

Kit.start({ width: W, height: H, title: document.title, hint: 'Arrows to move, Space to score', init, update, draw });
