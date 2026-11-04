import dns from 'node:dns/promises';
import net from 'node:net';

// The browser's rules, in code:
// - Only public http(s) pages: never this machine, the home network, a VPN range or a cloud
//   metadata service, also after DNS (a public name can point at 127.0.0.1).
// - Never type into a password or card field: logins happen in a visible window by the owner.
// - A step that really does something (send, pay, book, order, submit) asks the owner.

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

// Words of a step that acts for real, in several languages.
const CRITICAL = /\b(send|submit|pay|buy|order|book|checkout|purchase|confirm|place order|subscribe|sign up|delete|transfer|donate|publish|post)\b|שלח|שליחה|תשלום|לתשלום|לשלם|קנ[הי]|רכיש|הזמ[ןנ]|לאשר|אישור|מחק|פרסם|העבר|enviar|pagar|comprar|reservar|envoyer|payer|acheter|réserver|senden|bezahlen|kaufen|buchen/i;
const CRITICAL_PAGE = /checkout|payment|\/pay\b|\/cart|billing|kupa|tashlum/i;

// 'allow' | 'critical' for a browser step, from its target text and the current page URL.
export function judge(tool, input = {}, pageUrl = '') {
  const what = `${input.target || ''} ${input.text || ''}`;
  if (tool.endsWith('__press') && /^(enter|return)$/i.test(String(input.key || ''))) return 'critical'; // Enter submits forms
  if (CRITICAL_PAGE.test(pageUrl)) return 'critical';
  return CRITICAL.test(what) ? 'critical' : 'allow';
}
