// 3D adventure: walk around an island, collect every gem and keep away from the slimes. Built on kit3d.js.
// Tune the numbers in TUNING. The hero is assets/player.glb and the slimes are assets/enemy.glb:
// to change how they look, make new models with make_model at the same paths (no code change needed).
import { Kit, THREE } from './kit3d.js';

const TUNING = {
  speed: 6,          // walking speed (m/s); Shift runs 1.5x faster
  jump: 9,           // upward speed of a jump
  gems: 10,
  enemies: 3,
  enemySpeed: 2.4,   // m/s while chasing
  chaseRange: 9,     // slimes chase the hero when it is this close (m)
  lives: 3,
  island: 24,        // half the island's width (m)
};

let gems;
let enemies;
let lives;
let hurtTimer;

function spot(minFromStart) {
  let x, z;
  do { x = Kit.rand(-TUNING.island + 2, TUNING.island - 2); z = Kit.rand(-TUNING.island + 2, TUNING.island - 2); }
  while (Math.hypot(x, z) < minFromStart);
  return [x, z];
}

function tree(x, z) {
  Kit.solid(Kit.cylinder(0.3, 1.4, '#8b5a2b', x, 0, z));
  Kit.cone(1.3, 2.6, '#2e8b3e', x, 1.2, z);
}

function rock(x, z) {
  const s = Kit.rand(0.8, 1.6);
  Kit.solid(Kit.box(s, s * 0.7, s, '#8d9096', x, 0, z));
}

function init(g) {
  const water = Kit.add(new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: '#3d8fd6' })));
  water.rotation.x = -Math.PI / 2;
  water.position.y = -0.3;
  Kit.ground(TUNING.island * 2, '#7cc46a');
  for (let i = 0; i < 20; i++) {
    const [x, z] = spot(5);
    if (i % 3) tree(x, z); else rock(x, z);
  }

  g.player = Kit.model('assets/player.glb', Kit.shape.box(0.8, 1.8, 0.8, '#3366ff'));
  g.player.size = { w: 0.8, h: 1.8, d: 0.8 };
  g.player.vel = new THREE.Vector3();

  gems = [];
  for (let i = 0; i < TUNING.gems; i++) {
    const [x, z] = spot(3);
    gems.push(Kit.gem(0.35, '#3de0ff', x, 0.5, z));
  }

  enemies = [];
  for (let i = 0; i < TUNING.enemies; i++) {
    const [x, z] = spot(10);
    const e = Kit.model('assets/enemy.glb', Kit.shape.sphere(0.5, '#8e44ad'));
    e.position.set(x, 0, z);
    e.size = { w: 0.9, h: 0.8, d: 0.9 };
    e.vel = new THREE.Vector3();
    e.wander = Kit.rand(0, Math.PI * 2);
    enemies.push(e);
  }

  lives = TUNING.lives;
  hurtTimer = 0;
}

function update(g, dt) {
  const p = g.player;

  // Move relative to the camera; jump when on the ground
  const dir = Kit.moveInput();
  const speed = TUNING.speed * (Kit.down('run') ? 1.5 : 1);
  p.vel.x = dir.x * speed;
  p.vel.z = dir.z * speed;
  if (Kit.pressed('jump') && p.onGround) { p.vel.y = TUNING.jump; Kit.sfx('jump'); }
  Kit.move(p, dt);
  p.position.x = Kit.clamp(p.position.x, -TUNING.island + 0.5, TUNING.island - 0.5);
  p.position.z = Kit.clamp(p.position.z, -TUNING.island + 0.5, TUNING.island - 0.5);
  Kit.face(p, dir, dt);
  Kit.walk(p, p.onGround ? dir.length() : 0);

  // Gems spin; touching one scores
  for (const gem of gems) {
    gem.rotation.y += dt * 2;
    if (!gem.taken && Kit.near(p, gem, 1.3)) {
      gem.taken = true;
      Kit.remove(gem);
      Kit.addScore(1);
      Kit.sfx('coin');
      Kit.burst(gem.position, '#3de0ff');
    }
  }
  gems = gems.filter((gem) => !gem.taken);
  if (gems.length === 0) Kit.gameOver('You win!');

  // Slimes wander, and chase the hero when it comes close
  for (const e of enemies) {
    const to = new THREE.Vector3(p.position.x - e.position.x, 0, p.position.z - e.position.z);
    let v;
    if (to.length() < TUNING.chaseRange) v = to.normalize().multiplyScalar(TUNING.enemySpeed);
    else { e.wander += Kit.rand(-1.5, 1.5) * dt; v = new THREE.Vector3(Math.sin(e.wander), 0, Math.cos(e.wander)).multiplyScalar(TUNING.enemySpeed * 0.4); }
    e.vel.x = v.x;
    e.vel.z = v.z;
    Kit.move(e, dt);
    if (e.hitWall || Math.abs(e.position.x) > TUNING.island - 1 || Math.abs(e.position.z) > TUNING.island - 1) e.wander += Math.PI;
    e.position.x = Kit.clamp(e.position.x, -TUNING.island + 1, TUNING.island - 1);
    e.position.z = Kit.clamp(e.position.z, -TUNING.island + 1, TUNING.island - 1);
    Kit.face(e, v, dt);
    e.scale.y = 1 + Math.sin(g.time * 8 + e.wander) * 0.08;
  }

  // Touching a slime costs a life, then a short time where the hero blinks and cannot be hurt
  hurtTimer -= dt;
  if (hurtTimer <= 0 && enemies.some((e) => Kit.near(p, e, 1.1))) {
    lives -= 1;
    hurtTimer = 1.5;
    p.vel.y = 7;
    Kit.sfx('hit');
    Kit.shake(0.3);
    if (lives <= 0) Kit.gameOver();
  }
  p.visible = hurtTimer <= 0 || Math.floor(g.time * 10) % 2 === 0;

  Kit.hud(`Lives ${lives}   Gems ${TUNING.gems - gems.length}/${TUNING.gems}`);
}

Kit.start({
  title: document.title,
  hint: 'WASD or arrows to move, Space to jump, Q/E or drag the mouse to turn the camera. Press Space or click to start',
  camera: 'third',
  init,
  update,
  debug: (g) => ({ lives, gems: gems.length, onGround: !!g.player.onGround }),
});
