import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TelegramChannel } from '../src/channels/telegram.js';
import { MemoryState } from '../src/state.js';

const TOKEN = '123456:SECRET-token_abc';
const OWNER = 4242;

// A fake Bot API: records method + JSON body, answers { ok: true, result } per method.
function setup({ state = new MemoryState(), results = {}, fail = {} } = {}) {
  const calls = [];
  const logs = [];
  let nextId = 100;
  const fetchFn = async (url, init = {}) => {
    const m = url.match(/\/(?:file\/)?bot[^/]+\/(.+)$/);
    if (url.includes('/file/bot')) {
      calls.push({ method: 'FILE', path: m[1], url });
      return { arrayBuffer: async () => new TextEncoder().encode('filebytes').buffer };
    }
    const method = m[1];
    const body = JSON.parse(init.body || '{}');
    calls.push({ method, body });
    const r = { ok: true, status: 200, json: async () => ({ ok: true, result: null }) };
    if (fail[method]) return { ok: false, status: 500, json: async () => ({ ok: false, description: fail[method] }) };
    const result = typeof results[method] === 'function' ? results[method](body) : results[method];
    r.json = async () => ({ ok: true, result: result ?? (method === 'sendMessage' ? { message_id: nextId++ } : true) });
    return r;
  };
  const tg = new TelegramChannel({ token: TOKEN, state, fetchFn, log: (l) => logs.push(l), pollTimeoutS: 0 });
  const got = [];
  tg.onMessage = async (m) => { got.push(m); };
  const paired = () => { state.set('telegramOwner', OWNER); };
  const priv = (extra = {}, chat = OWNER) => ({ message_id: 7, chat: { id: chat, type: 'private' }, from: { id: chat }, ...extra });
  return { tg, state, calls, logs, got, paired, priv, byMethod: (m) => calls.filter((c) => c.method === m) };
}

describe('pairing', () => {
  test('constructor needs a token and makes a pair code when there is no owner', () => {
    assert.throws(() => new TelegramChannel({ state: new MemoryState() }), /TELEGRAM_BOT_TOKEN/);
    const { tg, state } = setup();
    assert.match(tg.pairCode, /^[0-9a-f]{8}$/);
    assert.equal(tg.owner, null);
    assert.equal(state.get('telegramPairCode'), tg.pairCode);
  });

  test('no new code when an owner or a code already exists', () => {
    assert.equal(setup({ state: new MemoryState({ telegramOwner: 1 }) }).tg.pairCode, null);
    assert.equal(setup({ state: new MemoryState({ telegramPairCode: 'abc' }) }).tg.pairCode, 'abc');
  });

  test('/start <code> from a private chat saves the owner, clears the code, sends a check mark', async () => {
    const { tg, state, priv, byMethod, got } = setup();
    const code = tg.pairCode;
    await tg.update(priv({ text: `/start ${code}` }));
    assert.equal(state.get('telegramOwner'), OWNER);
    assert.equal(state.get('telegramPairCode'), undefined);
    assert.deepEqual(byMethod('sendMessage').map((c) => c.body), [{ chat_id: OWNER, text: '✅' }]);
    assert.equal(got.length, 0);
  });

  test('a wrong code, or a code in a group, does nothing', async () => {
    const { tg, state, priv, calls } = setup();
    await tg.update(priv({ text: '/start wrong' }));
    await tg.update(priv({ text: `/start ${tg.pairCode}`, chat: { id: -5, type: 'group' } }));
    await tg.update(undefined);
    assert.equal(tg.owner, null);
    assert.ok(state.get('telegramPairCode'));
    assert.equal(calls.length, 0);
  });
});

describe('incoming messages', () => {
  test('other chat, group and bot are dropped; owner text passes', async () => {
    const { tg, paired, priv, got } = setup();
    paired();
    await tg.update(priv({ text: 'a' }, 999));
    await tg.update(priv({ text: 'b', chat: { id: OWNER, type: 'group' } }));
    await tg.update(priv({ text: 'c', from: { id: 1, is_bot: true } }));
    assert.equal(got.length, 0);
    await tg.update(priv({ text: 'hello', message_id: 55 }));
    assert.deepEqual(got, [{ id: '55', text: 'hello', unsupported: false }]);
  });

  test('forward_origin sets forwarded, reply_to_message.text sets quoted', async () => {
    const { tg, paired, priv, got } = setup();
    paired();
    await tg.update(priv({ text: 'x', forward_origin: { type: 'user' }, reply_to_message: { text: 'earlier' } }));
    assert.equal(got[0].forwarded, true);
    assert.equal(got[0].quoted, 'earlier');
  });

  test('voice gives audio meta; download calls getFile then fetches the file URL', async () => {
    const { tg, paired, priv, got, calls } = setup({ results: { getFile: { file_path: 'voice/f1.oga' } } });
    paired();
    await tg.update(priv({ voice: { file_id: 'V1', duration: 9, mime_type: 'audio/ogg' } }));
    const { audio, file, unsupported, text } = got[0];
    assert.deepEqual({ mimetype: audio.mimetype, seconds: audio.seconds, file, unsupported, text }, { mimetype: 'audio/ogg', seconds: 9, file: undefined, unsupported: false, text: '' });
    assert.equal(calls.length, 0, 'nothing is fetched before download()');
    const buf = await audio.download();
    assert.equal(buf.toString(), 'filebytes');
    assert.deepEqual(calls[0], { method: 'getFile', body: { file_id: 'V1' } });
    assert.equal(calls[1].url, `https://api.telegram.org/file/bot${TOKEN}/voice/f1.oga`);
  });

  test('photo gives image/jpeg file meta from the largest size; caption is the text', async () => {
    const { tg, paired, priv, got } = setup();
    paired();
    await tg.update(priv({ caption: 'cap', photo: [{ file_id: 's', file_size: 10 }, { file_id: 'big', file_size: 5000 }] }));
    assert.equal(got[0].text, 'cap');
    assert.equal(got[0].unsupported, false);
    assert.equal(got[0].file.mimetype, 'image/jpeg');
    assert.equal(got[0].file.bytes, 5000);
    assert.equal(got[0].audio, undefined);
  });

  test('a message with no text and no file (sticker) is unsupported', async () => {
    const { tg, paired, priv, got } = setup();
    paired();
    await tg.update(priv({ sticker: { file_id: 's' } }));
    assert.equal(got[0].unsupported, true);
  });
});

describe('sending', () => {
  test('send before pairing throws', async () => {
    const { tg } = setup();
    await assert.rejects(tg.send('hi'), /not connected/);
  });

  test('send returns the message id as a string', async () => {
    const { tg, paired, byMethod } = setup();
    paired();
    assert.equal(await tg.send('hi'), '100');
    assert.deepEqual(byMethod('sendMessage')[0].body, { chat_id: OWNER, text: 'hi' });
  });

  test('a 9000-char text is split into 3 sendMessage calls, in order', async () => {
    const { tg, paired, byMethod } = setup();
    paired();
    const text = 'a'.repeat(4000) + 'b'.repeat(4000) + 'c'.repeat(1000);
    assert.equal(await tg.send(text), '102');
    assert.deepEqual(byMethod('sendMessage').map((c) => c.body.text.length), [4000, 4000, 1000]);
    assert.equal(byMethod('sendMessage').map((c) => c.body.text).join(''), text);
  });

  test('react sends the emoji reaction; an empty emoji clears it', async () => {
    const { tg, paired, byMethod } = setup();
    paired();
    await tg.react('5', '👀');
    await tg.react('5', '');
    assert.deepEqual(byMethod('setMessageReaction').map((c) => c.body), [
      { chat_id: OWNER, message_id: 5, reaction: [{ type: 'emoji', emoji: '👀' }] },
      { chat_id: OWNER, message_id: 5, reaction: [] },
    ]);
  });

  test('typing(true) sends a chat action, typing(false) does not', async () => {
    const { tg, paired, byMethod } = setup();
    await tg.typing(true); // not paired: no call
    paired();
    await tg.typing(false);
    await tg.typing(true);
    assert.deepEqual(byMethod('sendChatAction').map((c) => c.body), [{ chat_id: OWNER, action: 'typing' }]);
  });

  test('an API error becomes an Error without the token', async () => {
    const { tg, paired } = setup({ fail: { sendMessage: 'Bad Request: chat not found' } });
    paired();
    await assert.rejects(tg.send('x'), (e) => e.message === 'telegram sendMessage: Bad Request: chat not found' && !e.message.includes(TOKEN));
  });
});

describe('poll loop', () => {
  test('one iteration handles an update, advances the offset, and stop() ends the loop', async () => {
    let tg;
    const s = setup({
      results: { getUpdates: () => { tg.stop(); return [{ update_id: 10, message: { message_id: 3, chat: { id: OWNER, type: 'private' }, text: 'polled' } }]; } },
    });
    tg = s.tg;
    s.paired();
    tg.start(async (m) => { s.got.push(m); });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(s.got.map((m) => m.text), ['polled']);
    assert.equal(tg.offset, 11);
    assert.equal(tg.running, false);
    assert.deepEqual(s.byMethod('getUpdates')[0].body, { timeout: 0, allowed_updates: ['message', 'edited_message', 'callback_query'] });
  });

  test('the token never appears in a log line, also on an error path', async () => {
    let tg;
    const s = setup({ fail: { getUpdates: 'Unauthorized' } });
    tg = s.tg;
    s.paired();
    tg.start(() => {});
    await new Promise((r) => setTimeout(r, 30));
    tg.stop();
    assert.ok(s.logs.some((l) => /telegram: telegram getUpdates: Unauthorized/.test(l)));
    // a network error whose message carries the URL is not our code's output; ours logs e.message only
    const s2 = setup();
    s2.tg.fetchFn = async () => { throw new Error('socket hang up'); };
    s2.paired();
    s2.tg.start(() => {});
    await new Promise((r) => setTimeout(r, 30));
    s2.tg.stop();
    for (const line of [...s.logs, ...s2.logs, ...setup().logs]) assert.ok(!line.includes(TOKEN), line);
  });

  test('start logs the pairing hint with the code but not the token', () => {
    const s = setup();
    s.tg.fetchFn = async () => { throw new Error('x'); };
    s.tg.start(() => {});
    s.tg.stop();
    assert.ok(s.logs[0].includes(`/start ${s.tg.pairCode}`));
    assert.ok(!s.logs.join('\n').includes(TOKEN));
  });
});
