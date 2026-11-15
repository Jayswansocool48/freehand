#!/usr/bin/env node
'use strict';
/*
 * Plays every 3D starter (and every 3D recipe inside the blank one) in a real browser and prints what
 * play_test reports, so a broken template is caught before the model ever sees it.
 *   node scripts/check-3d.js                 all templates and recipes
 *   node scripts/check-3d.js 3d-racer        one template
 * three.js is served by Freehand's preview server, so no internet is needed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TEMPLATES, RECIPES_3D, installTemplate } = require('../src/tools/gamekit');
const { BrowserSession } = require('../src/tools/browser');
const { previewUrl } = require('../src/server/preview');
const { buildGlb } = require('../src/tools/model3d');

const TREE = [
  { name: 'trunk', shape: 'cylinder', size: [0.4, 1.2, 0.4], position: [0, 0.6, 0], color: '#8b5a2b' },
  { name: 'top', shape: 'cone', size: [2, 2.5, 2], on: 'trunk', color: '#2e7d32', flat: true },
];

// Inputs a player would use in each starter.
const INPUTS = {
  '3d': ['click', 'key KeyW 1200', 'key Space', 'key KeyD 800'],
  '3d-platformer': ['click', 'key KeyW 600', 'key Space', 'key KeyW 500'],
  '3d-fps': ['click', 'key KeyW 800', 'key ArrowLeft 400', 'key Enter', 'key Enter'],
  '3d-racer': ['click', 'key ArrowUp 2500', 'key ArrowLeft 500'],
  '3d-runner': ['click', 'key ArrowLeft 150', 'wait 600', 'key Space', 'wait 600', 'key ArrowRight 150'],
  '3d-flyer': ['click', 'key ArrowUp 500', 'key ArrowLeft 600', 'wait 800'],
  '3d-blank': ['click', 'key KeyW 1000', 'key Space'],
};

async function useLocalThree(dir, url) {
  const base = url.slice(0, url.indexOf('/w/'));
  const f = path.join(dir, 'index.html');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8')
    .replace('https://unpkg.com/three@0.180.0/build/three.module.js', `${base}/lib/three/build/three.module.js`)
    .replace('https://unpkg.com/three@0.180.0/examples/jsm/', `${base}/lib/three/examples/jsm/`));
}

const SURVIVAL = ['gather', 'craft', 'build', 'hunger', 'daynight'];

/** Pastes a recipe's parts into the blank 3D game at its markers, keeping the markers for the next one. */
function withRecipe(text, r) {
  return text
    .replace('// RECIPE TOP', `${r.top}\n// RECIPE TOP`)
    .replace('  // RECIPE INIT', `${r.init.replace(/^/gm, '  ')}\n  // RECIPE INIT`)
    .replace('  // RECIPE UPDATE', `${r.update.replace(/^/gm, '  ')}\n  // RECIPE UPDATE`);
}

async function play(b, kind, recipe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh3d-'));
  installTemplate(dir, kind, { title: kind });
  if (recipe === 'scenery') fs.writeFileSync(path.join(dir, 'assets', 'tree.glb'), buildGlb({ name: 'tree', parts: TREE }).glb);
  // A recipe goes in after the recipes it builds on; "survival" is all the survival recipes together.
  const names = recipe === 'survival' ? SURVIVAL : recipe ? [...(RECIPES_3D[recipe].needs || []), recipe] : [];
  for (const n of names) {
    let r = RECIPES_3D[n];
    // Put the first tree right in front of the player so the test can chop it.
    if (recipe === 'survival' && n === 'gather') r = { ...r, init: r.init.replace('showInv();', "NODES.sort((a, b) => (a.kind === 'tree' ? -1 : 1) - (b.kind === 'tree' ? -1 : 1));\nNODES[0].position.set(0, 0, 1.6);\nshowInv();") };
    fs.writeFileSync(path.join(dir, 'game.js'), withRecipe(fs.readFileSync(path.join(dir, 'game.js'), 'utf8'), r));
  }
  const url = await previewUrl(dir, 'index.html');
  await useLocalThree(dir, url);
  const actions = recipe === 'survival' ? ['click', 'tap KeyF 5 250', 'key Digit1', 'wait 300'] : INPUTS[kind];
  const text = await b.playTest({ url, actions, seconds: 2 });
  if (recipe === 'survival' && !/1 Hatchet \(5 wood\) made/.test(text)) return { ok: false, text: 'Chopping the tree in front and crafting a hatchet did not work.\n' + text, dir };
  const state = (text.match(/Game state \(window\.__game\): (\{.*\})/) || [])[1];
  const bad = /^(ERRORS|FILES THAT FAILED|WATCH OUT)/m.test(text) || !state || JSON.parse(state).state === 'title';
  return { ok: !bad, text, state, dir };
}

async function main() {
  const only = process.argv.slice(2);
  const kinds = Object.keys(TEMPLATES).filter((k) => TEMPLATES[k].three && (!only.length || only.includes(k)));
  const recipes = !only.length || only.includes('recipes') ? [...Object.keys(RECIPES_3D || {}), 'survival'] : only.filter((n) => RECIPES_3D[n] || n === 'survival');
  const b = new BrowserSession({ headless: true, shotsDir: path.join(os.tmpdir(), 'fh3d-shots') });
  let failed = 0;
  try {
    for (const k of kinds) {
      const r = await play(b, k);
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${k}  ${r.state || ''}`);
      if (!r.ok || process.env.VERBOSE) { console.log(r.text + `\n(workspace ${r.dir})\n`); failed += r.ok ? 0 : 1; }
    }
    for (const name of recipes) {
      const r = await play(b, '3d-blank', name);
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} recipe ${name}  ${r.state || ''}`);
      if (!r.ok || process.env.VERBOSE) { console.log(r.text + `\n(workspace ${r.dir})\n`); failed += r.ok ? 0 : 1; }
    }
  } finally {
    await b.close();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
