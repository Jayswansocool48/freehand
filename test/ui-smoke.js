'use strict';
// Manual smoke test: drives the real UI in Chrome against a scripted mock model, saves screenshots to $OUT.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-core');
const { mockProvider, toolCall, text, tempHome, writeSettings } = require('./helpers');
const home = tempHome();
const { defaultSettings } = require('../src/core/config');
const { startServer } = require('../src/server');
const OUT = process.env.OUT || '/tmp/ui';
fs.mkdirSync(OUT, { recursive: true });
const assert = require('node:assert/strict');

(async () => {
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Joplin</title><body style="font:16px system-ui;margin:48px;max-width:640px"><h1>Joplin</h1><p>An open-source note-taking and to-do application with synchronisation.</p><a href="#d">Download</a> <button>Get started</button></body>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const siteUrl = `http://127.0.0.1:${site.address().port}/`;

  const mock = await mockProvider((body) => {
    if (!body.tools) return { message: text('{"title":"Compare note apps","steps":["Write the comparison","Check the source page","Verify output"]}') };
    const n = body.messages.filter((m) => m.role === 'tool').length;
    return { message: [
      { ...toolCall('file_write', { path: 'comparison.md', content: '# Notes\n| App | License |\n|---|---|\n| Joplin | MIT |' }), content: 'I will write the comparison first.' },
      toolCall('step_done', { summary: 'Comparison written to comparison.md' }),
      toolCall('shell', { command: 'echo verified && ls' }),
      toolCall('browser', { action: 'open', url: siteUrl }),
      toolCall('step_done', { summary: 'Checked the Joplin page' }),
      toolCall('step_done', { summary: 'Verified' }),
      toolCall('finish', { message: '## Done\nHere is the comparison:\n\n| App | License |\n|---|---|\n| Joplin | MIT |\n| Standard Notes | AGPL |\n\nSources: [Joplin](https://joplinapp.org)\n\n```bash\nls\n```', files: ['comparison.md'] }),
    ][n] };
  });
  const s = defaultSettings(); s.active = 'custom'; s.providers.custom.baseUrl = mock.url; s.providers.custom.model = 'qwen3:8b'; s.approval = 'ask';
  writeSettings(home, s);
  const srv = await startServer({ port: 0 });
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  await page.goto(srv.url);
  await page.waitForSelector('.home-chip');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '1-home.png') });
  await page.click('.home-chip >> nth=0');
  const filled = await page.inputValue('#input');
  assert.match(filled, /Research \[topic\]/);
  await page.fill('#input', 'Research 5 free note apps and write comparison.md');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.approval');
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, '2-approval.png') });
  await page.click('.approval .btn-primary');
  await page.waitForSelector('.final', { timeout: 30000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, '3-done.png') });
  // The panel should be showing the browser frame (the latest) with a screenshot
  assert.ok(await page.isVisible('#cp-body img.cp-shot'), 'browser screenshot visible in Computer panel');
  assert.ok(!(await page.isVisible('#cp-live')), 'at live position: no jump-to-live button');
  // scrub back to the terminal step
  await page.click('#cp-prev');
  assert.match(await page.textContent('#cp-body'), /echo verified/);
  assert.ok(await page.isVisible('#cp-live'), 'jump-to-live shown when scrubbed back');
  await page.screenshot({ path: path.join(OUT, '4-scrubbed-terminal.png') });
  await page.click('#cp-prev');
  assert.match(await page.textContent('#cp-body'), /comparison\.md/);
  await page.click('#cp-live');
  assert.ok(await page.isVisible('#cp-body img.cp-shot'));
  // progress bar
  assert.match(await page.textContent('#progress-count'), /3 \/ 3/);
  await page.click('#progress-toggle');
  assert.equal(await page.locator('#progress-list li').count(), 3);
  // files tab
  await page.click('.cp-tab[data-cp="files"]');
  await page.waitForSelector('.files-list li');
  // dark theme + custom font
  await page.click('#toggle-theme');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '5-dark.png') });
  await page.click('#open-settings');
  await page.waitForSelector('#settings[open]');
  await page.fill('#f-font', 'Cascadia Code');
  const fam = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  assert.match(fam, /Cascadia Code/);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, '6-settings.png') });
  await page.click('#save-settings');
  await page.waitForTimeout(900);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
  assert.equal(saved.ui.font, 'Cascadia Code'); assert.equal(saved.ui.theme, 'dark');
  console.log(JSON.stringify({ problems, title: await page.textContent('#task-title'), fontFamily: fam }));
  await browser.close(); srv.close(); mock.close(); site.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
