// Snake: steer with the arrow keys or WASD, eat food to grow, don't hit the walls or yourself. Built on kit.js.
// Tune the numbers in TUNING; change looks in draw(); add sprites with Kit.image('assets/x.png').
const TUNING = {
  cell: 20,           // size of one grid square in px
  cols: 20,
  rows: 24,
  stepTime: 0.14,     // seconds between moves at the start
  speedUp: 0.004,     // moves get this much faster per food eaten
  minStepTime: 0.06,
  startLength: 4,
  wrap: false,        // true: leaving one side comes back on the other instead of dying
};

const W = TUNING.cols * TUNING.cell;
const H = TUNING.rows * TUNING.cell;
let snake;     // list of {x, y} grid cells, head first
let dir;       // current direction {x, y}
let queued;    // turns pressed since the last move, played one per move so quick turns are not lost
let food;
let timer;

function init(g) {
  const cx = Math.floor(TUNING.cols / 2);
  const cy = Math.floor(TUNING.rows / 2);
  snake = [];
  for (let i = 0; i < TUNING.startLength; i++) snake.push({ x: cx - i, y: cy });
  dir = { x: 1, y: 0 };
  queued = [];
  timer = 0;
  placeFood();
}

function placeFood() {
  // Pick a free cell. Fine for small grids; the snake never fills it all in practice.
  do {
    food = { x: Math.floor(Kit.rand(0, TUNING.cols)), y: Math.floor(Kit.rand(0, TUNING.rows)) };
  } while (snake.some((s) => s.x === food.x && s.y === food.y));
}

function turn(x, y) {
  const last = queued.length ? queued[queued.length - 1] : dir;
  if (last.x === -x && last.y === -y) return; // no reversing into your own neck
  if (last.x === x && last.y === y) return;
  if (queued.length < 3) queued.push({ x, y });
}

function update(g, dt) {
  if (Kit.pressed('left')) turn(-1, 0);
  if (Kit.pressed('right')) turn(1, 0);
  if (Kit.pressed('up')) turn(0, -1);
  if (Kit.pressed('down')) turn(0, 1);

  timer += dt;
  const stepTime = Math.max(TUNING.minStepTime, TUNING.stepTime - g.score * TUNING.speedUp);
  if (timer < stepTime) return;
  timer -= stepTime;

  if (queued.length) dir = queued.shift();
  const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
  if (TUNING.wrap) {
    head.x = (head.x + TUNING.cols) % TUNING.cols;
    head.y = (head.y + TUNING.rows) % TUNING.rows;
  } else if (head.x < 0 || head.y < 0 || head.x >= TUNING.cols || head.y >= TUNING.rows) {
    return die();
  }
  // The tail moves away this step, so only the rest of the body counts.
  if (snake.slice(0, -1).some((s) => s.x === head.x && s.y === head.y)) return die();

  snake.unshift(head);
  if (head.x === food.x && head.y === food.y) {
    Kit.addScore(1);
    Kit.sfx('coin');
    Kit.burst((food.x + 0.5) * TUNING.cell, (food.y + 0.5) * TUNING.cell, '#ff5252', 10);
    placeFood();
  } else {
    snake.pop();
  }
}

function die() {
  Kit.burst((snake[0].x + 0.5) * TUNING.cell, (snake[0].y + 0.5) * TUNING.cell, '#8bc34a');
  Kit.gameOver();
}

function draw(g, ctx) {
  const c = TUNING.cell;
  // Checkerboard field
  for (let y = 0; y < TUNING.rows; y++) {
    for (let x = 0; x < TUNING.cols; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#a5d65a' : '#9ccc50';
      ctx.fillRect(x * c, y * c, c, c);
    }
  }

  // Food: an apple
  ctx.fillStyle = '#e53935';
  ctx.beginPath();
  ctx.arc((food.x + 0.5) * c, (food.y + 0.55) * c, c * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#5d4037';
  ctx.fillRect((food.x + 0.47) * c, food.y * c + 1, 2, c * 0.25);

  // Snake, tail to head so the head is on top
  for (let i = snake.length - 1; i >= 0; i--) {
    const s = snake[i];
    ctx.fillStyle = i === 0 ? '#2e5bd8' : i % 2 ? '#4a7cf0' : '#3f70e6';
    ctx.fillRect(s.x * c + 1, s.y * c + 1, c - 2, c - 2);
  }
  // Two eyes side by side, looking the way the snake is going
  const h = snake[0];
  const ex = (h.x + 0.5 + dir.x * 0.2) * c;
  const ey = (h.y + 0.5 + dir.y * 0.2) * c;
  ctx.fillStyle = '#fff';
  for (const side of [-1, 1]) ctx.fillRect(ex + dir.y * side * 5 - 2, ey + dir.x * side * 5 - 2, 4, 4);
}

Kit.start({
  width: W,
  height: H,
  title: document.title,
  hint: 'Space or click to start, arrow keys to steer',
  init,
  update,
  draw,
  debug: () => ({ length: snake.length, head: snake[0], food }),
});
