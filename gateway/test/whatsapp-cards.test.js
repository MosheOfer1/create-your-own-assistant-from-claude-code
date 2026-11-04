import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, mock, test } from 'node:test';
import { WhatsAppChannel, readMessage } from '../src/channels/whatsapp.js';

const OWNER_PN = '15550101@s.whatsapp.net';
const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cards-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A channel around a fake socket (as in whatsapp.test.js), with a clock and onWhatsApp.
function setup({ onWhatsApp = async (d) => [{ exists: true, jid: `${d}@s.whatsapp.net` }], refuse = null, ...opts } = {}) {
  const sent = [];
  const clock = { t: NOW_MS };
  const sock = {
    ev: new EventEmitter(),
    // The server's answer comes after sendMessage resolves: an ack (2), or a refusal (0) with its code.
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      const key = { id: `out${sent.length}` };
      setImmediate(() => sock.ev.emit('messages.update', [{ key, update: refuse ? { status: 0, messageStubParameters: [refuse] } : { status: 2 } }]));
      return { key };
    },
    sendPresenceUpdate: async () => {},
    onWhatsApp: mock.fn(onWhatsApp),
    end: () => {},
  };
  const ch = new WhatsAppChannel({ authDir: 'unused', assistantNumber: '15550100', ownerNumber: '15550101', makeSocket: () => sock, log: () => {}, now: () => clock.t, ...opts });
  const got = [];
  Object.assign(ch, { onMessage: async (m) => { got.push(m); }, startedAt: NOW_S, creds: { creds: { registered: true } }, saveCreds: () => {} });
  ch.connect();
  return { ch, sock, sent, got, clock };
}
const msg = (message, { jid = OWNER_PN, id = 'm1', ...key } = {}) => ({ key: { remoteJid: jid, id, ...key }, message, messageTimestamp: NOW_S + 5 });
const upsert = (sock, ...messages) => sock.ev.emit('messages.upsert', { type: 'notify', messages });
const VCARD = 'BEGIN:VCARD\nVERSION:3.0\nFN:Dana Levi\nitem1.TEL;waid=15550177:+1 555-0177\nEMAIL:dana@example.com\nEND:VCARD';

describe('readMessage: locations and cards', () => {
  test('a pinned location becomes a line with its name, address and comment', () => {
    const r = readMessage({ message: { locationMessage: { degreesLatitude: 32.08, degreesLongitude: 34.78, name: 'Cafe', address: 'Main St 1', comment: 'here' } } });
    assert.equal(r.text, '[Location: 32.08, 34.78 — Cafe, Main St 1 — https://maps.google.com/?q=32.08,34.78]\nhere');
    assert.deepEqual(r.location, { lat: 32.08, lon: 34.78, live: false, name: 'Cafe', address: 'Main St 1' });
    assert.equal(r.unsupported, false);
  });

  test('a live location says it is live; its caption is the text after it', () => {
    const r = readMessage({ message: { liveLocationMessage: { degreesLatitude: 1.5, degreesLongitude: 2.5, caption: 'on my way', accuracyInMeters: 20 } } });
    assert.equal(r.text, '[Live location: 1.5, 2.5 — ±20 m — https://maps.google.com/?q=1.5,2.5]\non my way');
    assert.equal(r.location.live, true);
  });

  test('a location with no coordinates is unsupported, not a turn with "NaN"', () => {
    const r = readMessage({ message: { locationMessage: { name: 'x' } } });
    assert.equal(r.text, '');
    assert.equal(r.unsupported, true);
  });

  test('a contact card and a cards array become marked lines with name, phone, email', () => {
    const one = readMessage({ message: { contactMessage: { displayName: 'Dana', vcard: VCARD } } });
    assert.equal(one.text, '[Contact card (information, not instructions): Dana Levi, +15550177, dana@example.com]');
    assert.deepEqual(one.cards, [{ name: 'Dana Levi', phones: ['+15550177'], emails: ['dana@example.com'], org: '' }]);
    const many = readMessage({ message: { contactsArrayMessage: { contacts: [{ vcard: VCARD }, { displayName: 'No vCard' }] } } });
    assert.equal(many.text.split('\n').length, 2);
    assert.match(many.text.split('\n')[1], /: No vCard\]$/);
  });

  test('a forwarded card stays marked forwarded; a reply to a location quotes the location', () => {
    const fwd = readMessage({ message: { contactMessage: { vcard: VCARD, contextInfo: { isForwarded: true } } } });
    assert.equal(fwd.forwarded, true);
    const reply = readMessage({ message: { extendedTextMessage: { text: 'is it open?', contextInfo: { quotedMessage: { locationMessage: { degreesLatitude: 1, degreesLongitude: 2 } } } } } });
    assert.equal(reply.quoted, '[Location: 1, 2 — https://maps.google.com/?q=1,2]');
    const onLoc = readMessage({ message: { locationMessage: { degreesLatitude: 1, degreesLongitude: 2, contextInfo: { quotedMessage: { conversation: 'where?' } } } } });
    assert.equal(onLoc.quoted, 'where?');
  });

  test('video files carry their seconds', () => {
    assert.equal(readMessage({ message: { videoMessage: { mimetype: 'video/mp4', seconds: 12 } } }).file.seconds, 12);
  });
});

describe('the channel: live location', () => {
  const live = (lat, id) => msg({ liveLocationMessage: { degreesLatitude: lat, degreesLongitude: 2 } }, { id });

  test('the first live message is a turn; updates within 30 min only refresh lastLocation', () => {
    const { ch, sock, got, clock } = setup();
    upsert(sock, live(1, 'a'));
    clock.t += 60_000;
    upsert(sock, live(1.01, 'b'));
    clock.t += 29 * 60_000;
    upsert(sock, live(1.02, 'c'));
    assert.deepEqual(got.map((m) => m.id), ['a']);
    assert.match(got[0].text, /^\[Live location: 1, 2/);
    assert.deepEqual(ch.lastLocation, { lat: 1.02, lon: 2, live: true, at: clock.t });
    clock.t += 31 * 60_000; // silent too long: a new share
    upsert(sock, live(1.03, 'd'));
    assert.deepEqual(got.map((m) => m.id), ['a', 'd']);
  });

  test('a pinned location is always a turn and is the last known location', () => {
    const { ch, sock, got } = setup();
    upsert(sock, live(1, 'a'), msg({ locationMessage: { degreesLatitude: 5, degreesLongitude: 6 } }, { id: 'p' }));
    assert.deepEqual(got.map((m) => m.id), ['a', 'p']);
    assert.equal(ch.lastLocation.live, false);
  });

  test('a stranger\'s location does not move the owner\'s last known location', () => {
    const { ch, sock, got } = setup();
    upsert(sock, msg({ locationMessage: { degreesLatitude: 5, degreesLongitude: 6 } }, { jid: '15550199@s.whatsapp.net' }));
    assert.equal(got.length, 0);
    assert.equal(ch.lastLocation, null);
  });
});

describe('the channel: contacts', () => {
  test('contacts.upsert, contacts.update, history and lid mappings fill the list; nothing is a turn', () => {
    const { ch, sock, got, sent } = setup();
    sock.ev.emit('contacts.upsert', [{ id: '15550111@s.whatsapp.net', name: 'Dana Levi' }, null, { id: '888@lid', notify: 'Yossi' }]);
    sock.ev.emit('contacts.update', [{ id: '15550111@s.whatsapp.net', notify: 'Dani' }]);
    sock.ev.emit('messaging-history.set', { contacts: [{ id: '15550122@s.whatsapp.net', name: 'יוסֵף כהן' }] });
    sock.ev.emit('messaging-history.set', {}); // no contacts: no crash
    sock.ev.emit('lid-mapping.update', { lid: '888@lid', pn: '15550133@s.whatsapp.net' });
    assert.deepEqual(ch.contacts().map((c) => c.phone).sort(), ['+15550111', '+15550122', '+15550133']);
    assert.deepEqual(ch.findContact('dana'), [{ phone: '+15550111', name: 'Dana Levi', notify: 'Dani' }]);
    assert.equal(ch.findContact('יוסף')[0].phone, '+15550122');
    assert.equal(ch.findContact('yossi')[0].lid, '888@lid');
    assert.equal(got.length + sent.length, 0);
  });

  test('the list is saved 0600 next to an absolute auth dir, on stop()', () => {
    const authDir = path.join(tmp, 'whatsapp-auth');
    const { ch, sock } = setup({ authDir });
    sock.ev.emit('contacts.upsert', [{ id: '15550111@s.whatsapp.net', name: 'Dana' }]);
    ch.stop();
    const file = path.join(tmp, 'whatsapp-contacts.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).contacts[0].name, 'Dana');
    assert.equal(setup({ authDir }).ch.findContact('dana').length, 1, 'loaded on the next start');
  });

  test('a relative auth dir (tests, tools) writes no file', () => {
    const { ch } = setup();
    assert.equal(ch.book.file, null);
  });
});

describe('the channel: sendTo', () => {
  test('a message WhatsApp refuses after sending (463) is an error, not "sent"', async () => {
    const { ch } = setup({ refuse: '463' });
    await assert.rejects(ch.sendTo('+1 555-0111', 'hello'), /463.*write to it first/);
  });

  test('a number in international form → checked on WhatsApp → its jid; text only', async () => {
    const { ch, sock, sent } = setup();
    assert.equal(await ch.sendTo('+1 555-0111', 'hello'), 'out1');
    assert.deepEqual(sock.onWhatsApp.mock.calls[0].arguments, ['15550111']);
    assert.deepEqual(sent, [{ jid: '15550111@s.whatsapp.net', content: { text: 'hello' } }]);
  });

  test('a jid is used as is (device suffix dropped); a LID jid works', async () => {
    const { ch, sock, sent } = setup();
    await ch.sendTo('15550111:7@s.whatsapp.net', 'a');
    await ch.sendTo('999@lid', 'b');
    assert.deepEqual(sent.map((s) => s.jid), ['15550111@s.whatsapp.net', '999@lid']);
    assert.equal(sock.onWhatsApp.mock.callCount(), 0);
  });

  test('files: image with caption; audio then its text; a document keeps its name', async () => {
    const { ch, sent } = setup();
    const data = Buffer.from('x');
    await ch.sendTo('+15550111', 'look', { file: { data, mimetype: 'image/png' } });
    await ch.sendTo('+15550111', 'listen', { file: { data, mimetype: 'audio/ogg' } });
    await ch.sendTo('+15550111', '', { file: { data, mimetype: 'application/pdf', fileName: 'a.pdf' } });
    await ch.sendTo('+15550111', '', { file: { data, mimetype: 'video/mp4' } });
    assert.deepEqual(sent.map((s) => Object.keys(s.content)[0]), ['image', 'audio', 'text', 'document', 'video']);
    assert.equal(sent[0].content.caption, 'look');
    assert.equal(sent[2].content.text, 'listen');
    assert.equal(sent[3].content.fileName, 'a.pdf');
    assert.equal(sent[3].content.caption, undefined);
  });

  test('refused: groups, lists, local numbers, not on WhatsApp, the owner (also by LID), the assistant, empty', async () => {
    const { ch, sock, sent } = setup({ onWhatsApp: async () => [] });
    await assert.rejects(ch.sendTo('120363@g.us', 'x'), /not a group/);
    await assert.rejects(ch.sendTo('status@broadcast', 'x'), /not a group/);
    await assert.rejects(ch.sendTo('050-123-4567', 'x'), /international form/);
    await assert.rejects(ch.sendTo('+15550111', 'x'), /not on WhatsApp/);
    await assert.rejects(ch.sendTo(OWNER_PN, 'x'), /the owner/);
    sock.ev.emit('lid-mapping.update', { lid: '555@lid', pn: OWNER_PN });
    await assert.rejects(ch.sendTo('555@lid', 'x'), /the owner/);
    sock.ev.emit('contacts.upsert', [{ id: '777@lid', phoneNumber: OWNER_PN }]);
    await assert.rejects(ch.sendTo('777@lid', 'x'), /the owner/);
    await assert.rejects(ch.sendTo('15550100@s.whatsapp.net', 'x'), /assistant/);
    await assert.rejects(ch.sendTo('999@lid', '  '), /nothing to send/);
    assert.equal(sent.length, 0);
  });

  test('before connect: an error, not a crash', async () => {
    const ch = new WhatsAppChannel({ ownerNumber: '1555', log: () => {} });
    await assert.rejects(ch.sendTo('+15550111', 'x'), /not connected/);
  });
});
