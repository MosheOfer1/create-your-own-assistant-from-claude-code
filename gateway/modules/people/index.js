import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownFile } from '../../src/policy.js';

// Other people, through the assistant's own WhatsApp number: find someone in the contacts,
// send them a message. Every message to someone else waits for the owner's yes (GATED: __send)
// and needs a one-time ticket for exactly the number, text and file the owner saw.
// Contacts: what the WhatsApp channel learns (channel.findContact), plus an optional file
// <dataDir>/contacts.json { contacts: [{ phone, name }] } (e.g. imported from an older assistant).
// Needs the whatsapp channel. Options (config.modules.people): none yet.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_FILE = 16 << 20; // WhatsApp's own limit for media is about 16 MB
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKC').replace(/[֑-ׇ]/g, '').trim(); // no Hebrew vowel marks
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf',
  mp4: 'video/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', txt: 'text/plain', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const mimeOf = (name) => MIME[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const ticketKey = (i = {}, fileSum = null) => sha(JSON.stringify([digits(i.to), String(i.text ?? ''), fileSum]));

export default function people(config, { now = Date.now, log = console.log } = {}) {
  let router = null;
  const tickets = new Map(); // ticketKey → expiry
  const channel = () => router?.channel;

  const extra = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(config.dataDir, 'contacts.json'), 'utf8')).contacts || []; } catch { return []; }
  })().filter((c) => digits(c.phone)).map((c) => ({ phone: `+${digits(c.phone)}`, name: c.name || c.notify || '' }));

  function find(query) {
    const q = norm(query);
    const d = digits(query).replace(/^0+/, ''); // a local number (050…) is inside the international one (97250…)
    const fromChannel = channel()?.findContact?.(query) || [];
    const mine = extra.filter((c) => (q && norm(c.name).includes(q)) || (d.length >= 5 && digits(c.phone).includes(d)));
    const seen = new Set();
    return [...fromChannel, ...mine].filter((c) => {
      const k = digits(c.phone);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 10);
  }
  const nameOf = (to) => find(to).find((c) => digits(c.phone) === digits(to))?.name;

  // A file to send: only from the assistant's own folder (inbox, outbox), never a dot path or data/.
  function fileOf(f) {
    if (!f) return null;
    const abs = path.resolve(config.agentCwd, String(f));
    if (!ownFile(abs, config.agentCwd, config.root) || !fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) throw new Error(`${f}: only a file in your own folder can be sent`);
    const buffer = fs.readFileSync(abs);
    if (buffer.length > MAX_FILE) throw new Error(`${f}: over ${MAX_FILE >> 20} MB`);
    return { buffer, fileName: path.basename(abs), sha256: sha(buffer) };
  }

  async function api(a) {
    try {
      if (a.action === 'find') {
        const list = find(a.query);
        return { ok: true, text: list.length ? list.map((c) => `${c.name || '?'} ${c.phone}`).join('\n') : 'nobody found' };
      }
      if (a.action === 'send') {
        if (digits(a.to).length < 8) throw new Error('give `to` as a full number in international format');
        if (!channel()?.sendTo) throw new Error('sending to others needs the WhatsApp channel');
        const file = fileOf(a.file);
        const k = ticketKey(a, file?.sha256 ?? null);
        const until = tickets.get(k);
        tickets.delete(k);
        if (!until || until < now()) throw new Error('this exact message was not approved by the owner');
        await channel().sendTo(`+${digits(a.to)}`, String(a.text), file ? { file: { data: file.buffer, mimetype: mimeOf(file.fileName), fileName: file.fileName } } : {});
        return { ok: true, text: `sent to ${nameOf(a.to) || `+${digits(a.to)}`}` };
      }
      return { ok: false, error: `unknown action ${a.action}` };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // The owner's prompt: who exactly, the whole text, the file.
  function describe(tool, i) {
    if (tool !== 'mcp__people__send') return null;
    const who = nameOf(i.to);
    let f = '';
    try { const x = fileOf(i.file); if (x) f = `\n📎 ${x.fileName} (${Math.ceil(x.buffer.length / 1024)} KB)`; } catch (e) { f = `\n📎 ⚠️ ${e.message}`; }
    return `💬 WhatsApp to ${who ? `${who} ` : ''}+${digits(i.to)}${f}\n\n${String(i.text ?? '')}`;
  }

  return {
    mcp: { people: { command: process.execPath, args: [path.join(HERE, 'mcp.js')] } },
    allowed: ['mcp__people__find'], // send is never here: it matches GATED (__send) and always asks
    routes: { '/people': api },
    prompt: '## Other people\nTo message someone for the owner, look them up with mcp__people__find, then mcp__people__send. '
      + 'The owner sees and approves every message first; do not ask "should I send?" in the chat, the tool call is the question.',
    describers: [describe],
    approved({ tool_name, input = {} }) {
      if (tool_name !== 'mcp__people__send') return;
      try { tickets.set(ticketKey(input, fileOf(input.file)?.sha256 ?? null), now() + 5 * 60_000); } catch (e) { log(`people: ${e.message}`); }
    },
    api,
    start(r) { router = r; if (!r.channel?.sendTo) log('people: no channel can send to others (needs whatsapp)'); },
  };
}
