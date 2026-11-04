import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Approvals } from '../src/approvals.js';
import { strings } from '../src/i18n.js';
import { Policy } from '../src/policy.js';
import { Router } from '../src/router.js';
import { MemoryState } from '../src/state.js';

const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const t = strings('en');
const RESUMED = '[This turn was cut off by a restart.';

// A real Router around a fake channel and agent. Pass `state` to build a "new process" on old state.
function setup({ hooks = {}, state = new MemoryState(), now = Date.now } = {}) {
  const channel = {
    sent: [],
    reacts: [],
    async send(text) { this.sent.push(text); return `b${this.sent.length}`; },
    async react(id, emoji) { this.reacts.push([id, emoji]); },
    async typing() {},
  };
  const agent = {
    calls: [],
    async run(o) { agent.calls.push(o); return { text: 'ok', sessionId: 's1', context: 100 }; },
  };
  const approvals = new Approvals({ timeoutMs: 5000, holdMs: 0, store: state, now });
  const policy = new Policy({ agentCwd: path.join(os.tmpdir(), 'rs-agent'), root: path.join(os.tmpdir(), 'rs-code') });
  const config = { language: 'en', batchMs: 0, sessionIdleHours: 6, contextMaxK: 90 };
  const router = new Router({ config, state, approvals, policy, agent, channel, hooks, now, log: () => {} });
  const settle = async () => { for (let i = 0; i < 3; i++) { await router.inflow; await router.batch; await router.queue; } };
  return { router, channel, agent, state, settle };
}

const say = async (s, text, id = 'm1') => { await s.router.receive({ id, text }); await s.settle(); };

test('beforeTurn "restart": agent not run, inflight saved quiet, restart called, nothing sent', async () => {
  let restarted = 0;
  let asked = 0;
  const clock = { t: 5_000_000 };
  const s = setup({ now: () => clock.t, hooks: { beforeTurn: async () => { asked++; return 'restart'; }, restart: () => { restarted++; } } });
  await say(s, 'remind Dana about lunch');
  assert.equal(asked, 1);
  assert.equal(restarted, 1);
  assert.equal(s.agent.calls.length, 0);
  assert.deepEqual(s.channel.sent, []);
  assert.deepEqual(s.state.get('inflight'), { text: 'remind Dana about lunch', at: clock.t, quiet: true });
  assert.equal(s.router.current ?? null, null, 'no turn is running');
});

test('after the restart: resume() on the same state runs the same text silently', async () => {
  const state = new MemoryState();
  const clock = { t: 5_000_000 };
  let restarted = 0;
  const first = setup({ state, now: () => clock.t, hooks: { beforeTurn: () => 'restart', restart: () => { restarted++; } } });
  await say(first, 'call Dana at five');
  assert.equal(restarted, 1);

  // A new process: a new Router on the same stored state; its beforeTurn finds nothing new.
  clock.t += 20_000;
  const second = setup({ state, now: () => clock.t, hooks: { beforeTurn: () => 'none', restart: () => { restarted++; } } });
  const p = second.router.resume();
  assert.ok(p, 'a quiet turn is queued');
  await p;
  await second.settle();
  assert.equal(second.agent.calls.length, 1);
  assert.equal(second.agent.calls[0].prompt, 'call Dana at five');
  assert.ok(!second.agent.calls[0].prompt.startsWith(RESUMED), 'not the RESUMED wrapper');
  assert.ok(!second.channel.sent.includes(t.resumed), 'no "resumed" line');
  assert.deepEqual(second.channel.sent, ['ok'], 'only the real answer is sent');
  assert.equal(second.state.get('inflight') ?? null, null);
  assert.equal(restarted, 1, 'no second restart');
});

test('a quiet inflight older than 15 minutes is dropped, not run', async () => {
  const clock = { t: 5_000_000 };
  const s = setup({ now: () => clock.t });
  s.state.set('inflight', { text: 'old news', at: clock.t - 16 * 60_000, quiet: true });
  assert.equal(s.router.resume(), null);
  assert.equal(s.agent.calls.length, 0);
  assert.equal(s.state.get('inflight') ?? null, null);
});

test('a non-quiet inflight still gets the "resumed" line and the RESUMED wrapper', async () => {
  const clock = { t: 5_000_000 };
  const s = setup({ now: () => clock.t });
  s.state.set('inflight', { text: 'water the plants', at: clock.t - 1000 });
  await s.router.resume();
  await s.settle();
  assert.equal(s.channel.sent[0], t.resumed);
  assert.ok(s.agent.calls[0].prompt.startsWith(RESUMED));
  assert.ok(s.agent.calls[0].prompt.endsWith('water the plants'));
});

test('quiet resume with beforeTurn "restart" again: saved again, not run (a restart loop is the hook\'s job to end)', async () => {
  let restarted = 0;
  const clock = { t: 5_000_000 };
  const s = setup({ now: () => clock.t, hooks: { beforeTurn: () => 'restart', restart: () => { restarted++; } } });
  s.state.set('inflight', { text: 'again', at: clock.t, quiet: true });
  await s.router.resume();
  await s.settle();
  assert.equal(restarted, 1);
  assert.equal(s.agent.calls.length, 0);
  assert.equal(s.state.get('inflight').quiet, true);
});

test('beforeTurn "none": a normal turn, no restart, inflight cleared after', async () => {
  let restarted = 0;
  const s = setup({ hooks: { beforeTurn: () => 'none', restart: () => { restarted++; } } });
  await say(s, 'hello Dana');
  assert.equal(restarted, 0);
  assert.equal(s.agent.calls.length, 1);
  assert.equal(s.agent.calls[0].prompt, 'hello Dana');
  assert.deepEqual(s.channel.sent, ['ok']);
  assert.equal(s.state.get('inflight') ?? null, null);
});

test('beforeTurn is awaited before the agent runs, and runs once per turn', async () => {
  const order = [];
  const s = setup({
    hooks: {
      beforeTurn: async () => { order.push('before:start'); await new Promise((r) => setTimeout(r, 20)); order.push('before:end'); return 'none'; },
    },
  });
  s.agent.run = async (o) => { order.push('agent'); s.agent.calls.push(o); return { text: 'ok', sessionId: 's1', context: 1 }; };
  await say(s, 'one');
  await say(s, 'two');
  assert.deepEqual(order, ['before:start', 'before:end', 'agent', 'before:start', 'before:end', 'agent']);
});

test('beforeTurn returning something else (undefined, null, "other"): a normal turn', async () => {
  for (const value of [undefined, null, 'other', 'RESTART', true]) {
    let restarted = 0;
    const s = setup({ hooks: { beforeTurn: () => value, restart: () => { restarted++; } } });
    await say(s, 'plain');
    assert.equal(restarted, 0, String(value));
    assert.equal(s.agent.calls.length, 1, String(value));
  }
});

// BUG in src/router.js turn(): `Promise.resolve(this.hooks.beforeTurn?.()).catch(...)` calls the hook
// before Promise.resolve, so a hook that throws SYNCHRONOUSLY (a plain function, not async) escapes the
// .catch: turn() rejects, enqueue() sends the owner an error line, and the agent never runs.
// An async hook that rejects is fine (next test). Fix would be e.g. `Promise.resolve().then(() => hooks.beforeTurn?.())`.
test('beforeTurn throwing synchronously: a normal turn', async () => {
  let restarted = 0;
  const s = setup({ hooks: { beforeTurn: () => { throw new Error('sync broke'); }, restart: () => { restarted++; } } });
  await say(s, 'still works');
  assert.equal(restarted, 0);
  assert.equal(s.agent.calls[0].prompt, 'still works');
  assert.deepEqual(s.channel.sent, ['ok']);
});

test('beforeTurn rejecting (async): a normal turn', async () => {
  const s = setup({ hooks: { beforeTurn: async () => { throw new Error('offline'); }, restart: () => {} } });
  await say(s, 'still works too');
  assert.equal(s.agent.calls.length, 1);
  assert.deepEqual(s.channel.sent, ['ok']);
});

test('no hooks.restart: "restart" is ignored and the turn runs normally', async () => {
  const s = setup({ hooks: { beforeTurn: () => 'restart' } });
  await say(s, 'no restart hook');
  assert.equal(s.agent.calls.length, 1);
  assert.equal(s.agent.calls[0].prompt, 'no restart hook');
  assert.deepEqual(s.channel.sent, ['ok']);
  assert.equal(s.state.get('inflight') ?? null, null);
});

test('no beforeTurn hook at all: a normal turn', async () => {
  const s = setup({ hooks: { restart: () => { throw new Error('must not be called'); } } });
  await say(s, 'plain turn');
  assert.equal(s.agent.calls.length, 1);
});

test('a restart before a turn removes the 👀 only when the turn is run (the message is kept for the resume)', async () => {
  const s = setup({ hooks: { beforeTurn: () => 'restart', restart: () => {} } });
  await say(s, 'keep me', 'mX');
  assert.deepEqual(s.channel.reacts, [['mX', '👀']]);
  assert.equal(s.state.get('inflight').text, 'keep me');
});

test('batched messages are saved as one text for the resume', async () => {
  const s = setup({ hooks: { beforeTurn: () => 'restart', restart: () => {} } });
  s.router.batchMs = 30;
  await s.router.receive({ id: 'a', text: 'first' });
  await s.router.receive({ id: 'b', text: 'second' });
  await s.settle();
  assert.equal(s.state.get('inflight').text, 'first\n\nsecond');
  assert.equal(s.agent.calls.length, 0);
});

test('hooks.restart result is returned from turn() and an async restart is awaited', async () => {
  let done = false;
  const s = setup({ hooks: { beforeTurn: () => 'restart', restart: async () => { await new Promise((r) => setTimeout(r, 15)); done = true; return 'bye'; } } });
  const r = await s.router.turn('go');
  assert.equal(r, 'bye');
  assert.equal(done, true);
});
