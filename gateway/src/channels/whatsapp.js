import makeWASocket, {
  DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, normalizeMessageContent, useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';

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

export const userPart = (jid = '') => jid.split('@')[0].split(':')[0];
export const digits = (s = '') => String(s).replace(/\D/g, '');
const direct = (jid = '') => /@(s\.whatsapp\.net|lid)$/.test(jid);

const plain = (c) => c?.conversation || c?.extendedTextMessage?.text || c?.imageMessage?.caption
  || c?.videoMessage?.caption || c?.documentMessage?.caption || '';

// A Baileys message → what the router reads: { text, quoted?, forwarded?, audio?, file?, unsupported }.
// Media bytes download only when asked (download()), so nothing is fetched for messages we drop.
export function readMessage(m, download = () => Promise.reject(new Error('no download'))) {
  const c = normalizeMessageContent(m.message);
  if (!c) return { text: '', unsupported: false };
  const text = plain(c);
  const ctx = (c.extendedTextMessage || c.imageMessage || c.documentMessage || c.videoMessage || c.audioMessage)?.contextInfo;
  const quoted = ctx?.quotedMessage ? plain(normalizeMessageContent(ctx.quotedMessage)) : '';
  const a = c.audioMessage;
  const f = c.imageMessage || c.documentMessage || c.videoMessage;
  const out = { text };
  if (quoted) out.quoted = quoted;
  if (ctx?.isForwarded) out.forwarded = true;
  if (a) out.audio = { mimetype: a.mimetype || 'audio/ogg', seconds: Number(a.seconds || 0), download };
  if (f) out.file = { mimetype: f.mimetype || 'application/octet-stream', name: f.fileName || '', bytes: Number(f.fileLength || 0), download };
  // Silent events (reactions, edits, receipts, keys) are not "unsupported" messages.
  const silent = c.protocolMessage || c.reactionMessage || c.senderKeyDistributionMessage || c.pollUpdateMessage || c.albumMessage;
  out.unsupported = !text && !a && !f && !silent;
  return out;
}

export class WhatsAppChannel {
  // assistantNumber: the number this device links to. ownerNumber: the only person it listens to.
  // onStatus(s): 'open' | 'closed' | 'down' (10 min without a connection) | 'logged-out'.
  constructor({ authDir, assistantNumber, ownerNumber, onPairingCode, log = console.log, makeSocket = makeWASocket, auth = useMultiFileAuthState, fetchVersion = fetchLatestBaileysVersion, now = Date.now }) {
    Object.assign(this, { authDir, onPairingCode, log, makeSocket, auth, fetchVersion, now });
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
        this.keys.set(m.key.id, m.key);
        if (this.keys.size > 200) this.keys.delete(this.keys.keys().next().value);
        const download = () => downloadMediaMessage(m, 'buffer', {}, { logger: this.logger, reuploadRequest: sock.updateMediaMessage });
        Promise.resolve(this.onMessage({ id: m.key.id, ...readMessage(m, download) })).catch((e) => this.log(`whatsapp: handler: ${e.message}`));
      }
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
    this.sock?.end(undefined);
  }
}
