import net from 'node:net';

// Addresses of this machine, the home network, a VPN range or a cloud metadata service.
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

export const LOCAL_NAME = /^(localhost|.*\.local|.*\.internal|.*\.ts\.net)$/i;

// The URL names a local or private place by itself, before any DNS: localhost, a .local name,
// a private IP in any form (URL parsing turns http://2130706433/ into 127.0.0.1).
// An unparsable URL counts as local: the caller then asks.
export function localUrl(url) {
  let u;
  try { u = new URL(url); } catch { return true; }
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return LOCAL_NAME.test(host) || (net.isIP(host) > 0 && privateIp(host));
}
