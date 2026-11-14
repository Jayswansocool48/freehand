// 3D starter: drive a player around, collect orbs, models load from assets/ with a box fallback.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TUNING = { speed: 6, turn: 2.6, orbs: 8, arena: 18 };

const hud = document.getElementById('hud');
const overlay = document.getElementById('overlay');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#9fd3f5');
scene.fog = new THREE.Fog('#9fd3f5', 30, 70);
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);

scene.add(new THREE.HemisphereLight('#ffffff', '#557755', 1.2));
const sun = new THREE.DirectionalLight('#ffffff', 2);
sun.position.set(10, 20, 8);
sun.castShadow = true;
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(TUNING.arena * 2, TUNING.arena * 2), new THREE.MeshStandardMaterial({ color: '#7cc46a' }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// The player is a box until a model loads. Replace 'assets/player.glb' with a make_model file.
const player = new THREE.Group();
const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1.4), new THREE.MeshStandardMaterial({ color: '#3366ff' }));
box.position.y = 0.5;
box.castShadow = true;
player.add(box);
scene.add(player);
new GLTFLoader().load(
  'assets/player.glb',
  (gltf) => { player.remove(box); player.add(gltf.scene); },
  undefined,
  () => console.warn('assets/player.glb not found, using a box for the player'),
);

const orbs = [];
const orbGeo = new THREE.SphereGeometry(0.4, 16, 12);
const orbMat = new THREE.MeshStandardMaterial({ color: '#ffd23f', emissive: '#aa7700' });

const keys = new Set();
const game = { state: 'title', score: 0, time: 0 };
window.__game = game;

function placeOrbs() {
  for (const o of orbs) scene.remove(o);
  orbs.length = 0;
  for (let i = 0; i < TUNING.orbs; i++) {
    const o = new THREE.Mesh(orbGeo, orbMat);
    do o.position.set((Math.random() * 2 - 1) * (TUNING.arena - 2), 0.6, (Math.random() * 2 - 1) * (TUNING.arena - 2));
    while (o.position.distanceTo(player.position) < 4);
    orbs.push(o);
    scene.add(o);
  }
}

function start() {
  game.state = 'play';
  game.score = 0;
  game.time = 0;
  player.position.set(0, 0, 0);
  player.rotation.y = 0;
  placeOrbs();
  overlay.hidden = true;
}

function win() {
  game.state = 'over';
  overlay.innerHTML = `<h1>All orbs collected!</h1><p>Time ${game.time.toFixed(1)} s. Press Space or click to play again.</p>`;
  overlay.hidden = false;
}

window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Space' && game.state !== 'play') { e.preventDefault(); start(); }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
overlay.addEventListener('pointerdown', () => { if (game.state !== 'play') start(); });
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
const camTarget = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta());
  if (game.state === 'play') {
    game.time += dt;
    const fwd = (keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0) - (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0);
    const turn = (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0) - (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0);
    player.rotation.y += turn * TUNING.turn * dt;
    player.position.x += Math.sin(player.rotation.y) * fwd * TUNING.speed * dt;
    player.position.z += Math.cos(player.rotation.y) * fwd * TUNING.speed * dt;
    player.position.x = THREE.MathUtils.clamp(player.position.x, -TUNING.arena + 1, TUNING.arena - 1);
    player.position.z = THREE.MathUtils.clamp(player.position.z, -TUNING.arena + 1, TUNING.arena - 1);
    for (let i = orbs.length - 1; i >= 0; i--) {
      if (orbs[i].position.distanceTo(player.position) < 1.2) {
        scene.remove(orbs[i]);
        orbs.splice(i, 1);
        game.score++;
      }
    }
    if (orbs.length === 0) win();
  }
  for (const o of orbs) o.position.y = 0.6 + Math.sin(clock.elapsedTime * 3 + o.position.x) * 0.15;
  // Camera follows from behind and above.
  const behind = new THREE.Vector3(-Math.sin(player.rotation.y) * 8, 5, -Math.cos(player.rotation.y) * 8);
  camera.position.lerp(player.position.clone().add(behind), 0.1);
  camTarget.lerp(player.position, 0.2);
  camera.lookAt(camTarget);
  hud.textContent = game.state === 'play' ? `Orbs ${game.score} / ${TUNING.orbs}   Time ${game.time.toFixed(1)}` : '';
  renderer.render(scene, camera);
});
