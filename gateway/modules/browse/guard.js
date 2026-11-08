import dns from 'node:dns/promises';
import net from 'node:net';

// The browser's rules, in code:
// - Only public http(s) pages: never this machine, the home network, a VPN range or a cloud
//   metadata service, also after DNS (a public name can point at 127.0.0.1). Pages, and every
//   file or fetch() a page asks for (browser.js routes them all).
// - Never type into a password or card field: logins happen in a visible window by the owner.
// - A step that really does something (send, pay, book, order, submit) asks the owner. It is
//   judged by the element the click really hits, not by the agent's words.

const PRIVATE4 = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]];
const toInt = (ip) => ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
export function privateIp(ip) {
  if (net.isIPv4(ip)) return PRIVATE4.some(([base, bits]) => (toInt(ip) >>> (32 - bits)) === (toInt(base) >>> (32 - bits)));
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:') && net.isIPv4(v.slice(7))) return privateIp(v.slice(7));
  // An IPv4 address inside IPv6 in hex (URL parsing writes [::ffff:127.0.0.1] as ::ffff:7f00:1),
  // also NAT64 (64:ff9b::/96): judge the IPv4 address inside.
  const m = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (m) {
    const [a, b] = [parseInt(m[1], 16), parseInt(m[2], 16)];
    return privateIp(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
  }
  return v === '::' || v === '::1' || /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

// Resolves to null when the URL is a public web page, else the reason.
export async function checkUrl(url, { lookup = dns.lookup } = {}) {
  let u;
  try { u = new URL(url); } catch { return 'not a valid URL'; }
  if (!['http:', 'https:'].includes(u.protocol)) return `only http(s) pages, not ${u.protocol}`;
  if (u.username || u.password) return 'no credentials in URLs';
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, ''); // "localhost." is localhost
  if (/^(localhost|.*\.local|.*\.internal|.*\.ts\.net)$/i.test(host)) return 'a local address';
  const ips = net.isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!ips.length) return `cannot resolve ${host}`;
  return ips.some(privateIp) ? 'a private or local address' : null;
}

// Fields the agent never types into: passwords, card numbers, security codes, one-time codes.
// It runs inside the page (Playwright serialises it), so it uses nothing from this file.
export function secretField(el) {
  const a = (k) => (el.getAttribute(k) || '').toLowerCase();
  const all = [a('name'), a('id'), a('autocomplete'), a('aria-label'), a('placeholder')].join(' ');
  return a('type') === 'password' || /cc-|card.?num|cardnumber|cvv|cvc|csc|security.?code|one-time-code|otp|\bpin\b|iban|password|passwd|סיסמ|כרטיס|קוד אבטחה/.test(all);
}

// What a click really hits, read in the page (Playwright serialises it, so it uses nothing from
// this file). The agent's words are not enough: `click "Sen"` or `click "button[type=submit]"`
// can land on "Send". So the gateway judges the control around the element: its visible name
// (also an icon's aria-label or alt) and whether a click submits a form.
export function elementInfo(el) {
  let c = el.closest('button,input,select,textarea,a,label,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=option]') || el;
  if (c.tagName === 'LABEL' && c.control) c = c.control; // a click on a label clicks its control
  const attr = (k) => c.getAttribute(k) || '';
  const tag = c.tagName.toLowerCase();
  const byId = attr('aria-labelledby').split(/\s+/).filter(Boolean).map((id) => c.ownerDocument?.getElementById(id)?.textContent || '');
  const inner = [...c.querySelectorAll('img[alt],[aria-label],[title]')].map((e) => e.getAttribute('alt') || e.getAttribute('aria-label') || e.getAttribute('title'));
  const shown = tag === 'input' && ['submit', 'button', 'image', 'reset'].includes(c.type) ? c.value || '' : '';
  const name = [attr('aria-label'), ...byId, c.innerText || c.textContent || '', shown, attr('title'), attr('data-tooltip'), ...inner]
    .join(' ').replace(/\s+/g, ' ').trim();
  // A <button> without a type is a submit button; .form also covers form="id" outside the form.
  // A wrapper counts by what it holds: Playwright clicks its middle, which may be the button.
  const submitter = (e) => ['BUTTON', 'INPUT'].includes(e.tagName) && !!e.form && ['submit', 'image'].includes(e.type);
  const submits = submitter(c) || [...c.querySelectorAll('button,input[type=submit],input[type=image]')].some(submitter);
  return { tag, role: attr('role'), name, submits };
}

// Words of a step that acts for real, in several languages. Only a hint for a page the
// conversation has not read: a button can have any name. Once a page was read every step asks
// anyway (index.js).
const CRITICAL = new RegExp([
  '\\b(send|submit|pay|buy|order|book|checkout|purchase|confirm|place order|subscribe|sign up|delete|trash|transfer|donate|publish|post|share|invite',
  'enviar|pagar|comprar|reservar|envoyer|payer|acheter|réserver|senden|bezahlen|kaufen|buchen|invia|paga|acquista|prenota|verzenden|versturen|betalen|kopen)\\b',
  'שלח|שליחה|תשלום|לתשלום|לשלם|קנ[הי]|רכיש|הזמ[ןנ]|לאשר|אישור|מחק|פרסם|העבר|שתף',
  'إرسال|ارسال|أرسل|ادفع|دفع|شراء|اشتر|احجز|حذف|نشر|отправ|оплат|купить|заказ|удалить|опубликовать',
].join('|'), 'i');
const CRITICAL_PAGE = /checkout|payment|\/pay\b|\/cart|billing|kupa|tashlum/i;

// Keys that only move around the page. Every other key may act: Enter submits a form,
// Control/Meta+Enter sends in Gmail, Space presses the focused button, a letter is a shortcut
// ("#" deletes in Gmail), Delete removes.
const MOVE_KEY = /^((shift\+)?tab|escape|home|end|pageup|pagedown|arrow(up|down|left|right))$/i;

// 'allow' | 'critical' for a browser step, from the agent's words, the current page URL and,
// for a click, the element it really hits (elementInfo, when known).
// ask: 'acts' (default) asks for every step that acts: a form's submit, Enter, send, book,
// confirm... ask: 'money' (the owner's choice) asks only for what moves money, deletes,
// publishes or sends a message; logins, forms, confirm and booking run freely, and the agent
// asks the one question in the chat (the prompt says so).
const MONEY = new RegExp([
  '\\b(pay|buy|checkout|purchase|place order|transfer|donate|delete|trash|publish|post|share|invite|send(?!\\s*(me\\s*)?(a\\s*|the\\s*)?(code|otp|sms))',
  'pagar|comprar|payer|acheter|bezahlen|kaufen|paga|acquista|betalen|kopen)\\b',
  'תשלום|לתשלום|לשלם|קנ[הי]|רכיש|מחק|פרסם|העבר|שתף|שלח(?!ו?\\s*(לי\\s*)?(את\\s*ה)?(קוד|סיסמ))',
  'ادفع|دفع|شراء|اشتر|حذف|نشر|оплат|купить|удалить|опубликовать',
].join('|'), 'i');
const SEND_KEY = /^(control|ctrl|meta|cmd)\+enter$|^delete$/i;

export function judge(tool, input = {}, pageUrl = '', el = null, { ask = 'acts' } = {}) {
  if (CRITICAL_PAGE.test(pageUrl)) return 'critical';
  if (ask === 'money') {
    if (tool.endsWith('__press')) return SEND_KEY.test(String(input.key ?? '').trim()) ? 'critical' : 'allow';
    if (!/__(click|type)$/.test(tool)) return 'critical';
    return MONEY.test(`${input.target || ''} ${tool.endsWith('__click') ? el?.name || '' : ''}`) ? 'critical' : 'allow';
  }
  if (tool.endsWith('__press')) return MOVE_KEY.test(String(input.key ?? '').trim()) ? 'allow' : 'critical';
  if (!/__(click|type)$/.test(tool)) return 'critical'; // select, upload, submit: always the owner
  const click = tool.endsWith('__click');
  if (click && el?.submits) return 'critical';
  return CRITICAL.test(`${input.target || ''} ${input.text || ''} ${click ? el?.name || '' : ''}`) ? 'critical' : 'allow';
}
