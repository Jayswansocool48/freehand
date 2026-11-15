// 3D endless runner: the hero runs on its own down three lanes. Left/Right switch lanes, Space jumps.
// Jump the low barriers, dodge the walls, grab coins; it gets faster. Built on kit3d.js.
// Tune the numbers in TUNING. The hero is assets/player.glb: to change how it looks,
// make a new model with make_model at that path (no code change needed).
import { Kit, THREE } from './kit3d.js';

const TUNING = {
  speed: 12,         // running speed at the start (m/s)
  speedUp: 0.25,     // extra speed per second
  maxSpeed: 30,
  lane: 2.5,         // distance between lanes (m)
  laneSpeed: 14,     // how fast the hero slides to a new lane
  jump: 9,
  gravity: 26,
  rowGap: 18,        // distance between rows of obstacles (m)
};

let lane;
let rows;
let things;
let ground;
let lines;
let speed;
let nextRow;

function addRow(z) {
  // One or two lanes get an obstacle; at least one lane always stays open.
  const blocked = [-1, 0, 1].sort(() => Math.random() - 0.5).slice(0, Math.random() < 0.6 ? 1 : 2);
  for (const l of [-1, 0, 1]) {
    const x = l * TUNING.lane;
    if (blocked.includes(l)) {
      const tall = Math.random() < 0.4;
      const o = tall ? Kit.box(2, 2.6, 0.6, '#c62828', x, 0, z) : Kit.box(2, 0.8, 0.6, '#ffb300', x, 0, z);
      o.kind = 'obstacle';
      things.push(o);
    } else if (Math.random() < 0.7) {
      for (let i = 0; i < 3; i++) {
        const c = Kit.cylinder(0.3, 0.08, '#ffd54f', x, 0.8, z + i * 2);
        c.rotation.z = Math.PI / 2;
        c.kind = 'coin';
        things.push(c);
      }
    }
  }
  // Scenery on both sides
  for (const side of [-1, 1]) {
    const h = Kit.rand(3, 9);
    const b = Kit.box(4, h, 6, Math.random() < 0.5 ? '#90a4ae' : '#b0bec5', side * Kit.rand(9, 14), 0, z);
    b.kind = 'scenery';
    things.push(b);
  }
}

function init(g) {
  ground = Kit.ground(200, '#78909c', '#6b7f89');
  lines = [-0.5, 0.5].map((x) => Kit.box(0.12, 0.02, 200, '#eceff1', x * TUNING.lane, 0, 0));
  g.player = Kit.model('assets/player.glb', Kit.shape.box(0.8, 1.8, 0.8, '#3366ff'));
  g.player.size = { w: 0.8, h: 1.8, d: 0.8 };
  g.player.vel = new THREE.Vector3();
  g.player.rotation.y = Math.PI; // run toward -z, away from the camera
  lane = 0;
  speed = TUNING.speed;
  things = [];
  rows = 0;
  nextRow = -45;
  for (let i = 0; i < 6; i++) { addRow(nextRow); nextRow -= TUNING.rowGap; }
}

function update(g, dt) {
  const p = g.player;
  speed = Math.min(TUNING.maxSpeed, speed + TUNING.speedUp * dt);

  if (Kit.pressed('left') && lane > -1) { lane -= 1; Kit.sfx('click'); }
  if (Kit.pressed('right') && lane < 1) { lane += 1; Kit.sfx('click'); }
  if ((Kit.pressed('jump') || Kit.pressed('up')) && p.onGround) { p.vel.y = TUNING.jump; Kit.sfx('jump'); }

  // Forward speed and the slide toward the chosen lane
  p.vel.z = -speed;
  p.vel.x = (lane * TUNING.lane - p.position.x) * TUNING.laneSpeed * 0.6;
  Kit.move(p, dt, { gravity: TUNING.gravity });
  p.rotation.z = Kit.clamp(-p.vel.x * 0.03, -0.25, 0.25);
  Kit.walk(p, p.onGround ? 1.6 : 0);

  // The ground moves with the hero in whole checker squares, so it looks endless
  ground.position.z = Math.round(p.position.z / 4) * 4;
  for (const l of lines) l.position.z = ground.position.z;

  // New rows ahead, old ones removed behind
  while (nextRow > p.position.z - 110) { addRow(nextRow); nextRow -= TUNING.rowGap; }
  for (const t of things) {
    if (t.position.z > p.position.z + 10) { t.gone = true; Kit.remove(t); continue; }
    if (t.kind === 'coin') {
      t.rotation.y += dt * 4;
      if (Kit.near(p, t, 1.2)) { t.gone = true; Kit.remove(t); Kit.addScore(1); Kit.sfx('coin'); }
    } else if (t.kind === 'obstacle' && Kit.hit(p, t, 0.15)) {
      Kit.burst(p.position, '#ff7043');
      Kit.gameOver();
    }
  }
  things = things.filter((t) => !t.gone);

  Kit.hud(`Distance ${Math.round(-p.position.z)} m   Speed ${Math.round(speed * 3.6)} km/h`);
}

Kit.start({
  title: document.title,
  hint: 'Left/Right or A/D to switch lanes, Space or Up to jump. Press Space or click to start',
  camera: 'chase',
  distance: 7,
  height: 3.5,
  sky: '#ffcc80',
  init,
  update,
  debug: (g) => ({ lane, speed: Math.round(speed), onGround: !!g.player.onGround }),
});
