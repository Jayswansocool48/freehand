// Blank 3D game: a character that walks and jumps on a ground. Build any 3D game from here. Built on kit3d.js.
// init(g) builds the world for each round, update(g, dt) moves things. The hero is assets/player.glb:
// to change how it looks, make a new model with make_model at that path (no code change needed).
import { Kit, THREE } from './kit3d.js';

const TUNING = {
  speed: 6,          // walking speed (m/s)
  jump: 9,
};

// RECIPE TOP

function init(g) {
  Kit.ground(60, '#7cc46a');
  Kit.solid(Kit.box(2, 1, 2, '#8d9096', 5, 0, -5)); // something to jump on
  g.player = Kit.model('assets/player.glb', Kit.shape.box(0.8, 1.8, 0.8, '#3366ff'));
  g.player.size = { w: 0.8, h: 1.8, d: 0.8 };
  g.player.vel = new THREE.Vector3();
  // RECIPE INIT
}

function update(g, dt) {
  const p = g.player;
  const dir = Kit.moveInput();
  p.vel.x = dir.x * TUNING.speed;
  p.vel.z = dir.z * TUNING.speed;
  if (Kit.pressed('jump') && p.onGround) { p.vel.y = TUNING.jump; Kit.sfx('jump'); }
  Kit.move(p, dt);
  Kit.face(p, dir, dt);
  Kit.walk(p, p.onGround ? dir.length() : 0);
  // RECIPE UPDATE
}

Kit.start({
  title: document.title,
  hint: 'WASD or arrows to move, Space to jump. Press Space or click to start',
  camera: 'third',
  init,
  update,
  debug: (g) => ({ onGround: !!g.player.onGround }),
});
