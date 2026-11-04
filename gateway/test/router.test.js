import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Approvals, SHOW_MAX } from '../src/approvals.js';
import { strings } from '../src/i18n.js';
import { Policy } from '../src/policy.js';
import { Router } from '../src/router.js';
import { MemoryState } from '../src/state.js';

// Approvals timers are unref'd; a ref'd timer keeps the test process alive while they run.
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const t = strings('en');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600_000;

async function waitFor(cond, what = 'condition') {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Real Router, Approvals, Policy and MemoryState around a fake channel and a fake agent.
function setup({ config = {}, timeoutMs = 5000, holdMs = 0, freeShell = false, hooks = {}, run, now = Date.now, state = new MemoryState() } = {}) {
  const log = [];
  const channel = {
    sent: [],
    reacts: [],
    async send(text) { log.push(`send:${text}`); this.sent.push(text); return `b${this.sent.length}`; },
    async react(id, emoji) { log.push(`react:${id}:${emoji}`); this.reacts.push([id, emoji]); },
    async typing() {},
  };
  const agent = {
    calls: [],
    async run(o) {
      agent.calls.push(o);
      log.push('agent');
      return run ? run(o, router) : { text: 'ok', sessionId: 's1', context: 1000 };
    },
  };
  const approvals = new Approvals({ timeoutMs, holdMs, store: state, now });
  const policy = new Policy({ agentCwd: path.join(os.tmpdir(), 'rt-agent'), root: path.join(os.tmpdir(), 'rt-code'), freeShell });
  const cfg = { language: 'en', batchMs: 0, sessionIdleHours: 6, contextMaxK: 90, ...config };
  const router = new Router({ config: cfg, state, approvals, policy, agent, channel, hooks, now, log: () => {} });
  const settle = async () => { for (let i = 0; i < 3; i++) { await router.inflow; await router.batch; await router.queue; } };
  return { router, channel, agent, state, approvals, log, settle };
}

const say = async (s, text, extra = {}) => { await s.router.receive({ id: `m${Math.random()}`, text, ...extra }); await s.settle(); };

test('a message gets 👀, reaches the agent, is answered, and 👀 is removed', async () => {
  const s = setup({ run: async () => ({ text: 'hi there', sessionId: 's1', context: 10 }) });
  await s.router.receive({ id: 'm1', text: 'hello' });
  await s.settle();
  assert.deepEqual(s.log, ['react:m1:👀', 'agent', 'send:hi there', 'react:m1:']);
  assert.equal(s.agent.calls[0].prompt, 'hello');
  assert.equal(s.state.get('inflight'), undefined);
  assert.equal(s.router.current, null);
});

test('two messages within batchMs become one turn', async () => {
  const s = setup({ config: { batchMs: 60 } });
  await s.router.receive({ id: 'a', text: 'first' });
  await sleep(10);
  await s.router.receive({ id: 'b', text: 'second' });
  await s.settle();
  assert.equal(s.agent.calls.length, 1);
  assert.equal(s.agent.calls[0].prompt, 'first\n\nsecond');
  assert.deepEqual(s.channel.reacts.filter(([, e]) => e === ''), [['a', ''], ['b', '']]);
});

test('messages far apart are separate turns', async () => {
  const s = setup({ config: { batchMs: 5 } });
  await say(s, 'one');
  await say(s, 'two');
  assert.deepEqual(s.agent.calls.map((c) => c.prompt), ['one', 'two']);
});

test('receive() handles messages in order, even when an earlier one is slow', async () => {
  const s = setup({ hooks: { command: async (text) => { if (text === 'slow') { await sleep(30); return 'R1'; } return null; } } });
  s.router.receive({ id: '1', text: 'slow' });
  s.router.receive({ id: '2', text: '/status' });
  await s.settle();
  assert.equal(s.channel.sent[0], 'R1');
  assert.match(s.channel.sent[1], /Waiting for approval: 0/);
});

test('an empty reply is shown as (empty); unsupported messages get a note; errors are reported', async () => {
  const s = setup({ run: async () => ({ text: '  ' }) });
  await say(s, 'q');
  assert.equal(s.channel.sent.at(-1), t.empty);
  await say(s, '', { unsupported: true });
  assert.equal(s.channel.sent.at(-1), t.unsupported);
  const bad = setup({ run: async () => { throw new Error('boom'); } });
  await bad.router.receive({ id: 'x', text: 'q' });
  await bad.settle();
  assert.deepEqual(bad.channel.sent, ['Error: boom']);
  assert.deepEqual(bad.channel.reacts.at(-1), ['x', '']);
  assert.equal(bad.state.get('inflight'), undefined);
});

test('"yes" while an approval waits resolves it; requestApproval sends the localized ask', async () => {
  const s = setup();
  const pending = s.router.requestApproval({ tool_name: 'mcp__x__do', input: { a: 1 } });
  await waitFor(() => s.channel.sent.length === 1, 'the ask');
  assert.equal(s.channel.sent[0], t.ask(1, 'mcp__x__do\n{"a":1}'));
  await s.router.receive({ id: 'y', text: 'yes' });
  assert.deepEqual(await pending, { allow: true, reason: 'owner' });
  assert.equal(s.channel.sent[1], t.allowed(1));
  assert.equal(s.agent.calls.length, 0); // the "yes" was not a prompt
});

test('the ask is in the owner language', async () => {
  const s = setup({ config: { language: 'he' } });
  const pending = s.router.requestApproval({ tool_name: 'Bash', input: { command: 'rm x' } });
  await waitFor(() => s.channel.sent.length === 1);
  assert.match(s.channel.sent[0], /בקשה #1/);
  assert.match(s.channel.sent[0], /להריץ פקודה:/);
  await s.router.receive({ id: 'n', text: 'לא' });
  assert.equal((await pending).allow, false);
  assert.match(s.channel.sent[1], /נדחה/);
});

test('read-only tools are free and never ask', async () => {
  const s = setup();
  assert.deepEqual(await s.router.requestApproval({ tool_name: 'Bash', input: { command: 'ls -la' } }), { allow: true, reason: 'free' });
  assert.equal(s.channel.sent.length, 0);
});

test('a module approve hook decides before the owner is asked', async () => {
  const s = setup({ hooks: { approve: async ({ tool_name }) => (tool_name === 'mcp__m__ok' ? { allow: true, reason: 'module' } : null) } });
  assert.deepEqual(await s.router.requestApproval({ tool_name: 'mcp__m__ok', input: {} }), { allow: true, reason: 'module' });
  assert.equal(s.channel.sent.length, 0);
});

test('in a tainted conversation the ask says why', async () => {
  const s = setup({ freeShell: true });
  s.router.markTainted('test');
  const pending = s.router.requestApproval({ tool_name: 'Bash', input: { command: 'npm test' } });
  await waitFor(() => s.channel.sent.length === 1);
  assert.ok(s.channel.sent[0].includes(t.taint));
  await say(s, 'yes');
  assert.equal((await pending).allow, true);
});

test('stop aborts a running turn and sends no reply', async () => {
  const s = setup({ run: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ text: 'late', aborted: true }))) });
  await s.router.receive({ id: 'm1', text: 'long job' });
  await waitFor(() => s.agent.calls.length === 1);
  await s.router.receive({ id: 'm2', text: 'עצור' });
  await s.settle();
  assert.deepEqual(s.channel.sent, [t.stopped]);
  assert.deepEqual(s.channel.reacts.at(-1), ['m1', '']);
  assert.equal(s.router.current, null);
  assert.equal(s.state.get('inflight'), undefined);
});

test('stop drops batched messages before the agent sees them', async () => {
  const s = setup({ config: { batchMs: 200 } });
  await s.router.receive({ id: 'a', text: 'one' });
  await s.router.receive({ id: 'b', text: 'two' });
  await s.router.receive({ id: 'c', text: 'stop' });
  await s.settle();
  assert.equal(s.agent.calls.length, 0);
  assert.deepEqual(s.channel.sent, [t.stopped]);
});

test('stop removes the 👀 from messages it dropped', async () => {
  const s = setup({ config: { batchMs: 100 } });
  await s.router.receive({ id: 'a', text: 'one' });
  await s.router.receive({ id: 'b', text: 'two' });
  await s.router.receive({ id: 'c', text: 'stop' });
  await s.settle();
  assert.deepEqual(s.channel.reacts.filter(([, e]) => e === '').map(([id]) => id).sort(), ['a', 'b']);
});

test('stop with nothing running says so; stop also denies a waiting approval', async () => {
  const s = setup();
  await say(s, '/stop');
  assert.deepEqual(s.channel.sent, [t.idle]);
  let result;
  const run = async (o, router) => { result = await router.requestApproval({ tool_name: 'mcp__x__do', input: {} }); return { text: 'x', aborted: o.signal.aborted }; };
  const w = setup({ run });
  await w.router.receive({ id: 'm', text: 'go' });
  await waitFor(() => w.approvals.waiting().length === 1);
  await w.router.receive({ id: 's', text: 'stop' });
  await w.settle();
  assert.equal(result.allow, false);
  assert.equal(result.reason, 'stopped');
  assert.equal(w.channel.sent.at(-1), t.stopped);
});

test('/new clears sessionId and taint', async () => {
  const s = setup();
  s.state.set('sessionId', 'old');
  s.router.markTainted('x');
  assert.equal(s.router.tainted(), true);
  await say(s, '/new');
  assert.equal(s.state.get('sessionId'), undefined);
  assert.equal(s.router.tainted(), false);
  assert.deepEqual(s.channel.sent, [t.newSession]);
  s.state.set('sessionId', 'old2');
  await say(s, 'שיחה חדשה');
  assert.equal(s.state.get('sessionId'), undefined);
  assert.equal(s.agent.calls.length, 0);
});

test('a forwarded message taints the conversation, is wrapped, and is never an answer', async () => {
  const s = setup();
  const pending = s.router.requestApproval({ tool_name: 'mcp__x__do', input: {} });
  await waitFor(() => s.approvals.waiting().length === 1);
  await say(s, 'yes', { forwarded: true });
  assert.equal(s.approvals.waiting().length, 1); // still waiting
  assert.equal(s.router.tainted(), true);
  assert.equal(s.agent.calls[0].prompt, '[Forwarded message, written by someone else:]\n«yes»');
  await say(s, 'yes');
  assert.equal((await pending).allow, true);
});

test('a quoted message adds the quote to the prompt', async () => {
  const s = setup();
  await say(s, 'and this?', { quoted: 'earlier text' });
  assert.equal(s.agent.calls[0].prompt, '[Replying to: «earlier text»]\nand this?');
});

test('a tool that brings in outside text taints the conversation', async () => {
  const s = setup({ run: async ({ onTool }) => { onTool('WebFetch', { url: 'https://a.com' }); return { text: 'done' }; } });
  await say(s, 'read it');
  assert.equal(s.router.tainted(), true);
});

test('the module context is put before the prompt', async () => {
  const s = setup({ hooks: { context: async (text) => `CTX for ${text}` } });
  await say(s, 'hello');
  assert.equal(s.agent.calls[0].prompt, 'CTX for hello\n\nhello');
});

test('sessionId is saved and passed to the next turn', async () => {
  const s = setup();
  await say(s, 'one');
  assert.equal(s.agent.calls[0].sessionId, null);
  assert.equal(s.state.get('sessionId'), 's1');
  await say(s, 'two');
  assert.equal(s.agent.calls[1].sessionId, 's1');
});

test('idle hours start a new session and clear the taint', async () => {
  const clock = { t: 1_000_000 };
  const s = setup({ now: () => clock.t });
  await say(s, 'one');
  s.router.markTainted('x');
  clock.t += 5 * HOUR;
  await say(s, 'two');
  assert.equal(s.agent.calls[1].sessionId, 's1');
  clock.t += 7 * HOUR;
  await say(s, 'three');
  assert.equal(s.agent.calls[2].sessionId, null);
  assert.equal(s.router.tainted(), false);
});

test('a context over contextMaxK starts a new session next turn', async () => {
  let context = 50_000;
  const s = setup({ run: async () => ({ text: 'ok', sessionId: 's9', context }) });
  await say(s, 'one');
  assert.equal(s.state.get('sessionId'), 's9');
  context = 91_000;
  await say(s, 'two');
  assert.equal(s.state.get('sessionId'), undefined);
  await say(s, 'three');
  assert.equal(s.agent.calls[2].sessionId, null);
});

test('a Bash command longer than SHOW_MAX is refused without asking', async () => {
  const s = setup();
  const r = await s.router.requestApproval({ tool_name: 'Bash', input: { command: `rm ${'x'.repeat(SHOW_MAX)}` } });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'too-long');
  assert.match(r.message, /too long/);
  assert.equal(s.channel.sent.length, 0);
  assert.equal(s.approvals.pending().length, 0);
});

test('model pick: everyday by default, strong when asked or needed, and it sticks a while', async () => {
  let t = 1_000_000;
  const s = setup({ config: { model: 'sonnet', strongModel: 'opus' }, now: () => t });
  await say(s, 'hi');
  await say(s, 'opus: what now');
  t += 60_000;
  await say(s, 'yes go on');
  t += 11 * 60_000;
  await say(s, 'thanks');
  assert.deepEqual(s.agent.calls.map((c) => c.model), ['sonnet', 'opus', 'opus', 'sonnet']);
  assert.equal(s.agent.calls[1].prompt, 'what now'); // the prefix is dropped
  const off = setup({ config: { strongModel: null } });
  await say(off, 'opus: plan my week');
  assert.equal(off.agent.calls[0].model, undefined); // the agent's own default
});

test('quiet hours: notify and proactive wait, then go out; a stale held turn is dropped; answers never wait', async () => {
  // 2026-11-04 23:00 UTC, a Wednesday; quiet 22:00-07:00.
  let t = Date.UTC(2026, 10, 4, 23, 0);
  const s = setup({ config: { timezone: 'UTC', quietHours: [{ from: '22:00', to: '07:00' }] }, now: () => t });
  await s.router.notify('📧 mail');
  await s.router.proactive('old brief'); // held 8 hours: stale by the morning
  await say(s, 'hi'); // the owner's own message is answered at once
  t = Date.UTC(2026, 10, 5, 6, 30);
  await s.router.proactive('brief');
  assert.deepEqual(s.agent.calls.map((c) => c.prompt), ['hi']);
  s.router.flushHeld(); // still quiet: nothing
  assert.equal(s.state.get('held').length, 3);
  t = Date.UTC(2026, 10, 5, 7, 1);
  s.router.flushHeld();
  await s.settle();
  assert.deepEqual(s.state.get('held'), []);
  assert.ok(s.channel.sent.includes('📧 mail'));
  assert.deepEqual(s.agent.calls.map((c) => c.prompt), ['hi', 'brief']);
});

test('"yes 7" for a request that is not open says so and starts no turn', async () => {
  const s = setup();
  await say(s, 'yes 7');
  assert.deepEqual(s.channel.sent, ['Request #7 is no longer open.']);
  assert.equal(s.agent.calls.length, 0);
});

test('a live location goes with each turn while it is fresh; an old or a fixed one does not', async () => {
  let t = 10_000_000;
  const s = setup({ now: () => t });
  s.channel.lastLocation = { lat: 32.1, lon: 34.8, at: t - 3 * 60_000, live: true };
  await say(s, 'where is the nearest pharmacy?');
  assert.match(s.agent.calls[0].prompt, /^\[The owner's live location \(3 min ago\): 32\.1, 34\.8 — https:\/\/maps\.google\.com\/\?q=32\.1,34\.8\]\n\nwhere/);
  t += 40 * 60_000;
  await say(s, 'and now?');
  assert.equal(s.agent.calls[1].prompt, 'and now?');
  s.channel.lastLocation = { lat: 1, lon: 2, at: t, live: false };
  await say(s, 'x');
  assert.equal(s.agent.calls[2].prompt, 'x');
});

test('any request too long to show in full is refused, never cut (M4)', async () => {
  const s = setup();
  for (const [tool_name, input] of [['Write', { file_path: '/x/f', content: 'y'.repeat(SHOW_MAX + 400) }], ['mcp__x__do', { a: 'y'.repeat(SHOW_MAX + 400) }]]) {
    const r = await s.router.requestApproval({ tool_name, input });
    assert.equal(r.reason, 'too-long', tool_name);
  }
  assert.equal(s.channel.sent.length, 0);
});

test('a parked request is parked for the agent and announced to the owner', async () => {
  const s = setup({ timeoutMs: 10, holdMs: 2 * HOUR });
  const r = await s.router.requestApproval({ tool_name: 'mcp__x__do', input: { a: 1 } });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'parked');
  assert.match(r.message, /#1 stays open 2 hours/);
  assert.equal(s.channel.sent[1], t.parked(1, 2));
});

test('parked + late yes: one grant for exactly that call, and a new turn is enqueued', async () => {
  const results = [];
  const run = async (o, router) => {
    if (o.prompt.startsWith('[The owner approved')) {
      // same call with the keys in another order, then the same call again
      results.push((await router.requestApproval({ tool_name: 'mcp__x__do', input: { b: [1, 2], a: 1 } })).reason);
      results.push((await router.requestApproval({ tool_name: 'mcp__x__do', input: { a: 1, b: [1, 2] } })).reason);
      return { text: 'did it' };
    }
    return { text: 'ok' };
  };
  const s = setup({ timeoutMs: 10, holdMs: 2 * HOUR, run });
  const first = await s.router.requestApproval({ tool_name: 'mcp__x__do', input: { a: 1, b: [1, 2] } });
  assert.equal(first.reason, 'parked');
  await s.router.receive({ id: 'y', text: 'yes 1' });
  await s.settle();
  assert.ok(s.channel.sent.includes(t.lateYes(1)));
  assert.equal(s.agent.calls.length, 1);
  assert.match(s.agent.calls[0].prompt, /^\[The owner approved request #1 now\./);
  assert.match(s.agent.calls[0].prompt, /tool: mcp__x__do\ninput \(JSON\): \{"a":1,"b":\[1,2\]\}/);
  assert.deepEqual(results, ['approved-late', 'parked']); // the grant works once
  assert.ok(s.channel.sent.includes(t.parked(2, 2))); // the second call asked again and parked as #2
  assert.ok(s.channel.sent.includes('did it'));
});

test('a different input does not use the grant, and a late no starts no turn', async () => {
  const s = setup({ timeoutMs: 10, holdMs: 2 * HOUR });
  await s.router.requestApproval({ tool_name: 'mcp__x__do', input: { a: 1 } });
  await s.router.requestApproval({ tool_name: 'mcp__x__do', input: { a: 2 } });
  await s.router.receive({ id: 'y', text: 'no 1' });
  await s.settle();
  assert.ok(s.channel.sent.includes(t.lateNo(1)));
  assert.equal(s.agent.calls.length, 0);
  s.router.grants.set(s.router.grantKey('mcp__x__do', { a: 1 }), Date.now() + HOUR);
  assert.equal(s.router.useGrant('mcp__x__do', { a: 2 }), false);
  assert.equal(s.router.useGrant('mcp__x__do', { a: 1 }), true);
});

test('an expired grant is not used', () => {
  const clock = { t: 1000 };
  const s = setup({ now: () => clock.t });
  s.router.grants.set(s.router.grantKey('Bash', { command: 'x' }), clock.t + 10 * 60_000);
  clock.t += 11 * 60_000;
  assert.equal(s.router.useGrant('Bash', { command: 'x' }), false);
});

test('resume() runs a recent cut-off turn once', async () => {
  const clock = { t: 10_000_000 };
  const s = setup({ now: () => clock.t });
  s.state.set('inflight', { text: 'do the thing', at: clock.t - 60_000 });
  await s.router.resume();
  await s.settle();
  assert.equal(s.channel.sent[0], t.resumed);
  assert.equal(s.agent.calls.length, 1);
  assert.match(s.agent.calls[0].prompt, /^\[This turn was cut off by a restart\./);
  assert.ok(s.agent.calls[0].prompt.endsWith('\ndo the thing'));
  assert.equal(s.state.get('inflight'), undefined);
  assert.equal(s.router.resume(), null); // nothing left to run
});

test('resume() skips old turns, resumed turns that were cut off again, and empty state', () => {
  const clock = { t: 10_000_000 };
  const s = setup({ now: () => clock.t });
  assert.equal(s.router.resume(), null);
  s.state.set('inflight', { text: 'old', at: clock.t - 16 * 60_000 });
  assert.equal(s.router.resume(), null);
  s.state.set('inflight', { text: '[This turn was cut off by a restart. Go on with it]\nx', at: clock.t });
  assert.equal(s.router.resume(), null);
  assert.equal(s.agent.calls.length, 0);
  assert.equal(s.state.get('inflight'), undefined);
});
