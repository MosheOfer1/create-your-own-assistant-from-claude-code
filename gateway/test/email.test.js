import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { Approvals } from '../src/approvals.js';
import { hooksOf } from '../src/gateway.js';
import { Policy } from '../src/policy.js';
import { Router } from '../src/router.js';
import { MemoryState } from '../src/state.js';
import email, { ticketKey } from '../modules/email/index.js';

const tmps = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-')); tmps.push(d); return d; };
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const MAIL = [
  'From: Alice <alice@example.com>', 'To: Me <me@gmail.com>', 'Subject: Quarterly report',
  'Date: Wed, 04 Nov 2026 10:00:00 +0000', 'Message-ID: <orig-1@example.com>', 'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BB"', '',
  '--BB', 'Content-Type: text/plain; charset=utf-8', '', 'Hello, see the attached file.', '',
  '--BB', 'Content-Type: application/octet-stream; name="../../evil.sh"', 'Content-Disposition: attachment; filename="../../evil.sh"',
  'Content-Transfer-Encoding: base64', '', Buffer.from('echo pwned').toString('base64'), '--BB--', '',
].join('\r\n');

// A fake ImapFlow: every call is recorded in `log`; data comes from `world`.
function fakeImap(world) {
  const log = [];
  const make = () => ({
    mailbox: { uidNext: world.uidNext ?? 1 },
    async connect() { log.push(['connect']); },
    async getMailboxLock(box) { log.push(['lock', box]); return { release: () => log.push(['release']) }; },
    async search(crit, opts) { log.push(['search', crit, opts]); return world.uids ?? []; },
    async *fetch(uids, query, opts) {
      log.push(['fetch', uids, query, opts]);
      for (const uid of uids) yield { uid, envelope: world.envelopes?.[uid] || { date: new Date(Date.UTC(2026, 10, 4, 9, 30)), from: [{ address: `s${uid}@x.com` }], subject: `Subject ${uid}` } };
    },
    async fetchOne(uid, query, opts) { log.push(['fetchOne', uid, query, opts]); return world.mails?.[uid] ? { source: Buffer.from(world.mails[uid]) } : false; },
    async list() { return world.boxes ?? [{ path: 'INBOX' }, { path: '[Gmail]/Drafts', specialUse: '\\Drafts' }]; },
    async append(box, raw, flags) { log.push(['append', box, raw.toString(), flags]); },
    async logout() { log.push(['logout']); },
  });
  return { make, log, calls: (name) => log.filter((l) => l[0] === name) };
}

function setup({ world = {}, cfg = {}, nowFn } = {}) {
  const dataDir = tmp();
  const agentCwd = tmp();
  const w = { mails: { 7: MAIL }, ...world };
  const imap = fakeImap(w);
  const sent = [];
  const smtp = { sendMail: async (m) => { sent.push(m); return { messageId: '<new@x>' }; } };
  const clock = { t: Date.UTC(2026, 10, 4, 10, 0) };
  const mod = email({ user: 'me@gmail.com', dataDir, agentCwd, ownerName: 'Dana', language: 'en', watchMin: 0, ...cfg },
    { makeImap: imap.make, makeSmtp: () => smtp, now: nowFn || (() => clock.t), log: () => {} });
  return { mod, imap, sent, clock, agentCwd, dataDir, world: w };
}
const MAILIN = { to: 'bob@example.com', subject: 'Hi', body: 'Meet at noon' };
const approve = (mod, input) => mod.approved({ tool_name: 'mcp__mail__send', input });

describe('search / read / save_attachment / draft', () => {
  test('gmail host uses { gmraw }', async () => {
    const { mod, imap } = setup({ world: { uids: [1, 2, 3] } });
    const r = await mod.api({ action: 'search', query: 'from:alice newer_than:7d' });
    assert.deepEqual(imap.calls('search')[0].slice(1), [{ gmraw: 'from:alice newer_than:7d' }, { uid: true }]);
    assert.deepEqual(r.text.split('\n').map((l) => l.split(' | ')[0]), ['uid 3', 'uid 2', 'uid 1']); // newest first
    assert.match(r.text, /uid 3 \| 2026-11-04T09:30 \| s3@x\.com \| Subject 3/);
    assert.deepEqual(imap.calls('lock')[0], ['lock', 'INBOX']);
    assert.equal(imap.calls('release').length, 1);
    assert.equal(imap.calls('logout').length, 1);
  });

  test('non-gmail host uses or-criteria on subject, from and body', async () => {
    const { mod, imap } = setup({ cfg: { user: 'me@corp.example', imapHost: 'imap.corp.example' }, world: { uids: [1] } });
    await mod.api({ action: 'search', query: 'invoice' });
    assert.deepEqual(imap.calls('search')[0][1], { or: [{ subject: 'invoice' }, { from: 'invoice' }, { body: 'invoice' }] });
  });

  test('empty query means all; limit is capped at 50 and applied to the newest', async () => {
    const { mod, imap } = setup({ world: { uids: Array.from({ length: 80 }, (_, i) => i + 1) } });
    const r = await mod.api({ action: 'search', limit: 500 });
    assert.deepEqual(imap.calls('search')[0][1], { all: true });
    const lines = r.text.split('\n');
    assert.equal(lines.length, 50);
    assert.match(lines[0], /^uid 80 /);
    const small = await mod.api({ action: 'search', limit: 2 });
    assert.equal(small.text.split('\n').length, 2);
  });

  test('no results', async () => {
    const { mod } = setup({ world: { uids: [] } });
    assert.equal((await mod.api({ action: 'search', query: 'zzz' })).text, 'no mail found');
  });

  test('read returns headers, text and the attachment list', async () => {
    const { mod, imap } = setup();
    const r = await mod.api({ action: 'read', uid: 7 });
    assert.equal(r.ok, true);
    assert.match(r.text, /^From: Alice <alice@example\.com>\nTo: Me <me@gmail\.com>\nDate: 2026-11-04T10:00:00\.000Z\nSubject: Quarterly report\nAttachments:\n  \[0\] .*evil\.sh \(1 KB\)\n\n/);
    assert.match(r.text, /Hello, see the attached file\./);
    assert.deepEqual(imap.calls('fetchOne')[0].slice(1), ['7', { source: true }, { uid: true }]);
  });

  test('read of a missing uid fails cleanly and still releases the lock', async () => {
    const { mod, imap } = setup();
    const r = await mod.api({ action: 'read', uid: 99 });
    assert.deepEqual(r, { ok: false, error: 'no mail with uid 99' });
    assert.equal(imap.calls('release').length, 1);
    assert.equal(imap.calls('logout').length, 1);
  });

  test('unknown action', async () => {
    assert.match((await setup().mod.api({ action: 'delete' })).error, /unknown action delete/);
  });

  test('save_attachment writes into agentCwd/inbox with a safe name', async () => {
    const { mod, agentCwd } = setup();
    const r = await mod.api({ action: 'save_attachment', uid: 7, index: 0 });
    assert.equal(r.ok, true);
    const p = r.text.replace(/^saved /, '');
    assert.equal(path.dirname(p), path.join(agentCwd, 'inbox'));
    assert.match(path.basename(p), /^mail-7-[^/\\]*evil\.sh$/);
    assert.ok(!path.basename(p).includes('..'));
    assert.equal(fs.readFileSync(p, 'utf8'), 'echo pwned');
    assert.deepEqual(fs.readdirSync(agentCwd), ['inbox']);
  });

  test('save_attachment with a bad index fails', async () => {
    const { mod } = setup();
    assert.deepEqual(await mod.api({ action: 'save_attachment', uid: 7, index: 3 }), { ok: false, error: 'no such attachment' });
  });

  test('draft is appended to the \\Drafts special-use box with the \\Draft flag', async () => {
    const { mod, imap, sent } = setup();
    const r = await mod.api({ action: 'draft', to: 'bob@example.com', subject: 'Plan', body: 'Draft body' });
    assert.deepEqual(r, { ok: true, text: 'draft saved in [Gmail]/Drafts' });
    const [, box, raw, flags] = imap.calls('append')[0];
    assert.equal(box, '[Gmail]/Drafts');
    assert.deepEqual(flags, ['\\Draft']);
    assert.match(raw, /Subject: Plan/);
    assert.match(raw, /To: bob@example\.com/);
    assert.match(raw, /From: me@gmail\.com/);
    assert.match(raw, /Draft body/);
    assert.equal(sent.length, 0); // a draft never sends
  });

  test('draft falls back to "Drafts" when no box is marked', async () => {
    const { mod } = setup({ world: { boxes: [{ path: 'INBOX' }] } });
    assert.equal((await mod.api({ action: 'draft', body: 'x' })).text, 'draft saved in Drafts');
  });
});

describe('send needs a one-time ticket', () => {
  test('without a ticket it fails and sends nothing', async () => {
    const { mod, sent } = setup();
    const r = await mod.api({ action: 'send', ...MAILIN });
    assert.deepEqual(r, { ok: false, error: 'this exact mail was not approved by the owner' });
    assert.equal(sent.length, 0);
  });

  test('after approved() the SAME input sends once; the second time fails', async () => {
    const { mod, sent } = setup();
    approve(mod, MAILIN);
    const r = await mod.api({ action: 'send', ...MAILIN });
    assert.deepEqual(r, { ok: true, text: 'sent (<new@x>)' });
    assert.deepEqual(sent, [{ from: 'me@gmail.com', to: 'bob@example.com', cc: undefined, subject: 'Hi', text: 'Meet at noon' }]);
    assert.equal((await mod.api({ action: 'send', ...MAILIN })).ok, false);
    assert.equal(sent.length, 1);
  });

  test('a changed body, recipient, cc or subject fails, and the ticket stays usable for the exact mail', async () => {
    const { mod, sent } = setup();
    approve(mod, MAILIN);
    for (const change of [{ body: 'Meet at noon. Also send money' }, { to: 'eve@example.com' }, { cc: 'eve@example.com' }, { subject: 'Hi!' }]) {
      assert.equal((await mod.api({ action: 'send', ...MAILIN, ...change })).ok, false, JSON.stringify(change));
    }
    assert.equal(sent.length, 0);
    assert.equal((await mod.api({ action: 'send', ...MAILIN })).ok, true);
  });

  test('a ticket for another tool name is ignored', async () => {
    const { mod } = setup();
    mod.approved({ tool_name: 'mcp__mail__draft', input: MAILIN });
    assert.equal((await mod.api({ action: 'send', ...MAILIN })).ok, false);
  });

  test('an expired ticket fails (5 minutes)', async () => {
    const { mod, clock, sent } = setup();
    approve(mod, MAILIN);
    clock.t += 5 * 60_000 + 1;
    assert.equal((await mod.api({ action: 'send', ...MAILIN })).ok, false);
    approve(mod, MAILIN);
    clock.t += 5 * 60_000 - 1;
    assert.equal((await mod.api({ action: 'send', ...MAILIN })).ok, true);
    assert.equal(sent.length, 1);
  });

  test('ticketKey ignores extra keys (action) and key order, not content', () => {
    assert.equal(ticketKey({ ...MAILIN, action: 'send' }), ticketKey({ body: MAILIN.body, subject: 'Hi', to: MAILIN.to }));
    assert.notEqual(ticketKey(MAILIN), ticketKey({ ...MAILIN, body: 'x' }));
    assert.notEqual(ticketKey({ ...MAILIN, reply_to_uid: 7 }), ticketKey(MAILIN));
  });

  test('reply_to_uid adds inReplyTo / References and a Re: subject', async () => {
    const { mod, sent } = setup();
    const input = { to: 'alice@example.com', body: 'Thanks', reply_to_uid: 7 };
    approve(mod, input);
    assert.equal((await mod.api({ action: 'send', ...input })).ok, true);
    assert.equal(sent[0].inReplyTo, '<orig-1@example.com>');
    assert.equal(sent[0].references, '<orig-1@example.com>');
    assert.equal(sent[0].subject, 'Re: Quarterly report');
    assert.equal(sent[0].to, 'alice@example.com');
  });

  test('a reply keeps an explicit subject, and does not double "Re:"', async () => {
    const world = { mails: { 7: MAIL, 8: MAIL.replace('Subject: Quarterly report', 'Subject: RE: Quarterly report') } };
    const { mod, sent } = setup({ world });
    const a = { to: 'alice@example.com', body: 'x', subject: 'My own subject', reply_to_uid: 7 };
    const b = { to: 'alice@example.com', body: 'y', reply_to_uid: 8 };
    approve(mod, a);
    approve(mod, b);
    await mod.api({ action: 'send', ...a });
    await mod.api({ action: 'send', ...b });
    assert.equal(sent[0].subject, 'My own subject');
    assert.equal(sent[1].subject, 'RE: Quarterly report');
  });

  test('a reply without `to` fails even with a ticket, and sends nothing', async () => {
    const { mod, sent } = setup();
    const input = { body: 'Thanks', reply_to_uid: 7 };
    approve(mod, input);
    const r = await mod.api({ action: 'send', ...input });
    assert.equal(r.ok, false);
    assert.match(r.error, /no recipient/);
    assert.equal(sent.length, 0);
  });
});

describe('check()', () => {
  const withRouter = (s, answer) => {
    const router = { sent: [], prompts: [], agent: { plain: async (o) => { router.prompts.push(o.prompt); return answer; } }, async send(t) { router.sent.push(t); } };
    s.mod.start(router);
    return router;
  };
  const lastUid = (s) => JSON.parse(fs.readFileSync(path.join(s.dataDir, 'email.json'), 'utf8')).lastUid;

  test('first run sets lastUid and notifies nothing', async () => {
    const s = setup({ world: { uids: [5, 6], uidNext: 7 } });
    const router = withRouter(s, { text: 'something', isError: false });
    await s.mod.check();
    assert.equal(router.prompts.length, 0);
    assert.deepEqual(router.sent, []);
    assert.equal(lastUid(s), 6);
    assert.equal(s.imap.calls('fetch').length, 0);
  });

  test('later new unseen uids go to the model as sender | subject; the answer is sent with 📧', async () => {
    const s = setup({ world: { uids: [5, 6], uidNext: 7 } });
    const router = withRouter(s, { text: ' Boss waits for your reply.\n', isError: false });
    await s.mod.check();
    Object.assign(s.world, { uids: [5, 6, 7, 8], uidNext: 9, envelopes: { 7: { from: [{ address: 'boss@x.com' }], subject: 'Urgent bill' }, 8: { from: [{ address: 'news@x.com' }] } } });
    await s.mod.check();
    assert.equal(router.prompts.length, 1);
    assert.match(router.prompts[0], /^New emails for Dana \(sender \| subject\):\n- boss@x\.com \| Urgent bill\n- news@x\.com \| \n\nWhich need Dana's attention/);
    assert.match(router.prompts[0], /Answer NONE, or one short line per email in en\./);
    assert.deepEqual(s.imap.calls('fetch').at(-1).slice(1, 2), [[7, 8]]); // 5 and 6 were seen before
    assert.deepEqual(router.sent, ['📧 Boss waits for your reply.']);
    assert.equal(lastUid(s), 8);
    await s.mod.check(); // nothing new: the model is not asked again
    assert.equal(router.prompts.length, 1);
  });

  test('NONE (any case, with a dot) sends nothing; an error answer sends nothing', async () => {
    for (const answer of [{ text: 'NONE', isError: false }, { text: 'None.', isError: false }, { text: '  ', isError: false }, { text: 'Real text', isError: true }]) {
      const s = setup({ world: { uids: [], uidNext: 2 } });
      const router = withRouter(s, answer);
      await s.mod.check();
      Object.assign(s.world, { uids: [2], uidNext: 3 });
      await s.mod.check();
      assert.equal(router.prompts.length, 1, JSON.stringify(answer));
      assert.deepEqual(router.sent, [], JSON.stringify(answer));
    }
  });

  test('"Nonetheless…" is not NONE', async () => {
    const s = setup({ world: { uids: [], uidNext: 2 } });
    const router = withRouter(s, { text: 'Nonetheless, the bank wrote', isError: false });
    await s.mod.check();
    Object.assign(s.world, { uids: [2], uidNext: 3 });
    await s.mod.check();
    assert.deepEqual(router.sent, ['📧 Nonetheless, the bank wrote']);
  });

  test('without a router the check still advances lastUid but asks nobody', async () => {
    const s = setup({ world: { uids: [], uidNext: 2 } });
    await s.mod.check();
    assert.equal(lastUid(s), 1);
  });
});

describe('policy and approval wiring', () => {
  const policyOf = (s) => new Policy({ agentCwd: s.agentCwd, root: path.join(os.tmpdir(), 'no-code'), modules: [s.mod] });

  test('untrusted covers search, read and save_attachment only', () => {
    const p = policyOf(setup());
    for (const tool of ['search', 'read', 'save_attachment']) assert.equal(p.untrusted(`mcp__mail__${tool}`), true, tool);
    for (const tool of ['draft', 'send']) assert.equal(p.untrusted(`mcp__mail__${tool}`), false, tool);
  });

  test('Policy never auto-allows mcp__mail__send, even when untainted; allowed has no send', () => {
    const s = setup();
    const p = policyOf(s);
    assert.equal(p.gated('mcp__mail__send'), true);
    assert.equal(p.autoAllow('mcp__mail__send', MAILIN), false);
    assert.equal(p.autoAllow('mcp__mail__send', MAILIN, { tainted: false }), false);
    assert.ok(!p.allowed.includes('mcp__mail__send'));
    assert.deepEqual(s.mod.allowed.sort(), ['mcp__mail__draft', 'mcp__mail__read', 'mcp__mail__save_attachment', 'mcp__mail__search']);
  });

  test('the describer shows to, cc, subject and body; a missing recipient is flagged', () => {
    const [d] = setup().mod.describers;
    assert.equal(d('Bash', {}), null);
    assert.equal(d('mcp__mail__read', {}), null);
    assert.equal(d('mcp__mail__send', { ...MAILIN, cc: 'c@x.com' }), '📧 Send an email to bob@example.com\nCc: c@x.com\nSubject: Hi\n\nMeet at noon');
    assert.match(d('mcp__mail__send', { body: 'x', reply_to_uid: 3 }), /^📧 Reply by email to \(nobody: will fail\)/);
    assert.equal(d('mcp__mail__send', { to: 'a@b', body: 'z'.repeat(3000) }).length, '📧 Send an email to a@b\n\n'.length + 3000); // the whole body: never a hidden tail
  });

  function routerFor(s) {
    const state = new MemoryState();
    const channel = { sent: [], async send(x) { this.sent.push(x); return 'id'; }, async react() {}, async typing() {} };
    const approvals = new Approvals({ timeoutMs: 5000, store: state });
    const hooks = hooksOf([s.mod]);
    const approvedCalls = [];
    const orig = hooks.approved;
    hooks.approved = (req) => { approvedCalls.push(req); orig(req); };
    const router = new Router({ config: { language: 'en', batchMs: 0 }, state, approvals, policy: policyOf(s), agent: { run: async () => ({ text: 'ok' }) }, channel, hooks, log: () => {} });
    const waitAsk = async () => { for (let i = 0; i < 100 && !approvals.waiting().length; i++) await new Promise((r) => setTimeout(r, 5)); };
    return { router, channel, approvals, approvedCalls, waitAsk };
  }

  test('Router asks the owner for mcp__mail__send; "yes" calls hooks.approved and opens exactly one ticket', async () => {
    const s = setup();
    const r = routerFor(s);
    const req = { tool_name: 'mcp__mail__send', input: MAILIN };
    const pending = r.router.requestApproval(req);
    await r.waitAsk();
    assert.match(r.channel.sent[0], /^🔐 Request #1\n📧 Send an email to bob@example\.com\nSubject: Hi\n\nMeet at noon/);
    assert.equal((await s.mod.api({ action: 'send', ...MAILIN })).ok, false, 'no ticket before the owner answers');
    await r.router.handle({ id: 'x', text: 'yes' });
    assert.deepEqual(await pending, { allow: true, reason: 'owner' });
    assert.deepEqual(r.approvedCalls, [req]);
    assert.equal((await s.mod.api({ action: 'send', ...MAILIN })).ok, true);
    assert.equal(s.sent.length, 1);
    assert.equal((await s.mod.api({ action: 'send', ...MAILIN })).ok, false);
  });

  test('"no" gives no ticket and does not call hooks.approved', async () => {
    const s = setup();
    const r = routerFor(s);
    const pending = r.router.requestApproval({ tool_name: 'mcp__mail__send', input: MAILIN });
    await r.waitAsk();
    await r.router.handle({ id: 'x', text: 'no' });
    assert.equal((await pending).allow, false);
    assert.equal(r.approvedCalls.length, 0);
    assert.equal((await s.mod.api({ action: 'send', ...MAILIN })).ok, false);
  });
});
