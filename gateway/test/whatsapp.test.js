import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, describe, mock, test } from 'node:test';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { WhatsAppChannel, readMessage } from '../src/channels/whatsapp.js';

const OWNER_PN = '972501234567@s.whatsapp.net';
const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;

// A channel around a fake socket. start() calls fetchLatestBaileysVersion (network), so we set the
// fields start() would set and call connect() directly.
function setup({ ownerNumber = '972501234567', registered = false, assistantNumber = '972509999999' } = {}) {
  const sockets = [];
  const sent = [];
  const presence = [];
  const makeSocket = () => {
    const sock = {
      ev: new EventEmitter(),
      sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: 'out1' } }; },
      sendPresenceUpdate: async (p, jid) => { presence.push([p, jid]); },
      requestPairingCode: mock.fn(async () => 'ABCD1234'),
      end: mock.fn(),
    };
    sockets.push(sock);
    return sock;
  };
  const ch = new WhatsAppChannel({ authDir: 'unused', assistantNumber, ownerNumber, makeSocket, log: () => {}, now: () => NOW_MS, onPairingCode: mock.fn() });
  const got = [];
  const statuses = [];
  ch.onStatus = (s) => statuses.push(s);
  Object.assign(ch, { onMessage: async (m) => { got.push(m); }, startedAt: NOW_S, creds: { creds: { registered } }, saveCreds: () => {}, logger: undefined });
  ch.connect();
  return { ch, sockets, sock: sockets[0], sent, presence, got, statuses };
}

const msg = (message, { jid = OWNER_PN, id = 'm1', ts = NOW_S + 5, ...key } = {}) => ({
  key: { remoteJid: jid, id, ...key }, message, messageTimestamp: ts,
});
const upsert = (sock, ...messages) => sock.ev.emit('messages.upsert', { type: 'notify', messages });
const tick = () => new Promise((r) => setImmediate(r));

describe('readMessage', () => {
  test('plain conversation', () => {
    assert.deepEqual(readMessage({ message: { conversation: 'hi' } }), { text: 'hi', unsupported: false });
  });

  test('extended text with quote and forwarded flag', () => {
    const r = readMessage({ message: { extendedTextMessage: { text: 'answer', contextInfo: { isForwarded: true, quotedMessage: { conversation: 'old' } } } } });
    assert.deepEqual(r, { text: 'answer', quoted: 'old', forwarded: true, unsupported: false });
  });

  test('image with caption gives text and file meta', async () => {
    const dl = async () => 'bytes';
    const r = readMessage({ message: { imageMessage: { caption: 'look', mimetype: 'image/jpeg', fileLength: 1234 } } }, dl);
    assert.equal(r.text, 'look');
    assert.equal(r.unsupported, false);
    assert.equal(r.audio, undefined);
    assert.deepEqual({ ...r.file, download: undefined }, { mimetype: 'image/jpeg', name: '', bytes: 1234, download: undefined });
    assert.equal(await r.file.download(), 'bytes');
  });

  test('audio gives audio meta', () => {
    const r = readMessage({ message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 7 } } });
    assert.equal(r.text, '');
    assert.equal(r.unsupported, false);
    assert.equal(r.audio.seconds, 7);
    assert.equal(r.audio.mimetype, 'audio/ogg; codecs=opus');
    assert.equal(r.file, undefined);
  });

  test('reaction and protocol messages are silent, not unsupported', () => {
    for (const message of [{ reactionMessage: { text: '👍' } }, { protocolMessage: { type: 0 } }]) {
      assert.deepEqual(readMessage({ message }), { text: '', unsupported: false });
    }
  });

  test('empty message and unknown type', () => {
    assert.deepEqual(readMessage({ message: null }), { text: '', unsupported: false });
    assert.equal(readMessage({ message: { stickerMessage: { mimetype: 'image/webp' } } }).unsupported, true);
  });
});

describe('owner filter', () => {
  test('owner by phone jid passes and carries the message id', () => {
    const { sock, got } = setup();
    upsert(sock, msg({ conversation: 'hello' }));
    assert.equal(got.length, 1);
    assert.equal(got[0].id, 'm1');
    assert.equal(got[0].text, 'hello');
  });

  test('owner via @lid passes after lid-mapping.update', () => {
    const { sock, got } = setup();
    upsert(sock, msg({ conversation: 'before' }, { jid: '555@lid' }));
    assert.equal(got.length, 0);
    sock.ev.emit('lid-mapping.update', { lid: '555@lid', pn: OWNER_PN });
    upsert(sock, msg({ conversation: 'after' }, { jid: '555@lid', id: 'm2' }));
    assert.deepEqual(got.map((m) => m.text), ['after']);
  });

  test('owner via @lid passes when remoteJidAlt is the owner pn', () => {
    const { sock, got } = setup();
    upsert(sock, msg({ conversation: 'x' }, { jid: '777@lid', remoteJidAlt: OWNER_PN }));
    assert.equal(got.length, 1);
  });

  test('a lid mapped to another number is not the owner', () => {
    const { sock, got } = setup();
    sock.ev.emit('lid-mapping.update', { lid: '888@lid', pn: '972500000000@s.whatsapp.net' });
    upsert(sock, msg({ conversation: 'x' }, { jid: '888@lid' }));
    assert.equal(got.length, 0);
  });

  test('fromMe, other number, group and old messages are dropped', () => {
    const { sock, got } = setup();
    upsert(sock,
      msg({ conversation: 'a' }, { fromMe: true, id: 'a' }),
      msg({ conversation: 'b' }, { jid: '972500000000@s.whatsapp.net', id: 'b' }),
      msg({ conversation: 'c' }, { jid: '120363@g.us', id: 'c', participant: OWNER_PN }),
      msg({ conversation: 'd' }, { id: 'd', ts: NOW_S - 61 }),
      msg(null, { id: 'e' }));
    assert.equal(got.length, 0);
    upsert(sock, msg({ conversation: 'ok' }, { id: 'f', ts: NOW_S - 60 }));
    assert.deepEqual(got.map((m) => m.id), ['f']);
  });

  test('ownerNumber with plus and spaces works', () => {
    const { sock, got } = setup({ ownerNumber: '+972 50-123 4567' });
    upsert(sock, msg({ conversation: 'hi' }));
    assert.equal(got.length, 1);
  });

  test('constructor without ownerNumber throws', () => {
    assert.throws(() => new WhatsAppChannel({ ownerNumber: '', assistantNumber: '1' }), /ownerNumber is required/);
    assert.throws(() => new WhatsAppChannel({ assistantNumber: '1' }), /ownerNumber is required/);
  });

  test('a throwing handler is logged, not thrown', async () => {
    const { ch, sock } = setup();
    const logs = [];
    ch.log = (l) => logs.push(l);
    ch.onMessage = async () => { throw new Error('boom'); };
    upsert(sock, msg({ conversation: 'x' }));
    await tick();
    assert.ok(logs.some((l) => /handler: boom/.test(l)));
  });
});

describe('replies', () => {
  test('send goes to the chat the owner last wrote from (lid stays lid)', async () => {
    const { ch, sock, sent } = setup();
    assert.equal(await ch.send('one'), 'out1');
    assert.equal(sent[0].jid, OWNER_PN);
    upsert(sock, msg({ conversation: 'x' }, { jid: '555@lid', remoteJidAlt: OWNER_PN }));
    await ch.send('two');
    assert.deepEqual(sent[1], { jid: '555@lid', content: { text: 'two' } });
  });

  test('typing sends presence to the current chat', async () => {
    const { ch, presence } = setup();
    await ch.typing(true);
    await ch.typing(false);
    assert.deepEqual(presence, [['composing', OWNER_PN], ['paused', OWNER_PN]]);
  });

  test('react sends the stored key; unknown id sends nothing', async () => {
    const { ch, sock, sent } = setup();
    upsert(sock, msg({ conversation: 'x' }, { id: 'abc' }));
    await ch.react('abc', '👀');
    assert.deepEqual(sent, [{ jid: OWNER_PN, content: { react: { text: '👀', key: { remoteJid: OWNER_PN, id: 'abc' } } } }]);
    await ch.react('nope', '👀');
    assert.equal(sent.length, 1);
  });

  test('the key store keeps only the last 200 ids', () => {
    const { ch, sock } = setup();
    for (let i = 0; i < 205; i++) upsert(sock, msg({ conversation: 'x' }, { id: `k${i}` }));
    assert.equal(ch.keys.size, 200);
    assert.ok(!ch.keys.has('k0') && ch.keys.has('k204'));
  });

  test('sendFile picks image, audio or document', async () => {
    const { ch, sent } = setup();
    await ch.sendFile(Buffer.from('a'), { mimetype: 'image/png', caption: 'c' });
    await ch.sendFile(Buffer.from('a'), { mimetype: 'audio/ogg' });
    await ch.sendFile(Buffer.from('a'), { mimetype: 'application/pdf', fileName: 'a.pdf' });
    assert.deepEqual(sent.map((s) => Object.keys(s.content)[0]), ['image', 'audio', 'document']);
  });
});

describe('pairing', () => {
  test('qr while not registered asks for a code once', async () => {
    const { ch, sock } = setup();
    sock.ev.emit('connection.update', { qr: 'QR1' });
    await tick();
    sock.ev.emit('connection.update', { qr: 'QR2' });
    await tick();
    assert.equal(sock.requestPairingCode.mock.callCount(), 1);
    assert.deepEqual(sock.requestPairingCode.mock.calls[0].arguments, ['972509999999']);
    assert.deepEqual(ch.onPairingCode.mock.calls.map((c) => c.arguments), [['ABCD1234']]);
  });

  test('no pairing code when already registered', async () => {
    const { ch, sock } = setup({ registered: true });
    sock.ev.emit('connection.update', { qr: 'QR1' });
    await tick();
    assert.equal(sock.requestPairingCode.mock.callCount(), 0);
    assert.equal(ch.onPairingCode.mock.callCount(), 0);
  });

  test('no assistantNumber: no request, a hint in the log', async () => {
    const { ch, sock } = setup({ assistantNumber: '' });
    const logs = [];
    ch.log = (l) => logs.push(l);
    sock.ev.emit('connection.update', { qr: 'QR1' });
    await tick();
    assert.equal(sock.requestPairingCode.mock.callCount(), 0);
    assert.ok(logs.some((l) => /assistantNumber/.test(l)));
  });
});

describe('status and reconnect', () => {
  afterEach(() => mock.timers.reset());
  const closeWith = (sock, statusCode) => sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode } } } });

  test('open reports open once', () => {
    const { sock, statuses } = setup();
    sock.ev.emit('connection.update', { connection: 'open' });
    sock.ev.emit('connection.update', { connection: 'open' });
    assert.deepEqual(statuses, ['open']);
  });

  test('logged-out reports logged-out and does not reconnect', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { sock, sockets, statuses } = setup();
    closeWith(sock, DisconnectReason.loggedOut);
    mock.timers.tick(10 * 60_000 + 1000);
    assert.deepEqual(statuses, ['logged-out']);
    assert.equal(sockets.length, 1);
  });

  test('other close reports closed, reconnects after backoff, down after 10 min', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { sock, sockets, statuses } = setup();
    closeWith(sock, 500);
    assert.deepEqual(statuses, ['closed']);
    assert.equal(sockets.length, 1);
    mock.timers.tick(6000);
    assert.equal(sockets.length, 2);
    closeWith(sockets[1], 500); // closed again: status is deduplicated
    mock.timers.tick(12_000);
    assert.equal(sockets.length, 3);
    mock.timers.tick(10 * 60_000);
    assert.deepEqual(statuses, ['closed', 'down']);
  });

  test('open before 10 minutes cancels the down timer', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { sock, statuses } = setup();
    closeWith(sock, 500);
    sock.ev.emit('connection.update', { connection: 'open' });
    mock.timers.tick(11 * 60_000);
    assert.deepEqual(statuses, ['closed', 'open']);
  });

  test('stop() ends the socket and prevents reconnect and down', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { ch, sock, sockets, statuses } = setup();
    closeWith(sock, 500);
    ch.stop();
    mock.timers.tick(11 * 60_000);
    assert.equal(sock.end.mock.callCount(), 1);
    assert.equal(sockets.length, 1);
    assert.deepEqual(statuses, ['closed']);
    closeWith(sock, 500);
    assert.deepEqual(statuses, ['closed']);
  });

  test('logged-out after a plain close: no late "down", no reconnect', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const { sock, sockets, statuses } = setup();
    closeWith(sock, 500); // starts the reconnect and down timers
    closeWith(sock, DisconnectReason.loggedOut);
    mock.timers.tick(11 * 60_000);
    assert.deepEqual(statuses, ['closed', 'logged-out']);
    assert.equal(sockets.length, 1);
  });
});
