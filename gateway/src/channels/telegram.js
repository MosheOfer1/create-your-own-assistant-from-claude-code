import crypto from 'node:crypto';
import { parseReply } from '../approvals.js';
import { cardsLine, keepLocation, locationLine, makeLocation, parseVcard } from './cards.js';

// Telegram as a channel (optional backup). The owner makes a bot with @BotFather; its token is in
// the environment (TELEGRAM_BOT_TOKEN), never in config or the chat. Pairing: the gateway makes a
// one-time code; the owner sends "/start <code>" to the bot once, and from then on only that chat
// is listened to. The Bot API needs the token in the URL path, so URLs are never logged.

// An approval request as i18n's t.ask(id, what) writes it, in every language: "🔐 <word> #N" on the
// first line, and "<word>: <yes> / <no>" on the last. The router passes no marker today, so the
// text is the sign; send(text, { approvalId }) is the robust way once the router passes it.
const ASK = /^🔐 [^\n#]{1,40}#(\d+)\n/u;
const ASK_WORDS = /\n[^\n:]{1,40}:\s*(\S+)\s*\/\s*(\S+)\s*$/u;
// The router's answer to a decision (t.allowed / t.denied / t.lateYes / t.lateNo): ✅ or ❌, then #N
// on the first line. A parked request ("⏳ … #N") keeps its buttons: a late answer still counts.
const RESULT = /^(✅|❌)[^\n]{0,120}?#(\d+)/u;
const ASKS_KEPT = 50;
const LIVE_FOREVER = 0x7fffffff; // live_period for "until I stop sharing"

// The words a button press types, as parseReply reads them: the request's own words, else English.
function answerWords(text) {
  const [, yes, no] = text.match(ASK_WORDS) || [];
  const ok = (w, d) => w && parseReply(`${w} 1`)?.decision === d;
  return { yes: ok(yes, 'allow') ? yes : 'yes', no: ok(no, 'deny') ? no : 'no' };
}

// Telegram's location (or venue) → cards.js location.
function locationOf(m) {
  const l = m.venue?.location || m.location;
  if (!l) return null;
  const period = Number(l.live_period || 0);
  return makeLocation({ lat: l.latitude, lon: l.longitude, live: period > 0, name: m.venue?.title, address: m.venue?.address,
    accuracy: l.horizontal_accuracy, minutes: period && period < LIVE_FOREVER ? period / 60 : 0 });
}

// Telegram's contact → a card like WhatsApp's. Its phone is international digits, often without "+".
function cardOf(c) {
  if (!c) return null;
  const v = c.vcard ? parseVcard(c.vcard) : { name: '', phones: [], emails: [], org: '' };
  const raw = String(c.phone_number || '');
  const phone = raw.startsWith('+') ? `+${raw.replace(/\D/g, '')}` : /^[1-9]\d{6,14}$/.test(raw.replace(/\D/g, '')) ? `+${raw.replace(/\D/g, '')}` : raw;
  return { ...v, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || v.name, phones: [...new Set([phone, ...v.phones].filter(Boolean))] };
}

// What a message says as text: its text or caption, or its location or card as a line.
function textOf(m) {
  const loc = locationOf(m);
  const card = cardOf(m.contact);
  return [loc && locationLine(loc), card && cardsLine([card]), m.text || m.caption || ''].filter(Boolean).join('\n');
}

export class TelegramChannel {
  constructor({ token, state, fetchFn = fetch, log = console.log, pollTimeoutS = 50, now = Date.now }) {
    if (!token) throw new Error('telegram: TELEGRAM_BOT_TOKEN is missing');
    Object.assign(this, { token, state, fetchFn, log, pollTimeoutS, now });
    this.lastLocation = null; // { lat, lon, at, live, name?, address?, accuracy? }: the owner's last known location
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
        const updates = await this.call('getUpdates', { offset: this.offset, timeout: this.pollTimeoutS, allowed_updates: ['message', 'edited_message', 'callback_query'] }, (this.pollTimeoutS + 10) * 1000);
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.callback_query) await this.press(u.callback_query);
          else if (u.edited_message) this.edited(u.edited_message);
          else await this.update(u.message);
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

  fromOwner(m) { return !!this.owner && m?.chat?.type === 'private' && m.chat.id === this.owner && !m.from?.is_bot; }

  async update(m) {
    if (!m || m.chat?.type !== 'private') return;
    if (!this.owner) {
      if (this.pairCode && (m.text || '').trim() === `/start ${this.pairCode}`) {
        this.state.set('telegramOwner', m.chat.id);
        this.state.set('telegramPairCode', null);
        this.log('telegram: connected');
        await this.send('✅');
      }
      return;
    }
    if (!this.fromOwner(m)) return;
    const loc = locationOf(m);
    // A live location's later positions come as edits (edited()); a new share is a turn.
    if (loc) keepLocation(this, loc, this.now());
    const text = textOf(m);
    const f = m.voice || m.audio || m.document || m.video || m.video_note || m.animation || m.photo?.at(-1);
    const download = async () => {
      const { file_path } = await this.call('getFile', { file_id: f.file_id });
      const r = await this.fetchFn(`https://api.telegram.org/file/bot${this.token}/${file_path}`);
      return Buffer.from(await r.arrayBuffer());
    };
    const msg = { id: String(m.message_id), text };
    if (m.forward_origin || m.forward_date || m.forward_from || m.forward_from_chat) msg.forwarded = true;
    const quoted = m.quote?.text || (m.reply_to_message && textOf(m.reply_to_message));
    if (quoted) msg.quoted = quoted;
    if (m.voice || m.audio) msg.audio = { mimetype: f.mime_type || 'audio/ogg', seconds: f.duration || 0, download };
    else if (f) {
      const mimetype = f.mime_type || (m.photo ? 'image/jpeg' : m.video_note ? 'video/mp4' : 'application/octet-stream');
      msg.file = { mimetype, name: f.file_name || '', bytes: f.file_size || 0, download };
      if (f.duration) msg.file.seconds = f.duration;
    }
    if (loc) msg.location = loc;
    if (m.contact) msg.cards = [cardOf(m.contact)];
    msg.unsupported = !text && !f;
    await this.onMessage(msg);
  }

  // Telegram moves a live location by editing its message: the new position is kept, no turn.
  edited(m) {
    if (!this.fromOwner(m)) return;
    const loc = locationOf(m);
    if (loc) keepLocation(this, loc, this.now(), { update: true });
  }

  // --- approval buttons ---
  // State 'telegramAsks': { [id]: { msg, yes, no, done? } }, the last ASKS_KEPT requests, so a
  // button still works after a restart (a parked request can be answered for hours).

  asks() { return this.state.get('telegramAsks') || {}; }

  saveAsk(id, ask) {
    const all = { ...this.asks(), [id]: ask };
    const keep = Object.keys(all).map(Number).sort((a, b) => b - a).slice(0, ASKS_KEPT);
    this.state.set('telegramAsks', Object.fromEntries(keep.map((k) => [k, all[k]])));
  }

  keyboard(id, ask) {
    return { inline_keyboard: [[{ text: `✅ ${ask.yes}`, callback_data: `ap:${id}:y` }, { text: `❌ ${ask.no}`, callback_data: `ap:${id}:n` }]] };
  }

  // A press is the owner typing "yes N" / "no N": the router's normal path (approvals.answer)
  // decides. Only the paired owner's chat counts; a request already decided is not sent again.
  async press(q) {
    const answer = (text) => this.call('answerCallbackQuery', { callback_query_id: q.id, ...(text && { text }) }).catch(() => {});
    const m = /^ap:(\d+):([yn])$/.exec(q?.data || '');
    const ask = m && this.asks()[m[1]];
    if (!this.owner || q?.from?.id !== this.owner || q.message?.chat?.id !== this.owner || !ask || ask.msg !== q.message.message_id) return answer();
    if (ask.done) return answer(ask.done);
    const word = m[2] === 'y' ? ask.yes : ask.no;
    await answer(m[2] === 'y' ? '✅' : '❌');
    await this.onMessage?.({ id: String(q.message.message_id), text: `${word} ${m[1]}` });
  }

  // A text the router sent (on this channel or another, see join.js). A decision closes its
  // request's buttons, and the message shows the result in their place.
  observe(text) {
    const r = typeof text === 'string' && text.match(RESULT);
    if (r) return this.approvalDone(Number(r[2]), text.split('\n')[0].slice(0, 60));
  }

  async approvalDone(id, label) {
    const ask = this.asks()[id];
    if (!ask || ask.done || !this.owner) return;
    this.saveAsk(id, { ...ask, done: label });
    await this.call('editMessageReplyMarkup', { chat_id: this.owner, message_id: ask.msg, reply_markup: { inline_keyboard: [[{ text: label, callback_data: 'ap:done' }]] } })
      .catch((e) => this.log(`telegram: buttons not updated: ${e.message}`));
  }

  // opts.approvalId: this text asks for approval N (the router may pass it; else ASK finds it).
  async send(text, { approvalId } = {}) {
    if (!this.owner) throw new Error('telegram: not connected yet');
    const id = approvalId ?? Number(text.match(ASK)?.[1] ?? NaN);
    const ask = Number.isInteger(id) && id > 0 ? { ...answerWords(text) } : null;
    let msgId;
    for (let i = 0; i < text.length || i === 0; i += 4000) {
      const last = i + 4000 >= text.length;
      const body = { chat_id: this.owner, text: text.slice(i, i + 4000), ...(ask && last && { reply_markup: this.keyboard(id, ask) }) };
      msgId = (await this.call('sendMessage', body)).message_id;
    }
    if (ask) this.saveAsk(id, { ...ask, msg: msgId });
    else this.observe(text);
    return String(msgId);
  }

  // Images as photos, anything else as a document (multipart; the token stays in the URL path only).
  async sendFile(buf, { mimetype = 'application/octet-stream', fileName = 'file', caption = '' } = {}) {
    if (!this.owner) throw new Error('telegram: not connected yet');
    const photo = /^image\/(jpeg|png|webp)$/.test(mimetype);
    const form = new FormData();
    form.append('chat_id', String(this.owner));
    if (caption) form.append('caption', caption.slice(0, 1000));
    form.append(photo ? 'photo' : 'document', new Blob([buf], { type: mimetype }), fileName);
    const r = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${photo ? 'sendPhoto' : 'sendDocument'}`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`telegram send file: ${j.description || `HTTP ${r.status}`}`);
    return String(j.result.message_id);
  }

  async react(id, emoji) {
    await this.call('setMessageReaction', { chat_id: this.owner, message_id: Number(id), reaction: emoji ? [{ type: 'emoji', emoji }] : [] });
  }

  async typing(on) { if (on && this.owner) await this.call('sendChatAction', { chat_id: this.owner, action: 'typing' }); }

  stop() { this.running = false; }
}
