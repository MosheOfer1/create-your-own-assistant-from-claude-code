import { strings } from '../i18n.js';

// Several channels as one for the router (e.g. WhatsApp first, Telegram as backup).
// - Messages from every channel reach the router; ids carry their channel ("whatsapp:ABC").
// - A reply goes to the channel the owner last wrote in (for stickyMin), else to the first one
//   that works; a failed send tries the next.
// - A channel that loses its link (WhatsApp 'logged-out' or 'down') is reported on the others.
export class Channels {
  constructor({ channels, language = 'en', stickyMin = 30, now = Date.now, log = console.log }) {
    Object.assign(this, { now, log, stickyMs: stickyMin * 60_000 });
    this.list = Object.entries(channels).map(([name, channel]) => ({ name, channel }));
    this.t = strings(language);
    for (const c of this.list) c.channel.onStatus = (s) => this.status(c.name, s);
  }

  start(onMessage) {
    for (const { name, channel } of this.list) {
      channel.start((msg) => {
        this.last = { name, at: this.now() };
        return onMessage({ ...msg, id: `${name}:${msg.id}` });
      });
    }
  }

  order() {
    const sticky = this.last && this.now() - this.last.at < this.stickyMs ? this.last.name : null;
    return [...this.list].sort((a, b) => (b.name === sticky) - (a.name === sticky));
  }

  async send(text, { skip } = {}) {
    let err;
    for (const { name, channel } of this.order()) {
      if (name === skip || this.down?.has(name)) continue;
      try { return `${name}:${await channel.send(text)}`; } catch (e) { err = e; this.log(`channels: ${name} send failed: ${e.message}`); }
    }
    throw err || new Error('no channel could send');
  }

  async sendFile(buf, opts) {
    const c = this.order().find((x) => x.channel.sendFile && !this.down?.has(x.name));
    if (!c) throw new Error('no channel can send files');
    return `${c.name}:${await c.channel.sendFile(buf, opts)}`;
  }

  async react(id, emoji) {
    const i = id.indexOf(':');
    await this.list.find((c) => c.name === id.slice(0, i))?.channel.react?.(id.slice(i + 1), emoji);
  }

  async typing(on) { await this.order()[0]?.channel.typing?.(on); }

  // Link lost → tell the owner on another channel, once; back → say so.
  status(name, s) {
    this.down ??= new Set();
    if (['logged-out', 'down'].includes(s) && !this.down.has(name)) {
      this.down.add(name);
      this.send(s === 'logged-out' ? this.t.waLoggedOut : this.t.waDown, { skip: name }).catch(() => this.log(`channels: ${name} is ${s} and no other channel can tell the owner`));
    }
    if (s === 'open' && this.down.delete(name)) this.send(this.t.waBack, { skip: name }).catch(() => {});
  }

  stop() { for (const { channel } of this.list) channel.stop?.(); }
}
