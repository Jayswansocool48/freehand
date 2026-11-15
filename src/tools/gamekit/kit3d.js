/*
 * kit3d.js: a small, tested 3D game engine on three.js from Freehand's game kit.
 * game.js is a module that starts with:  import { Kit, THREE } from './kit3d.js';
 *
 *   Kit.start({ init, update, title, hint, camera, sky, debug })
 *     init(g)        build a round: the world and g.player. Runs on every start and restart; everything
 *                    made with Kit helpers is removed first, so build it all again here.
 *     update(g, dt)  move things; dt is in seconds. Kit.gameOver() (or Kit.gameOver('You win!')) ends the round.
 *     camera         'third'  behind and above g.player; Q/E or dragging the mouse turns it
 *                    'chase'  behind the way g.player faces (cars, planes, runners)
 *                    'first'  from g.player's eyes; the mouse looks (click locks it), arrows/Q/E turn
 *                    'top'    high above g.player, looking down
 *                    'fixed'  you place g.camera yourself
 *   g.player         set it in init. The camera follows it and play_test reports where it is.
 *
 * Every object stands on its position: y is the BOTTOM of the shape, so y = 0 sits on the ground.
 * Models face +z (make_model models do too).
 *   Kit.box(w, h, d, color, x, y, z)   Kit.sphere(r, color, x, y, z)   Kit.cylinder(r, h, color, x, y, z)
 *   Kit.cone(r, h, color, x, y, z)     Kit.gem(r, color, x, y, z)      Kit.ring(r, thick, color, x, y, z) (y = centre)
 *   Kit.group(x, y, z)   Kit.ground(size, color, color2)   Kit.add(obj)   Kit.remove(obj)
 *   Kit.model('assets/player.glb', fallback)  shows fallback (a shape) until the file loads; Kit.anim(obj, 'Run') plays an animation
 *   Kit.walk(obj, amount)  swings parts named leg/arm while moving (amount 0..1)
 *   Kit.face(obj, dir, dt) turns obj smoothly toward the direction {x, z}
 * Input: Kit.down('left') held, Kit.pressed('jump') this frame only. Actions: left right up down jump action run.
 *   Space = jump; click, Enter, F, X or Z = action. Kit.moveInput() = {x, z} from WASD/arrows, relative to the camera.
 * Physics: Kit.solid(obj, moving) makes obj a wall or platform. Kit.move(obj, dt, {gravity, floor}) moves obj by
 *   obj.vel (a THREE.Vector3), adds gravity, stops at solids and at the floor (y = 0; floor: null for none).
 *   After it: obj.onGround, obj.hitWall. obj.size = {w, h, d} sets the body size (default 0.8 x 1.7 x 0.8).
 * Kit.camera and Kit.scene are the three.js camera and scene (Kit.camera.add(gun) puts a gun in view).
 * Kit.hit(a, b) boxes touch   Kit.near(a, b, dist)   Kit.aim(list) first object in list under the screen centre
 * Kit.addScore(n), Kit.hud('Lives 3') (Kit.hud('Time 30', 'timer') adds a second line), Kit.sfx('jump' | 'coin' | 'hit' | 'boom' | 'power' | 'click' | 'shoot'),
 * Kit.burst(position, color), Kit.shake(amount), Kit.rand(a, b), Kit.clamp(v, lo, hi)
 *
 * The state is mirrored to window.__game (with the player's position) so play_test can report it.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

export { THREE };

const KEYS = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  Space: 'jump', Enter: 'action', KeyF: 'action', KeyX: 'action', KeyZ: 'action',
  ShiftLeft: 'run', ShiftRight: 'run', KeyQ: 'turnleft', KeyE: 'turnright',
};
const STEP = 1 / 60;
const held = new Set();
const codes = new Set();
let fresh = new Set();
let cfg = null;
let audio = null;
let shakeAmt = 0;
let particles = [];
const solids = [];
const mixers = new Set();
const models = new Map();

const g = { state: 'title', score: 0, best: 0, time: 0, player: null, yaw: 0, pitch: 0 };

/* ---------- renderer, scene, lights, camera (made once) ---------- */

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.style.display = 'block';
renderer.domElement.style.touchAction = 'none';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 400);
camera.rotation.order = 'YXZ';
scene.add(camera); // so things can be attached to it, like a first-person gun
const world = new THREE.Group();
g.scene = world; // models often write g.scene.add(obj): same as Kit.add, cleared each round
scene.add(world);
scene.add(new THREE.HemisphereLight('#ffffff', '#4a5a3a', 1.3));
const sun = new THREE.DirectionalLight('#ffffff', 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 120 });
scene.add(sun, sun.target);
g.scene = scene;
g.camera = camera;
g.world = world;

/* ---------- page: HUD and title / game-over overlay ---------- */

const css = `
html, body { margin: 0; height: 100%; overflow: hidden; background: #000; font-family: system-ui, sans-serif; }
#kit-score { position: fixed; top: 12px; left: 0; right: 0; text-align: center; color: #fff; font: bold 26px system-ui, sans-serif; text-shadow: 0 2px 4px #000; pointer-events: none; }
#kit-hud { position: fixed; top: 14px; left: 16px; color: #fff; font: bold 18px system-ui, sans-serif; text-shadow: 0 2px 4px #000; pointer-events: none; white-space: pre; }
#kit-cross { position: fixed; left: 50%; top: 50%; width: 18px; height: 18px; margin: -9px; pointer-events: none; display: none;
  background: linear-gradient(#fff, #fff) center / 2px 100% no-repeat, linear-gradient(#fff, #fff) center / 100% 2px no-repeat; mix-blend-mode: difference; }
#kit-overlay { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  background: rgba(0,0,0,0.45); color: #fff; text-align: center; cursor: pointer; user-select: none; }
#kit-overlay[hidden] { display: none; }
#kit-overlay h1 { margin: 0 0 6px; font-size: 44px; text-shadow: 0 3px 6px #000; }
#kit-overlay p { margin: 0; font-size: 18px; }
`;
function el(tag, id) { const e = document.createElement(tag); e.id = id; document.body.appendChild(e); return e; }

/* ---------- shapes ---------- */

function material(color, extra) {
  return new THREE.MeshStandardMaterial({ color: color || '#cccccc', roughness: 0.75, flatShading: true, ...extra });
}
function mesh(geo, color, x, y, z) {
  geo.userData.kit = true;
  const m = new THREE.Mesh(geo, material(color));
  m.castShadow = true;
  m.receiveShadow = true;
  m.position.set(x || 0, y || 0, z || 0);
  return m;
}
// Geometries are moved so their origin is the middle of the bottom: position.y is where the shape stands.
const make = {
  box: (w = 1, h = 1, d = 1, color, x, y, z) => mesh(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), color, x, y, z),
  sphere: (r = 0.5, color, x, y, z) => mesh(new THREE.SphereGeometry(r, 20, 14).translate(0, r, 0), color, x, y, z),
  cylinder: (r = 0.5, h = 1, color, x, y, z) => mesh(new THREE.CylinderGeometry(r, r, h, 20).translate(0, h / 2, 0), color, x, y, z),
  cone: (r = 0.5, h = 1, color, x, y, z) => mesh(new THREE.ConeGeometry(r, h, 16).translate(0, h / 2, 0), color, x, y, z),
  gem: (r = 0.4, color, x, y, z) => mesh(new THREE.OctahedronGeometry(r).translate(0, r, 0), color, x, y, z),
  ring: (r = 2, thick = 0.25, color, x, y, z) => mesh(new THREE.TorusGeometry(r, thick, 10, 32), color, x, y, z),
};

function add(obj) { world.add(obj); return obj; }
function remove(obj) {
  if (!obj) return;
  if (obj.parent) obj.parent.remove(obj);
  const i = solids.findIndex((s) => s.obj === obj);
  if (i >= 0) solids.splice(i, 1);
  mixers.delete(obj);
}

function ground(size = 80, color = '#7cc46a', color2) {
  if (Array.isArray(size)) size = Math.max(...size.map(Number).filter((n) => n > 0), 1); // Kit.ground([20, 20])
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = color;
  x.fillRect(0, 0, 64, 64);
  x.fillStyle = color2 || shade(color, -0.12);
  x.fillRect(0, 0, 32, 32);
  x.fillRect(32, 32, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(size / 4, size / 4);
  tex.magFilter = THREE.NearestFilter;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  m.geometry.userData.kit = true;
  m.rotation.x = -Math.PI / 2;
  m.receiveShadow = true;
  return add(m);
}
function shade(color, amount) {
  const c = new THREE.Color(color);
  const hsl = {};
  c.getHSL(hsl);
  return '#' + c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l + amount))).getHexString();
}

/* ---------- models ---------- */

const loader = new GLTFLoader();
function loadModel(url) {
  if (!models.has(url)) models.set(url, loader.loadAsync(url));
  return models.get(url);
}

function model(url, fallback) {
  const holder = new THREE.Group();
  if (typeof fallback === 'function') fallback = fallback(); // Kit.model(url, () => Kit.box(...))
  const fb = fallback && fallback.isObject3D ? fallback : make.box(0.8, 1.6, 0.8, '#ff00cc');
  // A fallback made with Kit.box(..., x, y, z) puts the model there, not at the origin
  holder.position.copy(fb.position);
  fb.position.set(0, 0, 0);
  holder.add(fb);
  add(holder);
  loadModel(url).then((gltf) => {
    const m = SkeletonUtils.clone(gltf.scene);
    m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    holder.remove(fb);
    holder.add(m);
    holder.model = m;
    if (gltf.animations.length) {
      holder.mixer = new THREE.AnimationMixer(m);
      holder.clips = gltf.animations;
      mixers.add(holder);
      anim(holder, holder.wantAnim || gltf.animations[0].name);
    }
  }).catch(() => console.warn(url + ' could not be loaded, showing a plain shape instead'));
  return holder;
}

function anim(obj, name) {
  obj.wantAnim = name;
  if (!obj.mixer || obj.playing === name) return;
  const clip = obj.clips.find((c) => c.name === name) || obj.clips.find((c) => c.name.toLowerCase().includes(String(name).toLowerCase()));
  if (!clip) return;
  const next = obj.mixer.clipAction(clip);
  if (obj.action && obj.action !== next) obj.action.fadeOut(0.2);
  next.reset().fadeIn(0.2).play();
  obj.action = next;
  obj.playing = name;
}

function walk(obj, amount) {
  if (!obj.limbs) {
    obj.limbs = [];
    obj.traverse((o) => {
      const n = (o.name || '').toLowerCase();
      if (/leg|arm/.test(n)) obj.limbs.push({ o, sign: (/_l\b|left|_l$/.test(n) ? 1 : -1) * (/arm/.test(n) ? -1 : 1), base: o.rotation.x });
    });
    if (!obj.limbs.length && !obj.model) obj.limbs = null; // the model may still be loading; look again next time
  }
  obj.stride = (obj.stride || 0) + (amount || 0) * 0.25;
  for (const l of obj.limbs || []) l.o.rotation.x = l.base + Math.sin(obj.stride) * 0.7 * Math.min(1, amount || 0) * l.sign;
}

function face(obj, dir, dt) {
  if (!dir || (Math.abs(dir.x) < 1e-3 && Math.abs(dir.z) < 1e-3)) return;
  const want = Math.atan2(dir.x, dir.z);
  let diff = want - obj.rotation.y;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  obj.rotation.y += diff * Math.min(1, (dt || STEP) * 12);
}

/* ---------- physics ---------- */

const tmpBox = new THREE.Box3();
function solid(obj, moving = false) {
  obj.updateWorldMatrix(true, true);
  const s = { obj, moving, box: new THREE.Box3().setFromObject(obj), last: obj.position.clone(), delta: new THREE.Vector3() };
  solids.push(s);
  return obj;
}
function refreshSolids() {
  for (const s of solids) {
    if (!s.moving) continue;
    s.obj.updateWorldMatrix(true, true);
    s.box.setFromObject(s.obj);
    s.delta.subVectors(s.obj.position, s.last);
    s.last.copy(s.obj.position);
  }
}
function bodyOverlaps(obj, b) {
  const p = obj.position;
  const z = obj.size;
  const e = 0.001;
  return p.x + z.w / 2 > b.min.x + e && p.x - z.w / 2 < b.max.x - e &&
    p.y + z.h > b.min.y + e && p.y < b.max.y - e &&
    p.z + z.d / 2 > b.min.z + e && p.z - z.d / 2 < b.max.z - e;
}

function move(obj, dt, opts = {}) {
  if (!obj.vel) obj.vel = new THREE.Vector3();
  if (!obj.size) obj.size = { w: 0.8, h: 1.7, d: 0.8 };
  const gravity = opts.gravity == null ? 25 : opts.gravity;
  const floor = 'floor' in opts ? opts.floor : 0;
  if (obj.onGround && obj.standingOn && obj.standingOn.moving) obj.position.add(obj.standingOn.delta); // ride moving platforms
  obj.vel.y -= gravity * dt;
  obj.onGround = false;
  obj.hitWall = false;
  obj.standingOn = null;
  for (const axis of ['x', 'z', 'y']) {
    const step = obj.vel[axis] * dt;
    if (!step) continue;
    obj.position[axis] += step;
    for (const s of solids) {
      if (s.obj === obj || !bodyOverlaps(obj, s.box)) continue;
      const b = s.box;
      if (axis === 'y') {
        if (step < 0) { obj.position.y = b.max.y; obj.onGround = true; obj.standingOn = s; } else obj.position.y = b.min.y - obj.size.h;
        obj.vel.y = 0;
      } else if (b.max.y - obj.position.y <= 0.35) {
        obj.position.y = b.max.y; // a low step: walk up onto it
      } else {
        const half = axis === 'x' ? obj.size.w / 2 : obj.size.d / 2;
        obj.position[axis] = step > 0 ? b.min[axis] - half - 0.002 : b.max[axis] + half + 0.002;
        obj.vel[axis] = 0;
        obj.hitWall = true;
      }
    }
  }
  if (floor != null && obj.position.y <= floor) {
    obj.position.y = floor;
    if (obj.vel.y < 0) obj.vel.y = 0;
    obj.onGround = true;
  }
  return obj;
}

const boxA = new THREE.Box3();
const boxB = new THREE.Box3();
function hit(a, b, pad = 0) {
  if (!a || !b || !a.parent || !b.parent) return false;
  boxA.setFromObject(a).expandByScalar(-pad);
  boxB.setFromObject(b);
  return boxA.intersectsBox(boxB);
}
function near(a, b, dist) {
  return !!a && !!b && a.position.distanceTo(b.position) < dist;
}

const ray = new THREE.Raycaster();
const centre = new THREE.Vector2(0, 0);
function aim(list, maxDist = 200) {
  ray.setFromCamera(centre, camera);
  ray.far = maxDist;
  const hits = ray.intersectObjects(list.filter((o) => o && o.parent), true);
  if (!hits.length) return null;
  let o = hits[0].object;
  while (o && !list.includes(o)) o = o.parent;
  if (o) o.hitPoint = hits[0].point.clone();
  return o || null;
}

/* ---------- input ---------- */

function press(name) {
  if (!held.has(name)) fresh.add(name);
  held.add(name);
}
function onStartInput() {
  if (g.state === 'title' || (g.state === 'over' && g.time - g.overAt > 0.6)) { begin(); return true; }
  return false;
}
function lockMouse() {
  if (cfg.camera !== 'first' || document.pointerLockElement) return;
  try { const p = renderer.domElement.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not allowed here */ }
}

function moveInput() {
  let f = (held.has('up') ? 1 : 0) - (held.has('down') ? 1 : 0);
  let s;
  if (cfg.camera === 'first') s = (codes.has('KeyD') ? 1 : 0) - (codes.has('KeyA') ? 1 : 0); // arrows turn instead
  else s = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
  const len = Math.hypot(f, s) || 1;
  f /= len; s /= len;
  const sin = Math.sin(g.yaw);
  const cos = Math.cos(g.yaw);
  // forward is where the camera looks (-z at yaw 0); right is 90 degrees clockwise from it
  return new THREE.Vector3(-sin * f + cos * s, 0, -cos * f - sin * s);
}

function attachInput() {
  window.addEventListener('keydown', (e) => {
    codes.add(e.code);
    const name = KEYS[e.code];
    if (!name) return;
    e.preventDefault();
    if (e.repeat) return;
    if ((name === 'jump' || name === 'action') && onStartInput()) return;
    press(name);
  });
  window.addEventListener('keyup', (e) => {
    codes.delete(e.code);
    const name = KEYS[e.code];
    if (name) held.delete(name);
  });
  overlay.addEventListener('pointerdown', (e) => { e.preventDefault(); unlockAudio(); if (onStartInput()) lockMouse(); });
  renderer.domElement.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    unlockAudio();
    if (onStartInput()) { lockMouse(); return; }
    lockMouse();
    press('action');
  });
  window.addEventListener('pointerup', () => held.delete('action'));
  window.addEventListener('mousemove', (e) => {
    if (g.state !== 'play' || (!document.pointerLockElement && !e.buttons)) return;
    g.yaw -= e.movementX * 0.003;
    if (cfg.camera === 'first') g.pitch = Kit.clamp(g.pitch - e.movementY * 0.003, -1.3, 1.3);
  });
  window.addEventListener('blur', () => { held.clear(); codes.clear(); });
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

/* ---------- rounds ---------- */

function clearWorld() {
  for (const o of [...world.children]) {
    world.remove(o);
    o.traverse((c) => {
      if (c.geometry && c.geometry.userData.kit) c.geometry.dispose();
      if (c.material && c.geometry && c.geometry.userData.kit) [].concat(c.material).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
    });
  }
  solids.length = 0;
  mixers.clear();
  particles = [];
}

function build() {
  clearWorld();
  g.player = null;
  g.yaw = cfg.yaw || 0;
  g.pitch = 0;
  hudLines = {};
  cfg.init(g);
  placeCamera(1);
}

function begin() {
  unlockAudio();
  g.state = 'play';
  g.score = 0;
  g.time = 0;
  held.clear();
  fresh = new Set();
  build();
  overlay.hidden = true;
  sfx('click');
}

function gameOver(title) {
  if (g.state !== 'play') return;
  g.state = 'over';
  g.overTitle = title || 'Game over';
  g.overAt = g.time;
  if (g.score > g.best) { g.best = g.score; try { localStorage.setItem('kit3d-best:' + document.title, String(g.best)); } catch (e) { /* storage blocked */ } }
  sfx(/win|clear|finish/i.test(g.overTitle) ? 'power' : 'hit');
  shake(0.4);
  showOverlay(g.overTitle, `Score ${g.score}   Best ${g.best}`, 'Press Space or click to play again');
  if (document.pointerLockElement) document.exitPointerLock();
}

function showOverlay(title, line1, line2) {
  overlay.innerHTML = '';
  const h = document.createElement('h1');
  h.textContent = title;
  overlay.appendChild(h);
  for (const t of [line1, line2]) {
    if (!t) continue;
    const p = document.createElement('p');
    p.textContent = t;
    overlay.appendChild(p);
  }
  overlay.hidden = false;
}

/* ---------- camera ---------- */

const camGoal = new THREE.Vector3();
const lookGoal = new THREE.Vector3();
const lookAt = new THREE.Vector3();
function placeCamera(t) {
  const p = g.player;
  const mode = cfg.camera || 'third';
  if (mode === 'fixed' || !p) return;
  const dist = cfg.distance || (mode === 'chase' ? 7 : 8);
  const height = cfg.height || (mode === 'top' ? 22 : 4);
  if (mode === 'first') {
    camera.position.set(p.position.x, p.position.y + (cfg.eye || 1.6), p.position.z);
    camera.rotation.set(g.pitch, g.yaw, 0);
    p.rotation.y = g.yaw + Math.PI; // the player faces where the camera looks (models face +z)
  } else {
    if (mode === 'third') camGoal.set(Math.sin(g.yaw) * dist, height, Math.cos(g.yaw) * dist);
    else if (mode === 'chase') camGoal.set(-Math.sin(p.rotation.y) * dist, height, -Math.cos(p.rotation.y) * dist);
    else camGoal.set(0, height, height * 0.35);
    camGoal.add(p.position);
    lookGoal.copy(p.position).y += mode === 'top' ? 0 : 1.2;
    camera.position.lerp(camGoal, t);
    lookAt.lerp(lookGoal, Math.min(1, t * 2));
    camera.lookAt(lookAt);
  }
  if (shakeAmt > 0.01) {
    camera.position.x += Kit.rand(-shakeAmt, shakeAmt);
    camera.position.y += Kit.rand(-shakeAmt, shakeAmt);
    shakeAmt *= 0.88;
  }
  sun.position.set(p.position.x + 15, p.position.y + 30, p.position.z + 10);
  sun.target.position.copy(p.position);
}

/* ---------- effects ---------- */

const bitGeo = new THREE.BoxGeometry(0.15, 0.15, 0.15);
function burst(pos, color = '#ffffff', n = 14) {
  const mat = new THREE.MeshBasicMaterial({ color });
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(bitGeo, mat);
    m.position.copy(pos);
    m.position.y += 0.5;
    world.add(m);
    particles.push({ m, v: new THREE.Vector3(Kit.rand(-4, 4), Kit.rand(2, 7), Kit.rand(-4, 4)), life: 0.7 });
  }
}
function shake(amount = 0.3) { shakeAmt = Math.max(shakeAmt, amount); }

function unlockAudio() {
  if (audio) { if (audio.state === 'suspended') audio.resume(); return; }
  try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
}
const SOUNDS = {
  jump: [['square', 300, 600, 0.12, 0.12]],
  coin: [['square', 880, 880, 0.06, 0.1], ['square', 1320, 1320, 0.12, 0.1, 0.06]],
  hit: [['sawtooth', 220, 60, 0.3, 0.18]],
  boom: [['noise', 0, 0, 0.4, 0.25]],
  power: [['triangle', 300, 1200, 0.35, 0.16]],
  click: [['sine', 660, 660, 0.05, 0.08]],
  shoot: [['noise', 0, 0, 0.08, 0.2], ['square', 900, 200, 0.08, 0.06]],
};
function sfx(name) {
  if (!audio || audio.state !== 'running') return;
  for (const [type, f1, f2, dur, vol, delay] of SOUNDS[name] || []) {
    const t = audio.currentTime + (delay || 0);
    const gain = audio.createGain();
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    gain.connect(audio.destination);
    let src;
    if (type === 'noise') {
      const buf = audio.createBuffer(1, Math.ceil(audio.sampleRate * dur), audio.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      src = audio.createBufferSource();
      src.buffer = buf;
    } else {
      src = audio.createOscillator();
      src.type = type;
      src.frequency.setValueAtTime(f1, t);
      src.frequency.exponentialRampToValueAtTime(f2, t + dur);
    }
    src.connect(gain);
    src.start(t);
    src.stop(t + dur);
  }
}

/* ---------- loop ---------- */

let overlay;
let scoreEl;
let hudEl;
let hudLines = {};
let acc = 0;
const clock = new THREE.Clock();

function frame() {
  const dt = Math.min(0.1, clock.getDelta());
  acc += dt;
  let steps = 0;
  while (acc >= STEP && steps < 6) {
    g.time += STEP;
    if (g.state === 'play') {
      refreshSolids();
      if (cfg.camera === 'first' || cfg.camera === 'third') {
        const turn = (held.has('turnleft') ? 1 : 0) - (held.has('turnright') ? 1 : 0) +
          (cfg.camera === 'first' ? (codes.has('ArrowLeft') ? 1 : 0) - (codes.has('ArrowRight') ? 1 : 0) : 0);
        g.yaw += turn * 2.2 * STEP;
      }
      cfg.update(g, STEP);
    }
    for (const m of mixers) m.mixer.update(STEP);
    for (const p of particles) { p.v.y -= 15 * STEP; p.m.position.addScaledVector(p.v, STEP); p.life -= STEP; p.m.scale.setScalar(Math.max(0.01, p.life / 0.7)); }
    particles = particles.filter((p) => { if (p.life > 0) return true; world.remove(p.m); return false; });
    fresh.clear();
    acc -= STEP;
    steps++;
  }
  if (steps === 6) acc = 0;
  placeCamera(1 - Math.exp(-dt * 8));
  scoreEl.textContent = g.state === 'play' ? 'Score ' + g.score : '';
  hudEl.textContent = g.state === 'play' ? Object.values(hudLines).filter(Boolean).join('\n') : '';
  renderer.render(scene, camera);
  publish();
}

function publish() {
  const s = { state: g.state, score: g.score, best: g.best, time: Math.round((g.state === 'over' ? g.overAt : g.time) * 10) / 10 };
  if (g.player) {
    const p = g.player.position;
    s.player = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 };
  }
  if (cfg.debug) { try { Object.assign(s, cfg.debug(g)); } catch (e) { /* debug is optional */ } }
  window.__game = s;
}

/* ---------- the API ---------- */

export const Kit = {
  start(options) {
    cfg = options;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    document.body.appendChild(renderer.domElement);
    scoreEl = el('div', 'kit-score');
    hudEl = el('div', 'kit-hud');
    el('div', 'kit-cross').style.display = cfg.camera === 'first' ? 'block' : 'none';
    overlay = el('div', 'kit-overlay');
    const sky = new THREE.Color(cfg.sky || '#9fd3f5');
    scene.background = sky;
    scene.fog = cfg.fog === false ? null : new THREE.Fog(sky, (cfg.fog && cfg.fog[0]) || 45, (cfg.fog && cfg.fog[1]) || 140);
    try { g.best = Number(localStorage.getItem('kit3d-best:' + document.title)) || 0; } catch (e) { g.best = 0; }
    attachInput();
    build(); // so the title screen has the world behind it
    g.state = 'title';
    showOverlay(cfg.title || document.title, cfg.hint || 'Press Space or click to start', g.best ? 'Best ' + g.best : '');
    renderer.setAnimationLoop(frame);
    return g;
  },
  box: (...a) => add(make.box(...a)),
  sphere: (...a) => add(make.sphere(...a)),
  cylinder: (...a) => add(make.cylinder(...a)),
  cone: (...a) => add(make.cone(...a)),
  gem: (...a) => add(make.gem(...a)),
  ring: (...a) => add(make.ring(...a)),
  shape: make, // the same shapes without adding them to the world, e.g. as a Kit.model fallback
  group(x, y, z) { const o = new THREE.Group(); o.position.set(x || 0, y || 0, z || 0); return add(o); },
  camera, scene,
  ground, add, remove, model, anim, walk, face, solid, move, hit, near, aim, moveInput, burst, shake, sfx, gameOver,
  hud(text, line = 'main') { hudLines[line] = String(text); },
  down: (name) => held.has(name),
  pressed: (name) => fresh.has(name),
  addScore(n) { g.score += n == null ? 1 : n; },
  rand: (a, b) => a + Math.random() * (b - a),
  clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
};
window.Kit = Kit;
window.THREE = THREE;
