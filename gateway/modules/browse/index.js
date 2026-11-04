import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from './browser.js';
import { judge } from './guard.js';

// Browsing for the agent. Options (config.modules.browse):
//   identity ('assistant'): the profile name; one Chrome profile per identity
//   browserPath: a Chrome/Chromium binary (default: Playwright's Chromium), proxy: e.g. socks5://127.0.0.1:1080
// Opening and reading pages run freely (public pages only, checked in code). Clicks and typing run
// freely too, except a step that really acts (send, pay, book, Enter in a form): it asks the owner.
// Reading a page taints the conversation: from then on other strong actions ask.
const HERE = path.dirname(fileURLToPath(import.meta.url));

export default function browse(config, { chromium, check } = {}) {
  const identity = String(config.identity || 'assistant').replace(/[^\w-]/g, '_');
  const browser = new Browser({ profileDir: path.join(config.dataDir, 'browser', identity), executablePath: config.browserPath, proxy: config.proxy, chromium, check });
  const outbox = path.join(config.agentCwd, 'outbox');

  const actions = {
    open: (a) => browser.open(a.url),
    text: (a) => browser.text({ max: Math.min(Number(a.max) || 6000, 40000), all: !!a.all }),
    links: (a) => browser.links(a.word),
    click: (a) => browser.click(a.target),
    type: (a) => browser.type(a.target, a.text),
    press: (a) => browser.press(a.key),
    shot: () => browser.shot(path.join(outbox, `page-${Date.now()}.png`)),
  };

  async function api(a) {
    const fn = Object.hasOwn(actions, a.action) && actions[a.action];
    if (!fn) return { ok: false, error: `unknown action ${a.action}` };
    try { return { ok: true, text: await fn(a) }; } catch (e) { return { ok: false, error: String(e.message).split('\n')[0] }; }
  }

  const steps = /^mcp__browse__(click|type|press)$/;
  return {
    mcp: { browse: { command: process.execPath, args: [path.join(HERE, 'mcp.js')] } },
    allowed: ['open', 'text', 'links', 'shot'].map((t) => `mcp__browse__${t}`),
    untrusted: [/^mcp__browse__/],
    autoAllow: (tool, input) => steps.test(tool) && judge(tool, input, browser.url) === 'allow',
    describers: [(tool, i) => (steps.test(tool)
      ? `⚠️🌐 ${browser.url}\n${tool.endsWith('click') ? `Click "${i.target}"` : tool.endsWith('type') ? `Type into "${i.target}": ${String(i.text).slice(0, 200)}` : `Press ${i.key}`}`
      : null)],
    routes: { '/browse': api },
    prompt: '## Browser\nUse mcp__browse__open/text/links/click/type/press/shot for websites (public pages only). Read text first; a screenshot only when layout matters. '
      + 'A page saying LOGIN NEEDED: ask the owner to log in themselves; never type passwords or card numbers. A step that sends, pays or books asks the owner first.',
    browser,
    api,
    stop: () => browser.close(),
  };
}
