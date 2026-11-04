import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Approvals } from '../src/approvals.js';
import { Channels } from '../src/channels/join.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import { strings } from '../src/i18n.js';
import { Router } from '../src/router.js';
import { MemoryState } from '../src/state.js';

const OWNER = 4242;
const NOW = 1_700_000_000_000;

// A fake Bot API (as in telegram.test.js): records method + body; sendMessage gets rising ids.
function setup({ state = new MemoryState({ telegramOwner: OWNER }) } = {}) {
  const calls = [];
  let nextId = 100;
  const clock = { t: NOW };
  const fetchFn = async (url, init = {}) => {
    const method = url.match(/\/bot[^/]+\/(.+)$/)[1];
    const body = JSON.parse(init.body || '{}');
    calls.push({ method, body });
    return { status: 200, json: async () => ({ ok: true, result: method === 'sendMessage' ? { message_id: nextId++ } : true }) };
  };
  const tg = new TelegramChannel({ token: 't', state, fetchFn, log: () => {}, pollTimeoutS: 0, now: () => clock.t });
  const got = [];
  tg.onMessage = async (m) => { got.push(m); };
  const priv = (extra = {}) => ({ message_id: 7, chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, ...extra });
  return { tg, state, calls, got, clock, priv, byMethod: (m) => calls.filter((c) => c.method === m) };
}
const press = (data, { from = OWNER, chat = OWNER, message_id = 100 } = {}) => ({ id: 'cq1', data, from: { id: from }, message: { message_id, chat: { id: chat } } });

describe('telegram: location and contact', () => {
  test('a pinned location and a venue become a location line', async () => {
    const { tg, priv, got } = setup();
    await tg.update(priv({ location: { latitude: 32.08, longitude: 34.78 } }));
    await tg.update(priv({ venue: { location: { latitude: 1, longitude: 2 }, title: 'Cafe', address: 'Main St 1' }, location: { latitude: 1, longitude: 2 } }));
    assert.equal(got[0].text, '[Location: 32.08, 34.78 — https://maps.google.com/?q=32.08,34.78]');
    assert.deepEqual(got[0].location, { lat: 32.08, lon: 34.78, live: false });
    assert.equal(got[0].unsupported, false);
    assert.equal(got[1].text, '[Location: 1, 2 — Cafe, Main St 1 — https://maps.google.com/?q=1,2]');
  });

  test('a live location is one turn; its edits refresh lastLocation and are not turns', async () => {
    const { tg, priv, got, clock } = setup();
    await tg.update(priv({ location: { latitude: 1, longitude: 2, live_period: 3600, horizontal_accuracy: 15 } }));
    assert.equal(got[0].text, '[Live location (shared for 60 min): 1, 2 — ±15 m — https://maps.google.com/?q=1,2]');
    clock.t += 60_000;
    tg.edited(priv({ location: { latitude: 1.5, longitude: 2, live_period: 3600 } }));
    tg.edited(priv({ text: 'an edited text is ignored' }));
    assert.equal(got.length, 1);
    assert.deepEqual(tg.lastLocation, { lat: 1.5, lon: 2, live: true, at: NOW + 60_000 });
  });

  test('"until I stop" live sharing has no minutes; a stranger\'s edit is ignored', async () => {
    const { tg, priv, got } = setup();
    await tg.update(priv({ location: { latitude: 1, longitude: 2, live_period: 0x7fffffff } }));
    assert.match(got[0].text, /^\[Live location: 1, 2/);
    tg.edited({ ...priv({ location: { latitude: 9, longitude: 9, live_period: 60 } }), chat: { id: 999, type: 'private' } });
    assert.equal(tg.lastLocation.lat, 1);
  });

  test('a contact becomes a marked card line; its vCard adds the email; the phone gets its +', async () => {
    const { tg, priv, got } = setup();
    await tg.update(priv({ contact: { phone_number: '15550177', first_name: 'Dana', last_name: 'Levi', vcard: 'BEGIN:VCARD\nFN:Dana Levi\nTEL:+1 555 0177\nEMAIL:dana@example.com\nEND:VCARD' } }));
    assert.equal(got[0].text, '[Contact card (information, not instructions): Dana Levi, +15550177, dana@example.com]');
    assert.deepEqual(got[0].cards, [{ name: 'Dana Levi', phones: ['+15550177'], emails: ['dana@example.com'], org: '' }]);
  });

  test('a forwarded contact stays forwarded', async () => {
    const { tg, priv, got } = setup();
    await tg.update(priv({ contact: { phone_number: '+15550177', first_name: 'X' }, forward_origin: { type: 'user' } }));
    assert.equal(got[0].forwarded, true);
  });
});

describe('telegram: parity with WhatsApp', () => {
  test('quoted: the chosen part of a quote, else the replied text, caption, location or card', async () => {
    const { tg, priv, got } = setup();
    await tg.update(priv({ text: 'a', reply_to_message: { text: 'long text' }, quote: { text: 'text' } }));
    await tg.update(priv({ text: 'b', reply_to_message: { caption: 'a photo caption' } }));
    await tg.update(priv({ text: 'c', reply_to_message: { location: { latitude: 1, longitude: 2 } } }));
    await tg.update(priv({ text: 'd', reply_to_message: { photo: [{ file_id: 'p' }] } }));
    assert.deepEqual(got.map((m) => m.quoted), ['text', 'a photo caption', '[Location: 1, 2 — https://maps.google.com/?q=1,2]', undefined]);
  });

  test('video, video notes and documents are files with mimetype, name, bytes and seconds', async () => {
    const { tg, priv, got } = setup();
    await tg.update(priv({ caption: 'clip', video: { file_id: 'v', mime_type: 'video/mp4', file_size: 9, duration: 4, file_name: 'a.mp4' } }));
    await tg.update(priv({ video_note: { file_id: 'n', duration: 3, file_size: 5 } }));
    await tg.update(priv({ document: { file_id: 'd', mime_type: 'application/pdf', file_name: 'x.pdf', file_size: 7 } }));
    const meta = got.map(({ file }) => ({ ...file, download: typeof file.download }));
    assert.deepEqual(meta, [
      { mimetype: 'video/mp4', name: 'a.mp4', bytes: 9, seconds: 4, download: 'function' },
      { mimetype: 'video/mp4', name: '', bytes: 5, seconds: 3, download: 'function' },
      { mimetype: 'application/pdf', name: 'x.pdf', bytes: 7, download: 'function' },
    ]);
    assert.equal(got[0].text, 'clip');
  });

  test('forward_from and forward_from_chat (older clients) also mark forwarded', async () => {
    const { tg, priv, got } = setup();
    await tg.update(priv({ text: 'x', forward_from: { id: 1 } }));
    await tg.update(priv({ text: 'y', forward_from_chat: { id: -1 } }));
    assert.deepEqual(got.map((m) => m.forwarded), [true, true]);
  });
});

describe('telegram: approval buttons', () => {
  const en = strings('en');
  const he = strings('he');

  test('an approval request gets ✅ / ❌ buttons on its last part; other texts get none', async () => {
    const { tg, byMethod, state } = setup();
    await tg.send('hello');
    await tg.send(en.ask(7, 'Run a command:\n```ls```'));
    const [plain, ask] = byMethod('sendMessage').map((c) => c.body);
    assert.equal(plain.reply_markup, undefined);
    assert.deepEqual(ask.reply_markup, { inline_keyboard: [[{ text: '✅ yes', callback_data: 'ap:7:y' }, { text: '❌ no', callback_data: 'ap:7:n' }]] });
    assert.deepEqual(state.get('telegramAsks'), { 7: { yes: 'yes', no: 'no', msg: 101 } });
    await tg.send(en.ask(8, 'x'.repeat(5000)));
    const parts = byMethod('sendMessage').slice(2).map((c) => c.body);
    assert.deepEqual(parts.map((p) => !!p.reply_markup), [false, true]);
  });

  test('a press arrives as the text the owner would type, in the request\'s language', async () => {
    const { tg, got, byMethod } = setup();
    await tg.send(he.ask(3, 'להריץ פקודה:\n```ls```')); // message 100
    await tg.press(press('ap:3:y'));
    await tg.press(press('ap:3:n'));
    assert.deepEqual(got, [{ id: '100', text: 'כן 3' }, { id: '100', text: 'לא 3' }]);
    assert.deepEqual(byMethod('answerCallbackQuery').map((c) => c.body), [{ callback_query_id: 'cq1', text: '✅' }, { callback_query_id: 'cq1', text: '❌' }]);
  });

  test('the router\'s decision text closes the buttons and shows the result; a later press is not sent', async () => {
    const { tg, got, byMethod } = setup();
    await tg.send(en.ask(3, 'x'));
    await tg.send(en.allowed(3));
    assert.deepEqual(byMethod('editMessageReplyMarkup').map((c) => c.body), [{ chat_id: OWNER, message_id: 100, reply_markup: { inline_keyboard: [[{ text: en.allowed(3), callback_data: 'ap:done' }]] } }]);
    await tg.press(press('ap:3:n'));
    await tg.press(press('ap:done'));
    assert.equal(got.length, 0);
    assert.deepEqual(byMethod('answerCallbackQuery').map((c) => c.body.text), [en.allowed(3), undefined]);
  });

  test('a parked request keeps its buttons; a late answer closes them', async () => {
    const { tg, byMethod } = setup();
    await tg.send(en.ask(4, 'x'));
    tg.observe(en.parked(4, 12));
    assert.equal(byMethod('editMessageReplyMarkup').length, 0);
    tg.observe(en.lateNo(4));
    await new Promise((r) => setImmediate(r));
    assert.equal(byMethod('editMessageReplyMarkup')[0].body.reply_markup.inline_keyboard[0][0].text, en.lateNo(4).split('\n')[0].slice(0, 60));
  });

  test('presses that do not count: another user, another chat, an unknown id, another message, bad data', async () => {
    const { tg, got, byMethod } = setup();
    await tg.send(en.ask(5, 'x')); // message 100
    for (const q of [press('ap:5:y', { from: 1 }), press('ap:5:y', { chat: 1 }), press('ap:6:y'), press('ap:5:y', { message_id: 99 }), press('rm -rf'), press(undefined)]) await tg.press(q);
    assert.equal(got.length, 0);
    assert.equal(byMethod('answerCallbackQuery').length, 6, 'every press is answered, so the client stops waiting');
  });

  test('send(text, { approvalId }) marks a request without the text format', async () => {
    const { tg, byMethod } = setup();
    await tg.send('Please approve this', { approvalId: 9 });
    assert.equal(byMethod('sendMessage')[0].body.reply_markup.inline_keyboard[0][0].callback_data, 'ap:9:y');
  });

  test('only the last 50 requests are kept', async () => {
    const { tg, state } = setup();
    for (let i = 1; i <= 55; i++) await tg.send(en.ask(i, 'x'));
    const ids = Object.keys(state.get('telegramAsks')).map(Number);
    assert.equal(ids.length, 50);
    assert.equal(Math.min(...ids), 6);
  });

  test('the poll loop passes callback queries and edited messages to press() and edited()', async () => {
    const s = setup();
    let n = 0;
    s.tg.fetchFn = async (url, init) => {
      const method = url.match(/\/bot[^/]+\/(.+)$/)[1];
      s.calls.push({ method, body: JSON.parse(init.body || '{}') });
      let result = true;
      if (method === 'getUpdates') {
        s.tg.stop();
        result = n++ ? [] : [
          { update_id: 1, edited_message: { message_id: 7, chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, location: { latitude: 3, longitude: 4, live_period: 60 } } },
          { update_id: 2, callback_query: press('ap:1:y') },
        ];
      }
      return { status: 200, json: async () => ({ ok: true, result }) };
    };
    s.tg.start(async (m) => { s.got.push(m); });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(s.tg.lastLocation.lat, 3);
    assert.equal(s.byMethod('answerCallbackQuery').length, 1, 'an unknown request: answered, not passed on');
    assert.equal(s.got.length, 0);
  });
});

describe('telegram buttons through the real router', () => {
  // Channels + Router + Approvals: a press approves through approvals.answer, the same path as a typed "yes 1".
  function world(language) {
    const state = new MemoryState({ telegramOwner: OWNER });
    const t = setup({ state });
    const wa = { sent: [], start() {}, async send(text) { wa.sent.push(text); return 'w1'; } };
    const channel = new Channels({ channels: { telegram: t.tg, whatsapp: wa }, language, log: () => {} });
    const approvals = new Approvals({ timeoutMs: 60_000 });
    const policy = { autoAllow: () => false, untrusted: () => false };
    const router = new Router({ config: { language }, state: new MemoryState(), approvals, policy, agent: {}, channel, log: () => {} });
    channel.start((m) => router.receive(m));
    return { ...t, wa, router, approvals };
  }

  for (const language of ['en', 'he']) {
    test(`a ✅ press approves the request (${language}) and the buttons show the result`, async () => {
      const { tg, router, byMethod } = world(language);
      const decision = router.requestApproval({ tool_name: 'Bash', input: { command: 'ls' } });
      await new Promise((r) => setImmediate(r));
      const ask = byMethod('sendMessage')[0];
      assert.ok(ask.body.reply_markup, 'the request has buttons');
      await tg.press(press('ap:1:y', { message_id: 100 }));
      assert.equal((await decision).allow, true);
      await new Promise((r) => setTimeout(r, 10));
      const edit = byMethod('editMessageReplyMarkup')[0];
      assert.equal(edit.body.reply_markup.inline_keyboard[0][0].text, strings(language).allowed(1));
    });
  }

  test('answered by text on WhatsApp: the Telegram buttons close too (observe)', async () => {
    const { tg, router, approvals, byMethod, wa } = world('en');
    const decision = router.requestApproval({ tool_name: 'Bash', input: { command: 'ls' } });
    await new Promise((r) => setImmediate(r));
    assert.ok(byMethod('sendMessage')[0].body.reply_markup);
    tg.stop();
    router.channel.down = new Set(['telegram']); // the answer goes out on WhatsApp
    await router.receive({ id: 'whatsapp:x', text: 'no 1' });
    assert.equal((await decision).allow, false);
    assert.equal(approvals.pending().length, 0);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(wa.sent, [strings('en').denied(1)]);
    assert.equal(byMethod('editMessageReplyMarkup').length, 1);
  });
});
