import fs from 'node:fs';
import path from 'node:path';
import { checkUrl, secretField } from './guard.js';

// A Chromium with a persistent profile (one per identity, so logins stay and identities never
// mix). It runs inside the calling process over a pipe: no debugging port another process
// could use. headless for work; headed for a login by the owner (see login.js).
const CLEAN = `(all) => {
  if (all) return document.body.innerText;
  const noise = [...document.querySelectorAll('nav,footer,header,[role=navigation],[role=banner],[role=contentinfo],[id*=cookie i],[class*=cookie i]')]
    .filter((e) => e !== document.body && !e.querySelector('main,[role=main],table'));
  const old = noise.map((e) => e.style.display); noise.forEach((e) => { e.style.display = 'none'; });
  const main = document.querySelector('main,[role=main]');
  let t = main && main.innerText.trim().length > 300 ? main.innerText : document.body.innerText;
  noise.forEach((e, i) => { e.style.display = old[i]; });
  if ((t || '').trim().length < 200) t = document.body.innerText;
  return (t || '').replace(/\\n\\s*\\n+/g, '\\n').trim();
}`;
const LINKS = `() => [...document.querySelectorAll('a,button,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],input[type=submit]')]
  .filter((e) => e.getBoundingClientRect().height > 0)
  .map((e) => { const n = ((e.innerText || '').trim() || e.getAttribute('aria-label') || e.value || e.title || '').replace(/\\s+/g, ' ').slice(0, 60);
    return n ? n + ' -> ' + (e.href || '(' + (e.getAttribute('role') || e.tagName.toLowerCase()) + ')') : ''; })
  .filter((s, i, a) => s && a.indexOf(s) === i)`;
const BOT = /radware|verifying you are human|verifying your browser|just a moment|attention required|captcha|are you a robot|unusual traffic/i;
const LOGIN = /accounts\.google\.com|\/signin|\/login|\/challenge|servicelogin|\/auth\//i;

// Playwright's Chromium if installed, else a system Chrome.
export async function chromePath(env = process.env) {
  if (env.BROWSE_CHROME) return env.BROWSE_CHROME;
  const { chromium } = await import('playwright-core');
  const own = chromium.executablePath();
  if (own && fs.existsSync(own)) return own;
  const sys = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
  if (!sys) throw new Error('no Chrome found: run `npx playwright-core install chromium` or set BROWSE_CHROME');
  return sys;
}

export class Browser {
  // cdpUrl: attach to a Chrome that is already running (the CLI keeps one per identity between
  // commands). Only for the owner's own sessions: the gateway never opens a debugging port.
  constructor({ profileDir, executablePath, headless = true, proxy, chromium, check = checkUrl, cdpUrl }) {
    Object.assign(this, { profileDir, executablePath, headless, proxy, check, cdpUrl });
    this.chromium = chromium;
    this.url = '';
  }

  async context() {
    if (this.ctx) return this.ctx;
    this.chromium ??= (await import('playwright-core')).chromium;
    if (this.cdpUrl) {
      this.remote = await this.chromium.connectOverCDP(this.cdpUrl, { timeout: 20000 });
      this.ctx = this.remote.contexts()[0];
    } else {
      fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
      this.ctx = await this.chromium.launchPersistentContext(this.profileDir, {
        headless: this.headless, executablePath: this.executablePath, viewport: { width: 1280, height: 900 },
        args: ['--disable-blink-features=AutomationControlled'], ...(this.proxy && { proxy: { server: this.proxy } }),
      });
    }
    // Every page load (also redirects and links the page opens) must go to a public address.
    await this.ctx.route('**/*', async (route) => {
      const req = route.request();
      if (!req.isNavigationRequest()) return route.continue();
      const why = await this.check(req.url());
      return why ? route.abort('blockedbyclient') : route.continue();
    });
    this.ctx.on('close', () => { this.ctx = null; this.pg = null; });
    return this.ctx;
  }

  // Logins made in the visible window (bin/chrome-step.js) arrive as <profileDir>.import.json:
  // Playwright storage state (cookies + localStorage), which works across systems, unlike a copied
  // profile (macOS encrypts cookies with the Keychain). Imported once, then the file is removed.
  async importLogins(ctx) {
    const file = `${this.profileDir}.import.json`;
    if (!this.profileDir || !fs.existsSync(file)) return;
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.cookies?.length) await ctx.addCookies(state.cookies);
      for (const o of state.origins || []) {
        if (!o.localStorage?.length) continue;
        await ctx.addInitScript(({ origin, items }) => {
          if (location.origin === origin) for (const { name, value } of items) if (localStorage.getItem(name) === null) localStorage.setItem(name, value);
        }, { origin: o.origin, items: o.localStorage });
      }
    } finally { fs.rmSync(file, { force: true }); }
  }

  async page() {
    const ctx = await this.context();
    await this.importLogins(ctx);
    if (!this.pg || this.pg.isClosed()) this.pg = ctx.pages().find((p) => !p.isClosed()) || await ctx.newPage();
    return this.pg;
  }

  // Waits until the text stops changing (late results), at most ms.
  async settle(p, ms = 8000) {
    await p.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    const end = Date.now() + ms;
    let last = -1;
    let same = 0;
    while (same < 3 && Date.now() < end) {
      await p.waitForTimeout(400);
      const n = await p.evaluate('(document.body?.innerText||"").length').catch(() => -2);
      same = n === last && n > 0 ? same + 1 : 0;
      last = n;
    }
    this.url = p.url();
  }

  async wall(p) {
    if (LOGIN.test(p.url())) return `LOGIN NEEDED: ${new URL(p.url()).hostname}. Ask the owner to log in (a visible window on their computer); do not type credentials.`;
    const head = `${await p.title()} ${await p.evaluate('(document.body?.innerText||"").slice(0,400)').catch(() => '')}`;
    return BOT.test(head) ? `BLOCKED: a bot check on ${new URL(p.url()).hostname}. Do not retry in a loop.` : '';
  }

  async text({ max = 6000, all = false } = {}) {
    const p = await this.page();
    const w = await this.wall(p);
    const t = `${w ? `${w}\n` : ''}${await p.evaluate(`(${CLEAN})(${!!all})`)}`;
    return t.length <= max ? t : `${t.slice(0, max)}\n… (${t.length} chars; ask for more with max)`;
  }

  async open(url) {
    const why = await this.check(url);
    if (why) throw new Error(`refused: ${why}`);
    const p = await this.page();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.settle(p);
    return `${await p.title()} | ${p.url()}\n${await this.text()}`;
  }

  async links(word = '') {
    const out = await (await this.page()).evaluate(`(${LINKS})()`);
    return out.filter((l) => !word || l.toLowerCase().includes(word.toLowerCase())).slice(0, 200).join('\n') || 'no match';
  }

  // The first VISIBLE element by link/button name, then text, then CSS.
  async find(p, target) {
    const tries = [() => p.getByRole('link', { name: target, exact: true }), () => p.getByRole('button', { name: target, exact: true }),
      () => p.getByLabel(target, { exact: true }), () => p.getByText(target, { exact: true }), () => p.getByRole('link', { name: target }),
      () => p.getByRole('button', { name: target }), () => p.getByPlaceholder(target), () => p.getByLabel(target), () => p.getByText(target), () => p.locator(target)];
    for (const make of tries) {
      try {
        const loc = make().locator('visible=true');
        if (await loc.count()) return loc.first();
      } catch { /* not a valid selector for this kind */ }
    }
    throw new Error(`nothing visible matches "${target}"; look at links`);
  }

  async click(target) {
    const p = await this.page();
    const before = p.url();
    await (await this.find(p, target)).click({ timeout: 10000 });
    await p.waitForURL((u) => String(u) !== before, { timeout: 2500 }).catch(() => {});
    await this.settle(p);
    return `clicked; now ${p.url()}\n${await this.wall(p)}`.trim();
  }

  async type(target, text) {
    const p = await this.page();
    const el = await this.find(p, target);
    if (await el.evaluate(secretField)) throw new Error('refused: a password, card or code field. The owner types those themselves.');
    await el.fill(String(text));
    return 'typed';
  }

  async press(key) {
    const p = await this.page();
    await p.keyboard.press(key);
    await this.settle(p, 5000);
    return `pressed ${key}; now ${p.url()}`;
  }

  async shot(file) {
    const p = await this.page();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await p.screenshot({ path: file });
    return file;
  }

  // Attached: only let go (Chrome keeps running). Own: close it (the profile stays).
  async close() {
    if (this.remote) await this.remote.close().catch(() => {}); else await this.ctx?.close().catch(() => {});
    this.ctx = null; this.pg = null; this.remote = null;
  }
}
