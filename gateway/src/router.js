import { describe, parseReply, SHOW_MAX } from './approvals.js';
import { NEW, STOP, strings } from './i18n.js';
import { pickModel, STICKY_MS } from './modelpick.js';
import { quietUntil } from './quiet.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const GRANT_MS = 10 * 60_000; // a late yes may be used this long
const RESUME_MS = 15 * 60_000; // a turn cut off by a restart runs again if this recent
const LIVE_MS = 30 * 60_000; // a live location this recent goes with each turn
const HELD_TURN_MS = 3 * 3600_000; // a turn held in quiet hours still runs if this recent
const RESUMED = '[This turn was cut off by a restart.';

// The heart of the gateway: owner messages in, agent turns, approvals, replies out.
//
// channel: { send(text) → id, react?(msgId, emoji), typing?(on) }. Channels deliver only the
// owner's own messages: msg = { id, text, forwarded?, quoted? }.
// agent: { run({ prompt, sessionId, signal, onTool }) → { text, sessionId, isError, aborted, context } }.
// hooks (modules): context(text) → extra prompt text; command(text) → reply or null;
// describers: [(tool, input, t) → text]; approve(request) → decision or null.
export class Router {
  constructor({ config, state, approvals, policy, agent, channel, hooks = {}, now = Date.now, log = console.log }) {
    Object.assign(this, { config, state, approvals, policy, agent, channel, hooks, now, log });
    this.t = strings(config.language);
    this.inbox = [];
    this.grants = new Map(); // tool + exact input → expiry
    this.queue = Promise.resolve();
    this.batchMs = config.batchMs ?? 0;
    approvals.onLate = (item, decision) => this.lateAnswer(item, decision);
  }

  // opts.approvalId marks an approval request (Telegram puts buttons on it).
  async send(text, opts) {
    return this.channel.send(text?.trim() ? text : this.t.empty, opts);
  }

  // --- what the assistant says on its own (a mail summary, the morning brief) ---
  // Held in quiet hours (quiet.js), then sent. A held turn older than HELD_TURN_MS is dropped:
  // a morning brief at the end of Shabbat is no use. Answers and your own reminders never wait.

  quiet() { return quietUntil(this.config.quietHours, this.config.timezone, this.now()); }

  notify(text) { return this.quiet() ? this.hold({ send: text }) : this.send(text); }

  proactive(prompt) { return this.quiet() ? this.hold({ turn: prompt }) : this.enqueue(() => this.turn(prompt)); }

  hold(item) {
    this.state.set('held', [...(this.state.get('held') || []), { ...item, at: this.now() }].slice(-20));
    this.log(`quiet: held a ${item.send ? 'message' : 'turn'}`);
  }

  flushHeld() {
    const held = this.state.get('held') || [];
    if (!held.length || this.quiet()) return;
    this.state.set('held', []);
    for (const h of held) {
      if (h.send) this.send(h.send).catch(() => {});
      else if (this.now() - h.at < HELD_TURN_MS) this.enqueue(() => this.turn(h.turn));
    }
  }

  // The owner's live location, while they share it (the channel keeps it fresh for 30 minutes).
  // A pinned one counts for 3 hours: the owner often sends it first and asks after.
  // Kept in state too: an update restarts the gateway, often right between "here I am" and "where am I?".
  whereNow() {
    const live = this.channel.lastLocation, kept = this.state.get('lastLocation');
    const l = live && (!kept || live.at >= kept.at) ? live : kept;
    if (live && l === live && (kept?.at !== live.at || kept?.place !== live.place)) this.state.set('lastLocation', live);
    if (!l || this.now() - l.at > (l.live ? LIVE_MS : 3 * 3600_000)) return '';
    const min = Math.round((this.now() - l.at) / 60_000);
    return `[The owner's ${l.live ? 'live' : 'last sent'} location (${min} min ago): ${l.lat}, ${l.lon}${l.place ? ` — ${l.place}` : ''} — https://maps.google.com/?q=${l.lat},${l.lon}]`;
  }

  // --- sessions ---

  // The session the next turn continues. Idle for hours → a new one (short is fast and cheap).
  session() {
    const last = this.state.get('lastTurnAt');
    if (this.config.sessionIdleHours && last && this.now() - last > this.config.sessionIdleHours * 3600_000) this.newSession();
    return this.state.get('sessionId') || null;
  }

  newSession() {
    this.state.set('sessionId', null);
    this.state.set('tainted', null);
  }

  tainted() { return !!this.state.get('tainted'); }

  markTainted(why) {
    if (this.tainted()) return;
    this.state.set('tainted', { why: String(why).slice(0, 80), at: this.now() });
    this.log(`session: tainted by ${why}`);
  }

  // --- messages ---

  // Messages are taken in order, one after the other. Taking one never waits for a turn, so a
  // "yes" still reaches an approval while the agent works.
  receive(msg) {
    this.inflow = (this.inflow || Promise.resolve()).then(() => this.handle(msg)).catch((e) => this.log(`handle: ${e.stack || e}`));
    return this.inflow;
  }

  async handle(msg) {
    let text = (msg.text || '').trim();
    // Voice notes and files become text for the agent (media module). They go straight to a
    // turn: a transcript or a caption never answers an approval or runs a command.
    if ((msg.audio || msg.file) && this.hooks.media) {
      let t;
      try { t = await this.hooks.media(msg); } catch (e) { return this.send(this.t.error(e.message)); } // to the owner, not a turn
      if (msg.forwarded) this.markTainted('forwarded file');
      if (t) this.submit(msg.forwarded ? `[Forwarded, written by someone else:]\n${t}` : t, msg.id);
      return;
    }
    if (!text) return msg.unsupported || msg.audio || msg.file ? this.send(this.t.unsupported) : undefined;
    // A forwarded message is someone else's text: data, never an answer or a command.
    if (msg.forwarded) {
      this.markTainted('forwarded message');
      this.submit(`[Forwarded message, written by someone else:]\n«${text.slice(0, 8000)}»`, msg.id);
      return;
    }
    const answered = this.approvals.answer(text);
    if (answered) return this.send((answered.decision === 'allow' ? this.t.allowed : this.t.denied)(answered.id));
    // "yes 5" for a request that is no longer open (done, expired, a late button press): say so,
    // never start a turn with it.
    const late = parseReply(text);
    if (late?.id != null) return this.send(this.t.notOpen(late.id));
    const low = text.toLowerCase();
    if (STOP.includes(low)) return this.stop();
    if (NEW.includes(low)) {
      this.newSession();
      return this.send(this.t.newSession);
    }
    if (low === '/status') {
      const last = this.state.get('lastTurnAt');
      return this.send(this.t.status({ pending: this.approvals.pending().length, busy: !!this.current, idle: last ? `${Math.round((this.now() - last) / 60_000)} min` : '-' }));
    }
    const reply = await this.hooks.command?.(text);
    if (reply) return this.send(reply);
    const quoted = msg.quoted ? `[Replying to: «${String(msg.quoted).slice(0, 500)}»]\n` : '';
    this.submit(quoted + text, msg.id);
  }

  // Messages close together become one turn. 👀 at once, so the owner sees it arrived.
  submit(text, id) {
    if (id) this.channel.react?.(id, '👀')?.catch?.(() => {});
    this.inbox.push({ text, id });
    this.lastAt = this.now();
    if (this.batch) return this.batch;
    this.batch = this.enqueue(async () => {
      for (let wait = this.batchMs; wait > 0; wait = this.lastAt + this.batchMs - this.now()) await sleep(wait);
      const items = this.inbox.splice(0);
      this.batch = null;
      if (items.length) await this.turn(items.map((i) => i.text).join('\n\n'), items.map((i) => i.id).filter(Boolean));
    });
    return this.batch;
  }

  // One turn at a time; later work waits its turn.
  enqueue(job) {
    const next = this.queue.then(job).catch((e) => this.send(this.t.error(e.message)).catch(() => {}));
    this.queue = next;
    return next;
  }

  stop() {
    const items = this.inbox.splice(0);
    for (const i of items) if (i.id) this.channel.react?.(i.id, '')?.catch?.(() => {});
    const dropped = items.length;
    for (const a of this.approvals.waiting()) this.approvals.resolve(a.id, 'deny', 'stopped');
    if (!this.current && !dropped) return this.send(this.t.idle);
    this.current?.abort();
    return this.send(this.t.stopped);
  }

  async turn(text, ids = []) {
    // The private repo changed (config or code version): keep the message, restart, and answer
    // it after the restart as if nothing happened (resume, quiet).
    if (await Promise.resolve().then(() => this.hooks.beforeTurn?.()).catch(() => null) === 'restart' && this.hooks.restart) {
      this.state.set('inflight', { text, at: this.now(), quiet: true });
      return this.hooks.restart();
    }
    // The everyday model, or the strong one when this turn needs it (modelpick.js).
    let model;
    if (this.config.strongModel) {
      const p = pickModel(text, { now: this.now(), strongUntil: this.state.get('strongUntil') || 0 });
      text = p.text;
      model = p.strong ? this.config.strongModel : this.config.model;
      if (p.strong) this.state.set('strongUntil', this.now() + STICKY_MS);
    }
    const ctl = new AbortController();
    this.current = ctl;
    const typing = setInterval(() => this.channel.typing?.(true)?.catch?.(() => {}), 10_000);
    this.channel.typing?.(true)?.catch?.(() => {});
    // Kept until the turn ends: a restart in the middle finds it and carries on (resume).
    this.state.set('inflight', { text, at: this.now() });
    try {
      const extra = [(await Promise.resolve().then(() => this.hooks.context?.(text)).catch(() => '')) || '', this.whereNow()].filter(Boolean).join('\n\n');
      const onTool = (name, input) => { if (this.policy.untrusted(name, input)) this.markTainted(name); };
      const r = await this.agent.run({ prompt: [extra, text].filter(Boolean).join('\n\n'), sessionId: this.session(), model, signal: ctl.signal, onTool });
      this.state.set('lastTurnAt', this.now());
      // A failed turn drops its session: a broken one (e.g. it cannot be resumed) must not stick.
      if (r.isError && !r.aborted) this.newSession();
      else if (r.sessionId) this.state.set('sessionId', r.sessionId);
      if (this.config.contextMaxK && r.context > this.config.contextMaxK * 1000) {
        this.log(`session: ${Math.round(r.context / 1000)}K tokens a step, the next turn starts fresh`);
        this.newSession();
      }
      if (!r.aborted) {
        await this.send(r.text);
        this.hooks.afterTurn?.(text, r);
      }
    } finally {
      clearInterval(typing);
      this.channel.typing?.(false)?.catch?.(() => {});
      for (const id of ids) this.channel.react?.(id, '')?.catch?.(() => {});
      this.state.set('inflight', null);
      this.current = null;
    }
  }

  // After a restart: a recent turn that was cut off runs again, once.
  resume() {
    const f = this.state.get('inflight');
    this.state.set('inflight', null);
    if (!f?.text || this.now() - f.at > RESUME_MS || f.text.startsWith(RESUMED)) return null;
    // Restarted for an update before the turn began: nothing was done yet, so just answer it.
    if (f.quiet) return this.enqueue(() => this.turn(f.text));
    return this.enqueue(async () => {
      await this.send(this.t.resumed).catch(() => {});
      return this.turn(`${RESUMED} Go on with it; before you repeat an action, check whether it was already done.]\n${f.text}`);
    });
  }

  // --- approvals (called by the control API for every tool not pre-allowed) ---

  // Every yes (now or late) is reported to modules (hooks.approved), so a module that does the
  // real send can demand a one-time ticket for exactly what the owner saw.
  async requestApproval(request) {
    const r = await this.decide(request);
    if (r.allow) this.hooks.approved?.(request);
    return r;
  }

  async decide({ tool_name, input = {} }) {
    const tainted = this.tainted();
    if (this.policy.autoAllow(tool_name, input, { tainted })) return { allow: true, reason: 'free' };
    const fromModule = await this.hooks.approve?.({ tool_name, input, tainted });
    if (fromModule) return fromModule;
    if (this.useGrant(tool_name, input)) return { allow: true, reason: 'approved-late' };
    if (tool_name === 'Bash' && String(input.command || '').length > SHOW_MAX) {
      return { allow: false, reason: 'too-long', message: `The command is longer than ${SHOW_MAX} characters, too long for the owner to read. Put it in a script file in your folder and ask to run that.` };
    }
    const what = describe(tool_name, input, this.t, this.hooks.describers);
    if (what.length > SHOW_MAX + 300) { // room for the header lines around a full-size command
      return { allow: false, reason: 'too-long', message: `This request is longer than ${SHOW_MAX} characters, too long for the owner to read in full. Make it shorter (for a file: write it in your folder first, or in smaller parts).` };
    }
    const note = tainted && this.policy.autoAllow(tool_name, input) ? this.t.taint : '';
    return this.ask({ tool_name, input }, note + what);
  }

  async ask(request, what) {
    const { id, promise } = this.approvals.create(request);
    await this.send(this.t.ask(id, what), { approvalId: id });
    const r = await promise;
    if (r.reason !== 'parked') return r;
    const hours = Math.round(this.approvals.holdMs / 3600_000);
    await this.send(this.t.parked(id, hours)).catch(() => {});
    return { allow: false, reason: 'parked', message: `The owner has not answered yet. Request #${id} stays open ${hours} hours; when they approve it, you get a new turn to do it. Go on without it.` };
  }

  grantKey(tool, input) { return `${tool}\n${stable(input)}`; }

  useGrant(tool, input) {
    const k = this.grantKey(tool, input);
    const until = this.grants.get(k);
    this.grants.delete(k);
    return Boolean(until && until >= this.now());
  }

  // A parked request was answered. Yes opens a one-time grant for exactly that call and starts
  // a turn that makes it.
  lateAnswer(item, decision) {
    const { tool_name, input } = item.request;
    if (decision !== 'allow') return this.send(this.t.lateNo(item.id)).catch(() => {});
    this.grants.set(this.grantKey(tool_name, input), this.now() + GRANT_MS);
    this.send(this.t.lateYes(item.id)).catch(() => {});
    return this.enqueue(() => this.turn(`[The owner approved request #${item.id} now. Make exactly this call once, input unchanged:\n`
      + `tool: ${tool_name}\ninput (JSON): ${JSON.stringify(input)}\nThen say in one line what happened, and go on with the task it was part of.]`));
  }
}
