// Breakout: move the paddle (arrow keys or mouse) to bounce the ball into the bricks. Built on kit.js.
// Tune the numbers in TUNING; change the level in COLORS and makeBricks(); change looks in draw().
const TUNING = {
  paddleWidth: 80,
  paddleSpeed: 420,   // px/s with the arrow keys
  ballSpeed: 300,     // px/s at the start
  speedUp: 4,         // extra ball speed per brick broken
  lives: 3,
  rows: 6,
  cols: 8,
  brickHeight: 18,
};
const COLORS = ['#ef5350', '#ff9800', '#fdd835', '#66bb6a', '#42a5f5', '#ab47bc']; // one per row, top first

const W = 400;
const H = 600;
let paddle;
let ball;
let bricks;
let lives;
let lastPointerX;

function init(g) {
  paddle = { x: W / 2 - TUNING.paddleWidth / 2, y: H - 50, w: TUNING.paddleWidth, h: 12 };
  lives = TUNING.lives;
  lastPointerX = g.pointer ? g.pointer.x : null;
  makeBricks();
  serve();
}

function makeBricks() {
  bricks = [];
  const gap = 4;
  const bw = (W - 20 - gap * (TUNING.cols - 1)) / TUNING.cols;
  for (let r = 0; r < TUNING.rows; r++) {
    for (let c = 0; c < TUNING.cols; c++) {
      bricks.push({ x: 10 + c * (bw + gap), y: 70 + r * (TUNING.brickHeight + gap), w: bw, h: TUNING.brickHeight, color: COLORS[r % COLORS.length], alive: true });
    }
  }
}

// The ball sits on the paddle and launches up at a slight angle.
function serve() {
  const a = Kit.rand(-0.5, 0.5);
  ball = { x: paddle.x + paddle.w / 2, y: paddle.y - 10, r: 7, vx: Math.sin(a) * TUNING.ballSpeed, vy: -Math.cos(a) * TUNING.ballSpeed };
}

function update(g, dt) {
  // Paddle: keys, or follow the mouse/finger when it moves
  if (Kit.down('left')) paddle.x -= TUNING.paddleSpeed * dt;
  if (Kit.down('right')) paddle.x += TUNING.paddleSpeed * dt;
  if (g.pointer && g.pointer.x !== lastPointerX) { paddle.x = g.pointer.x - paddle.w / 2; lastPointerX = g.pointer.x; }
  paddle.x = Kit.clamp(paddle.x, 0, W - paddle.w);

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  // Walls
  if (ball.x < ball.r) { ball.x = ball.r; ball.vx = Math.abs(ball.vx); }
  if (ball.x > W - ball.r) { ball.x = W - ball.r; ball.vx = -Math.abs(ball.vx); }
  if (ball.y < ball.r) { ball.y = ball.r; ball.vy = Math.abs(ball.vy); }

  const box = { x: ball.x - ball.r, y: ball.y - ball.r, w: ball.r * 2, h: ball.r * 2 };

  // Paddle: where the ball lands on it sets the bounce angle. Only bounce when moving down.
  if (ball.vy > 0 && Kit.overlap(box, paddle)) {
    const hit = Kit.clamp((ball.x - (paddle.x + paddle.w / 2)) / (paddle.w / 2), -1, 1);
    const speed = Math.hypot(ball.vx, ball.vy);
    ball.vx = Math.sin(hit * 1.05) * speed;
    ball.vy = -Math.cos(hit * 1.05) * speed;
    ball.y = paddle.y - ball.r;
    Kit.sfx('click');
  }

  // Bricks: break at most one per frame, bounce off the side it was hit from
  for (const b of bricks) {
    if (!b.alive || !Kit.overlap(box, b)) continue;
    b.alive = false;
    const fromSide = Math.min(Math.abs(ball.x - b.x), Math.abs(ball.x - (b.x + b.w))) < Math.min(Math.abs(ball.y - b.y), Math.abs(ball.y - (b.y + b.h)));
    if (fromSide) ball.vx = -ball.vx; else ball.vy = -ball.vy;
    const speed = Math.hypot(ball.vx, ball.vy);
    const faster = (speed + TUNING.speedUp) / speed;
    ball.vx *= faster;
    ball.vy *= faster;
    Kit.addScore(1);
    Kit.sfx('coin');
    Kit.burst(b.x + b.w / 2, b.y + b.h / 2, b.color, 8);
    break;
  }
  if (!bricks.some((b) => b.alive)) Kit.gameOver('You win!');

  // Missed the ball
  if (ball.y > H + ball.r) {
    lives -= 1;
    Kit.shake(6);
    if (lives <= 0) Kit.gameOver();
    else { Kit.sfx('hit'); serve(); }
  }
}

function draw(g, ctx) {
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#1a1f3a');
  bg.addColorStop(1, '#2b1d3f');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  for (const b of bricks) {
    if (!b.alive) continue;
    ctx.fillStyle = b.color;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(b.x, b.y, b.w, 4);
  }

  ctx.fillStyle = '#e0e0e0';
  ctx.fillRect(paddle.x, paddle.y, paddle.w, paddle.h);
  ctx.fillStyle = '#90caf9';
  ctx.fillRect(paddle.x + 4, paddle.y + 3, paddle.w - 8, 4);

  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
  ctx.fill();

  // Lives as small balls in the corner
  for (let i = 0; i < lives; i++) {
    ctx.beginPath();
    ctx.arc(W - 18 - i * 18, 22, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

Kit.start({
  width: W,
  height: H,
  title: document.title,
  hint: 'Space or click to start, arrows or mouse to move',
  init,
  update,
  draw,
  debug: () => ({ lives, bricksLeft: bricks.filter((b) => b.alive).length, ballY: Math.round(ball.y) }),
});
