// 3D platformer: jump from platform to platform, collect coins and reach the flag. Falling off costs a life.
// Built on kit3d.js. Change the course in LEVEL and the feel in TUNING. The hero is assets/player.glb:
// to change how it looks, make a new model with make_model at that path (no code change needed).
import { Kit, THREE } from './kit3d.js';

const TUNING = {
  speed: 6,          // running speed (m/s)
  jump: 10,          // upward speed of a jump
  gravity: 25,
  lives: 3,
  fallY: -12,        // falling below this costs a life
  coinPoints: 1,
  flagPoints: 10,
};

// One platform per row: [x, top y, z, width, depth, slide]. The course runs away from the camera (-z).
// slide > 0 makes the platform move from side to side by that many metres. The last platform holds the flag.
const LEVEL = [
  [0, 0, 0, 6, 6, 0],
  [0, 0.6, -7, 3, 3, 0],
  [3, 1.3, -11.5, 3, 3, 0],
  [0, 2, -16, 3, 2.5, 3],
  [-3, 2.6, -21, 3, 3, 0],
  [-1, 3.3, -25.5, 2.5, 2.5, 0],
  [2, 4, -30, 3, 3, 2.5],
  [0, 4.6, -35, 3, 3, 0],
  [0, 5.2, -41, 6, 6, 0],
];

let platforms;
let coins;
let flag;
let lives;
let checkpoint;

function init(g) {
  platforms = [];
  coins = [];
  LEVEL.forEach(([x, top, z, w, d, slide], i) => {
    const color = i === LEVEL.length - 1 ? '#f4d35e' : i % 2 ? '#8bc34a' : '#a1887f';
    const p = Kit.box(w, 1, d, color, x, top - 1, z);
    p.baseX = x;
    p.slide = slide;
    Kit.solid(p, slide > 0);
    platforms.push(p);
    if (i > 0 && i < LEVEL.length - 1) {
      const c = Kit.cylinder(0.35, 0.08, '#ffc83d', x, top + 0.9, z);
      c.rotation.z = Math.PI / 2;
      coins.push(c);
    }
  });
  const [fx, ftop, fz] = LEVEL[LEVEL.length - 1];
  flag = Kit.cylinder(0.08, 3, '#eeeeee', fx, ftop, fz);
  const cloth = Kit.box(0.9, 0.6, 0.05, '#e53935', 0.45, 2.3, 0);
  flag.add(cloth);
  for (let i = 0; i < 12; i++) Kit.box(Kit.rand(2, 5), 0.8, Kit.rand(1.5, 3), '#ffffff', Kit.rand(-25, 25), Kit.rand(-6, 14), Kit.rand(-60, 10));

  g.player = Kit.model('assets/player.glb', Kit.shape.box(0.8, 1.8, 0.8, '#3366ff'));
  g.player.size = { w: 0.7, h: 1.8, d: 0.7 };
  g.player.vel = new THREE.Vector3();
  checkpoint = new THREE.Vector3(0, 0.1, 0);
  g.player.position.copy(checkpoint);
  lives = TUNING.lives;
}

function update(g, dt) {
  const p = g.player;

  // Moving platforms slide from side to side
  for (const plat of platforms) if (plat.slide) plat.position.x = plat.baseX + Math.sin(g.time * 1.2) * plat.slide;

  // Run relative to the camera, jump from the ground
  const dir = Kit.moveInput();
  p.vel.x = dir.x * TUNING.speed;
  p.vel.z = dir.z * TUNING.speed;
  if (Kit.pressed('jump') && p.onGround) { p.vel.y = TUNING.jump; Kit.sfx('jump'); }
  Kit.move(p, dt, { gravity: TUNING.gravity, floor: null });
  Kit.face(p, dir, dt);
  Kit.walk(p, p.onGround ? dir.length() : 0);

  // The last platform you stood on is where you come back after a fall
  if (p.onGround && p.standingOn && !p.standingOn.moving) {
    const b = p.standingOn.box;
    checkpoint.set((b.min.x + b.max.x) / 2, b.max.y + 0.1, (b.min.z + b.max.z) / 2);
  }

  if (p.position.y < TUNING.fallY) {
    lives -= 1;
    Kit.sfx('hit');
    Kit.shake(0.3);
    if (lives <= 0) { Kit.gameOver(); return; }
    p.position.copy(checkpoint);
    p.vel.set(0, 0, 0);
  }

  for (const c of coins) {
    c.rotation.y += dt * 3;
    if (!c.taken && Kit.near(p, c, 1.4)) {
      c.taken = true;
      Kit.remove(c);
      Kit.addScore(TUNING.coinPoints);
      Kit.sfx('coin');
      Kit.burst(c.position, '#ffc83d');
    }
  }
  coins = coins.filter((c) => !c.taken);

  if (Math.hypot(p.position.x - flag.position.x, p.position.z - flag.position.z) < 1.2 && p.position.y > flag.position.y - 0.5) {
    Kit.addScore(TUNING.flagPoints);
    Kit.gameOver('You win!');
  }

  Kit.hud(`Lives ${lives}   Coins left ${coins.length}`);
}

Kit.start({
  title: document.title,
  hint: 'WASD or arrows to move, Space to jump, Q/E or drag the mouse to turn the camera. Press Space or click to start',
  camera: 'third',
  sky: '#8fd0ff',
  init,
  update,
  debug: (g) => ({ lives, coins: coins.length, onGround: !!g.player.onGround }),
});
