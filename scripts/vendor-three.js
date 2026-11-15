'use strict';
// Copies the three.js add-ons the model viewer imports (and everything they import) into vendor/three-addons.
// electron-builder drops every "examples" folder from node_modules, so the packaged app needs its own copy.
const fs = require('fs');
const path = require('path');

const src = path.join(path.dirname(path.dirname(require.resolve('three'))), 'examples', 'jsm');
const out = path.join(__dirname, '..', 'vendor', 'three-addons');
const entries = ['controls/OrbitControls.js', 'loaders/GLTFLoader.js', 'loaders/OBJLoader.js', 'loaders/FBXLoader.js', 'loaders/STLLoader.js', 'utils/SkeletonUtils.js'];

fs.rmSync(out, { recursive: true, force: true });
const seen = new Set();
const visit = (rel) => {
  if (seen.has(rel)) return;
  seen.add(rel);
  const text = fs.readFileSync(path.join(src, rel), 'utf8');
  fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
  fs.writeFileSync(path.join(out, rel), text);
  for (const m of text.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g)) visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
};
entries.forEach(visit);
console.log(`Copied ${seen.size} three.js add-on files to vendor/three-addons`);
