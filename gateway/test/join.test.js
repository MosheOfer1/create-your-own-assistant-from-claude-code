import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Channels } from '../src/channels/join.js';
import { strings } from '../src/i18n.js';

// A fake channel: remembers the handler from start(), records sends, can be told to fail.
function fake(name, { failing = false, files = false } = {}) {
  const c = {
    name, sent: [], reacted: [], typed: [], failing, onStatus: null, stopped: false,
    start(on) { c.on = on; },
    async send(text) { if (c.failing) throw new Error(`${name} down`); c.sent.push(text); return `${name}-out${c.sent.length}`; },
    async react(id, emoji) { c.reacted.push([id, emoji]); },
    async typing(on) { c.typed.push(on); },
    stop() { c.stopped = true; },
  };
  if (files) c.sendFile = async (buf, opts) => { c.files = [buf, opts]; return 'file1'; };
  return c;
}

function setup({ language = 'en', stickyMin = 30, ...opts } = {}) {
  const wa = fake('whatsapp', opts.wa);
  const tg = fake('telegram', opts.tg);
  const clock = { t: 1_000_000 };
  const logs = [];
  const ch = new Channels({ channels: { whatsapp: wa, telegram: tg }, language, stickyMin, now: () => clock.t, log: (l) => logs.push(l) });
  const got = [];
  ch.start((m) => { got.push(m); });
  return { ch, wa, tg, clock, got, logs };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('routing', () => {
  test('incoming ids are prefixed with the channel name', () => {
    const { wa, tg, got } = setup();
    wa.on({ id: 'ABC', text: 'a' });
    tg.on({ id: '5', text: 'b' });
    assert.deepEqual(got, [{ id: 'whatsapp:ABC', text: 'a' }, { id: 'telegram:5', text: 'b' }]);
  });

  test('react goes to the channel in the prefix with the bare id', async () => {
    const { ch, wa, tg } = setup();
    await ch.react('telegram:5', '👀');
    await ch.react('whatsapp:a:b', '✅'); // only the first colon splits
    await ch.react('nosuch:1', '👀');
    await ch.react('plain', '👀');
    assert.deepEqual(tg.reacted, [['5', '👀']]);
    assert.deepEqual(wa.reacted, [['a:b', '✅']]);
  });

  test('send goes to the first channel by default and returns a prefixed id', async () => {
    const { ch, wa, tg } = setup();
    assert.equal(await ch.send('hi'), 'whatsapp:whatsapp-out1');
    assert.deepEqual([wa.sent, tg.sent], [['hi'], []]);
  });

  test('replies stick to the channel the owner last wrote on, for stickyMin', async () => {
    const { ch, wa, tg, clock } = setup({ stickyMin: 30 });
    tg.on({ id: '1', text: 'x' });
    await ch.send('one');
    clock.t += 29 * 60_000;
    await ch.send('two');
    clock.t += 2 * 60_000; // 31 min after the owner wrote
    await ch.send('three');
    assert.deepEqual(tg.sent, ['one', 'two']);
    assert.deepEqual(wa.sent, ['three']);
  });

  test('typing goes to the preferred channel', async () => {
    const { ch, wa, tg } = setup();
    await ch.typing(true);
    tg.on({ id: '1', text: 'x' });
    await ch.typing(false);
    assert.deepEqual([wa.typed, tg.typed], [[true], [false]]);
  });

  test('sendFile uses the first channel that can send files', async () => {
    const { ch, tg } = setup({ tg: { files: true } });
    assert.equal(await ch.sendFile(Buffer.from('x'), { mimetype: 'image/png' }), 'telegram:file1');
    assert.equal(tg.files[1].mimetype, 'image/png');
    const none = setup();
    await assert.rejects(none.ch.sendFile(Buffer.from('x'), {}), /no channel can send files/);
  });

  test('stop() stops every channel', () => {
    const { ch, wa, tg } = setup();
    ch.stop();
    assert.ok(wa.stopped && tg.stopped);
  });
});

describe('failures', () => {
  test('a failing send falls through to the next channel', async () => {
    const { ch, wa, tg, logs } = setup({ wa: { failing: true } });
    assert.equal(await ch.send('hi'), 'telegram:telegram-out1');
    assert.deepEqual(tg.sent, ['hi']);
    assert.equal(wa.sent.length, 0);
    assert.ok(logs.some((l) => /whatsapp send failed: whatsapp down/.test(l)));
  });

  test('all channels failing throws the last error', async () => {
    const { ch } = setup({ wa: { failing: true }, tg: { failing: true } });
    await assert.rejects(ch.send('hi'), /telegram down/);
  });

  test('no channels at all throws', async () => {
    const ch = new Channels({ channels: {}, log: () => {} });
    await assert.rejects(ch.send('hi'), /no channel could send/);
  });
});

describe('link status', () => {
  for (const language of ['he', 'en']) {
    test(`logged-out is announced once on telegram only (${language}), back says waBack`, async () => {
      const { wa, tg, ch } = setup({ language });
      const t = strings(language);
      wa.onStatus('logged-out');
      await tick();
      assert.deepEqual(tg.sent, [t.waLoggedOut]);
      assert.deepEqual(wa.sent, []);
      wa.onStatus('logged-out');
      wa.onStatus('down');
      await tick();
      assert.equal(tg.sent.length, 1, 'not announced again');
      assert.ok(ch.down.has('whatsapp'));
      wa.onStatus('open');
      await tick();
      assert.deepEqual(tg.sent, [t.waLoggedOut, t.waBack]);
      assert.deepEqual(wa.sent, []);
      wa.onStatus('open');
      await tick();
      assert.equal(tg.sent.length, 2, 'back is announced once');
    });
  }

  test('the language strings differ', () => {
    assert.notEqual(strings('he').waLoggedOut, strings('en').waLoggedOut);
  });

  test('down sends the waDown text; closed and open without a loss send nothing', async () => {
    const { wa, tg } = setup();
    wa.onStatus('closed');
    wa.onStatus('open');
    await tick();
    assert.deepEqual(tg.sent, []);
    wa.onStatus('down');
    await tick();
    assert.deepEqual(tg.sent, [strings('en').waDown]);
  });

  test('a down channel is skipped for sends, and used again once it is open', async () => {
    const { ch, wa, tg } = setup();
    wa.onStatus('down');
    await tick();
    tg.sent.length = 0;
    assert.equal(await ch.send('hi'), 'telegram:telegram-out1');
    assert.deepEqual(wa.sent, []);
    wa.onStatus('open');
    await tick();
    tg.sent.length = 0;
    assert.equal(await ch.send('again'), 'whatsapp:whatsapp-out1');
  });

  test('when no other channel can tell the owner, it is logged, not thrown', async () => {
    const { wa, logs } = setup({ tg: { failing: true } });
    wa.onStatus('logged-out');
    await tick();
    assert.ok(logs.some((l) => /whatsapp is logged-out and no other channel can tell the owner/.test(l)));
  });

  test('the sticky channel being down is skipped even when the owner wrote there last', async () => {
    const { ch, wa, tg } = setup();
    wa.on({ id: '1', text: 'x' });
    wa.onStatus('down');
    await tick();
    tg.sent.length = 0;
    await ch.send('hi');
    assert.deepEqual([wa.sent, tg.sent], [[], ['hi']]);
  });
});

describe('pass-through', () => {
  test('send options reach the channel (skip does not); the other channels observe the text', async () => {
    const { ch, wa, tg } = setup();
    const opts = [];
    wa.send = async (text, o) => { opts.push(o); return 'w1'; };
    tg.observed = [];
    tg.observe = (text) => tg.observed.push(text);
    wa.observe = () => { throw new Error('the sender does not observe its own text'); };
    await ch.send('🔐 Request #1', { approvalId: 1, skip: 'nosuch' });
    await tick();
    assert.deepEqual(opts, [{ approvalId: 1 }]);
    assert.deepEqual(tg.observed, ['🔐 Request #1']);
  });

  test('a throwing observe does not break the send', async () => {
    const { ch, tg } = setup();
    tg.observe = () => { throw new Error('boom'); };
    assert.equal(await ch.send('hi'), 'whatsapp:whatsapp-out1');
    await tick();
  });

  test('lastLocation is the newest of all channels, or null', () => {
    const { ch, wa, tg } = setup();
    assert.equal(ch.lastLocation, null);
    wa.lastLocation = { lat: 1, lon: 1, at: 10, live: false };
    tg.lastLocation = { lat: 2, lon: 2, at: 20, live: true };
    assert.equal(ch.lastLocation.lat, 2);
  });

  test('sendTo, contacts and findContact go to the channel that has them', async () => {
    const { ch, wa } = setup();
    assert.deepEqual([ch.contacts(), ch.findContact('x')], [[], []]);
    await assert.rejects(ch.sendTo('+15550111', 'x'), /no channel can send to other people/);
    const calls = [];
    Object.assign(wa, {
      sendTo: async (...a) => { calls.push(a); return 'id1'; },
      contacts: () => [{ phone: '+15550111' }],
      findContact: (q, limit) => [{ phone: '+15550111', q, limit }],
    });
    assert.equal(await ch.sendTo('+15550111', 'hi', { file: null }), 'id1');
    assert.deepEqual(calls, [['+15550111', 'hi', { file: null }]]);
    assert.deepEqual(ch.contacts(), [{ phone: '+15550111' }]);
    assert.deepEqual(ch.findContact('dana', 3), [{ phone: '+15550111', q: 'dana', limit: 3 }]);
  });
});
