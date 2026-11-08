import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { Browser } from '../modules/browse/browser.js';
import { checkUrl, elementInfo, judge, privateIp, secretField } from '../modules/browse/guard.js';
import browse from '../modules/browse/index.js';
import { Approvals } from '../src/approvals.js';
import { hooksOf } from '../src/gateway.js';
import { strings } from '../src/i18n.js';
import { Policy } from '../src/policy.js';
import { Router } from '../src/router.js';
import { MemoryState } from '../src/state.js';

const run = promisify(execFile);
const GATEWAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let tmp;
before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browse-test-'))); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// --- fakes ---------------------------------------------------------------------------------

const lookupTo = (...addresses) => async () => addresses.map((address) => ({ address }));

// A DOM element, enough for guard.secretField and guard.elementInfo. tag is upper case like the
// DOM; form: a truthy object when the element belongs to a form; parent: what closest() returns.
function fakeDom({ tag = 'A', attrs = {}, text = '', type, value, form = null, children = [], parent, doc } = {}) {
  const el = {
    tagName: tag, innerText: text, type: type ?? (tag === 'BUTTON' ? 'submit' : tag === 'INPUT' ? 'text' : undefined), value, form,
    ownerDocument: doc || { getElementById: () => null },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    closest: () => parent || el,
    querySelectorAll: (sel) => (sel.startsWith('img')
      ? children.filter((c) => ['alt', 'aria-label', 'title'].some((k) => c.getAttribute(k)))
      : children.filter((c) => ['BUTTON', 'INPUT'].includes(c.tagName))),
  };
  return el;
}

// A locator: count() and first() after .locator('visible=true'). evaluate(fn) runs fn on `el`.
function fakeLocator({ count = 0, onClick, onFill, secret = false, evalCalls, el: dom } = {}) {
  const node = dom || fakeDom({ attrs: secret ? { type: 'password' } : {} });
  const el = {
    click: async (opts) => onClick?.(opts),
    fill: async (v) => onFill?.(v),
    evaluate: async (fn) => { evalCalls?.push(fn); return typeof fn === 'function' ? fn(node) : undefined; },
  };
  return { locator: (sel) => { assert.equal(sel, 'visible=true'); return { count: async () => count, first: () => el }; } };
}

// A page. `finders` maps the kind of lookup (role:link, role:button, label, text, placeholder, css)
// to a locator (called with the lookup's arguments); every lookup is logged in `calls` in order.
function fakePage({ url = 'https://example.com/', title = 'Example', body = 'Hello Dana', finders = {}, closed = false } = {}) {
  const calls = [];
  const state = { url, title, body, closed };
  const empty = () => fakeLocator({ count: 0 });
  const find = (kind, ...args) => { calls.push([kind, ...args]); return (finders[kind] || empty)(...args); };
  const page = {
    calls, state,
    goto: async (u, opts) => { calls.push(['goto', u, opts]); state.url = u; },
    title: async () => state.title,
    url: () => state.url,
    isClosed: () => state.closed,
    evaluate: async (script) => {
      const s = String(script);
      if (s === '(document.body?.innerText||"").length') return state.body.length;
      if (s.includes('.slice(0,400)')) return state.body.slice(0, 400);
      if (s.includes('querySelectorAll(\'a,button')) return state.links || [];
      return state.body; // CLEAN
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    waitForURL: async (pred, opts) => { calls.push(['waitForURL', opts]); if (state.waitFails) throw new Error('timeout'); },
    keyboard: { press: async (k) => { calls.push(['press', k]); } },
    screenshot: async (opts) => { calls.push(['screenshot', opts]); },
    getByRole: (role, o) => find(`role:${role}`, o),
    getByText: (t, o) => find('text', t, o),
    getByLabel: (t, o) => find('label', t, o),
    getByPlaceholder: (t, o) => find('placeholder', t, o),
    locator: (sel) => find('css', sel),
  };
  return page;
}

function fakeChromium(page, { routeCapture = {} } = {}) {
  const log = { launches: [], cdp: [], ctxClosed: 0, remoteClosed: 0, onClose: null };
  const ctx = {
    route: async (pattern, handler) => { routeCapture.pattern = pattern; routeCapture.handler = handler; },
    on: (ev, fn) => { if (ev === 'close') log.onClose = fn; },
    pages: () => [page],
    newPage: async () => page,
    close: async () => { log.ctxClosed++; },
  };
  const chromium = {
    launchPersistentContext: async (dir, opts) => { log.launches.push({ dir, opts }); return ctx; },
    connectOverCDP: async (url, opts) => { log.cdp.push({ url, opts }); return { contexts: () => [ctx], close: async () => { log.remoteClosed++; } }; },
  };
  return { chromium, ctx, log };
}

const allowAll = async () => null;
const makeBrowser = (page, extra = {}) => {
  const f = fakeChromium(page, extra.capture ? { routeCapture: extra.capture } : {});
  const b = new Browser({ profileDir: path.join(tmp, 'profile'), chromium: f.chromium, check: extra.check || allowAll, ...extra.opts });
  return { b, ...f };
};

// --- guard.privateIp -----------------------------------------------------------------------

describe('guard.privateIp', () => {
  for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '127.8.8.8',
    '169.254.169.254', '100.64.0.1', '100.127.255.254', '0.0.0.0', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1',
    '::ffff:10.1.2.3', '::FFFF:192.168.0.1', '224.0.0.1', '255.255.255.255', 'FE80::ABCD']) {
    test(`private: ${ip}`, () => assert.equal(privateIp(ip), true));
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '100.128.0.1', '100.63.255.255', '11.0.0.1', '192.169.0.1',
    '2606:4700::1111', '::ffff:8.8.8.8', '2001:db8::1']) {
    test(`public: ${ip}`, () => assert.equal(privateIp(ip), false));
  }

  test('IPv4-mapped IPv6 in hex form (what new URL() produces) is private', () => {
    assert.equal(privateIp('::ffff:7f00:1'), true); // = ::ffff:127.0.0.1
    assert.equal(privateIp('::ffff:a9fe:a9fe'), true); // = ::ffff:169.254.169.254
  });
});

// --- guard.checkUrl ------------------------------------------------------------------------

describe('guard.checkUrl', () => {
  const pub = lookupTo('93.184.216.34');

  test('a public https page is fine (null)', async () => {
    assert.equal(await checkUrl('https://example.com/a?b=1', { lookup: pub }), null);
    assert.equal(await checkUrl('http://example.com', { lookup: pub }), null);
  });

  test('the lookup gets the host and { all: true }', async () => {
    const seen = [];
    await checkUrl('https://shop.example.com/x', { lookup: async (h, o) => { seen.push([h, o]); return [{ address: '8.8.8.8' }]; } });
    assert.deepEqual(seen, [['shop.example.com', { all: true }]]);
  });

  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank']) {
    test(`refuses scheme: ${url}`, async () => {
      const why = await checkUrl(url, { lookup: pub });
      assert.ok(why && /only http/.test(why), why);
    });
  }

  test('refuses credentials in the URL', async () => {
    assert.match(await checkUrl('https://dana:secret@example.com/', { lookup: pub }), /credentials/);
    assert.match(await checkUrl('https://dana@example.com/', { lookup: pub }), /credentials/);
  });

  for (const url of ['http://localhost/', 'http://LOCALHOST:3000/', 'https://printer.local/', 'https://db.internal/', 'https://box.tailnet.ts.net/']) {
    test(`refuses local names without any lookup: ${url}`, async () => {
      const lookup = async () => { throw new Error('lookup must not be called'); };
      assert.equal(await checkUrl(url, { lookup }), 'a local address');
    });
  }

  test('a public-looking name that resolves to 127.0.0.1 is refused', async () => {
    assert.equal(await checkUrl('https://evil.example.com/', { lookup: lookupTo('127.0.0.1') }), 'a private or local address');
  });

  test('a name that resolves to the cloud metadata address is refused', async () => {
    assert.equal(await checkUrl('https://meta.example.com/', { lookup: lookupTo('169.254.169.254') }), 'a private or local address');
  });

  test('one private address among several refuses', async () => {
    assert.equal(await checkUrl('https://mixed.example.com/', { lookup: lookupTo('8.8.8.8', '10.0.0.5', '1.1.1.1') }), 'a private or local address');
    assert.equal(await checkUrl('https://mixed.example.com/', { lookup: lookupTo('8.8.8.8', '::1') }), 'a private or local address');
  });

  test('all public addresses (v4 and v6) are fine', async () => {
    assert.equal(await checkUrl('https://dual.example.com/', { lookup: lookupTo('8.8.8.8', '2606:4700::1111') }), null);
  });

  test('a resolve failure (reject) refuses', async () => {
    const why = await checkUrl('https://nope.example.com/', { lookup: async () => { throw new Error('ENOTFOUND'); } });
    assert.equal(why, 'cannot resolve nope.example.com');
  });

  test('an empty answer refuses', async () => {
    assert.equal(await checkUrl('https://empty.example.com/', { lookup: lookupTo() }), 'cannot resolve empty.example.com');
  });

  for (const url of ['http://10.0.0.1/', 'http://192.168.0.1:8080/admin', 'http://127.0.0.1/', 'http://[::1]/', 'http://[::1]:9222/json', 'http://[fe80::1]/', 'http://169.254.169.254/latest/meta-data/']) {
    test(`refuses IP literal ${url} without a lookup`, async () => {
      const lookup = async () => { throw new Error('lookup must not be called'); };
      assert.equal(await checkUrl(url, { lookup }), 'a private or local address');
    });
  }

  test('a public IP literal is fine', async () => {
    const lookup = async () => { throw new Error('lookup must not be called'); };
    assert.equal(await checkUrl('http://8.8.8.8/', { lookup }), null);
    assert.equal(await checkUrl('https://[2606:4700::1111]/', { lookup }), null);
  });

  test('odd IPv4 spellings are normalised by URL and refused', async () => {
    const lookup = async () => [];
    assert.ok(await checkUrl('http://127.1/', { lookup }));
    assert.ok(await checkUrl('http://2130706433/', { lookup }));
    assert.ok(await checkUrl('http://0x7f.0.0.1/', { lookup }));
  });

  test('refuses an invalid URL', async () => {
    assert.equal(await checkUrl('not a url', { lookup: pub }), 'not a valid URL');
    assert.equal(await checkUrl('', { lookup: pub }), 'not a valid URL');
    assert.equal(await checkUrl('example.com', { lookup: pub }), 'not a valid URL');
  });

  test('IPv4-mapped IPv6 literal for loopback / metadata is refused', async () => {
    const lookup = async () => [];
    assert.ok(await checkUrl('http://[::ffff:127.0.0.1]/', { lookup }));
    assert.ok(await checkUrl('http://[::ffff:169.254.169.254]/', { lookup }));
  });
});

// --- guard.judge ---------------------------------------------------------------------------

describe('guard.judge', () => {
  const click = 'mcp__browse__click';
  const type = 'mcp__browse__type';
  const press = 'mcp__browse__press';

  for (const target of ['Submit order', 'Send', 'Pay now', 'הזמן עכשיו', 'לתשלום', 'Comprar', 'Place order', 'Delete account', 'שלח', 'Envoyer', 'Bezahlen']) {
    test(`click "${target}" is critical`, () => assert.equal(judge(click, { target }, 'https://shop.example.com/'), 'critical'));
  }
  for (const target of ['Medium', 'Next page', 'Search', 'Read more', 'Add a comment', 'Login']) {
    test(`click "${target}" is allowed`, () => assert.equal(judge(click, { target }, 'https://shop.example.com/'), 'allow'));
  }

  test('critical words match only whole words (Sender, Postal, Ordering are not "send"/"post"/"order")', () => {
    assert.equal(judge(click, { target: 'Sender list' }), 'allow');
    assert.equal(judge(click, { target: 'Postal codes' }), 'allow');
  });

  test('case does not matter', () => {
    assert.equal(judge(click, { target: 'SEND' }), 'critical');
    assert.equal(judge(click, { target: 'pay NOW' }), 'critical');
  });

  for (const pageUrl of ['https://shop.example.com/checkout', 'https://shop.example.com/cart?x=1', 'https://shop.example.com/payment/step2',
    'https://shop.example.com/pay', 'https://shop.example.com/billing']) {
    test(`any step on ${pageUrl} is critical`, () => {
      assert.equal(judge(click, { target: 'Medium' }, pageUrl), 'critical');
      assert.equal(judge(type, { target: 'Name', text: 'Dana' }, pageUrl), 'critical');
      assert.equal(judge(press, { key: 'Tab' }, pageUrl), 'critical');
    });
  }

  test('an unrelated page does not make steps critical', () => {
    assert.equal(judge(click, { target: 'Medium' }, 'https://shop.example.com/products/shirt'), 'allow');
    assert.equal(judge(click, { target: 'Medium' }), 'allow');
  });

  test('press Enter / Return is critical, any case', () => {
    for (const key of ['Enter', 'enter', 'RETURN', 'Return']) assert.equal(judge(press, { key }, 'https://example.com/'), 'critical');
  });
  test('press Tab / Escape / ArrowDown is allowed', () => {
    for (const key of ['Tab', 'Escape', 'ArrowDown']) assert.equal(judge(press, { key }, 'https://example.com/'), 'allow');
  });
  test('"Enter" only counts for press, not for click', () => {
    assert.equal(judge(click, { target: 'Enter' }), 'allow');
  });

  test('type: the typed text is checked too ("please send" into a field is critical)', () => {
    // Sensible as a safe default (a message box is how things get sent), but it is a false positive for
    // a search box: typing "buy cheap flights" into "Search" asks the owner. See report.
    assert.equal(judge(type, { target: 'Message', text: 'please send' }, 'https://example.com/'), 'critical');
    assert.equal(judge(type, { target: 'Search', text: 'buy cheap flights' }, 'https://example.com/'), 'critical');
    assert.equal(judge(type, { target: 'Search', text: 'blue shirt' }, 'https://example.com/'), 'allow');
  });

  test('tolerates missing input; a missing key asks (only movement keys are free)', () => {
    assert.equal(judge(click, undefined, ''), 'allow');
    assert.equal(judge(press, {}, ''), 'critical');
  });

  test('keys that can submit or act are critical: Control/Meta+Enter, Space, letters, Delete', () => {
    for (const key of ['Control+Enter', 'Meta+Enter', 'Shift+Enter', 'NumpadEnter', 'Space', ' ', '#', 'e', 'Delete', 'Backspace', 'Control+s']) {
      assert.equal(judge(press, { key }, 'https://mail.example.com/'), 'critical', key);
    }
    for (const key of ['Shift+Tab', 'PageDown', 'PageUp', 'Home', 'End', 'ArrowUp', 'arrowleft']) assert.equal(judge(press, { key }), 'allow', key);
  });

  test('the element found decides, not the agent\'s words: a submit button with a neutral name is critical', () => {
    assert.equal(judge(click, { target: 'Go' }, '', { tag: 'button', name: 'Go', submits: true }), 'critical');
    assert.equal(judge(click, { target: 'button[type=submit]' }, '', { tag: 'button', name: 'Continue', submits: true }), 'critical');
    assert.equal(judge(click, { target: '#x' }, '', { tag: 'div', role: 'button', name: 'Send ‪(Ctrl-Enter)‬', submits: false }), 'critical');
    assert.equal(judge(click, { target: 'Medium' }, '', { tag: 'a', name: 'Medium', submits: false }), 'allow');
  });

  test('type does not judge the field\'s name (filling does not submit), only the words', () => {
    assert.equal(judge(type, { target: 'To', text: 'dana@example.com' }, '', { tag: 'input', name: 'Send to', submits: false }), 'allow');
  });

  test('send words in more languages', () => {
    for (const target of ['إرسال', 'Отправить', 'Invia', 'Verzenden', 'Share', 'שתף']) assert.equal(judge(click, { target }), 'critical', target);
  });

  test('other step tools (select, upload, submit) are always critical', () => {
    for (const t of ['select', 'upload', 'submit']) assert.equal(judge(`mcp__browse__${t}`, { target: 'Medium' }), 'critical', t);
  });
});

// --- guard.elementInfo ---------------------------------------------------------------------

describe('guard.elementInfo', () => {
  const form = {};
  test('a <button> in a form without a type submits (the DOM default), whatever its name', () => {
    assert.deepEqual(elementInfo(fakeDom({ tag: 'BUTTON', text: 'Go', form })), { tag: 'button', role: '', name: 'Go', submits: true });
  });
  test('a type=button in a form, or a button outside any form, does not submit', () => {
    assert.equal(elementInfo(fakeDom({ tag: 'BUTTON', type: 'button', text: 'Go', form })).submits, false);
    assert.equal(elementInfo(fakeDom({ tag: 'BUTTON', text: 'Go' })).submits, false);
  });
  test('input type=submit / image in a form submits; its value is its name', () => {
    const i = elementInfo(fakeDom({ tag: 'INPUT', type: 'submit', value: 'Weiter', form }));
    assert.equal(i.submits, true);
    assert.equal(i.name, 'Weiter');
    assert.equal(elementInfo(fakeDom({ tag: 'INPUT', type: 'image', form })).submits, true);
  });
  test('a text input does not show its typed value as a name', () => {
    assert.equal(elementInfo(fakeDom({ tag: 'INPUT', type: 'text', value: 'please send it', form })).name, '');
  });
  test('a span inside a button is judged as the button (closest)', () => {
    const button = fakeDom({ tag: 'BUTTON', text: 'Send', form });
    const i = elementInfo(fakeDom({ tag: 'SPAN', text: 'Se', parent: button }));
    assert.equal(i.tag, 'button');
    assert.equal(i.name, 'Send');
    assert.equal(i.submits, true);
  });
  test('an icon button: aria-label, aria-labelledby and an inner img alt make the name', () => {
    const doc = { getElementById: (id) => (id === 'l1' ? { textContent: 'Post now' } : null) };
    const icon = fakeDom({ tag: 'IMG', attrs: { alt: 'Paper plane' } });
    const i = elementInfo(fakeDom({ tag: 'DIV', attrs: { role: 'button', 'aria-label': 'Send', 'aria-labelledby': 'l1 missing' }, children: [icon], doc }));
    assert.equal(i.role, 'button');
    assert.equal(i.name, 'Send Post now Paper plane');
  });
  test('a wrapper that holds a submit button counts as submitting (a click hits its middle)', () => {
    const inner = fakeDom({ tag: 'BUTTON', text: 'Go', form });
    assert.equal(elementInfo(fakeDom({ tag: 'DIV', text: 'Go', children: [inner] })).submits, true);
  });
  test('a label clicks its control', () => {
    const control = fakeDom({ tag: 'INPUT', type: 'submit', value: 'OK', form });
    const label = fakeDom({ tag: 'LABEL', text: 'OK' });
    label.control = control;
    assert.equal(elementInfo(label).submits, true);
  });
});

// --- guard.secretField ---------------------------------------------------------------------

describe('guard.secretField', () => {
  const el = (attrs) => ({ getAttribute: (k) => (k in attrs ? attrs[k] : null) });

  for (const attrs of [{ type: 'password' }, { type: 'PASSWORD' }, { autocomplete: 'cc-number' }, { autocomplete: 'cc-csc' }, { name: 'cvv' }, { name: 'CVC' },
    { id: 'card_number' }, { id: 'cardnumber' }, { placeholder: 'סיסמה' }, { 'aria-label': 'Security code' }, { autocomplete: 'one-time-code' },
    { name: 'otp' }, { name: 'iban' }, { placeholder: 'מספר כרטיס אשראי' }, { placeholder: 'קוד אבטחה' }, { name: 'user_password' }, { name: 'pin' }]) {
    test(`secret: ${JSON.stringify(attrs)}`, () => assert.equal(secretField(el(attrs)), true));
  }
  for (const attrs of [{ name: 'email' }, { name: 'username' }, { name: 'q' }, { type: 'text', id: 'first_name', placeholder: 'Dana' }, {}, { name: 'search', type: 'search' }]) {
    test(`not secret: ${JSON.stringify(attrs)}`, () => assert.equal(secretField(el(attrs)), false));
  }
  test('"pin" matches only as a word (pinterest, shipping are not secret)', () => {
    assert.equal(secretField(el({ name: 'pinterest_url' })), false);
    assert.equal(secretField(el({ name: 'shipping_address' })), false);
  });
  test('"otp" inside another word is treated as secret (known over-match, safe direction)', () => {
    assert.equal(secretField(el({ name: 'hotpot' })), true);
  });
});

// --- Browser -------------------------------------------------------------------------------

describe('Browser.open', () => {
  test('refuses a private URL without calling goto (and without launching Chrome)', async () => {
    const page = fakePage();
    const { b, log } = makeBrowser(page, { check: (u) => checkUrl(u, { lookup: lookupTo('127.0.0.1') }) });
    await assert.rejects(b.open('https://evil.example.com/'), /^Error: refused: a private or local address$/);
    assert.equal(page.calls.filter((c) => c[0] === 'goto').length, 0);
    assert.equal(log.launches.length, 0);
  });

  test('refuses file: without calling goto', async () => {
    const page = fakePage();
    const { b } = makeBrowser(page, { check: (u) => checkUrl(u, { lookup: lookupTo('8.8.8.8') }) });
    await assert.rejects(b.open('file:///etc/passwd'), /refused: only http/);
    assert.equal(page.calls.length, 0);
  });

  test('a public URL calls goto and returns "title | url" then the text', async () => {
    const page = fakePage({ title: 'Dana Shop', body: 'Welcome to the shop of Dana' });
    const { b } = makeBrowser(page);
    const out = await b.open('https://shop.example.com/');
    const goto = page.calls.find((c) => c[0] === 'goto');
    assert.deepEqual(goto.slice(0, 2), ['goto', 'https://shop.example.com/']);
    assert.equal(goto[2].waitUntil, 'domcontentloaded');
    assert.equal(out, 'Dana Shop | https://shop.example.com/\nWelcome to the shop of Dana');
    assert.equal(b.url, 'https://shop.example.com/');
  });

  test('the check receives the requested URL', async () => {
    const seen = [];
    const { b } = makeBrowser(fakePage(), { check: async (u) => { seen.push(u); return null; } });
    await b.open('https://example.com/x');
    assert.deepEqual(seen, ['https://example.com/x']);
  });
});

describe('Browser context route (navigation guard)', () => {
  async function routed(check) {
    const capture = {};
    const { b } = makeBrowser(fakePage(), { capture, check });
    await b.context();
    const route = (url, nav) => {
      const r = { aborted: null, continued: 0 };
      return {
        r,
        route: { request: () => ({ isNavigationRequest: () => nav, url: () => url }), abort: async (why) => { r.aborted = why; }, continue: async () => { r.continued++; } },
      };
    };
    return { capture, route };
  }

  test('registers one handler for **/*', async () => {
    const { capture } = await routed(allowAll);
    assert.equal(capture.pattern, '**/*');
    assert.equal(typeof capture.handler, 'function');
  });

  test('aborts a navigation to a blocked URL with blockedbyclient', async () => {
    const { capture, route } = await routed(async (u) => (u.includes('127.0.0.1') ? 'a private or local address' : null));
    const x = route('http://127.0.0.1:9222/json', true);
    await capture.handler(x.route);
    assert.equal(x.r.aborted, 'blockedbyclient');
    assert.equal(x.r.continued, 0);
  });

  test('continues a navigation to a public URL', async () => {
    const { capture, route } = await routed(allowAll);
    const x = route('https://example.com/', true);
    await capture.handler(x.route);
    assert.equal(x.r.aborted, null);
    assert.equal(x.r.continued, 1);
  });

  // The real checkUrl, with DNS answers per host.
  const dnsTo = (map) => (u) => checkUrl(u, { lookup: async (h) => (map[h] || ['93.184.216.34']).map((address) => ({ address })) });

  for (const url of ['http://192.168.1.1/admin', 'http://127.0.0.1:8080/api', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:9222/json',
    'https://router.example.com/x.png', 'https://localhost/x.js']) {
    test(`a page's own request (image, script, fetch) to ${url} is aborted`, async () => {
      const { capture, route } = await routed(dnsTo({ 'router.example.com': ['192.168.0.1'] }));
      const x = route(url, false);
      await capture.handler(x.route);
      assert.equal(x.r.aborted, 'blockedbyclient');
      assert.equal(x.r.continued, 0);
    });
  }

  test('a page\'s request to a public host continues', async () => {
    const { capture, route } = await routed(dnsTo({}));
    const x = route('https://cdn.example.com/app.js', false);
    await capture.handler(x.route);
    assert.equal(x.r.continued, 1);
  });

  test('data: and blob: requests need no check (no network)', async () => {
    let checked = 0;
    const { capture, route } = await routed(async () => { checked++; return 'blocked'; });
    for (const u of ['data:image/png;base64,AAAA', 'blob:https://example.com/123']) {
      const x = route(u, false);
      await capture.handler(x.route);
      assert.equal(x.r.continued, 1, u);
    }
    assert.equal(checked, 0);
  });

  test('a check that throws aborts (fails closed)', async () => {
    const { capture, route } = await routed(async () => { throw new Error('dns down'); });
    for (const nav of [true, false]) {
      const x = route('https://example.com/a', nav);
      await capture.handler(x.route);
      assert.equal(x.r.aborted, 'blockedbyclient');
    }
  });

  test('page files: one check per origin for 30 s; page loads are checked every time', async () => {
    const seen = [];
    const capture = {};
    const { b } = makeBrowser(fakePage(), { capture, check: async (u) => { seen.push(u); return null; } });
    await b.context();
    assert.equal(await b.checkHost('https://cdn.example.com/a.js', 1000), null);
    await b.checkHost('https://cdn.example.com/b.css', 2000);
    await b.checkHost('https://cdn.example.com:8443/c', 2000); // another origin
    assert.equal(seen.length, 2);
    await b.checkHost('https://cdn.example.com/d.js', 1000 + 31_000);
    assert.equal(seen.length, 3);
    const nav = { request: () => ({ isNavigationRequest: () => true, url: () => 'https://cdn.example.com/' }), abort: async () => {}, continue: async () => {} };
    await capture.handler(nav);
    await capture.handler(nav);
    assert.equal(seen.length, 5);
  });

  test('credentials in a page file URL are refused (no lookup)', async () => {
    const { capture, route } = await routed(checkUrl);
    const x = route('https://dana:pw@example.com/x', false);
    await capture.handler(x.route);
    assert.equal(x.r.aborted, 'blockedbyclient');
  });
});

describe('Browser modes', () => {
  test('launch mode passes profileDir, headless, viewport and no CDP', async () => {
    const page = fakePage();
    const f = fakeChromium(page);
    const profileDir = path.join(tmp, 'profile-launch', 'dana');
    const b = new Browser({ profileDir, chromium: f.chromium, check: allowAll, headless: false, executablePath: '/opt/chrome' });
    await b.page();
    assert.equal(f.log.cdp.length, 0);
    assert.equal(f.log.launches.length, 1);
    assert.equal(f.log.launches[0].dir, profileDir);
    assert.equal(f.log.launches[0].opts.headless, false);
    assert.equal(f.log.launches[0].opts.executablePath, '/opt/chrome');
    assert.deepEqual(f.log.launches[0].opts.viewport, { width: 1280, height: 900 });
    assert.equal(f.log.launches[0].opts.serviceWorkers, 'block', 'a service worker\'s requests would skip the route');
    assert.ok(fs.statSync(profileDir).isDirectory());
    assert.equal(fs.statSync(profileDir).mode & 0o077, 0, 'profile dir is private');
  });

  test('launch mode is headless by default and adds the proxy only when set', async () => {
    const f1 = fakeChromium(fakePage());
    await new Browser({ profileDir: path.join(tmp, 'p1'), chromium: f1.chromium, check: allowAll }).context();
    assert.equal(f1.log.launches[0].opts.headless, true);
    assert.equal('proxy' in f1.log.launches[0].opts, false);
    const f2 = fakeChromium(fakePage());
    await new Browser({ profileDir: path.join(tmp, 'p2'), chromium: f2.chromium, check: allowAll, proxy: 'socks5://127.0.0.1:1080' }).context();
    assert.deepEqual(f2.log.launches[0].opts.proxy, { server: 'socks5://127.0.0.1:1080' });
  });

  test('the context is created once', async () => {
    const f = fakeChromium(fakePage());
    const b = new Browser({ profileDir: path.join(tmp, 'p3'), chromium: f.chromium, check: allowAll });
    await Promise.all([b.page(), b.page()].map((p) => p.catch(() => {})));
    await b.page();
    assert.ok(f.log.launches.length >= 1);
    const n = f.log.launches.length;
    await b.page();
    assert.equal(f.log.launches.length, n);
  });

  test('cdpUrl mode uses connectOverCDP, never launches, and does not create a profile dir', async () => {
    const f = fakeChromium(fakePage());
    const profileDir = path.join(tmp, 'never-created');
    const b = new Browser({ profileDir, chromium: f.chromium, check: allowAll, cdpUrl: 'http://127.0.0.1:9333' });
    await b.page();
    assert.equal(f.log.launches.length, 0);
    assert.equal(f.log.cdp.length, 1);
    assert.equal(f.log.cdp[0].url, 'http://127.0.0.1:9333');
    assert.equal(fs.existsSync(profileDir), false);
  });

  test('cdpUrl mode: close() closes the remote connection, not the context', async () => {
    const f = fakeChromium(fakePage());
    const b = new Browser({ chromium: f.chromium, check: allowAll, cdpUrl: 'http://127.0.0.1:9333' });
    await b.page();
    await b.close();
    assert.equal(f.log.remoteClosed, 1);
    assert.equal(f.log.ctxClosed, 0);
    assert.equal(b.ctx, null);
    assert.equal(b.pg, null);
    assert.equal(b.remote, null);
  });

  test('launch mode: close() closes the context; a second close is harmless', async () => {
    const f = fakeChromium(fakePage());
    const b = new Browser({ profileDir: path.join(tmp, 'p4'), chromium: f.chromium, check: allowAll });
    await b.page();
    await b.close();
    await b.close();
    assert.equal(f.log.ctxClosed, 1);
    assert.equal(f.log.remoteClosed, 0);
  });

  test('when the context closes by itself the next call makes a fresh one', async () => {
    const f = fakeChromium(fakePage());
    const b = new Browser({ profileDir: path.join(tmp, 'p5'), chromium: f.chromium, check: allowAll });
    await b.page();
    f.log.onClose();
    assert.equal(b.ctx, null);
    await b.page();
    assert.equal(f.log.launches.length, 2);
  });

  test('a closed page is replaced by an open one from the context', async () => {
    const page = fakePage();
    const { b } = makeBrowser(page);
    assert.equal(await b.page(), page);
    page.state.closed = true;
    const fresh = fakePage();
    b.ctx.pages = () => [page, fresh];
    assert.equal(await b.page(), fresh);
  });
});

describe('Browser.text and walls', () => {
  test('plain text has no wall line', async () => {
    const { b } = makeBrowser(fakePage({ body: 'just text' }));
    assert.equal(await b.text(), 'just text');
  });

  test('a login URL gives LOGIN NEEDED with the host, then the text', async () => {
    const { b } = makeBrowser(fakePage({ url: 'https://accounts.google.com/v3/signin/identifier', body: 'Sign in' }));
    const t = await b.text();
    assert.match(t, /^LOGIN NEEDED: accounts\.google\.com\. Ask the owner to log in/);
    assert.match(t, /do not type credentials/);
    assert.ok(t.endsWith('\nSign in'));
  });

  for (const url of ['https://site.example.com/login', 'https://site.example.com/signin?next=/', 'https://site.example.com/auth/start', 'https://site.example.com/challenge']) {
    test(`login URL detected: ${url}`, async () => {
      const { b } = makeBrowser(fakePage({ url }));
      assert.match(await b.text(), /^LOGIN NEEDED: site\.example\.com/);
    });
  }

  for (const [title, body] of [['Just a moment...', 'Checking'], ['Site', 'Please complete the CAPTCHA'], ['Attention Required! | Cloudflare', ''],
    ['Site', 'Verifying you are human'], ['Site', 'Radware Bot Manager'], ['Site', 'unusual traffic from your computer network']]) {
    test(`bot check detected: ${title} / ${body}`, async () => {
      const { b } = makeBrowser(fakePage({ url: 'https://site.example.com/page', title, body }));
      assert.match(await b.text(), /^BLOCKED: a bot check on site\.example\.com\. Do not retry in a loop\./);
    });
  }

  test('a bot-check phrase after the first 400 chars is not a wall', async () => {
    const { b } = makeBrowser(fakePage({ body: `${'x'.repeat(500)} captcha` }));
    assert.doesNotMatch(await b.text({ max: 10000 }), /^BLOCKED/);
  });

  test('LOGIN wins over BLOCKED (login URL is checked first)', async () => {
    const { b } = makeBrowser(fakePage({ url: 'https://site.example.com/login', title: 'Just a moment' }));
    assert.match(await b.text(), /^LOGIN NEEDED/);
  });

  test('text is cut at max with a note', async () => {
    const { b } = makeBrowser(fakePage({ body: 'a'.repeat(300) }));
    const t = await b.text({ max: 100 });
    assert.ok(t.startsWith('a'.repeat(100)));
    assert.match(t, /… \(300 chars; ask for more with max\)$/);
  });

  test('all=true is passed into the page script', async () => {
    const page = fakePage();
    const seen = [];
    const orig = page.evaluate;
    page.evaluate = async (s) => { seen.push(String(s)); return orig(s); };
    const { b } = makeBrowser(page);
    await b.text({ all: true });
    assert.ok(seen.some((s) => s.endsWith('(true)')));
    await b.text();
    assert.ok(seen.some((s) => s.endsWith('(false)')));
  });
});

describe('Browser.links', () => {
  test('filters by word, case-insensitively, and says "no match"', async () => {
    const page = fakePage();
    page.state.links = ['Home -> https://example.com/', 'Medium -> (button)', 'Contact Dana -> https://example.com/c'];
    const { b } = makeBrowser(page);
    assert.equal(await b.links(), 'Home -> https://example.com/\nMedium -> (button)\nContact Dana -> https://example.com/c');
    assert.equal(await b.links('dana'), 'Contact Dana -> https://example.com/c');
    assert.equal(await b.links('zzz'), 'no match');
  });
});

describe('Browser.click / find', () => {
  const hit = (onClick) => () => fakeLocator({ count: 1, onClick });

  test('tries the lookups in the documented order and errors when none is visible', async () => {
    const page = fakePage();
    const { b } = makeBrowser(page);
    await assert.rejects(b.click('Medium'), /^Error: nothing visible matches "Medium"; look at links$/);
    assert.deepEqual(page.calls.map((c) => c[0]), ['role:link', 'role:button', 'label', 'text', 'placeholder', 'css']);
    assert.equal(page.calls[0][1].name, 'Medium');
  });

  test('every name lookup is exact (no loose part-of-name match)', async () => {
    const page = fakePage();
    const { b } = makeBrowser(page);
    await assert.rejects(b.click('Medium'));
    for (const c of page.calls.filter((x) => x[0] !== 'css')) assert.equal(c.at(-1)?.exact, true, c[0]);
  });

  test('click "Sen" does not click "Send" (Playwright\'s loose match would)', async () => {
    const clicked = [];
    // Like Playwright: exact compares the whole name, loose takes a part of it.
    const send = (o) => fakeLocator({ count: (o.exact ? o.name === 'Send' : 'Send'.includes(o.name)) ? 1 : 0, onClick: () => clicked.push('Send') });
    const page = fakePage({ finders: { 'role:button': send } });
    const { b } = makeBrowser(page);
    await assert.rejects(b.click('Sen'), /nothing visible matches "Sen"/);
    assert.deepEqual(clicked, []);
    await b.click('Send');
    assert.deepEqual(clicked, ['Send']);
  });

  test('a guard sees the element found and can stop the click before it happens', async () => {
    const clicked = [];
    const el = fakeDom({ tag: 'BUTTON', text: 'Go', form: {} });
    const page = fakePage({ finders: { css: () => fakeLocator({ count: 1, el, onClick: () => clicked.push('go') }) } });
    const { b } = makeBrowser(page);
    const seen = [];
    await assert.rejects(b.click('button[type=submit]', { guard: (i) => { seen.push(i); return i.submits ? 'it submits' : null; } }), /^Error: refused: it submits$/);
    assert.deepEqual(clicked, []);
    assert.deepEqual(seen, [{ tag: 'button', role: '', name: 'Go', submits: true }]);
  });

  test('a guard fails closed when the element cannot be read', async () => {
    const page = fakePage({ finders: { css: () => fakeLocator({ count: 1, el: { closest: () => { throw new Error('detached'); } } }) } });
    const { b } = makeBrowser(page);
    await assert.rejects(b.click('#x', { guard: () => null }), /refused: cannot read the element/);
  });

  test('the click goes to the element handle when there is one (pinned, not looked up again)', async () => {
    const clicked = [];
    const loc = fakeLocator({ count: 1, onClick: () => clicked.push('locator') });
    const first = loc.locator('visible=true').first();
    first.elementHandle = async () => ({ evaluate: first.evaluate, click: async () => clicked.push('handle') });
    const page = fakePage({ finders: { 'role:link': () => ({ locator: () => ({ count: async () => 1, first: () => first }) }) } });
    const { b } = makeBrowser(page);
    await b.click('Medium');
    assert.deepEqual(clicked, ['handle']);
  });

  test('stops at the first lookup with a visible element', async () => {
    const clicked = [];
    const page = fakePage({ finders: { 'role:button': hit(() => clicked.push('button')) } });
    const { b } = makeBrowser(page);
    const out = await b.click('Medium');
    assert.deepEqual(clicked, ['button']);
    assert.deepEqual(page.calls.map((c) => c[0]).filter((k) => k.startsWith('role') || k === 'css'), ['role:link', 'role:button']);
    assert.match(out, /^clicked; now https:\/\/example\.com\//);
  });

  test('falls back to a CSS selector last', async () => {
    const clicked = [];
    const page = fakePage({ finders: { css: hit(() => clicked.push('css')) } });
    const { b } = makeBrowser(page);
    await b.click('#buy');
    assert.deepEqual(clicked, ['css']);
    assert.equal(page.calls.at(-1)[0], 'waitForURL');
  });

  test('a lookup that throws (bad selector) is skipped', async () => {
    const clicked = [];
    const page = fakePage({ finders: { 'role:link': () => { throw new Error('bad'); }, label: hit(() => clicked.push('label')) } });
    const { b } = makeBrowser(page);
    await b.click('Medium');
    assert.deepEqual(clicked, ['label']);
  });

  test('a throwing css selector at the end still gives the "nothing visible" error', async () => {
    const page = fakePage({ finders: { css: () => { throw new Error('invalid selector'); } } });
    const { b } = makeBrowser(page);
    await assert.rejects(b.click('<<<'), /nothing visible matches "<<<"/);
  });

  test('click passes a timeout and reports the new URL and a wall if any', async () => {
    const opts = [];
    const page = fakePage({ finders: { 'role:link': hit((o) => { opts.push(o); page.state.url = 'https://site.example.com/login'; }) } });
    const { b } = makeBrowser(page);
    const out = await b.click('Account');
    assert.deepEqual(opts, [{ timeout: 10000 }]);
    assert.match(out, /^clicked; now https:\/\/site\.example\.com\/login\nLOGIN NEEDED: site\.example\.com/);
    assert.equal(b.url, 'https://site.example.com/login');
  });

  test('click does not fail when the URL does not change (waitForURL times out)', async () => {
    const page = fakePage({ finders: { 'role:link': hit(() => {}) } });
    page.state.waitFails = true;
    const { b } = makeBrowser(page);
    assert.match(await b.click('Same page'), /^clicked; now https:\/\/example\.com\/$/);
  });
});

describe('Browser.type', () => {
  test('refuses when the element is a secret field and never fills it', async () => {
    const filled = [];
    const page = fakePage({ finders: { label: () => fakeLocator({ count: 1, secret: true, onFill: (v) => filled.push(v) }) } });
    const { b } = makeBrowser(page);
    await assert.rejects(b.type('Password', 'hunter2'), /^Error: refused: a password, card or code field\. The owner types those themselves\.$/);
    assert.deepEqual(filled, []);
  });

  test('evaluates the real secretField function in the page', async () => {
    const evalCalls = [];
    const page = fakePage({ finders: { label: () => fakeLocator({ count: 1, evalCalls }) } });
    const { b } = makeBrowser(page);
    await b.type('Name', 'Dana');
    assert.equal(evalCalls[0], secretField);
  });

  test('fills a normal field and returns "typed"', async () => {
    const filled = [];
    const page = fakePage({ finders: { label: () => fakeLocator({ count: 1, onFill: (v) => filled.push(v) }) } });
    const { b } = makeBrowser(page);
    assert.equal(await b.type('Name', 'Dana'), 'typed');
    assert.deepEqual(filled, ['Dana']);
  });

  test('text is converted to a string', async () => {
    const filled = [];
    const page = fakePage({ finders: { label: () => fakeLocator({ count: 1, onFill: (v) => filled.push(v) }) } });
    const { b } = makeBrowser(page);
    await b.type('Age', 42);
    assert.deepEqual(filled, ['42']);
  });

  test('errors when the field is not found', async () => {
    const { b } = makeBrowser(fakePage());
    await assert.rejects(b.type('Nowhere', 'x'), /nothing visible matches "Nowhere"/);
  });
});

describe('Browser.press / shot', () => {
  test('press sends the key and reports the URL', async () => {
    const page = fakePage();
    const { b } = makeBrowser(page);
    assert.equal(await b.press('Tab'), 'pressed Tab; now https://example.com/');
    assert.deepEqual(page.calls.find((c) => c[0] === 'press'), ['press', 'Tab']);
  });

  test('shot creates the folder and returns the path', async () => {
    const page = fakePage();
    const { b } = makeBrowser(page);
    const file = path.join(tmp, 'shots', 'deep', 'p.png');
    assert.equal(await b.shot(file), file);
    assert.ok(fs.statSync(path.dirname(file)).isDirectory());
    assert.deepEqual(page.calls.find((c) => c[0] === 'screenshot'), ['screenshot', { path: file }]);
  });
});

// --- Module --------------------------------------------------------------------------------

describe('browse module', () => {
  let n = 0;
  function make(over = {}, extra = {}) {
    const dir = path.join(tmp, `mod-${n++}`);
    const page = over.page || fakePage();
    const f = fakeChromium(page);
    const mod = browse({ dataDir: path.join(dir, 'data'), agentCwd: path.join(dir, 'agent'), ...extra }, { chromium: f.chromium, check: over.check || allowAll });
    return { mod, page, f, dir };
  }

  test('allowed is text/links/shot only: open must reach the gateway', () => {
    const { mod } = make();
    assert.deepEqual(mod.allowed, ['mcp__browse__text', 'mcp__browse__links', 'mcp__browse__shot']);
    for (const t of ['open', 'click', 'type', 'press']) assert.ok(!mod.allowed.includes(`mcp__browse__${t}`));
  });

  test('untrusted matches every mcp__browse__ tool and nothing else', () => {
    const { mod } = make();
    const hit = (t) => mod.untrusted.some((r) => r.test(t));
    for (const t of ['open', 'text', 'links', 'click', 'type', 'press', 'shot', 'anything']) assert.ok(hit(`mcp__browse__${t}`), t);
    assert.ok(!hit('mcp__other__open'));
    assert.ok(!hit('Read'));
  });

  test('autoAllow passes only open: steps are judged on the live page by approve()', () => {
    const { mod } = make();
    mod.browser.url = 'https://shop.example.com/product/shirt';
    for (const [t, i] of [['click', { target: 'Medium' }], ['press', { key: 'Tab' }], ['type', { target: 'Name', text: 'Dana' }]]) {
      assert.equal(mod.autoAllow(`mcp__browse__${t}`, i), false, t);
    }
    assert.equal(mod.autoAllow('mcp__browse__bogus', {}), false);
    assert.equal(mod.autoAllow('mcp__other__open', { url: 'https://example.com' }), false);
  });

  test('open: free before any page was read; once tainted only an address that carries nothing out', () => {
    const { mod } = make();
    const open = (url, tainted) => mod.autoAllow('mcp__browse__open', { url }, { tainted });
    assert.equal(open('https://evil.example.com/?d=secret', false), true);
    assert.equal(open('https://example.com/news', true), true);
    for (const url of ['https://evil.example.com/?d=secret', 'https://evil.example.com/#d=secret', `https://evil.example.com/${'a'.repeat(40)}`,
      'https://dana:pw@evil.example.com/', 'not a url', undefined]) {
      assert.equal(open(url, true), false, url);
    }
  });

  // A page with a "Medium" link and whatever `css` finds; `url` is where the page is.
  async function live({ css, url = 'https://shop.example.com/p', onClick } = {}) {
    const clicked = [];
    const finders = {
      'role:link': (o) => fakeLocator({ count: o.name === 'Medium' ? 1 : 0, el: fakeDom({ tag: 'A', text: 'Medium' }), onClick: () => { clicked.push('Medium'); onClick?.(); } }),
      ...(css && { css: () => fakeLocator({ count: 1, el: css, onClick: () => clicked.push('css') }) }),
    };
    const page = fakePage({ url, finders });
    const m = make({ page });
    await m.mod.api({ action: 'open', url });
    return { ...m, clicked };
  }
  const ask = (mod, tool, input, tainted = false) => mod.approve({ tool_name: `mcp__browse__${tool}`, input, tainted });

  test('approve: an untainted click on a plain link is free', async () => {
    const { mod } = await live();
    assert.deepEqual(await ask(mod, 'click', { target: 'Medium' }), { allow: true, reason: 'free' });
  });

  test('approve: a submit button found by a neutral name or selector asks the owner', async () => {
    const { mod } = await live({ css: fakeDom({ tag: 'BUTTON', text: 'Continue', form: {} }) });
    assert.equal(await ask(mod, 'click', { target: 'button[type=submit]' }), null);
    assert.match(mod.describers[0]('mcp__browse__click', { target: 'button[type=submit]' }), /Click "button\[type=submit\]" → button "Continue" \(submits a form\)$/);
  });

  test('approve: an icon button named Send by aria-label asks, though the selector is neutral', async () => {
    const { mod } = await live({ css: fakeDom({ tag: 'DIV', attrs: { role: 'button', 'aria-label': 'Send' } }) });
    assert.equal(await ask(mod, 'click', { target: 'div.T-I' }), null);
  });

  test('approve: in a tainted conversation a step that does not act stays free; long typing asks', async () => {
    const { mod } = await live();
    for (const [t, i] of [['click', { target: 'Medium' }], ['type', { target: 'Search', text: 'shirts' }], ['press', { key: 'Tab' }]]) {
      assert.deepEqual(await ask(mod, t, i, true), { allow: true, reason: 'free' }, t);
    }
    assert.equal(await ask(mod, 'type', { target: 'Search', text: 'x'.repeat(61) }, true), null, 'long text asks');
    assert.deepEqual(await ask(mod, 'type', { target: 'Search', text: 'x'.repeat(61) }, false), { allow: true, reason: 'free' });
  });

  test('approve: keys that can submit ask (Enter, Control+Enter, Meta+Enter); Tab is free', async () => {
    const { mod } = await live();
    for (const key of ['Enter', 'Control+Enter', 'Meta+Enter', 'Space']) assert.equal(await ask(mod, 'press', { key }), null, key);
    assert.deepEqual(await ask(mod, 'press', { key: 'Tab' }), { allow: true, reason: 'free' });
  });

  test('approve: a checkout page makes every step ask; other tools are not its business', async () => {
    const { mod } = await live({ url: 'https://shop.example.com/checkout' });
    assert.equal(await ask(mod, 'click', { target: 'Medium' }), null);
    assert.equal(await mod.approve({ tool_name: 'Bash', input: { command: 'ls' }, tainted: false }), null);
  });

  test('a click the approval step passed is judged again on the element at click time', async () => {
    const send = fakeDom({ tag: 'BUTTON', text: 'Send', form: {} });
    const { mod, page, clicked } = await live();
    const input = { target: 'Medium' };
    assert.equal((await ask(mod, 'click', input)).allow, true);
    mod.approved({ tool_name: 'mcp__browse__click', input });
    // The page swapped the link for a Send button in between.
    const swapped = { 'role:link': () => fakeLocator({ count: 1, el: send, onClick: () => clicked.push('Send') }) };
    page.getByRole = (role, o) => (swapped[`role:${role}`] || (() => fakeLocator()))(o);
    const r = await mod.api({ action: 'click', ...input });
    assert.equal(r.ok, false);
    assert.match(r.error, /^refused: this step acts \(submits a form, "Send"\), so the owner must approve it/);
    assert.deepEqual(clicked, []);
  });

  test('a step the owner approved runs once without the second judgement', async () => {
    const { mod, clicked } = await live({ css: fakeDom({ tag: 'BUTTON', text: 'Go', form: {} }) });
    const input = { target: '#go' };
    assert.equal(await ask(mod, 'click', input), null); // asks; the owner says yes:
    mod.approved({ tool_name: 'mcp__browse__click', input });
    assert.equal((await mod.api({ action: 'click', ...input })).ok, true);
    assert.deepEqual(clicked, ['css']);
    const again = await mod.api({ action: 'click', ...input }); // the yes was for one call
    assert.equal(again.ok, false);
    assert.match(again.error, /^refused: this step acts/);
    assert.deepEqual(clicked, ['css']);
  });

  test('a step that reaches the route without any approval is judged too (press Control+Enter)', async () => {
    const { mod, page } = await live();
    const r = await mod.api({ action: 'press', key: 'Control+Enter' });
    assert.equal(r.ok, false);
    assert.match(r.error, /^refused: this step acts/);
    assert.equal(page.calls.some((c) => c[0] === 'press'), false);
    assert.equal((await mod.api({ action: 'press', key: 'Tab' })).ok, true);
  });

  test('a click that lands on /cart makes the next click ask', async () => {
    const { mod, page } = await live({ onClick: () => { page.state.url = 'https://shop.example.com/cart'; } });
    assert.equal((await ask(mod, 'click', { target: 'Medium' })).allow, true);
    assert.equal((await mod.api({ action: 'click', target: 'Medium' })).ok, true);
    assert.equal(mod.browser.url, 'https://shop.example.com/cart');
    assert.equal(await ask(mod, 'click', { target: 'Medium' }), null);
  });

  test('approve does not start Chrome: with no page open it judges the words only', async () => {
    const { mod, f } = make();
    assert.deepEqual(await ask(mod, 'click', { target: 'Medium' }), { allow: true, reason: 'free' });
    assert.equal(await ask(mod, 'click', { target: 'Send' }), null);
    assert.equal(f.log.launches.length, 0);
  });

  test('describers show the page URL and the target for click/type/press, open\'s address, null for others', () => {
    const { mod } = make();
    mod.browser.url = 'https://shop.example.com/p';
    const d = mod.describers[0];
    assert.equal(d('mcp__browse__click', { target: 'Submit order' }), '⚠️🌐 https://shop.example.com/p\nClick "Submit order"');
    assert.equal(d('mcp__browse__type', { target: 'Note', text: 'Hi Dana' }), '⚠️🌐 https://shop.example.com/p\nType into "Note": Hi Dana');
    assert.equal(d('mcp__browse__press', { key: 'Enter' }), '⚠️🌐 https://shop.example.com/p\nPress Enter');
    assert.equal(d('mcp__browse__open', { url: 'https://evil.example.com/?d=x' }), '⚠️🌐 Open https://evil.example.com/?d=x');
    for (const t of ['text', 'links', 'shot', 'unknown']) assert.equal(d(`mcp__browse__${t}`, {}), null);
    assert.equal(d('Bash', { command: 'ls' }), null);
  });

  test('describer shows all the typed text: never a hidden tail', () => {
    const { mod } = make();
    const out = mod.describers[0]('mcp__browse__type', { target: 'Note', text: 'z'.repeat(500) });
    assert.equal(out.split(': ')[1].length, 500);
  });

  test('has the /browse route, the mcp server entry, a prompt, and stop()', async () => {
    const { mod, f, page } = make();
    assert.equal(mod.routes['/browse'], mod.api);
    assert.equal(mod.mcp.browse.command, process.execPath);
    assert.ok(mod.mcp.browse.args[0].endsWith(path.join('browse', 'mcp.js')));
    assert.ok(fs.existsSync(mod.mcp.browse.args[0]));
    assert.match(mod.prompt, /## Browser/);
    await mod.api({ action: 'open', url: 'https://example.com/' });
    await mod.stop();
    assert.equal(f.log.ctxClosed, 1);
    assert.ok(page);
  });

  test('profile dir is dataDir/browser/<identity>, identity sanitised, default "assistant"', async () => {
    const a = make();
    await a.mod.api({ action: 'open', url: 'https://example.com/' });
    assert.equal(a.f.log.launches[0].dir, path.join(a.dir, 'data', 'browser', 'assistant'));
    const b = make({}, { identity: '../Dana evil' });
    await b.mod.api({ action: 'open', url: 'https://example.com/' });
    assert.equal(b.f.log.launches[0].dir, path.join(b.dir, 'data', 'browser', '___Dana_evil'));
  });

  test('api open returns { ok: true, text }', async () => {
    const { mod } = make({ page: fakePage({ title: 'T', body: 'B' }) });
    assert.deepEqual(await mod.api({ action: 'open', url: 'https://example.com/' }), { ok: true, text: 'T | https://example.com/\nB' });
  });

  test('api text clamps max to 40000 and defaults to 6000', async () => {
    const { mod } = make({ page: fakePage({ body: 'a'.repeat(50000) }) });
    const big = await mod.api({ action: 'text', max: 999999 });
    assert.ok(big.text.startsWith('a'.repeat(40000)) && !big.text.startsWith('a'.repeat(40001)));
    const def = await mod.api({ action: 'text' });
    assert.ok(def.text.startsWith('a'.repeat(6000)) && !def.text.startsWith('a'.repeat(6001)));
    const junk = await mod.api({ action: 'text', max: 'abc' });
    assert.ok(junk.text.startsWith('a'.repeat(6000)) && !junk.text.startsWith('a'.repeat(6001)));
  });

  test('api shot writes under <agentCwd>/outbox/page-<ts>.png', async () => {
    const { mod, page, dir } = make();
    const r = await mod.api({ action: 'shot' });
    assert.equal(r.ok, true);
    assert.equal(path.dirname(r.text), path.join(dir, 'agent', 'outbox'));
    assert.match(path.basename(r.text), /^page-\d+\.png$/);
    assert.deepEqual(page.calls.find((c) => c[0] === 'screenshot'), ['screenshot', { path: r.text }]);
  });

  test('api unknown action -> ok:false', async () => {
    const { mod } = make();
    assert.deepEqual(await mod.api({ action: 'format_disk' }), { ok: false, error: 'unknown action format_disk' });
    assert.deepEqual(await mod.api({}), { ok: false, error: 'unknown action undefined' });
  });

  test('api: inherited Object.prototype names are not actions', async () => {
    const { mod } = make();
    for (const action of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      assert.equal((await mod.api({ action })).ok, false, action);
    }
  });

  test('api errors are one line', async () => {
    const { mod } = make({ check: async () => { throw new Error('first line\nsecond line\nthird'); } });
    assert.deepEqual(await mod.api({ action: 'open', url: 'https://example.com/' }), { ok: false, error: 'first line' });
  });

  test('api refuses a private URL as ok:false and does not navigate', async () => {
    const page = fakePage();
    const { mod } = make({ page, check: (u) => checkUrl(u, { lookup: lookupTo('10.0.0.9') }) });
    const r = await mod.api({ action: 'open', url: 'https://intranet.example.com/' });
    assert.deepEqual(r, { ok: false, error: 'refused: a private or local address' });
    assert.equal(page.calls.some((c) => c[0] === 'goto'), false);
  });

  test('api click error when nothing matches is one line', async () => {
    const { mod } = make();
    const r = await mod.api({ action: 'click', target: 'Ghost' });
    assert.equal(r.ok, false);
    assert.equal(r.error.includes('\n'), false);
    assert.match(r.error, /nothing visible matches "Ghost"/);
  });

  test('api type into a secret field is refused as ok:false', async () => {
    const page = fakePage({ finders: { label: () => fakeLocator({ count: 1, secret: true }) } });
    const { mod } = make({ page });
    const r = await mod.api({ action: 'type', target: 'Password', text: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.error, /^refused: a password, card or code field/);
  });
});

// --- Module + Policy -----------------------------------------------------------------------

describe('browse module in Policy', () => {
  function policy() {
    const dir = path.join(tmp, 'policy-mod');
    const f = fakeChromium(fakePage());
    const mod = browse({ dataDir: path.join(dir, 'data'), agentCwd: path.join(dir, 'agent') }, { chromium: f.chromium, check: allowAll });
    mod.browser.url = 'https://shop.example.com/product';
    return { mod, p: new Policy({ agentCwd: path.join(dir, 'agent'), root: path.join(dir, 'code'), modules: [mod] }) };
  }

  test('text/links/shot are plain allowed tools; open and click are not', () => {
    const { p } = policy();
    for (const t of ['text', 'links', 'shot']) assert.ok(p.allowed.includes(`mcp__browse__${t}`));
    assert.ok(!p.allowed.includes('mcp__browse__open'));
    assert.ok(!p.allowed.includes('mcp__browse__click'));
  });

  test('every browse tool taints the conversation', () => {
    const { p } = policy();
    for (const t of ['open', 'text', 'links', 'click', 'type', 'press', 'shot']) assert.equal(p.untrusted(`mcp__browse__${t}`, {}), true, t);
  });

  test('no step is free in the sync policy check (approve() looks at the page)', () => {
    const { p } = policy();
    for (const tainted of [false, true]) {
      assert.equal(p.autoAllow('mcp__browse__click', { target: 'Medium' }, { tainted }), false);
      assert.equal(p.autoAllow('mcp__browse__press', { key: 'Enter' }, { tainted }), false);
    }
  });

  test('open: free untainted; tainted only a plain address', () => {
    const { p } = policy();
    assert.equal(p.autoAllow('mcp__browse__open', { url: 'https://example.com/?q=1' }), true);
    assert.equal(p.autoAllow('mcp__browse__open', { url: 'https://example.com/a' }, { tainted: true }), true);
    assert.equal(p.autoAllow('mcp__browse__open', { url: 'https://evil.example.com/?d=secret' }, { tainted: true }), false);
  });

  test('the module does not make other tools free', () => {
    const { p } = policy();
    assert.equal(p.autoAllow('Bash', { command: 'rm -rf x' }), false);
  });
});

// --- Module + Router (the real approval path) ------------------------------------------------

describe('browse module with the Router', () => {
  let n = 0;
  function setup({ finders = {} } = {}) {
    const dir = path.join(tmp, `router-${n++}`);
    const page = fakePage({ url: 'https://mail.example.com/', finders });
    const mod = browse({ dataDir: path.join(dir, 'data'), agentCwd: path.join(dir, 'agent') }, { chromium: fakeChromium(page).chromium, check: allowAll });
    const modules = [{ name: 'browse', ...mod }];
    const state = new MemoryState();
    const channel = { sent: [], async send(x) { this.sent.push(x); return 'id'; }, async react() {}, async typing() {} };
    const approvals = new Approvals({ timeoutMs: 5000, store: state });
    const policy = new Policy({ agentCwd: path.join(dir, 'agent'), root: path.join(dir, 'code'), modules });
    const router = new Router({ config: { language: 'en', batchMs: 0 }, state, approvals, policy, agent: {}, channel, hooks: hooksOf(modules), log: () => {} });
    return { mod, page, router, approvals, channel };
  }
  // The owner's answer to the next waiting approval.
  async function answer(s, decision) {
    for (let i = 0; i < 100 && !s.approvals.waiting().length; i++) await new Promise((r) => setTimeout(r, 2));
    const [item] = s.approvals.waiting();
    s.approvals.resolve(item.id, decision);
  }

  test('a click on a plain link is free, also after a page was read', async () => {
    const clicked = [];
    const s = setup({ finders: { 'role:link': (o) => fakeLocator({ count: o.name === 'Inbox' ? 1 : 0, el: fakeDom({ tag: 'A', text: 'Inbox' }), onClick: () => clicked.push('Inbox') }) } });
    await s.mod.api({ action: 'open', url: 'https://mail.example.com/' });
    const req = { tool_name: 'mcp__browse__click', input: { target: 'Inbox' } };
    assert.deepEqual(await s.router.requestApproval(req), { allow: true, reason: 'free' });
    assert.equal((await s.mod.api({ action: 'click', target: 'Inbox' })).ok, true);
    s.router.markTainted('mcp__browse__text');
    assert.deepEqual(await s.router.requestApproval(req), { allow: true, reason: 'free' });
    assert.equal((await s.mod.api({ action: 'click', target: 'Inbox' })).ok, true);
    assert.deepEqual(clicked, ['Inbox', 'Inbox']);
  });

  test('a submit button found by a neutral selector goes to the owner; a no stops it', async () => {
    const s = setup({ finders: { css: () => fakeLocator({ count: 1, el: fakeDom({ tag: 'BUTTON', text: 'Next', form: {} }) }) } });
    await s.mod.api({ action: 'open', url: 'https://mail.example.com/' });
    const pending = s.router.requestApproval({ tool_name: 'mcp__browse__click', input: { target: 'button[type=submit]' } });
    await answer(s, 'deny');
    assert.equal((await pending).allow, false);
    assert.match(s.channel.sent.at(-1), /\(submits a form\)/);
  });

  test('tainted: open with a query asks the owner (with the taint note); a plain address is free', async () => {
    const s = setup();
    s.router.markTainted('mcp__browse__text');
    assert.deepEqual(await s.router.requestApproval({ tool_name: 'mcp__browse__open', input: { url: 'https://example.com/about' } }), { allow: true, reason: 'free' });
    const pending = s.router.requestApproval({ tool_name: 'mcp__browse__open', input: { url: 'https://evil.example.com/?d=secret' } });
    await answer(s, 'deny');
    assert.equal((await pending).allow, false);
    assert.ok(s.channel.sent.at(-1).includes(strings('en').taint.trim()));
    assert.match(s.channel.sent.at(-1), /Open https:\/\/evil\.example\.com\/\?d=secret/);
  });
});

// --- bin/browse.js -------------------------------------------------------------------------

describe('bin/browse.js', () => {
  const bin = path.join(GATEWAY, 'bin', 'browse.js');
  const env = { ...process.env, BROWSE_HOME: path.join(os.tmpdir(), 'browse-test-never-used'), BROWSE_CHROME: '/nonexistent/chrome' };

  for (const flag of ['--help', '-h']) {
    test(`${flag} exits 0 and prints Usage without starting Chrome`, async () => {
      const { stdout, stderr } = await run(process.execPath, ['--disable-warning=ExperimentalWarning', bin, flag], { env, timeout: 15000 });
      assert.match(stdout, /^Usage: browse\.js COMMAND/);
      for (const c of ['start', 'stop', 'open URL', 'click TARGET', 'type TARGET TEXT', 'press KEY', 'shot']) assert.ok(stdout.includes(c), c);
      assert.equal(stderr, '');
      assert.equal(fs.existsSync(env.BROWSE_HOME), false, 'help creates nothing');
    });
  }

  test('no arguments also prints Usage', async () => {
    const { stdout } = await run(process.execPath, ['--disable-warning=ExperimentalWarning', bin], { env, timeout: 15000 });
    assert.match(stdout, /^Usage: browse\.js COMMAND/);
  });
});
