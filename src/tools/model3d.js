'use strict';
const fs = require('fs');
const path = require('path');

/*
 * 3D models without dependencies: builds low-poly .glb files from simple shapes (make_model) and
 * summarises model files (model_info) so a text-only model knows their size, parts and animations.
 */

const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'pyramid', 'wedge', 'torus'];
const NAMED = {
  white: '#ffffff', black: '#111111', gray: '#808080', grey: '#808080', red: '#d64545', green: '#4caf50', blue: '#3b6fd6', yellow: '#f2c94c',
  orange: '#f2994a', purple: '#8e5bd6', pink: '#f28cb1', brown: '#8b5a2b', tan: '#d2b48c', wood: '#9c6b3f', stone: '#8d9096', grass: '#5a9a3c',
  water: '#3d8fd6', sand: '#e2c88f', gold: '#d4a73a', silver: '#c0c4c8', skin: '#e0ac69', leaf: '#3f8f3a', sky: '#87ceeb', snow: '#f4f6f8',
};

/* ---------- geometry (unit shapes, centred, fitting a 1x1x1 box) ---------- */
function geo() { return { pos: [], nrm: [], idx: [] }; }

function box() {
  const g = geo();
  const faces = [[[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]];
  for (const [n, u, v] of faces) {
    const b = g.pos.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) g.pos.push(0.5 * (n[k] + su * u[k] + sv * v[k]));
      g.nrm.push(...n);
    }
    g.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return g;
}

function sphere(seg) {
  const g = geo();
  const rows = Math.max(3, Math.round(seg / 2));
  for (let y = 0; y <= rows; y++) {
    const th = (y / rows) * Math.PI;
    for (let x = 0; x <= seg; x++) {
      const ph = (x / seg) * Math.PI * 2;
      const n = [-Math.cos(ph) * Math.sin(th), Math.cos(th), Math.sin(ph) * Math.sin(th)];
      g.pos.push(n[0] * 0.5, n[1] * 0.5, n[2] * 0.5);
      g.nrm.push(...n);
    }
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < seg; x++) {
      const a = y * (seg + 1) + x, b = a + seg + 1;
      if (y !== 0) g.idx.push(a, b, a + 1);
      if (y !== rows - 1) g.idx.push(a + 1, b, b + 1);
    }
  }
  return g;
}

/** Cylinder (top radius rt) or cone (rt = 0), height 1, base radius 0.5. */
function lathe(seg, rt) {
  const g = geo();
  const rb = 0.5;
  const slope = rb - rt; // radius change over a height of 1
  for (let x = 0; x <= seg; x++) {
    const ph = (x / seg) * Math.PI * 2;
    const c = Math.cos(ph), s = Math.sin(ph);
    const len = Math.hypot(1, slope);
    const n = [c / len, slope / len, s / len];
    g.pos.push(c * rt, 0.5, s * rt, c * rb, -0.5, s * rb);
    g.nrm.push(...n, ...n);
  }
  for (let x = 0; x < seg; x++) { const a = x * 2; if (rt > 0) g.idx.push(a, a + 2, a + 1); g.idx.push(a + 1, a + 2, a + 3); }
  const cap = (y, r, up) => {
    if (r <= 0) return;
    const c0 = g.pos.length / 3;
    g.pos.push(0, y, 0); g.nrm.push(0, up, 0);
    for (let x = 0; x <= seg; x++) { const ph = (x / seg) * Math.PI * 2; g.pos.push(Math.cos(ph) * r, y, Math.sin(ph) * r); g.nrm.push(0, up, 0); }
    for (let x = 0; x < seg; x++) up > 0 ? g.idx.push(c0, c0 + x + 2, c0 + x + 1) : g.idx.push(c0, c0 + x + 1, c0 + x + 2);
  };
  cap(0.5, rt, 1);
  cap(-0.5, rb, -1);
  return g;
}

function wedge() {
  // A ramp: full height at the back (z = -0.5), sloping to nothing at the front (z = +0.5).
  const P = [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]];
  const tris = [[0, 1, 2], [0, 2, 3], [0, 4, 5], [0, 5, 1], [3, 2, 5], [3, 5, 4], [0, 3, 4], [1, 5, 2]];
  const g = geo();
  for (const t of tris) for (const i of t) g.pos.push(...P[i]);
  for (let i = 0; i < tris.length * 3; i++) g.idx.push(i);
  return flat(g);
}

/** Torus lying flat, sized directly: outer width w, depth d, tube thickness t. */
function torus(seg, w, t, d) {
  const g = geo();
  const tube = Math.max(0.001, Math.min(t, w / 2) / 2);
  const R = Math.max(tube, w / 2 - tube);
  const zs = w ? d / w : 1;
  const ring = Math.max(6, Math.round(seg / 2));
  for (let i = 0; i <= seg; i++) {
    const u = (i / seg) * Math.PI * 2;
    for (let j = 0; j <= ring; j++) {
      const v = (j / ring) * Math.PI * 2;
      const cx = Math.cos(u), sz = Math.sin(u);
      g.pos.push((R + tube * Math.cos(v)) * cx, tube * Math.sin(v), (R + tube * Math.cos(v)) * sz * zs);
      const n = [Math.cos(v) * cx, Math.sin(v), (Math.cos(v) * sz) / (zs || 1)];
      const l = Math.hypot(...n) || 1;
      g.nrm.push(n[0] / l, n[1] / l, n[2] / l);
    }
  }
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < ring; j++) {
      const a = i * (ring + 1) + j, b = a + ring + 1;
      g.idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  return g;
}

/** Splits shared vertices so every triangle gets its own face normal (the faceted low-poly look). */
function flat(g) {
  const out = geo();
  for (let i = 0; i < g.idx.length; i += 3) {
    const v = [0, 1, 2].map((k) => g.pos.slice(g.idx[i + k] * 3, g.idx[i + k] * 3 + 3));
    const e1 = v[1].map((x, k) => x - v[0][k]), e2 = v[2].map((x, k) => x - v[0][k]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...n);
    if (l < 1e-12) continue; // zero-area triangle
    for (const p of v) { out.pos.push(...p); out.nrm.push(n[0] / l, n[1] / l, n[2] / l); out.idx.push(out.idx.length); }
  }
  return out;
}

/** Bakes a non-uniform size into a unit shape (normals use the inverse scale so lighting stays right). */
function scaled(g, s) {
  for (let i = 0; i < g.pos.length; i += 3) {
    for (let k = 0; k < 3; k++) g.pos[i + k] *= s[k];
    const n = [0, 1, 2].map((k) => g.nrm[i + k] / (s[k] || 1e-6));
    const l = Math.hypot(...n) || 1;
    for (let k = 0; k < 3; k++) g.nrm[i + k] = n[k] / l;
  }
  return g;
}

function shapeGeometry(p) {
  const seg = Math.max(3, Math.min(64, Math.round(Number(p.segments) || 16)));
  const s = p.size;
  let g;
  switch (p.shape) {
    case 'box': g = box(); break;
    case 'sphere': g = sphere(seg); break;
    case 'cylinder': g = lathe(seg, 0.5); break;
    case 'cone': g = lathe(seg, 0); break;
    case 'pyramid': g = lathe(4, 0); break;
    case 'wedge': g = wedge(); break;
    case 'torus': return p.flat ? flat(torus(seg, s[0], s[1], s[2])) : torus(seg, s[0], s[1], s[2]);
    default: throw new Error(`Unknown shape "${p.shape}". Use: ${SHAPES.join(', ')}.`);
  }
  if (p.shape === 'pyramid') { // turn the 4-sided cone so its sides face the axes, and size it to the full box
    for (let i = 0; i < g.pos.length; i += 3) {
      for (const arr of [g.pos, g.nrm]) {
        const x = arr[i], z = arr[i + 2];
        arr[i] = (x - z) * Math.SQRT1_2; arr[i + 2] = (x + z) * Math.SQRT1_2;
      }
      if (Math.abs(g.pos[i]) > 1e-6 || Math.abs(g.pos[i + 2]) > 1e-6) { g.pos[i] *= Math.SQRT2; g.pos[i + 2] *= Math.SQRT2; }
    }
  }
  if (p.flat || p.shape === 'pyramid') g = flat(g);
  return scaled(g, s);
}

/* ---------- parts and materials ---------- */
const vec3 = (v, d) => (Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(Number(x))) ? v.map(Number) : d);

function parseColor(c) {
  let hex = String(c || '#9aa4b1').trim().toLowerCase();
  if (NAMED[hex]) hex = NAMED[hex];
  const m = hex.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) throw new Error(`Color "${c}" is not a hex color like "#4caf50".`);
  const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
  // glTF colours are linear; convert from sRGB so the model looks like the hex code.
  return [0, 2, 4].map((i) => { const v = parseInt(h.slice(i, i + 2), 16) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
}

function quat(deg) {
  const [x, y, z] = deg.map((d) => (d * Math.PI) / 360);
  const [cx, cy, cz, sx, sy, sz] = [Math.cos(x), Math.cos(y), Math.cos(z), Math.sin(x), Math.sin(y), Math.sin(z)];
  // XYZ order, same as three.js Euler defaults.
  return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz];
}

function normalizePart(raw, i) {
  if (!raw || typeof raw !== 'object') throw new Error(`Part ${i + 1} is not an object.`);
  const shape = String(raw.shape || raw.type || 'box').toLowerCase();
  if (!SHAPES.includes(shape)) throw new Error(`Part ${i + 1}: unknown shape "${shape}". Use: ${SHAPES.join(', ')}.`);
  let size = raw.size;
  if (typeof size === 'number') size = [size, size, size];
  size = vec3(size, [1, 1, 1]).map((v) => Math.max(1e-4, Math.abs(v)));
  return {
    name: String(raw.name || `${shape}_${i + 1}`).slice(0, 60),
    on: raw.on ? String(raw.on) : null,
    shape, size, flat: !!raw.flat, segments: raw.segments,
    position: vec3(raw.position, [0, 0, 0]),
    rotation: typeof raw.rotation === 'number' ? [0, raw.rotation, 0] : vec3(raw.rotation, [0, 0, 0]), // a single number turns it around y
    color: parseColor(raw.color),
    roughness: Math.min(1, Math.max(0, raw.roughness == null ? 0.8 : Number(raw.roughness))),
    metalness: Math.min(1, Math.max(0, Number(raw.metalness) || 0)),
    emissive: raw.emissive ? parseColor(raw.emissive) : null,
    opacity: raw.opacity == null ? 1 : Math.min(1, Math.max(0, Number(raw.opacity))),
  };
}

/* ---------- glTF binary writer ---------- */
function buildGlb(spec) {
  const parts = (Array.isArray(spec.parts) ? spec.parts : []).slice(0, 300).map(normalizePart);
  if (!parts.length) throw new Error('"parts" must list at least one shape.');
  const chunks = [];
  let byteLength = 0;
  const bufferViews = [], accessors = [], meshes = [], materials = [], nodes = [];
  const matKey = new Map();
  let triangles = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];

  const addView = (typed, target) => {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); byteLength += pad; }
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: buf.length, target });
    chunks.push(buf);
    byteLength += buf.length;
    return bufferViews.length - 1;
  };

  const boxes = new Map(); // part name -> world bounds, for "on" placement and the checks below
  const placed = [];
  for (const p of parts) {
    const g = shapeGeometry(p);
    const n = g.pos.length / 3;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], g.pos[i + k]); mx[k] = Math.max(mx[k], g.pos[i + k]); }
    const q = quat(p.rotation);
    const local = worldBox(q, [0, 0, 0], mn, mx);
    if (p.on) {
      // "on": rest this part on top of an earlier one; x and z become offsets from that part's centre.
      const base = boxes.get(p.on);
      if (!base) throw new Error(`Part "${p.name}": "on" names "${p.on}", but no earlier part has that name. List the part it rests on first.`);
      p.position = [(base.min[0] + base.max[0]) / 2 + p.position[0], base.max[1] - local.min[1], (base.min[2] + base.max[2]) / 2 + p.position[2]];
    }
    const wb = worldBox(q, p.position, mn, mx);
    boxes.set(p.name, wb);
    placed.push({ name: p.name, box: wb });
    accessors.push({ bufferView: addView(new Float32Array(g.pos), 34962), componentType: 5126, count: n, type: 'VEC3', min: mn, max: mx });
    const posAcc = accessors.length - 1;
    accessors.push({ bufferView: addView(new Float32Array(g.nrm), 34962), componentType: 5126, count: n, type: 'VEC3' });
    const nrmAcc = accessors.length - 1;
    const big = n > 65535;
    accessors.push({ bufferView: addView(big ? new Uint32Array(g.idx) : new Uint16Array(g.idx), 34963), componentType: big ? 5125 : 5123, count: g.idx.length, type: 'SCALAR' });
    const idxAcc = accessors.length - 1;
    triangles += g.idx.length / 3;

    const key = JSON.stringify([p.color, p.roughness, p.metalness, p.emissive, p.opacity]);
    if (!matKey.has(key)) {
      const m = { name: `mat_${materials.length + 1}`, pbrMetallicRoughness: { baseColorFactor: [...p.color, p.opacity], metallicFactor: p.metalness, roughnessFactor: p.roughness } };
      if (p.emissive) m.emissiveFactor = p.emissive;
      if (p.opacity < 1) m.alphaMode = 'BLEND';
      materials.push(m);
      matKey.set(key, materials.length - 1);
    }
    meshes.push({ name: p.name, primitives: [{ attributes: { POSITION: posAcc, NORMAL: nrmAcc }, indices: idxAcc, material: matKey.get(key) }] });
    const node = { name: p.name, mesh: meshes.length - 1 };
    if (p.position.some((v) => v)) node.translation = p.position;
    if (p.rotation.some((v) => v)) node.rotation = quat(p.rotation);
    nodes.push(node);
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], wb.min[k]); hi[k] = Math.max(hi[k], wb.max[k]); }
  }
  const rootName = String(spec.name || 'model').slice(0, 60);
  const root = { name: rootName, children: nodes.map((_, i) => i) };
  // Stand the model on the ground: lift it if any part goes below y = 0.
  const lift = lo[1] < 0 ? -lo[1] : 0;
  if (lift) {
    root.translation = [0, lift, 0];
    lo[1] += lift; hi[1] += lift;
    for (const p of placed) { p.box.min[1] += lift; p.box.max[1] += lift; }
  }
  nodes.push(root);
  const gltf = {
    asset: { version: '2.0', generator: 'Freehand make_model' },
    scene: 0, scenes: [{ name: rootName, nodes: [nodes.length - 1] }],
    nodes, meshes, materials, accessors, bufferViews, buffers: [{ byteLength }],
  };
  const bin = Buffer.concat(chunks, byteLength);
  const binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + binPad.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  const glb = Buffer.concat([header, ch(json.length, 0x4e4f534a), json, ch(binPad.length, 0x004e4942), binPad]);
  return { glb, parts: parts.length, triangles, bounds: { min: lo, max: hi }, lifted: lift, warnings: checkLayout(placed, lo, hi) };
}

/** World-space bounds of a part's local box after rotation and translation. */
function worldBox(q, pos, mn, mx) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const cx of [mn[0], mx[0]]) for (const cy of [mn[1], mx[1]]) for (const cz of [mn[2], mx[2]]) {
    const w = rotate(q, [cx, cy, cz]).map((v, k) => v + pos[k]);
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], w[k]); max[k] = Math.max(max[k], w[k]); }
  }
  return { min, max };
}

/** Spots the usual mistakes of placing parts by hand: floating, buried or under the ground. */
function checkLayout(placed, lo, hi) {
  const tol = Math.max(...hi.map((v, k) => v - lo[k])) * 0.02;
  const touches = (a, b) => [0, 1, 2].every((k) => a.min[k] <= b.max[k] + tol && b.min[k] <= a.max[k] + tol);
  const inside = (a, b) => [0, 1, 2].every((k) => a.min[k] >= b.min[k] - 1e-6 && a.max[k] <= b.max[k] + 1e-6);
  const out = [];
  for (const [i, a] of placed.entries()) {
    const others = placed.filter((_, j) => j !== i);
    if (a.box.min[1] > tol && !others.some((b) => touches(a.box, b.box))) out.push(`"${a.name}" floats in the air: it touches no other part and not the ground (its bottom is at y = ${a.box.min[1].toFixed(2)}). Move it, or use "on".`);
    const host = others.find((b) => inside(a.box, b.box));
    if (host) out.push(`"${a.name}" is completely inside "${host.name}", so it cannot be seen. Move it out to the surface (for example with "on": "${host.name}").`);
  }
  return out.slice(0, 8);
}

function rotate(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

/* ---------- model_info ---------- */
const fmt = (v) => v.map((x) => Number(x.toFixed(3))).join(' × ');

function mat4(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const apply = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);

function gltfSummary(gltf, label) {
  const lines = [label];
  const nodes = gltf.nodes || [];
  const meshes = gltf.meshes || [];
  const acc = gltf.accessors || [];
  let tris = 0;
  for (const m of meshes) for (const p of m.primitives || []) {
    const a = p.indices != null ? acc[p.indices] : acc[p.attributes && p.attributes.POSITION];
    if (a) tris += Math.floor(a.count / 3);
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const visit = (i, parent, depth) => {
    const n = nodes[i];
    if (!n || depth > 64) return;
    const local = n.matrix && n.matrix.length === 16 ? n.matrix : mat4(n.translation, n.rotation, n.scale);
    const world = mul(parent, local);
    if (n.mesh != null && meshes[n.mesh]) {
      for (const p of meshes[n.mesh].primitives || []) {
        const a = acc[p.attributes && p.attributes.POSITION];
        if (!a || !a.min || !a.max) continue;
        for (const x of [a.min[0], a.max[0]]) for (const y of [a.min[1], a.max[1]]) for (const z of [a.min[2], a.max[2]]) {
          const w = apply(world, [x, y, z]);
          for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
        }
      }
    }
    for (const c of n.children || []) visit(c, world, depth + 1);
  };
  const scene = (gltf.scenes || [])[gltf.scene || 0];
  const rootsList = scene ? scene.nodes || [] : nodes.map((_, i) => i);
  for (const r of rootsList) visit(r, mat4(), 0);
  lines.push(`Meshes: ${meshes.length} · triangles: ${tris.toLocaleString('en-US')} · materials: ${(gltf.materials || []).length} · textures: ${(gltf.textures || []).length}`);
  if (Number.isFinite(lo[0])) {
    const size = hi.map((v, k) => v - lo[k]);
    lines.push(`Size (model units, usually metres): ${fmt(size)} (width × height × depth)`);
    lines.push(`Bounds: min ${fmt(lo)}, max ${fmt(hi)}. ${lo[1] < -0.01 * size[1] ? 'Origin is above the bottom: lift it by ' + (-lo[1]).toFixed(3) + ' to stand it on the ground.' : 'Bottom sits at y = ' + lo[1].toFixed(3) + '.'}`);
  }
  const named = nodes.map((n) => n.name).filter(Boolean);
  if (named.length) lines.push(`Node names: ${named.slice(0, 40).join(', ')}${named.length > 40 ? ` (+${named.length - 40} more)` : ''}`);
  if ((gltf.skins || []).length) lines.push(`Rigged: ${gltf.skins.length} skin(s), ${gltf.skins.reduce((s, k) => s + (k.joints || []).length, 0)} joints.`);
  const anims = gltf.animations || [];
  if (anims.length) {
    lines.push('Animations (play with THREE.AnimationMixer, clip names as in gltf.animations):');
    for (const [i, a] of anims.entries()) {
      let dur = 0;
      for (const s of a.samplers || []) { const inp = acc[s.input]; if (inp && inp.max) dur = Math.max(dur, inp.max[0]); }
      lines.push(`  ${i}: "${a.name || 'Clip ' + (i + 1)}" ${dur ? dur.toFixed(2) + 's' : ''}`);
    }
  } else lines.push('Animations: none');
  return lines.join('\n');
}

function modelInfo(file) {
  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(file);
  const label = `${path.basename(file)} (${ext.slice(1).toUpperCase()}, ${(buf.length / 1024).toFixed(1)} KB)`;
  if (ext === '.glb') {
    if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('Not a valid .glb file (bad header).');
    const len = buf.readUInt32LE(12);
    return gltfSummary(JSON.parse(buf.slice(20, 20 + len).toString('utf8')), label) + '\nLoad in three.js with GLTFLoader.';
  }
  if (ext === '.gltf') return gltfSummary(JSON.parse(buf.toString('utf8')), label) + '\nLoad in three.js with GLTFLoader (keep its .bin and texture files next to it).';
  if (ext === '.obj') {
    const txt = buf.toString('utf8');
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    let v = 0, f = 0;
    const groups = new Set();
    for (const line of txt.split('\n')) {
      if (line.startsWith('v ')) { v++; const p = line.trim().split(/\s+/).slice(1, 4).map(Number); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); } }
      else if (line.startsWith('f ')) f += Math.max(1, line.trim().split(/\s+/).length - 3);
      else if (/^[og] /.test(line)) groups.add(line.slice(2).trim());
    }
    const size = hi.map((x, k) => x - lo[k]);
    return [label, `Vertices: ${v} · triangles: ~${f}`, v ? `Size: ${fmt(size)} (width × height × depth); bounds min ${fmt(lo)}, max ${fmt(hi)}` : '', groups.size ? `Objects/groups: ${[...groups].slice(0, 30).join(', ')}` : '', 'Load in three.js with OBJLoader (materials from a .mtl file need MTLLoader). No animations in OBJ.'].filter(Boolean).join('\n');
  }
  if (ext === '.stl') {
    const ascii = buf.slice(0, 5).toString() === 'solid' && buf.includes('facet');
    const tris = ascii ? (buf.toString().match(/facet normal/g) || []).length : buf.readUInt32LE(80);
    return `${label}\nTriangles: ${tris} (${ascii ? 'ASCII' : 'binary'} STL, no colours or animations)\nLoad in three.js with STLLoader.`;
  }
  if (ext === '.fbx') {
    const binary = buf.slice(0, 18).toString() === 'Kaydara FBX Binary';
    return `${label}\n${binary ? 'Binary' : 'ASCII'} FBX. Load in three.js with FBXLoader; FBX files are often in centimetres, so scale by 0.01 if it looks huge. Open it in the Play tab viewer to see its size and animations.`;
  }
  throw new Error('model_info reads .glb, .gltf, .obj, .stl and .fbx files.');
}

module.exports = { buildGlb, modelInfo, SHAPES };
