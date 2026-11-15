#!/usr/bin/env node
'use strict';
/*
 * Game evals: runs the real agent with a local model on game requests, then grades what it built
 * by playing it. Like Hatch's training scores, run it before and after a change to see whether
 * Freehand got better.
 *
 *   node scripts/eval-games.js                       all cases with freehand-v2
 *   node scripts/eval-games.js flappy snake          only these cases
 *   EVAL_MODEL=qwen3:4b-instruct node scripts/eval-games.js
 *
 * Results go to eval-results/<time>/ (one workspace per case plus report.json).
 */
const fs = require('fs');
const path = require('path');
const { Agent } = require('../src/core/agent');
const { defaultSettings } = require('../src/core/config');
const { BrowserSession } = require('../src/tools/browser');
const { previewUrl } = require('../src/server/preview');

// Each case: the request, and inputs that a working game should survive and react to.
const CASES = {
  flappy: { ask: 'make flappy bird', inputs: ['tap Space 10 380'] },
  platformer: { ask: 'make a platformer where a fox collects gems', inputs: ['key ArrowRight 1500', 'key Space', 'key ArrowRight 1500'] },
  snake: { ask: 'make a snake game', inputs: ['key ArrowUp 100', 'wait 800', 'key ArrowLeft 100', 'wait 800'] },
  breakout: { ask: 'make a breakout game with colourful bricks', inputs: ['key ArrowLeft 600', 'key ArrowRight 900'] },
  shooter: { ask: 'make a space shooter', inputs: ['key ArrowLeft 500', 'key Space', 'key Space', 'key ArrowRight 700'] },
  adventure3d: { ask: 'make a 3d game where a knight collects gold coins', inputs: ['key KeyW 1200', 'key Space', 'key KeyD 800'] },
  platformer3d: { ask: 'make a 3d platformer with a robot', inputs: ['key KeyW 500', 'key Space', 'key KeyW 400'] },
  fps: { ask: 'make a first person shooter with zombies', inputs: ['key KeyW 800', 'key ArrowLeft 400', 'key Enter', 'key Enter'] },
  racer: { ask: 'make a racing game with a red sports car', inputs: ['key ArrowUp 2000', 'key ArrowLeft 500'] },
};

function settings() {
  const s = defaultSettings();
  s.active = 'ollama';
  s.providers.ollama.model = process.env.EVAL_MODEL || 'freehand-v2:latest';
  s.approval = 'auto';
  s.effort = process.env.EVAL_EFFORT || 'high';
  s.browserHeadless = true;
  return s;
}

/** Plays the finished game with a fixed set of inputs and scores it. */
async function grade(workspace, inputs) {
  const out = { page: false, errors: null, started: false, survived: false, reacts: false, score: null, notes: '' };
  if (!fs.existsSync(path.join(workspace, 'index.html'))) { out.notes = 'no index.html'; return out; }
  out.page = true;
  const b = new BrowserSession({ headless: true, shotsDir: path.join(workspace, '.freehand', 'eval') });
  try {
    const url = await previewUrl(workspace, 'index.html');
    const text = await b.playTest({ url, actions: ['click', ...inputs], seconds: 1 });
    out.errors = /^ERRORS/m.test(text) || /^FILES THAT FAILED/m.test(text);
    const m = text.match(/Game state \(window\.__game\): (\{.*\})/);
    const state = m ? JSON.parse(m[1]) : null;
    out.started = state ? state.state !== 'title' : /changed/i.test(text);
    out.survived = state ? state.state === 'play' || (state.time || 0) > 2 : !/game over/i.test(text);
    out.reacts = /screen changed|moved|changed a lot/i.test(text) && !/stayed at .* through all the movement keys/.test(text);
    out.score = state ? state.score : null;
    out.notes = text.slice(0, 1500);
  } catch (e) {
    out.notes = 'grader failed: ' + e.message;
  } finally {
    await b.close();
  }
  return out;
}

function points(r) {
  return (r.page ? 1 : 0) + (r.errors === false ? 1 : 0) + (r.started ? 1 : 0) + (r.survived ? 1 : 0) + (r.reacts ? 1 : 0) + (r.usedTemplate ? 1 : 0);
}

async function main() {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CASES);
  const root = path.join(__dirname, '..', 'eval-results', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(root, { recursive: true });
  const report = [];
  for (const name of names) {
    const c = CASES[name];
    if (!c) { console.error(`unknown case ${name}`); continue; }
    const workspace = path.join(root, name);
    fs.mkdirSync(workspace, { recursive: true });
    const events = [];
    const log = fs.createWriteStream(path.join(workspace, 'events.jsonl'));
    const agent = new Agent({
      settings: settings(), workspace, history: [], signal: new AbortController().signal,
      emit: (type, d) => { events.push({ type, ...d }); log.write(JSON.stringify({ type, ...d }) + '\n'); if (type === 'tool') console.log(`  [${name}] ${d.label}`); },
      ask: async () => 'Use your best judgement.', approve: async () => true,
    });
    const t0 = Date.now();
    console.log(`> ${name}: "${c.ask}"`);
    const result = await agent.run(c.ask);
    log.end();
    const tools = events.filter((e) => e.type === 'tool').map((e) => e.name);
    const r = { name, status: result.status, minutes: +((Date.now() - t0) / 60000).toFixed(1), tools, usedTemplate: tools.includes('game_template') || events.some((e) => e.type === 'notice' && /template/i.test(e.text)) };
    Object.assign(r, await grade(workspace, c.inputs));
    r.points = points(r);
    console.log(`< ${name}: ${r.points}/6  status=${r.status} template=${r.usedTemplate} errors=${r.errors} started=${r.started} survived=${r.survived} reacts=${r.reacts} score=${r.score} (${r.minutes} min)`);
    report.push(r);
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  }
  const total = report.reduce((n, r) => n + r.points, 0);
  console.log(`\nTotal ${total}/${report.length * 6}. Report: ${path.join(root, 'report.json')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
