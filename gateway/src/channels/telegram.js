import crypto from 'node:crypto';

// Telegram as a channel (optional backup). The owner makes a bot with @BotFather; its token is in
// the environment (TELEGRAM_BOT_TOKEN), never in config or the chat. Pairing: the gateway makes a
// one-time code; the owner sends "/start <code>" to the bot once, and from then on only that chat
// is listened to. The Bot API needs the token in the URL path, so URLs are never logged.
export class TelegramChannel {
  constructor({ token, state, fetchFn = fetch, log = console.log, pollTimeoutS = 50 }) {
    if (!token) throw new Error('telegram: TELEGRAM_BOT_TOKEN is missing');
    Object.assign(this, { token, state, fetchFn, log, pollTimeoutS });
    if (!state.get('telegramOwner') && !state.get('telegramPairCode')) state.set('telegramPairCode', crypto.randomBytes(4).toString('hex'));
  }

  get owner() { return this.state.get('telegramOwner') || null; }
  get pairCode() { return this.state.get('telegramPairCode') || null; }

  async call(method, body = {}, timeoutMs = 15_000) {
    const r = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description || `HTTP ${r.status}`}`);
    return j.result;
  }

  start(onMessage) {
    this.onMessage = onMessage;
    this.running = true;
    if (this.pairCode) this.log(`telegram: send "/start ${this.pairCode}" to your bot to connect it`);
    this.loop();
  }

  async loop() {
    let wait = 1000;
    while (this.running) {
      try {
        const updates = await this.call('getUpdates', { offset: this.offset, timeout: this.pollTimeoutS, allowed_updates: ['message'] }, (this.pollTimeoutS + 10) * 1000);
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.update(u.message);
        }
        wait = 1000;
        await new Promise((r) => setImmediate(r)); // let timers and I/O run between polls
      } catch (e) {
        if (!this.running) return;
        this.log(`telegram: ${e.message}`);
        await new Promise((r) => setTimeout(r, wait).unref?.());
        wait = Math.min(wait * 2, 60_000);
      }
    }
  }

  async update(m) {
    if (!m || m.chat?.type !== 'private') return;
    const text = m.text || m.caption || '';
    if (!this.owner) {
      if (this.pairCode && text.trim() === `/start ${this.pairCode}`) {
        this.state.set('telegramOwner', m.chat.id);
        this.state.set('telegramPairCode', null);
        this.log('telegram: connected');
        await this.send('✅');
      }
      return;
    }
    if (m.chat.id !== this.owner || m.from?.is_bot) return;
    const f = m.voice || m.audio || m.document || m.video || m.photo?.at(-1);
    const download = async () => {
      const { file_path } = await this.call('getFile', { file_id: f.file_id });
      const r = await this.fetchFn(`https://api.telegram.org/file/bot${this.token}/${file_path}`);
      return Buffer.from(await r.arrayBuffer());
    };
    const msg = { id: String(m.message_id), text };
    if (m.forward_origin || m.forward_date) msg.forwarded = true;
    if (m.reply_to_message?.text) msg.quoted = m.reply_to_message.text;
    if (m.voice || m.audio) msg.audio = { mimetype: f.mime_type || 'audio/ogg', seconds: f.duration || 0, download };
    else if (f) msg.file = { mimetype: f.mime_type || (m.photo ? 'image/jpeg' : 'application/octet-stream'), name: f.file_name || '', bytes: f.file_size || 0, download };
    msg.unsupported = !text && !f;
    await this.onMessage(msg);
  }

  async send(text) {
    if (!this.owner) throw new Error('telegram: not connected yet');
    let id;
    for (let i = 0; i < text.length || i === 0; i += 4000) {
      id = (await this.call('sendMessage', { chat_id: this.owner, text: text.slice(i, i + 4000) })).message_id;
    }
    return String(id);
  }

  async react(id, emoji) {
    await this.call('setMessageReaction', { chat_id: this.owner, message_id: Number(id), reaction: emoji ? [{ type: 'emoji', emoji }] : [] });
  }

  async typing(on) { if (on && this.owner) await this.call('sendChatAction', { chat_id: this.owner, action: 'typing' }); }

  stop() { this.running = false; }
}
