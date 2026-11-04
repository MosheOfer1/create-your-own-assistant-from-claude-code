import makeWASocket, {
  DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, normalizeMessageContent, useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import path from 'node:path';
import pino from 'pino';
import { cardsLine, clean, keepLocation, locationLine, makeLocation, parseVcard } from './cards.js';
import { ContactBook, normalizePhone, userPart } from './contacts.js';

// WhatsApp on the assistant's OWN number, as a linked device (Baileys). The owner writes to the
// assistant like to any contact. Only the owner's messages pass; everything else is dropped here.
//
// First run: the gateway asks WhatsApp for an 8-character pairing code for the assistant's number;
// on the assistant's phone: WhatsApp → Linked devices → Link with phone number → type the code.
// Keep Baileys' default browser: a custom browser name makes WhatsApp reject pairing codes.
// The assistant's phone must open WhatsApp about every 14 days, or the link drops ('logged-out').

// libsignal prints whole session records (private keys) with console.info. Drop those lines.
const SIGNAL_NOISE = /^(Closing session|Opening session|Removing old closed session|Migrating session to|Closing open session)/;
const info = console.info.bind(console);
console.info = (first, ...rest) => { if (!(typeof first === 'string' && SIGNAL_NOISE.test(first))) info(first, ...rest); };

export { userPart };
export const digits = (s = '') => String(s).replace(/\D/g, '');
const direct = (jid = '') => /@(s\.whatsapp\.net|lid)$/.test(jid);

const plain = (c) => c?.conversation || c?.extendedTextMessage?.text || c?.imageMessage?.caption
  || c?.videoMessage?.caption || c?.documentMessage?.caption || '';

// A pinned location (locationMessage) or a live one (liveLocationMessage; its updates arrive as
// more messages of the same kind). Its comment or caption is the owner's own words.
function locationOf(c) {
  const l = c?.locationMessage || c?.liveLocationMessage;
  if (!l) return null;
  const loc = makeLocation({ lat: l.degreesLatitude, lon: l.degreesLongitude, live: !!(c.liveLocationMessage || l.isLive),
    name: l.name, address: l.address, accuracy: l.accuracyInMeters });
  return loc && { loc, words: String(l.comment || l.caption || '').trim() };
}

// One card (contactMessage) or several (contactsArrayMessage), each with a vCard.
function cardsOf(c) {
  const list = c?.contactMessage ? [c.contactMessage] : c?.contactsArrayMessage?.contacts;
  if (!list?.length) return null;
  return list.map((x) => {
    const card = parseVcard(x.vcard || '');
    return { ...card, name: card.name || clean(x.displayName, 100) };
  });
}

// What a quoted message said, also when it was a location or a card.
function quotedText(c) {
  if (!c) return '';
  const l = locationOf(c);
  const cards = cardsOf(c);
  return plain(c) || (l ? locationLine(l.loc) : '') || (cards ? cardsLine(cards) : '');
}

const CONTEXT = ['extendedTextMessage', 'imageMessage', 'documentMessage', 'videoMessage', 'audioMessage',
  'locationMessage', 'liveLocationMessage', 'contactMessage', 'contactsArrayMessage'];

// A Baileys message → what the router reads:
// { text, quoted?, forwarded?, audio?, file?, location?, cards?, unsupported }.
// A location or a card is already text (cards.js); `location` and `cards` carry the parsed facts.
// Media bytes download only when asked (download()), so nothing is fetched for messages we drop.
export function readMessage(m, download = () => Promise.reject(new Error('no download'))) {
  const c = normalizeMessageContent(m.message);
  if (!c) return { text: '', unsupported: false };
  const l = locationOf(c);
  const cards = cardsOf(c);
  const text = [l && locationLine(l.loc), cards && cardsLine(cards), l?.words || plain(c)].filter(Boolean).join('\n');
  const ctx = CONTEXT.map((k) => c[k]?.contextInfo).find(Boolean);
  const quoted = ctx?.quotedMessage ? quotedText(normalizeMessageContent(ctx.quotedMessage)) : '';
  const a = c.audioMessage;
  const f = c.imageMessage || c.documentMessage || c.videoMessage;
  const out = { text };
  if (quoted) out.quoted = quoted;
  if (ctx?.isForwarded) out.forwarded = true;
  if (a) out.audio = { mimetype: a.mimetype || 'audio/ogg', seconds: Number(a.seconds || 0), download };
  if (f) out.file = { mimetype: f.mimetype || 'application/octet-stream', name: f.fileName || '', bytes: Number(f.fileLength || 0), download };
  if (f?.seconds) out.file.seconds = Number(f.seconds);
  if (l) out.location = l.loc;
  if (cards) out.cards = cards;
  // Silent events (reactions, edits, receipts, keys) are not "unsupported" messages.
  const silent = c.protocolMessage || c.reactionMessage || c.senderKeyDistributionMessage || c.pollUpdateMessage || c.albumMessage;
  out.unsupported = !text && !a && !f && !silent;
  return out;
}

// Baileys content for a file to someone else: images, video and audio as such, else a document.
function fileContent({ data, mimetype = 'application/octet-stream', fileName = 'file' }, caption) {
  if (/^image\/(jpeg|png|webp)$/.test(mimetype)) return { image: data, caption };
  if (/^video\//.test(mimetype)) return { video: data, mimetype, caption };
  if (/^audio\//.test(mimetype)) return { audio: data, mimetype };
  return { document: data, mimetype, fileName, caption };
}

export class WhatsAppChannel {
  // assistantNumber: the number this device links to. ownerNumber: the only person it listens to.
  // onStatus(s): 'open' | 'closed' | 'down' (10 min without a connection) | 'logged-out'.
  // contactsFile: the contact list (default: whatsapp-contacts.json next to the auth folder).
  constructor({ authDir, assistantNumber, ownerNumber, onPairingCode, log = console.log, makeSocket = makeWASocket, auth = useMultiFileAuthState, fetchVersion = fetchLatestBaileysVersion, now = Date.now,
    contactsFile = authDir && path.isAbsolute(authDir) ? path.join(path.dirname(authDir), 'whatsapp-contacts.json') : null }) {
    Object.assign(this, { authDir, onPairingCode, log, makeSocket, auth, fetchVersion, now });
    this.book = new ContactBook({ file: contactsFile, log });
    this.lastLocation = null; // { lat, lon, at, live, name?, address?, accuracy? }: the owner's last known location
    this.assistant = digits(assistantNumber);
    this.owner = digits(ownerNumber);
    if (!this.owner) throw new Error('whatsapp: ownerNumber is required');
    this.ownerIds = new Set([this.owner]); // the owner's phone number and the LIDs WhatsApp uses for them
    this.keys = new Map(); // message id → key, for reactions (last 200)
    this.chat = `${this.owner}@s.whatsapp.net`; // where replies go: the chat the owner last wrote from
    this.onStatus = null;
  }

  isOwner(key = {}) {
    if (key.fromMe || !direct(key.remoteJid)) return false;
    return [key.remoteJid, key.remoteJidAlt, key.senderPn].some((j) => j && this.ownerIds.has(userPart(j)));
  }

  learn(lid, pn) { if (lid && pn && userPart(pn) === this.owner) this.ownerIds.add(userPart(lid)); }

  status(s) {
    if (s === this.last) return;
    this.last = s;
    this.log(`whatsapp: ${s}`);
    this.onStatus?.(s);
  }

  async start(onMessage) {
    this.onMessage = onMessage;
    this.startedAt = Math.floor(this.now() / 1000);
    const { state, saveCreds } = await this.auth(this.authDir);
    Object.assign(this, { creds: state, saveCreds });
    try { this.version = (await this.fetchVersion()).version; } catch { /* Baileys' built-in version */ }
    this.logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });
    this.connect();
  }

  connect() {
    const sock = this.makeSocket({ auth: this.creds, logger: this.logger, markOnlineOnConnect: false, syncFullHistory: false, ...(this.version && { version: this.version }) });
    this.sock = sock;
    let asked = false;
    sock.ev.on('creds.update', this.saveCreds);
    sock.ev.on('lid-mapping.update', (m) => this.learn(m?.lid, m?.pn));
    sock.ev.on('connection.update', async (u) => {
      if (sock !== this.sock) return; // an old socket's late events
      if (u.qr && !asked && !this.creds.creds?.registered) {
        asked = true;
        if (!this.assistant) return this.log('whatsapp: set assistantNumber to get a pairing code');
        try {
          const code = await sock.requestPairingCode(this.assistant);
          this.log(`whatsapp: pairing code ${code}`);
          this.onPairingCode?.(code);
        } catch (e) { this.log(`whatsapp: pairing code failed: ${e.message}`); }
      }
      if (u.connection === 'open') {
        this.retries = 0;
        clearTimeout(this.downTimer);
        this.downTimer = null;
        this.status('open');
      }
      if (u.connection === 'close' && !this.stopped) {
        if (u.lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
          // Logged out for good: no reconnect, no "down" later. Linking again needs a new pairing code.
          clearTimeout(this.downTimer);
          clearTimeout(this.retryTimer);
          this.downTimer = null;
          return this.status('logged-out');
        }
        this.status('closed');
        this.downTimer ??= setTimeout(() => this.status('down'), 10 * 60_000);
        this.downTimer.unref?.();
        this.retries = (this.retries || 0) + 1;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => !this.stopped && this.connect(), Math.min(60_000, 3000 * 2 ** Math.min(this.retries, 5)));
        this.retryTimer.unref?.();
      }
    });
    // 'notify' = new messages. 'append' is history and our own sends: never a turn.
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type && type !== 'notify') return;
      for (const m of messages) {
        if (m.key?.remoteJid?.endsWith('@lid')) this.learn(m.key.remoteJid, m.key.remoteJidAlt || m.key.senderPn);
        if (!m.message || !this.isOwner(m.key) || Number(m.messageTimestamp) < this.startedAt - 60) continue;
        this.chat = m.key.remoteJid;
        const download = () => downloadMediaMessage(m, 'buffer', {}, { logger: this.logger, reuploadRequest: sock.updateMediaMessage });
        const read = readMessage(m, download);
        // A live location's updates only refresh lastLocation: no turn for each step (cards.js).
        if (read.location && !keepLocation(this, read.location, this.now())) continue;
        this.keys.set(m.key.id, m.key);
        if (this.keys.size > 200) this.keys.delete(this.keys.keys().next().value);
        Promise.resolve(this.onMessage({ id: m.key.id, ...read })).catch((e) => this.log(`whatsapp: handler: ${e.message}`));
      }
    });
    // Names and numbers for finding a recipient later (contacts.js). Never a turn, never a reply.
    const addAll = (list) => { for (const c of Array.isArray(list) ? list : []) if (c && typeof c === 'object') this.book.add(c); };
    sock.ev.on('contacts.upsert', addAll);
    sock.ev.on('contacts.update', addAll);
    sock.ev.on('messaging-history.set', (h) => addAll(h?.contacts));
    sock.ev.on('lid-mapping.update', (m) => this.book.map(m?.lid, m?.pn));
  }

  // --- other people (for a module with an approval gate; no tool reaches this by itself) ---

  contacts() { return this.book.list(); }

  findContact(query, limit) { return this.book.find(query, limit); }

  // A direct chat with one person: a phone number in international form, or a phone / LID jid.
  // Groups, lists and the owner's own chat are refused: this is for other people only.
  async resolve(to) {
    const s = String(to ?? '').trim();
    let jid;
    if (s.includes('@')) {
      if (!direct(s)) throw new Error('whatsapp: sendTo writes to one person, not a group or a list');
      jid = `${userPart(s)}@${s.split('@')[1]}`; // a device suffix (":12") is dropped
    } else {
      const d = normalizePhone(s);
      if (!d) throw new Error('whatsapp: not a phone number in international form (+country…)');
      const [r] = (await this.sock.onWhatsApp?.(d)) || [{ exists: true }];
      if (!r?.exists) throw new Error('whatsapp: this number is not on WhatsApp');
      jid = r.jid || `${d}@s.whatsapp.net`;
    }
    const user = userPart(jid);
    const phone = jid.endsWith('@lid') ? this.book.phoneOfLid(jid) : user;
    if (this.ownerIds.has(user) || phone === this.owner) throw new Error('whatsapp: that is the owner; use send()');
    if (user === this.assistant || phone === this.assistant) throw new Error('whatsapp: that is the assistant\'s own number');
    return jid;
  }

  // One message to someone else. file: { data: Buffer, mimetype, fileName? }; the text is its
  // caption (audio has none, so the text goes after it). Returns the last message id.
  async sendTo(to, text = '', { file } = {}) {
    if (!this.sock) throw new Error('whatsapp: not connected yet');
    if (!String(text).trim() && !file) throw new Error('whatsapp: nothing to send');
    const jid = await this.resolve(to);
    const caption = String(text).trim() ? String(text) : undefined;
    const parts = file ? [fileContent(file, caption)] : [{ text: String(text) }];
    if (file && caption && parts[0].audio) parts.push({ text: caption });
    let id;
    for (const content of parts) {
      const ack = this.ackOf();
      id = (await this.sock.sendMessage(jid, content))?.key?.id;
      await ack(id);
    }
    return id;
  }

  // WhatsApp may refuse a message after sendMessage resolved (error 463: a new number may not
  // start a chat with someone who never wrote to it). The refusal comes as a messages.update with
  // status ERROR (0). Listen before sending; wait up to ackMs for the server's ack or refusal.
  ackOf(ackMs = this.ackMs ?? 10_000) {
    const seen = new Map();
    const on = (ups) => { for (const u of ups || []) if (u.key?.id && u.update?.status !== undefined) seen.set(u.key.id, u.update); };
    this.sock.ev.on('messages.update', on);
    return (id) => new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const u = seen.get(id);
        const done = (f) => { this.sock.ev.off?.('messages.update', on); f(); };
        if (u && u.status === 0) {
          const code = u.messageStubParameters?.[0] || '';
          return done(() => reject(new Error(code === '463'
            ? 'whatsapp refused the message (463): this new number cannot start a chat with them. They need to write to it first, or save it as a contact.'
            : `whatsapp refused the message${code ? ` (${code})` : ''}`)));
        }
        if ((u && u.status >= 2) || Date.now() - t0 > ackMs) return done(resolve);
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  async send(text) {
    const sent = await this.sock.sendMessage(this.chat, { text });
    return sent?.key?.id;
  }

  // Files to the owner: images as images, audio as audio, anything else as a document.
  async sendFile(buf, { mimetype, fileName, caption = '' }) {
    const kind = /^image\/(jpeg|png|webp)$/.test(mimetype) ? 'image' : /^audio\//.test(mimetype) ? 'audio' : 'document';
    const msg = kind === 'image' ? { image: buf, caption } : kind === 'audio' ? { audio: buf, mimetype } : { document: buf, mimetype, fileName, caption };
    const sent = await this.sock.sendMessage(this.chat, msg);
    return sent?.key?.id;
  }

  async react(id, emoji) {
    const key = this.keys.get(id);
    if (key) await this.sock.sendMessage(key.remoteJid, { react: { text: emoji, key } });
  }

  async typing(on) { await this.sock?.sendPresenceUpdate(on ? 'composing' : 'paused', this.chat); }

  stop() {
    this.stopped = true;
    clearTimeout(this.downTimer);
    clearTimeout(this.retryTimer);
    this.book.flush();
    this.sock?.end(undefined);
  }
}
