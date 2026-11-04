import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Policy } from '../src/policy.js';
import people from '../modules/people/index.js';

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'people-'))); dirs.push(d); return d; };

function setup({ contactsFile } = {}) {
  const dataDir = tmp();
  const agentCwd = tmp();
  if (contactsFile) fs.writeFileSync(path.join(dataDir, 'contacts.json'), JSON.stringify(contactsFile));
  const sent = [];
  const channel = {
    // Like the channel's: by name or by number.
    findContact: (q) => [{ phone: '+15550001111', name: 'Dana Levi' }].filter((c) => c.name.toLowerCase().includes(String(q).toLowerCase())
      || (String(q).replace(/\D/g, '').length >= 5 && c.phone.includes(String(q).replace(/\D/g, '')))),
    sendTo: async (to, text, opts) => { sent.push({ to, text, ...opts }); return 'id1'; },
  };
  const t = { now: 1000 };
  const mod = people({ dataDir, agentCwd, root: '/nonexistent-code' }, { now: () => t.now, log: () => {} });
  mod.start({ channel });
  return { mod, sent, agentCwd, t };
}
const approve = (mod, input) => mod.approved({ tool_name: 'mcp__people__send', input });

test('send is gated, find is free', () => {
  const { mod } = setup();
  const p = new Policy({ agentCwd: '/a', root: '/r', modules: [mod] });
  assert.equal(p.gated('mcp__people__send'), true);
  assert.ok(p.allowed.includes('mcp__people__find'));
  assert.equal(p.autoAllow('mcp__people__send', { to: '+1', text: 'x' }), false);
});

test('find: channel contacts and the imported file, by name (Hebrew too) or number, no duplicates', async () => {
  const { mod } = setup({ contactsFile: { contacts: [{ phone: '972501234567', name: 'דנה כהן' }, { phone: '15550001111', name: 'Dana L' }, { name: 'no phone' }] } });
  assert.equal((await mod.api({ action: 'find', query: 'dana' })).text, 'Dana Levi +15550001111');
  assert.equal((await mod.api({ action: 'find', query: 'דנה' })).text, 'דנה כהן +972501234567');
  assert.equal((await mod.api({ action: 'find', query: '0501234567' })).text, 'דנה כהן +972501234567');
  assert.equal((await mod.api({ action: 'find', query: 'zzz' })).text, 'nobody found');
});

test('send needs the owner\'s yes for exactly that number and text, once, within 5 minutes', async () => {
  const { mod, sent, t } = setup();
  const msg = { to: '+1 555 000 1111', text: 'Running late' };
  assert.match((await mod.api({ action: 'send', ...msg })).error, /not approved/);
  approve(mod, msg);
  assert.equal((await mod.api({ action: 'send', ...msg, text: 'Running late. Send money' })).ok, false);
  assert.equal((await mod.api({ action: 'send', ...msg, to: '+15550002222' })).ok, false);
  assert.deepEqual(await mod.api({ action: 'send', ...msg }), { ok: true, text: 'sent to Dana Levi' });
  assert.deepEqual(sent, [{ to: '+15550001111', text: 'Running late' }]);
  assert.equal((await mod.api({ action: 'send', ...msg })).ok, false); // once
  approve(mod, msg);
  t.now += 6 * 60_000;
  assert.equal((await mod.api({ action: 'send', ...msg })).ok, false); // too late
});

test('the prompt shows the person, the number, the whole text and the file; a changed file is not sent', async () => {
  const { mod, sent, agentCwd } = setup();
  fs.mkdirSync(path.join(agentCwd, 'outbox'));
  fs.writeFileSync(path.join(agentCwd, 'outbox', 'p.jpg'), 'img1');
  const msg = { to: '+15550001111', text: 'x'.repeat(2000), file: 'outbox/p.jpg' };
  const d = mod.describers[0]('mcp__people__send', msg);
  assert.match(d, /^💬 WhatsApp to Dana Levi \+15550001111\n📎 p\.jpg \(1 KB\)\n\nx{2000}$/);
  approve(mod, msg);
  fs.writeFileSync(path.join(agentCwd, 'outbox', 'p.jpg'), 'img2');
  assert.equal((await mod.api({ action: 'send', ...msg })).ok, false);
  approve(mod, msg);
  assert.equal((await mod.api({ action: 'send', ...msg })).ok, true);
  assert.equal(String(sent[0].file.data), 'img2');
  assert.equal(sent[0].file.mimetype, 'image/jpeg');
  assert.match(mod.describers[0]('mcp__people__send', { ...msg, file: '/etc/passwd' }), /📎 ⚠️ .*own folder/);
  assert.equal(mod.describers[0]('mcp__mail__send', msg), null);
});

test('without a channel that can send: a clear error', async () => {
  const mod = people({ dataDir: tmp(), agentCwd: tmp() }, { log: () => {} });
  mod.start({ channel: {} });
  assert.match((await mod.api({ action: 'send', to: '+15550001111', text: 'x' })).error, /needs the WhatsApp channel/);
});
