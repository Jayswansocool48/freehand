// 3D flying: the plane flies forward on its own. Arrows or WASD steer it up, down, left and right.
// Fly through the rings for points and dodge the floating rocks. Built on kit3d.js.
// Tune the numbers in TUNING. The plane is assets/player.glb: to change how it looks,
// make a new model with make_model at that path (no code change needed).
import { Kit, THREE } from './kit3d.js';

const TUNING = {
  speed: 18,         // forward speed at the start (m/s)
  speedUp: 0.3,      // extra speed per second
  steer: 9,          // sideways and up/down speed (m/s)
  width: 10,         // how far left/right the plane may go (m)
  low: 2,            // lowest and highest the plane may fly
  high: 14,
  ringGap: 30,       // distance between rings (m)
  ringRadius: 2.6,
  rocksPerRing: 2,
  lives: 3,
};

let rings;
let rocks;
let ground;
let lives;
let speed;
let nextZ;
let hurtTimer;

function addRing(z) {
  const r = Kit.ring(TUNING.ringRadius, 0.25, '#ffca28', Kit.rand(-TUNING.width + 3, TUNING.width - 3), Kit.rand(TUNING.low + 2, TUNING.high - 2), z);
  r.material.emissive = new THREE.Color('#7a5c00');
  rings.push(r);
  for (let i = 0; i < TUNING.rocksPerRing; i++) {
    const rock = Kit.box(Kit.rand(1.5, 3), Kit.rand(1.5, 3), Kit.rand(1.5, 3), '#795548',
      Kit.rand(-TUNING.width, TUNING.width), Kit.rand(TUNING.low, TUNING.high), z - Kit.rand(8, TUNING.ringGap - 8));
    rock.rotation.set(Kit.rand(0, 3), Kit.rand(0, 3), 0);
    rock.spin = Kit.rand(-1, 1);
    rocks.push(rock);
  }
}

function init(g) {
  ground = Kit.ground(300, '#4caf50', '#43a047');
  for (let i = 0; i < 25; i++) Kit.box(Kit.rand(4, 9), 1.2, Kit.rand(3, 6), '#ffffff', Kit.rand(-60, 60), Kit.rand(18, 30), Kit.rand(-250, 0));
  g.player = Kit.model('assets/player.glb', Kit.shape.box(1.2, 0.6, 2, '#e74c3c'));
  g.player.position.set(0, 6, 0);
  g.player.rotation.y = Math.PI; // fly toward -z, away from the camera
  rings = [];
  rocks = [];
  nextZ = -40;
  for (let i = 0; i < 5; i++) { addRing(nextZ); nextZ -= TUNING.ringGap; }
  lives = TUNING.lives;
  speed = TUNING.speed;
  hurtTimer = 0;
}

function update(g, dt) {
  const p = g.player;
  speed += TUNING.speedUp * dt;
  const sx = (Kit.down('right') ? 1 : 0) - (Kit.down('left') ? 1 : 0);
  const sy = (Kit.down('up') ? 1 : 0) - (Kit.down('down') ? 1 : 0);
  p.position.x = Kit.clamp(p.position.x + sx * TUNING.steer * dt, -TUNING.width, TUNING.width);
  p.position.y = Kit.clamp(p.position.y + sy * TUNING.steer * dt, TUNING.low, TUNING.high);
  p.position.z -= speed * dt;
  p.rotation.z += (sx * 0.5 - p.rotation.z) * Math.min(1, dt * 6); // bank into turns
  p.rotation.x += (-sy * 0.3 - p.rotation.x) * Math.min(1, dt * 6);
  ground.position.z = Math.round(p.position.z / 8) * 8;

  while (nextZ > p.position.z - 160) { addRing(nextZ); nextZ -= TUNING.ringGap; }

  // A ring scores when the plane passes through its middle
  for (const r of rings) {
    if (!r.passed && p.position.z < r.position.z) {
      r.passed = true;
      const off = Math.hypot(p.position.x - r.position.x, p.position.y + 0.5 - r.position.y);
      if (off < TUNING.ringRadius) {
        Kit.addScore(1);
        Kit.sfx('coin');
        r.material.color.set('#66bb6a');
        Kit.burst(r.position, '#ffca28');
      }
    }
  }

  hurtTimer -= dt;
  for (const rock of rocks) {
    rock.rotation.y += rock.spin * dt;
    if (hurtTimer <= 0 && Kit.hit(p, rock, 0.3)) {
      lives -= 1;
      hurtTimer = 1.5;
      Kit.sfx('boom');
      Kit.shake(0.5);
      Kit.burst(p.position, '#ff7043');
      if (lives <= 0) Kit.gameOver();
    }
  }
  p.visible = hurtTimer <= 0 || Math.floor(g.time * 10) % 2 === 0;

  // Forget things that are far behind
  for (const list of [rings, rocks]) for (const o of list) if (o.position.z > p.position.z + 20) { o.gone = true; Kit.remove(o); }
  rings = rings.filter((o) => !o.gone);
  rocks = rocks.filter((o) => !o.gone);

  Kit.hud(`Lives ${lives}   Speed ${Math.round(speed * 3.6)} km/h`);
}

Kit.start({
  title: document.title,
  hint: 'Arrows or WASD to steer, fly through the rings, dodge the rocks. Press Space or click to start',
  camera: 'chase',
  distance: 9,
  height: 2.5,
  sky: '#81d4fa',
  fog: [60, 180],
  init,
  update,
  debug: () => ({ lives, rings: rings.length, speed: Math.round(speed) }),
});
