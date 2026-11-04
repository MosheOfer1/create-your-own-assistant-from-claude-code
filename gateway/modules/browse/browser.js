import fs from 'node:fs';
import path from 'node:path';
import { checkUrl, elementInfo, secretField } from './guard.js';

// A Chromium with a persistent profile (one per identity, so logins stay and identities never
// mix). In the gateway it runs inside the process over a pipe: no debugging port another
// process (the agent's shell) could use. Only the owner's own CLI (bin/browse.js) attaches to a
// Chrome on a 127.0.0.1 port (cdpUrl). Logins by hand: bin/chrome-step.js.
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
const HOST_TTL_MS = 30_000;

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
    this.hosts = new Map(); // origin → { why: Promise<reason|null>, until }
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
        // A service worker's own requests skip the route below (Playwright issue 1090).
        serviceWorkers: 'block',
      });
    }
    // Every request must go to a public address: page loads, redirects and links the page opens,
    // and also its images, scripts and fetch() calls. Else a page could make this browser reach
    // the home network, this machine or a cloud metadata service for it.
    await this.ctx.route('**/*', (route) => this.screen(route));
    this.ctx.on('close', () => { this.ctx = null; this.pg = null; });
    return this.ctx;
  }

  async screen(route) {
    const req = route.request();
    const url = req.url();
    if (/^(data|blob):/i.test(url)) return route.continue(); // inside the page, no network
    const why = await (req.isNavigationRequest() ? this.check(url) : this.checkHost(url)).catch(() => 'the address check failed');
    return why ? route.abort('blockedbyclient') : route.continue();
  }

  // The check for a page's files: one DNS lookup per origin for a short time, because a page
  // loads hundreds of files from a few hosts. Page loads keep a fresh check each time.
  checkHost(url, now = Date.now()) {
    let key;
    try {
      const u = new URL(url);
      key = `${u.username || u.password ? 'creds:' : ''}${u.protocol}//${u.host}`;
    } catch { return this.check(url); }
    const hit = this.hosts.get(key);
    if (hit && hit.until > now) return hit.why;
    if (this.hosts.size > 500) this.hosts.clear();
    const why = Promise.resolve().then(() => this.check(url));
    this.hosts.set(key, { why, until: now + HOST_TTL_MS });
    return why;
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

  // The first VISIBLE element by exact link/button name, label, text or placeholder, then CSS.
  // Exact only: Playwright's loose match takes a part of the name, so "Sen" would find "Send".
  async find(p, target) {
    const exact = { exact: true };
    const tries = [() => p.getByRole('link', { name: target, exact: true }), () => p.getByRole('button', { name: target, exact: true }),
      () => p.getByLabel(target, exact), () => p.getByText(target, exact), () => p.getByPlaceholder(target, exact), () => p.locator(target)];
    for (const make of tries) {
      try {
        const loc = make().locator('visible=true');
        if (await loc.count()) return loc.first();
      } catch { /* not a valid selector for this kind */ }
    }
    throw new Error(`nothing visible matches "${target}"; look at links`);
  }

  // What target points at now (elementInfo), for the approval step. Never starts Chrome.
  async inspect(target) {
    if (!this.pg || this.pg.isClosed() || target == null) return null;
    const el = await this.find(this.pg, String(target)).catch(() => null);
    return el ? el.evaluate(elementInfo).catch(() => null) : null;
  }

  // guard(info) → a reason to stop, or null. It sees the element the step will really act on,
  // so a page that changed after the approval step cannot slip a Send button in.
  async guarded(guard, el) {
    if (!guard) return;
    const info = el ? await el.evaluate(elementInfo).catch(() => null) : null;
    if (el && !info) throw new Error('refused: cannot read the element, so this step needs the owner');
    const why = guard(info);
    if (why) throw new Error(`refused: ${why}`);
  }

  // The element itself, not a locator: a locator looks again on click, and the page may have
  // swapped what it finds in between.
  async pinned(p, target) {
    const loc = await this.find(p, target);
    return (await loc.elementHandle?.({ timeout: 2000 }).catch(() => null)) || loc;
  }

  async click(target, { guard } = {}) {
    const p = await this.page();
    const before = p.url();
    const el = await this.pinned(p, target);
    await this.guarded(guard, el);
    await el.click({ timeout: 10000 });
    await p.waitForURL((u) => String(u) !== before, { timeout: 2500 }).catch(() => {});
    await this.settle(p);
    return `clicked; now ${p.url()}\n${await this.wall(p)}`.trim();
  }

  async type(target, text, { guard } = {}) {
    const p = await this.page();
    const el = await this.pinned(p, target);
    if (await el.evaluate(secretField)) throw new Error('refused: a password, card or code field. The owner types those themselves.');
    await this.guarded(guard, el);
    await el.fill(String(text));
    return 'typed';
  }

  async press(key, { guard } = {}) {
    const p = await this.page();
    await this.guarded(guard, null);
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
