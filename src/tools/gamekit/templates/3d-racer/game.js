// 3D racing: drive round the track through every checkpoint, 3 laps against the clock. Grass slows you down,
// cones knock your speed. Built on kit3d.js. Tune the car in TUNING. The car is assets/player.glb:
// to change how it looks, make a new model with make_model at that path (no code change needed).
import { Kit, THREE } from './kit3d.js';

const TUNING = {
  maxSpeed: 26,      // m/s on the road
  accel: 14,
  brake: 24,
  drag: 4,           // slowing down when no pedal is pressed
  steer: 2.2,        // turning speed at full speed
  grassSpeed: 0.45,  // top speed on grass, as a share of maxSpeed
  laps: 3,
  radius: 40,        // the track is a ring this far from the middle
  width: 12,
  cones: 14,
};

const CHECKPOINTS = 4; // gates spaced evenly round the ring; gate 0 is the start and finish line
let speed;
let lap;
let next;
let cones;

function gate(angle, i) {
  const x = Math.cos(angle) * TUNING.radius;
  const z = Math.sin(angle) * TUNING.radius;
  const g = Kit.group(x, 0, z);
  g.rotation.y = -angle;
  const color = i === 0 ? '#ffffff' : '#ff7043';
  const l = Kit.box(0.5, 4, 0.5, color, -TUNING.width / 2 - 0.5, 0, 0);
  const r = Kit.box(0.5, 4, 0.5, color, TUNING.width / 2 + 0.5, 0, 0);
  const top = Kit.box(TUNING.width + 1.5, 0.6, 0.5, i === 0 ? '#212121' : color, 0, 4, 0);
  g.add(l, r, top);
  return g;
}

function init(g) {
  Kit.ground(240, '#6ab04c');
  const road = Kit.add(new THREE.Mesh(
    new THREE.RingGeometry(TUNING.radius - TUNING.width / 2, TUNING.radius + TUNING.width / 2, 96),
    new THREE.MeshStandardMaterial({ color: '#555b61', roughness: 0.9 }),
  ));
  road.rotation.x = -Math.PI / 2;
  road.position.y = 0.02;
  road.receiveShadow = true;
  for (let i = 0; i < CHECKPOINTS; i++) gate((i / CHECKPOINTS) * Math.PI * 2, i);
  for (let i = 0; i < 40; i++) {
    const a = Kit.rand(0, Math.PI * 2);
    const r = Kit.rand(0, 1) < 0.5 ? Kit.rand(5, TUNING.radius - TUNING.width) : Kit.rand(TUNING.radius + TUNING.width, 100);
    Kit.cylinder(0.3, 1.2, '#8b5a2b', Math.cos(a) * r, 0, Math.sin(a) * r);
    Kit.cone(1.4, 3, '#2e7d32', Math.cos(a) * r, 1, Math.sin(a) * r);
  }
  cones = [];
  for (let i = 0; i < TUNING.cones; i++) {
    const a = 0.3 + (i / TUNING.cones) * Math.PI * 1.9;
    const r = TUNING.radius + Kit.rand(-TUNING.width / 2 + 1, TUNING.width / 2 - 1);
    cones.push(Kit.cone(0.35, 0.8, '#ff9800', Math.cos(a) * r, 0, Math.sin(a) * r));
  }

  g.player = Kit.model('assets/player.glb', Kit.shape.box(1, 0.7, 1.6, '#3366ff'));
  g.player.position.set(TUNING.radius, 0, -3);
  g.player.rotation.y = 0; // facing +z, the way the race goes
  speed = 0;
  lap = 1;
  next = 1;
}

function update(g, dt) {
  const p = g.player;
  const fromMiddle = Math.hypot(p.position.x, p.position.z);
  const onRoad = Math.abs(fromMiddle - TUNING.radius) < TUNING.width / 2;
  const top = TUNING.maxSpeed * (onRoad ? 1 : TUNING.grassSpeed);

  // Pedals and steering
  if (Kit.down('up')) speed += TUNING.accel * dt;
  else if (Kit.down('down')) speed -= TUNING.brake * dt;
  else speed -= Math.sign(speed) * Math.min(Math.abs(speed), TUNING.drag * dt);
  if (speed > top) speed = Math.max(top, speed - TUNING.brake * dt);
  speed = Kit.clamp(speed, -8, TUNING.maxSpeed);
  const turn = (Kit.down('left') ? 1 : 0) - (Kit.down('right') ? 1 : 0);
  p.rotation.y += turn * TUNING.steer * dt * Kit.clamp(speed / 10, -1, 1);
  p.position.x += Math.sin(p.rotation.y) * speed * dt;
  p.position.z += Math.cos(p.rotation.y) * speed * dt;
  p.rotation.z = -turn * Math.min(1, Math.abs(speed) / TUNING.maxSpeed) * 0.06; // lean in the turns

  // Checkpoints in order; crossing the start line after all of them is a lap
  const angle = (Math.atan2(p.position.z, p.position.x) + Math.PI * 2) % (Math.PI * 2);
  const want = (next / CHECKPOINTS) * Math.PI * 2;
  const gap = Math.abs(Math.atan2(Math.sin(angle - want), Math.cos(angle - want)));
  if (gap < 0.08 && onRoad) {
    Kit.addScore(1);
    Kit.sfx('coin');
    if (next === 0) {
      if (lap === TUNING.laps) { Kit.gameOver(`Finished in ${g.time.toFixed(1)} s`); return; }
      lap += 1;
      Kit.sfx('power');
    }
    next = (next + 1) % CHECKPOINTS;
  }

  for (const c of cones) {
    if (!c.hit && Kit.near(p, c, 1.3)) {
      c.hit = true;
      speed *= 0.5;
      Kit.sfx('hit');
      Kit.burst(c.position, '#ff9800', 8);
      Kit.remove(c);
    }
  }
  cones = cones.filter((c) => !c.hit);

  Kit.hud(`Lap ${lap}/${TUNING.laps}   Time ${g.time.toFixed(1)}   ${Math.round(Math.abs(speed) * 3.6)} km/h${onRoad ? '' : '   GRASS'}`);
}

Kit.start({
  title: document.title,
  hint: 'Up/W to drive, Down/S to brake, Left/Right to steer. Press Space or click to start',
  camera: 'chase',
  distance: 8,
  height: 3.5,
  init,
  update,
  debug: () => ({ lap, nextCheckpoint: next, speed: Math.round(speed) }),
});
