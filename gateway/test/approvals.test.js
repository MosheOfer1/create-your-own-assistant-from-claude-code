import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Approvals, describe, parseReply, SHOW_MAX } from '../src/approvals.js';
import { strings } from '../src/i18n.js';
import { MemoryState } from '../src/state.js';

// Approvals timers are unref'd; a ref'd timer keeps the test process alive while they run.
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const req = (command = 'ls') => ({ tool_name: 'Bash', input: { command } });
const tick = () => new Promise((r) => setImmediate(r));

test('parseReply understands yes and no in several languages', () => {
  assert.deepEqual(parseReply('yes'), { decision: 'allow', id: null });
  assert.deepEqual(parseReply('  YES  '), { decision: 'allow', id: null });
  assert.deepEqual(parseReply('no'), { decision: 'deny', id: null });
  assert.deepEqual(parseReply('כן'), { decision: 'allow', id: null });
  assert.deepEqual(parseReply('לא'), { decision: 'deny', id: null });
  assert.deepEqual(parseReply('yes 3'), { decision: 'allow', id: 3 });
  assert.deepEqual(parseReply('כן #3'), { decision: 'allow', id: 3 });
  assert.deepEqual(parseReply('no #12'), { decision: 'deny', id: 12 });
  assert.deepEqual(parseReply('👍'), { decision: 'allow', id: null });
  assert.deepEqual(parseReply('❌'), { decision: 'deny', id: null });
});

test('parseReply ignores other text', () => {
  for (const t of ['', 'maybe', 'yes please', 'yes 3 4', 'what is the weather', 'yes, do it', '3']) {
    assert.equal(parseReply(t), null, JSON.stringify(t));
  }
  assert.equal(parseReply(), null);
});

test('create then answer("yes") allows', async () => {
  const a = new Approvals({ timeoutMs: 1000 });
  const { id, promise } = a.create(req());
  assert.equal(id, 1);
  assert.deepEqual(a.answer('yes'), { id: 1, decision: 'allow' });
  assert.deepEqual(await promise, { allow: true, reason: 'owner' });
  assert.equal(a.pending().length, 0);
});

test('answer("no") denies', async () => {
  const a = new Approvals({ timeoutMs: 1000 });
  const { promise } = a.create(req());
  a.answer('לא');
  assert.deepEqual(await promise, { allow: false, reason: 'owner' });
});

test('with two waiting, a bare yes is not an answer; a numbered one is', async () => {
  const a = new Approvals({ timeoutMs: 1000 });
  const one = a.create(req('one'));
  const two = a.create(req('two'));
  assert.equal(a.answer('yes'), null);
  assert.equal(a.waiting().length, 2);
  assert.deepEqual(a.answer('yes 2'), { id: 2, decision: 'allow' });
  assert.equal((await two.promise).allow, true);
  assert.deepEqual(a.answer('no'), { id: 1, decision: 'deny' }); // now only one waits
  assert.equal((await one.promise).allow, false);
});

test('an unknown number or non-reply is not an answer', () => {
  const a = new Approvals({ timeoutMs: 1000 });
  a.create(req());
  assert.equal(a.answer('yes 99'), null);
  assert.equal(a.answer('hello'), null);
  assert.equal(a.waiting().length, 1);
});

test('byNonce finds a pending request', () => {
  const a = new Approvals({ timeoutMs: 1000 });
  const { nonce, id } = a.create(req());
  assert.equal(a.byNonce(nonce).id, id);
  assert.equal(a.byNonce('nope'), null);
});

test('without holdMs a timeout denies', async () => {
  const a = new Approvals({ timeoutMs: 5 });
  const { promise } = a.create(req());
  assert.deepEqual(await promise, { allow: false, reason: 'timeout' });
  assert.equal(a.pending().length, 0);
});

test('with holdMs a timeout parks; a late answer calls onLate', async () => {
  const late = [];
  const a = new Approvals({ timeoutMs: 5, holdMs: 10_000, onLate: (item, d) => late.push([item.id, d, item.request]) });
  const { id, promise } = a.create(req('rm x'));
  assert.deepEqual(await promise, { allow: false, reason: 'parked', id });
  assert.equal(a.waiting().length, 0);
  assert.equal(a.pending().length, 1);
  assert.equal(a.answer('yes'), null); // parked: a bare yes needs its number
  assert.deepEqual(a.answer(`yes ${id}`), { id, decision: 'allow' });
  assert.deepEqual(late, [[id, 'allow', req('rm x')]]);
  assert.equal(a.pending().length, 0);
});

test('a parked request expires after holdMs without calling onLate', async () => {
  const late = [];
  const a = new Approvals({ timeoutMs: 2, holdMs: 10, onLate: (...x) => late.push(x) });
  const { promise } = a.create(req());
  await promise;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(a.pending().length, 0);
  assert.deepEqual(late, []);
});

test('stopping a waiting request denies it with reason stopped', async () => {
  const a = new Approvals({ timeoutMs: 1000 });
  const { id, promise } = a.create(req());
  a.resolve(id, 'deny', 'stopped');
  assert.deepEqual(await promise, { allow: false, reason: 'stopped' });
  assert.equal(a.resolve(id, 'deny'), false);
});

test('the store keeps ids growing and a parked request survives a new instance', async () => {
  const store = new MemoryState();
  const a = new Approvals({ timeoutMs: 2, holdMs: 10_000, store });
  const first = a.create(req('first'));
  await first.promise; // parked
  const second = a.create(req('second')); // still waiting
  assert.equal(second.id, 2);

  const late = [];
  const b = new Approvals({ timeoutMs: 1000, holdMs: 10_000, store, onLate: (item, d) => late.push([item.id, d]) });
  // The agent turn of a request that was waiting is gone too, so both come back parked.
  assert.deepEqual(b.pending().map((i) => [i.id, i.parked]), [[1, true], [2, true]]);
  assert.equal(b.create(req('third')).id, 3); // never reuses 1 or 2
  assert.deepEqual(b.answer('yes 1'), { id: 1, decision: 'allow' });
  assert.deepEqual(late, [[1, 'allow']]);
  for (const p of [a, b]) for (const i of p.pending()) clearTimeout(i.timer);
  await tick();
});

test('an expired stored request is dropped on load, and nothing is kept without holdMs', () => {
  const store = new MemoryState({ approvalNextId: 5, approvalsOpen: [{ id: 4, nonce: 'n', request: req(), at: 0, until: 1000 }] });
  const a = new Approvals({ timeoutMs: 1000, holdMs: 1000, store, now: () => 5000 });
  assert.equal(a.pending().length, 0);
  assert.equal(a.create(req()).id, 5);
  const live = new MemoryState({ approvalNextId: 5, approvalsOpen: [{ id: 4, nonce: 'n', request: req(), at: 0, until: 9000 }] });
  assert.equal(new Approvals({ timeoutMs: 1000, holdMs: 0, store: live, now: () => 5000 }).pending().length, 0);
});

test('describe shows a Bash command in full', () => {
  const t = strings('en');
  const long = `echo ${'x'.repeat(SHOW_MAX - 10)} END`;
  const text = describe('Bash', { command: long }, t);
  assert.ok(text.startsWith(t.runCommand));
  assert.ok(text.includes(long));
  assert.ok(text.endsWith('```'));
});

test('describe: files, other tools, long input and describers', () => {
  const t = strings('en');
  assert.equal(describe('Write', { file_path: '/a/b.md' }, t), `${t.changeFile} /a/b.md`);
  assert.equal(describe('NotebookEdit', { notebook_path: '/a/b.ipynb' }, t), `${t.changeFile} /a/b.ipynb`);
  assert.equal(describe('mcp__x__do', { a: 1 }, t), 'mcp__x__do\n{"a":1}');
  const cut = describe('mcp__x__do', { a: 'y'.repeat(3000) }, t);
  assert.ok(cut.endsWith('…') && cut.length < 1600);
  const describers = [() => null, (tool, input) => (tool === 'Bash' ? `custom ${input.command}` : null)];
  assert.equal(describe('Bash', { command: 'ls' }, t, describers), 'custom ls');
  assert.ok(describe('Write', { file_path: '/f' }, t, describers).startsWith(t.changeFile));
});
