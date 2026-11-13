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
    let lastErr;
    for (let round = 0; round < 2 && !this.browser; round++) {
      for (const opts of attempts) {
        try { this.browser = await chromium.launch({ ...opts, args: ['--no-sandbox'] }); break; } catch (e) { lastErr = e; }
      }
      if (!this.browser && round === 0) installChromium(); // one automatic attempt to download Chromium
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

  async close() {
    try { if (this.browser) await this.browser.close(); } catch { /* ignore */ }
    this.browser = null;
    this.page = null;
  }
}

function installChromium() {
  try {
    const cli = require.resolve('playwright-core/cli.js');
    spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'ignore', timeout: 300000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  } catch { /* handled by caller */ }
}

module.exports = { BrowserSession, installChromium };
