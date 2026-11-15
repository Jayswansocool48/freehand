// 3D first-person shooter: enemies come at you in waves inside a walled arena. Shoot them before they reach you.
// Built on kit3d.js. Tune the numbers in TUNING. Enemies are assets/enemy.glb: to change how they look,
// make a new model with make_model at that path (no code change needed).
import { Kit, THREE } from './kit3d.js';

const TUNING = {
  speed: 7,          // walking speed (m/s)
  jump: 8,
  health: 100,
  damage: 10,        // health lost when an enemy touches you
  fireDelay: 0.25,   // seconds between shots
  enemySpeed: 2.5,   // m/s, a little faster each wave
  enemyHp: 2,        // shots to defeat one
  firstWave: 3,      // enemies in wave 1; each wave adds 2
  arena: 22,         // half the arena's width (m)
};

// The gun is attached to the camera once, so it stays in view.
const gun = Kit.shape.box(0.07, 0.09, 0.42, '#37474f', 0.22, -0.26, -0.5);
gun.add(Kit.shape.box(0.05, 0.12, 0.07, '#263238', 0, -0.1, 0.12)); // the grip
const flash = Kit.shape.sphere(0.05, '#ffeb3b', 0.22, -0.23, -0.78);
flash.material.emissive = new THREE.Color('#ffeb3b');
Kit.camera.add(gun, flash);

let enemies;
let health;
let wave;
let fireTimer;
let hurtTimer;

function init(g) {
  Kit.ground(TUNING.arena * 2, '#9e9e9e', '#8a8a8a');
  const a = TUNING.arena;
  // Outer walls and some cover; solids block you and the enemies
  Kit.solid(Kit.box(a * 2, 3, 1, '#607d8b', 0, 0, -a));
  Kit.solid(Kit.box(a * 2, 3, 1, '#607d8b', 0, 0, a));
  Kit.solid(Kit.box(1, 3, a * 2, '#607d8b', -a, 0, 0));
  Kit.solid(Kit.box(1, 3, a * 2, '#607d8b', a, 0, 0));
  const cover = [[-8, -8], [8, -8], [-8, 8], [8, 8], [0, -14], [0, 14], [-14, 0], [14, 0]];
  for (const [x, z] of cover) Kit.solid(Kit.box(2, Kit.rand(1.2, 2.5), 2, '#8d6e63', x, 0, z));

  g.player = Kit.group(0, 0, 0);
  g.player.size = { w: 0.7, h: 1.8, d: 0.7 };
  g.player.vel = new THREE.Vector3();

  enemies = [];
  health = TUNING.health;
  wave = 0;
  fireTimer = 0;
  hurtTimer = 0;
  flash.visible = false;
  nextWave();
}

function nextWave() {
  wave += 1;
  const n = TUNING.firstWave + (wave - 1) * 2;
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 + Kit.rand(-0.3, 0.3);
    const e = Kit.model('assets/enemy.glb', Kit.shape.sphere(0.5, '#e53935'));
    e.position.set(Math.cos(angle) * (TUNING.arena - 3), 0, Math.sin(angle) * (TUNING.arena - 3));
    e.size = { w: 0.9, h: 0.9, d: 0.9 };
    e.vel = new THREE.Vector3();
    e.hp = TUNING.enemyHp;
    enemies.push(e);
  }
}

function update(g, dt) {
  const p = g.player;

  // WASD walks, arrows/Q/E or the mouse turn (handled by the kit's first-person camera)
  const dir = Kit.moveInput();
  p.vel.x = dir.x * TUNING.speed;
  p.vel.z = dir.z * TUNING.speed;
  if (Kit.pressed('jump') && p.onGround) p.vel.y = TUNING.jump;
  Kit.move(p, dt);

  // Shoot what is under the crosshair
  fireTimer -= dt;
  flash.visible = fireTimer > TUNING.fireDelay - 0.05;
  gun.position.z = -0.5 + Math.max(0, fireTimer - TUNING.fireDelay + 0.15);
  if ((Kit.pressed('action') || Kit.down('action')) && fireTimer <= 0) {
    fireTimer = TUNING.fireDelay;
    Kit.sfx('shoot');
    const target = Kit.aim(enemies);
    if (target) {
      target.hp -= 1;
      Kit.burst(target.hitPoint, '#ff7043', 8);
      if (target.hp <= 0) {
        Kit.remove(target);
        Kit.addScore(1);
        Kit.sfx('boom');
        Kit.burst(target.position, '#e53935');
      }
    }
  }
  enemies = enemies.filter((e) => e.hp > 0);
  if (enemies.length === 0) nextWave();

  // Enemies walk straight at you
  const speed = TUNING.enemySpeed + (wave - 1) * 0.3;
  for (const e of enemies) {
    const to = new THREE.Vector3(p.position.x - e.position.x, 0, p.position.z - e.position.z).normalize();
    e.vel.x = to.x * speed;
    e.vel.z = to.z * speed;
    Kit.move(e, dt);
    Kit.face(e, to, dt);
    e.position.y += Math.abs(Math.sin(g.time * 6 + e.id)) * 0.02;
  }

  hurtTimer -= dt;
  if (hurtTimer <= 0 && enemies.some((e) => Kit.near(p, e, 1.3))) {
    health -= TUNING.damage;
    hurtTimer = 0.8;
    Kit.sfx('hit');
    Kit.shake(0.25);
    if (health <= 0) { health = 0; Kit.gameOver(); }
  }

  Kit.hud(`Health ${health}   Wave ${wave}   Enemies ${enemies.length}`);
}

Kit.start({
  title: document.title,
  hint: 'WASD to move, mouse or arrows to look, click or Enter to shoot, Space to jump. Click to start',
  camera: 'first',
  sky: '#b0bec5',
  init,
  update,
  debug: () => ({ health, wave, enemies: enemies.length }),
});
