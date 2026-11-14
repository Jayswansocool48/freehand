'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let playwright;
function pw() {
  if (!playwright) playwright = require('playwright-core');
  return playwright;
}

const SNAPSHOT_FN = `() => {
  document.querySelectorAll('[data-fh]').forEach((e) => e.removeAttribute('data-fh'));
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]';
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (r.bottom < -200 || r.top > innerHeight * 3) continue;
    n++;
    el.setAttribute('data-fh', String(n));
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || '';
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const href = tag === 'a' ? (el.getAttribute('href') || '').slice(0, 100) : '';
    out.push('[' + n + '] ' + tag + (type ? '(' + type + ')' : '') + ' "' + label + '"' + (href ? ' -> ' + href : ''));
    if (n >= 70) break;
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { title: document.title, url: location.href, elements: out, text: text.slice(0, 2500), scrollY: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight };
}`;

/** One lazily-launched browser per task. */
class BrowserSession {
  constructor({ headless = true, shotsDir, onShot }) {
    this.headless = headless;
    this.shotsDir = shotsDir;
    this.onShot = onShot;
    this.browser = null;
    this.page = null;
    this.shotN = 0;
  }

  async launch() {
    if (this.page) return;
    const { chromium } = pw();
    const base = { headless: this.headless };
    const attempts = [];
    if (process.env.FREEHAND_BROWSER_PATH) attempts.push({ ...base, executablePath: process.env.FREEHAND_BROWSER_PATH });
    attempts.push(base); // Playwright-managed Chromium (npm run setup-browser)
    for (const channel of process.platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'chromium', 'msedge']) attempts.push({ ...base, channel });
    for (const executablePath of cachedChromiums()) attempts.push({ ...base, executablePath }); // older Playwright downloads still work
    let lastErr;
    for (let round = 0; round < 2 && !this.browser; round++) {
      for (const opts of attempts) {
        try { this.browser = await chromium.launch({ ...opts, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] }); break; } catch (e) { lastErr = e; }
      }
      if (!this.browser && round === 0) installChromium(this.headless); // one automatic attempt to download Chromium
    }
    if (!this.browser) {
      throw new Error('No browser available. Install Chrome/Edge, or run "npm run setup-browser" once. Detail: ' + String(lastErr && lastErr.message).split('\n')[0]);
    }
    const ctx = await this.browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
    this.page = await ctx.newPage();
    this.page.setDefaultTimeout(15000);
  }

  async settle() {
    try { await this.page.waitForLoadState('domcontentloaded', { timeout: 8000 }); } catch { /* ignore */ }
    try { await this.page.waitForLoadState('networkidle', { timeout: 3000 }); } catch { /* ignore */ }
  }

  async shot(fullPage = false) {
    fs.mkdirSync(this.shotsDir, { recursive: true });
    const file = path.join(this.shotsDir, `shot-${String(++this.shotN).padStart(3, '0')}.png`);
    await this.page.screenshot({ path: file, fullPage });
    if (this.onShot) this.onShot(file);
    return file;
  }

  async snapshot() {
    const s = await this.page.evaluate(`(${SNAPSHOT_FN})()`);
    const lines = [`Page: ${s.title}`, `URL: ${s.url}`, `Scroll: ${s.scrollY}/${Math.max(0, s.height - s.viewport)}px`, '', 'Interactive elements (use the number as "index"):', ...(s.elements.length ? s.elements : ['(none visible)']), '', 'Visible text (start):', s.text];
    return lines.join('\n');
  }

  /** Executes one browser action and returns text for the model. */
  async act(args) {
    const a = args.action;
    if (a === 'close') { await this.close(); return 'Browser closed.'; }
    await this.launch();
    const page = this.page;
    switch (a) {
      case 'open': {
        if (!/^https?:\/\//i.test(args.url || '')) throw new Error('"url" must start with http:// or https://');
        await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await this.settle();
        break;
      }
      case 'snapshot': break;
      case 'click': {
        await page.locator(`[data-fh="${Number(args.index)}"]`).first().click({ timeout: 8000 });
        await this.settle();
        break;
      }
      case 'type': {
        const loc = page.locator(`[data-fh="${Number(args.index)}"]`).first();
        await loc.fill(String(args.text == null ? '' : args.text), { timeout: 8000 });
        if (args.submit) { await loc.press('Enter'); await this.settle(); }
        break;
      }
      case 'press': { await page.keyboard.press(String(args.key || 'Enter')); await this.settle(); break; }
      case 'scroll': {
        const dy = (args.direction === 'up' ? -1 : 1) * (Number(args.amount) || 700);
        await page.mouse.wheel(0, dy);
        await page.waitForTimeout(400);
        break;
      }
      case 'back': { await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}); await this.settle(); break; }
      case 'screenshot': {
        const f = await this.shot(!!args.full_page);
        return `Screenshot saved: ${path.relative(path.dirname(this.shotsDir), f).replace(/\\/g, '/')}`;
      }
      case 'text': {
        const txt = await page.evaluate(() => (document.body ? document.body.innerText : ''));
        const off = Number(args.offset) || 0;
        const max = Number(args.max_chars) || 8000;
        return txt.slice(off, off + max) + (txt.length > off + max ? `\n...[${txt.length} chars total; use offset=${off + max}]` : '');
      }
      default: throw new Error(`Unknown browser action "${a}". Use: open, snapshot, click, type, press, scroll, back, screenshot, text, close.`);
    }
    await this.shot().catch(() => {});
    return this.snapshot();
  }

  /**
   * Opens a game or page the agent built, plays it with simple inputs and reports what went wrong:
   * uncaught errors, console errors, files that failed to load, and a screenshot of the result.
   * actions: "click", "click X Y", "key KEY [ms]", "type TEXT", "mouse X Y", "wait MS".
   */
  async playTest({ url, actions = [], seconds = 3 }) {
    await this.launch();
    const page = this.page;
    const errors = [], consoleLines = [], failed = [];
    const onConsole = (m) => {
      const t = m.type();
      const line = `[${t}] ${m.text()}`.slice(0, 400);
      if (/GL Driver Message|GPU stall|swiftshader/i.test(line)) return; // graphics driver noise, not the game's fault
      if (t === 'error') errors.push(line); else if (consoleLines.length < 40) consoleLines.push(line);
    };
    const onPageError = (e) => errors.push(`[uncaught] ${String(e && (e.stack || e.message) || e).split('\n').slice(0, 4).join('\n')}`.slice(0, 800));
    const onFailed = (r) => failed.push(`${r.url()} (${(r.failure() && r.failure().errorText) || 'failed'})`);
    const onResponse = (r) => { if (r.status() >= 400) failed.push(`${r.url()} (HTTP ${r.status()})`); };
    page.on('console', onConsole); page.on('pageerror', onPageError); page.on('requestfailed', onFailed); page.on('response', onResponse);
    const done = [];
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await this.settle();
      await page.waitForTimeout(800);
      const vp = page.viewportSize() || { width: 1280, height: 800 };
      for (const raw of (Array.isArray(actions) ? actions : []).slice(0, 40)) {
        const [cmd, ...rest] = String(raw).trim().split(/\s+/);
        const nums = rest.map(Number);
        try {
          switch ((cmd || '').toLowerCase()) {
            case 'click': await page.mouse.click(Number.isFinite(nums[0]) ? nums[0] : vp.width / 2, Number.isFinite(nums[1]) ? nums[1] : vp.height / 2); break;
            case 'mouse': await page.mouse.move(nums[0] || 0, nums[1] || 0, { steps: 5 }); break;
            case 'key': case 'press': case 'hold': {
              const ms = Math.min(5000, Number(rest[1]) || 120);
              await page.keyboard.down(rest[0] || 'Space'); await page.waitForTimeout(ms); await page.keyboard.up(rest[0] || 'Space');
              break;
            }
            case 'type': await page.keyboard.type(rest.join(' '), { delay: 30 }); break;
            case 'wait': await page.waitForTimeout(Math.min(10000, nums[0] || 500)); break;
            default: throw new Error('unknown action; use click, mouse, key, type or wait');
          }
          done.push(String(raw));
        } catch (e) { done.push(`${raw} -> FAILED: ${String(e.message).split('\n')[0]}`); }
      }
      await page.waitForTimeout(Math.min(15000, Math.max(0, Number(seconds) || 0) * 1000));
      const shot = await this.shot();
      const info = await page.evaluate(() => ({
        title: document.title,
        canvases: [...document.querySelectorAll('canvas')].map((c) => `${c.width}x${c.height}`),
        text: (document.body ? document.body.innerText : '').trim().replace(/\n{2,}/g, '\n').slice(0, 1200),
      }));
      // Report workspace paths ("./assets/x.glb") instead of long preview URLs.
      const dir = url.slice(0, url.lastIndexOf('/') + 1);
      const uniq = (a) => [...new Set(a.map((x) => x.split(dir).join('./')))];
      return [
        `Played ${url.split(dir).join('./')}`,
        `Title: ${info.title || '(none)'} · canvases: ${info.canvases.length ? info.canvases.join(', ') : 'none'}`,
        done.length ? `Inputs: ${done.join(' | ')}` : 'Inputs: none',
        errors.length ? `ERRORS (${errors.length}), fix these:\n${uniq(errors).slice(0, 15).join('\n')}` : 'Errors: none',
        failed.length ? `FILES THAT FAILED TO LOAD:\n${uniq(failed).slice(0, 15).join('\n')}` : 'Failed loads: none',
        consoleLines.length ? `Console:\n${uniq(consoleLines).slice(-15).join('\n')}` : '',
        info.text ? `Visible text:\n${info.text}` : 'Visible text: none',
        `Screenshot: ${path.relative(path.dirname(this.shotsDir), shot).replace(/\\/g, '/')}`,
      ].filter(Boolean).join('\n');
    } finally {
      page.off('console', onConsole); page.off('pageerror', onPageError); page.off('requestfailed', onFailed); page.off('response', onResponse);
    }
  }

  async close() {
    try { if (this.browser) await this.browser.close(); } catch { /* ignore */ }
    this.browser = null;
    this.page = null;
  }
}

/** Chromium builds already in the Playwright cache, newest first, even if they are not the exact revision this Playwright wants. */
function cachedChromiums() {
  const home = require('os').homedir();
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || home, 'ms-playwright') : process.platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'ms-playwright') : path.join(home, '.cache', 'ms-playwright'));
  let dirs = [];
  try { dirs = fs.readdirSync(cache).filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d)); } catch { return []; }
  dirs.sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
  const names = process.platform === 'win32' ? ['chrome.exe', 'chrome-headless-shell.exe', 'headless_shell.exe'] : ['chrome', 'chrome-headless-shell', 'headless_shell'];
  const out = [];
  for (const d of dirs) {
    for (const sub of fs.readdirSync(path.join(cache, d))) {
      for (const n of names) { const f = path.join(cache, d, sub, n); if (fs.existsSync(f)) out.push(f); }
    }
  }
  return out;
}

/** Hidden windows run Playwright's small headless shell; a visible window needs full Chromium. */
function installChromium(headless = true) {
  try {
    const cli = require.resolve('playwright-core/cli.js');
    spawnSync(process.execPath, [cli, 'install', headless ? 'chromium-headless-shell' : 'chromium'], { stdio: 'ignore', timeout: 300000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  } catch { /* handled by caller */ }
}

module.exports = { BrowserSession, installChromium };
