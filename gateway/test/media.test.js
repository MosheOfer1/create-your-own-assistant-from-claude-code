import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { Approvals } from '../src/approvals.js';
import { hooksOf } from '../src/gateway.js';
import { strings } from '../src/i18n.js';
import { Policy } from '../src/policy.js';
import { Router } from '../src/router.js';
import { MemoryState } from '../src/state.js';
import media, { makeTranscriber, safeName } from '../modules/media/index.js';

const tmps = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'media-')); tmps.push(d); return d; };
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const t = strings('en');
const buf = (s = 'audio') => Buffer.from(s);
const nolog = () => {};

// An exec that records its calls; whisper-cli answers with `stdout`.
function fakeExec(stdout = ' hello   world \n') {
  const calls = [];
  const exec = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
    if (bin === 'ffmpeg') assert.ok(fs.existsSync(args[args.indexOf('-i') + 1]), 'ffmpeg input file exists');
    return { stdout: bin === 'ffmpeg' ? '' : stdout };
  };
  return { exec, calls };
}

describe('safeName', () => {
  test('path tricks and dot files lose their dangerous parts', () => {
    assert.equal(safeName('../../etc/passwd'), 'etc_passwd');
    assert.equal(safeName('.env'), 'env');
    assert.equal(safeName('..'), 'file');
    assert.equal(safeName('a/b\\c.txt'), 'a_b_c.txt');
  });
  test('Hebrew letters stay, other characters become _', () => {
    assert.equal(safeName('דו"ח שנתי.pdf'), 'דו_ח_שנתי.pdf');
    assert.equal(safeName('my file (1).png'), 'my_file_1_.png');
  });
  test('empty, undefined and fallback', () => {
    assert.equal(safeName(''), 'file');
    assert.equal(safeName(undefined, 'x.bin'), 'x.bin');
    assert.equal(safeName('???', 'fb'), 'fb');
  });
  test('long names keep the last 80 characters (the extension)', () => {
    const n = safeName(`${'a'.repeat(200)}.pdf`);
    assert.equal(n.length, 80);
    assert.ok(n.endsWith('.pdf'));
  });
});

describe('makeTranscriber', () => {
  test('off gives null', () => assert.equal(makeTranscriber({ transcriber: 'off' }), null));

  test('whisper: ffmpeg first, then whisper-cli with -l <lang>; stdout is tidied', async () => {
    const { exec, calls } = fakeExec();
    const tr = makeTranscriber({ dataDir: '/data', language: 'he-IL' }, { exec, log: nolog });
    assert.equal(await tr.transcribe(buf()), 'hello world');
    assert.deepEqual(calls.map((c) => c.bin), ['ffmpeg', 'whisper-cli']);
    const wavArg = calls[0].args.at(-1);
    assert.deepEqual(calls[0].args.slice(0, 2), ['-loglevel', 'error']);
    assert.ok(calls[0].args.includes('16000'));
    const w = calls[1].args;
    assert.equal(w[w.indexOf('-l') + 1], 'he');
    assert.equal(w[w.indexOf('-f') + 1], wavArg);
    assert.equal(w[w.indexOf('-m') + 1], path.join('/data', 'models', 'ggml-base.bin'));
    assert.ok(w.includes('-nt') && w.includes('-np'));
  });

  test('whisper: language defaults to auto; custom binaries and model are used', async () => {
    const { exec, calls } = fakeExec('x');
    await makeTranscriber({ ffmpegBin: 'myff', whisperBin: 'mywh', whisperModel: '/m.bin' }, { exec, log: nolog }).transcribe(buf());
    assert.deepEqual(calls.map((c) => c.bin), ['myff', 'mywh']);
    assert.equal(calls[1].args[calls[1].args.indexOf('-m') + 1], '/m.bin');
  });

  test('whisper: no language means -l auto', async () => {
    const { exec, calls } = fakeExec('x');
    await makeTranscriber({ dataDir: '/d' }, { exec, log: nolog }).transcribe(buf());
    const w = calls[1].args;
    assert.equal(w[w.indexOf('-l') + 1], 'auto');
  });

  test('whisper: the temp dir is removed after success and after a failure', async () => {
    const ok = fakeExec();
    await makeTranscriber({ dataDir: '/d' }, { exec: ok.exec, log: nolog }).transcribe(buf());
    assert.ok(!fs.existsSync(path.dirname(ok.calls[0].args.at(-1))));
    let dir;
    const failing = async (bin, args) => { dir = path.dirname(args.at(-1)); throw new Error('ffmpeg died'); };
    await assert.rejects(makeTranscriber({ dataDir: '/d' }, { exec: failing, log: nolog }).transcribe(buf()), /ffmpeg died/);
    assert.ok(!fs.existsSync(dir));
  });

  describe('http', () => {
    const saved = process.env.TRANSCRIBE_API_KEY;
    after(() => { if (saved === undefined) delete process.env.TRANSCRIBE_API_KEY; else process.env.TRANSCRIBE_API_KEY = saved; });

    test('posts a FormData with file and model, bearer key from the environment', async () => {
      process.env.TRANSCRIBE_API_KEY = 'sk-test';
      const seen = [];
      const fetchFn = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ text: 'שלום' }) }; };
      const tr = makeTranscriber({ transcriber: 'http', httpUrl: 'https://x.test/v1/audio/transcriptions', httpModel: 'm1' }, { fetchFn, log: nolog });
      assert.equal(await tr.transcribe(buf('abc'), 'audio/ogg'), 'שלום');
      const { url, init } = seen[0];
      assert.equal(url, 'https://x.test/v1/audio/transcriptions');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.authorization, 'Bearer sk-test');
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get('model'), 'm1');
      const file = init.body.get('file');
      assert.equal(file.type, 'audio/ogg');
      assert.equal(file.size, 3);
    });

    test('model defaults to whisper-1; a missing key sends an empty bearer', async () => {
      delete process.env.TRANSCRIBE_API_KEY;
      let init;
      const fetchFn = async (u, i) => { init = i; return { ok: true, json: async () => ({}) }; };
      assert.equal(await makeTranscriber({ transcriber: 'http', httpUrl: 'u' }, { fetchFn, log: nolog }).transcribe(buf(), 'audio/ogg'), '');
      assert.equal(init.body.get('model'), 'whisper-1');
      assert.equal(init.headers.authorization, 'Bearer ');
    });

    test('error path: API message, or HTTP status when the body is not JSON', async () => {
      const bad = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) });
      await assert.rejects(makeTranscriber({ transcriber: 'http', httpUrl: 'u' }, { fetchFn: bad, log: nolog }).transcribe(buf(), 'a/b'), /bad key/);
      const html = async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
      await assert.rejects(makeTranscriber({ transcriber: 'http', httpUrl: 'u' }, { fetchFn: html, log: nolog }).transcribe(buf(), 'a/b'), /HTTP 502/);
    });
  });
});

function setup(opts = {}, deps = {}) {
  const agentCwd = tmp();
  const dataDir = tmp();
  const fx = fakeExec(deps.stdout);
  const mod = media({ agentCwd, dataDir, language: 'en', ...opts }, { exec: fx.exec, fetchFn: deps.fetchFn, log: deps.log || nolog });
  const router = { sent: [], async send(x) { this.sent.push(x); } };
  mod.start(router);
  mod.stop();
  return { mod, router, agentCwd, calls: fx.calls };
}
const voice = (o = {}) => ({ audio: { seconds: 5, mimetype: 'audio/ogg', download: async () => buf(), ...o } });
const file = (o = {}, text = '') => ({ text, file: { name: 'a.pdf', mimetype: 'application/pdf', bytes: 10, download: async () => buf('PDFDATA'), ...o } });

describe('media module: voice', () => {
  test('a voice note is echoed with 🎤 and becomes a transcript prompt', async () => {
    const { mod, router } = setup({}, { stdout: 'buy milk' });
    const p = await mod.media(voice());
    assert.deepEqual(router.sent, ['🎤 buy milk']);
    assert.equal(p, '[Voice message, automatic transcript that may contain mistakes:]\nbuy milk');
  });

  test('too long: voiceLong text, null', async () => {
    const { mod, router, calls } = setup({ maxMinutes: 2 });
    assert.equal(await mod.media(voice({ seconds: 121 })), null);
    assert.deepEqual(router.sent, [t.voiceLong(2)]);
    assert.equal(calls.length, 0);
    assert.notEqual(await mod.media(voice({ seconds: 120 })), null); // the limit itself is fine
  });

  test('empty transcript: voiceEmpty, null', async () => {
    const { mod, router } = setup({}, { stdout: '  \n ' });
    assert.equal(await mod.media(voice()), null);
    assert.deepEqual(router.sent, [t.voiceEmpty]);
  });

  test('transcriber off: voiceOff, null', async () => {
    const { mod, router } = setup({ transcriber: 'off' });
    assert.equal(await mod.media(voice()), null);
    assert.deepEqual(router.sent, [t.voiceOff]);
  });

  test('the http transcriber works through the module', async () => {
    const fetchFn = async () => ({ ok: true, json: async () => ({ text: 'via http' }) });
    const { mod, router } = setup({ transcriber: 'http', httpUrl: 'u' }, { fetchFn });
    assert.match(await mod.media(voice()), /via http$/);
    assert.deepEqual(router.sent, ['🎤 via http']);
  });

  test('a message with neither audio nor file gives null', () => {
    assert.equal(setup().mod.media({ text: 'hi' }), null);
  });
});

describe('media module: files', () => {
  test('saved under agentCwd/inbox; the prompt has the path, type, size and the caption', async () => {
    const { mod, agentCwd } = setup();
    const p = await mod.media(file({}, ' please summarise '));
    const m = /file: (\S+) \(application\/pdf, 1 KB\)/.exec(p);
    assert.ok(m, p);
    assert.equal(path.dirname(m[1]), path.join(agentCwd, 'inbox'));
    assert.match(path.basename(m[1]), /^\d{8}T\d{6}-a\.pdf$/);
    assert.equal(fs.readFileSync(m[1], 'utf8'), 'PDFDATA');
    assert.ok(p.endsWith(']\nplease summarise'));
  });

  test('without a caption the prompt ends at the bracket', async () => {
    const { mod } = setup();
    assert.ok((await mod.media(file())).endsWith('if the task needs it.]'));
  });

  test('hostile and Hebrew names stay inside the inbox', async () => {
    const { mod, agentCwd } = setup();
    for (const name of ['../../etc/passwd', '.env', 'דו"ח.pdf']) {
      await mod.media(file({ name }));
    }
    const inbox = path.join(agentCwd, 'inbox');
    const names = fs.readdirSync(inbox).map((n) => n.replace(/^\d{8}T\d{6}-/, '')).sort();
    assert.deepEqual(names, ['env.pdf', 'etc_passwd.pdf', 'דו_ח.pdf'].sort()); // the type adds .pdf
    assert.ok(!fs.existsSync(path.join(agentCwd, '..', 'etc')));
    assert.deepEqual(fs.readdirSync(agentCwd), ['inbox']);
  });

  test('a nameless file gets file + extension from its type; a name without extension gets one', async () => {
    const { mod, agentCwd } = setup();
    await mod.media(file({ name: undefined, mimetype: 'image/jpeg' }));
    await mod.media(file({ name: 'photo', mimetype: 'image/png' }));
    const names = fs.readdirSync(path.join(agentCwd, 'inbox')).map((n) => n.replace(/^\d{8}T\d{6}-/, '')).sort();
    assert.deepEqual(names, ['file.jpg', 'photo.png']);
  });

  test('too big: fileBig text, nothing saved', async () => {
    const { mod, router, agentCwd } = setup({ maxFileMB: 1 });
    assert.equal(await mod.media(file({ bytes: (1 << 20) + 1 })), null);
    assert.deepEqual(router.sent, [t.fileBig(1)]);
    assert.ok(!fs.existsSync(path.join(agentCwd, 'inbox')));
  });
});

describe('media module: tidy', () => {
  test('deletes files older than keepDays and keeps newer ones', () => {
    const { mod, agentCwd } = setup({ keepDays: 3 });
    const inbox = path.join(agentCwd, 'inbox');
    fs.mkdirSync(inbox);
    const day = 86_400_000;
    for (const [n, ageDays] of [['old', 5], ['edge', 2], ['new', 0]]) {
      const p = path.join(inbox, n);
      fs.writeFileSync(p, 'x');
      const when = new Date(Date.now() - ageDays * day);
      fs.utimesSync(p, when, when);
    }
    mod.tidy();
    assert.deepEqual(fs.readdirSync(inbox).sort(), ['edge', 'new']);
    mod.tidy(Date.now() + 10 * day); // later "now": everything is old
    assert.deepEqual(fs.readdirSync(inbox), []);
  });

  test('keepDays defaults to 7; a missing inbox is fine', () => {
    const { mod, agentCwd } = setup();
    mod.tidy();
    const inbox = path.join(agentCwd, 'inbox');
    fs.mkdirSync(inbox);
    const p = path.join(inbox, 'f');
    fs.writeFileSync(p, 'x');
    const old = new Date(Date.now() - 6 * 86_400_000);
    fs.utimesSync(p, old, old);
    mod.tidy();
    assert.ok(fs.existsSync(p));
    const older = new Date(Date.now() - 8 * 86_400_000);
    fs.utimesSync(p, older, older);
    mod.tidy();
    assert.ok(!fs.existsSync(p));
  });
});

describe('Router with the media hook', () => {
  function routerSetup(opts = {}, deps = {}) {
    const m = setup(opts, deps);
    const state = new MemoryState();
    const channel = { sent: [], async send(x) { this.sent.push(x); return 'id'; }, async react() {}, async typing() {} };
    const agent = { calls: [], async run(o) { this.calls.push(o); return { text: 'ok', sessionId: 's', context: 1 }; } };
    const approvals = new Approvals({ timeoutMs: 5000, store: state });
    const policy = new Policy({ agentCwd: m.agentCwd, root: path.join(os.tmpdir(), 'no-code'), modules: [m.mod] });
    const router = new Router({ config: { language: 'en', batchMs: 0 }, state, approvals, policy, agent, channel, hooks: hooksOf([m.mod]), log: () => {} });
    m.mod.start(router);
    m.mod.stop();
    const settle = async () => { for (let i = 0; i < 3; i++) { await router.inflow; await router.batch; await router.queue; } };
    return { ...m, router, channel, agent, approvals, state, settle };
  }

  test('hooksOf exposes media only when a module has it', () => {
    assert.equal(hooksOf([{}]).media, null);
    assert.equal(typeof hooksOf([setup().mod]).media, 'function');
  });

  test('a voice "yes" while an approval waits does NOT answer it: it becomes a turn', async () => {
    const s = routerSetup({}, { stdout: 'yes' });
    const pending = s.router.decide({ tool_name: 'Bash', input: { command: 'rm -rf build' } });
    for (let i = 0; i < 50 && !s.approvals.waiting().length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(s.approvals.waiting().length, 1);
    await s.router.handle({ id: 'v1', ...voice() });
    await s.settle();
    assert.equal(s.approvals.waiting().length, 1, 'approval still open');
    assert.equal(s.agent.calls.length, 1);
    assert.match(s.agent.calls[0].prompt, /Voice message[^\n]*\nyes$/);
    assert.ok(s.channel.sent.includes('🎤 yes'));
    s.approvals.resolve(s.approvals.waiting()[0].id, 'deny');
    assert.equal((await pending).allow, false);
  });

  test('a forwarded file marks the session tainted and is wrapped as foreign text', async () => {
    const s = routerSetup();
    assert.equal(s.router.tainted(), false);
    await s.router.handle({ id: 'f1', forwarded: true, ...file() });
    await s.settle();
    assert.equal(s.router.tainted(), true);
    assert.match(s.agent.calls[0].prompt, /^\[Forwarded, written by someone else:\]\n\[The owner sent a file: /);
  });

  test('an own (not forwarded) file does not taint', async () => {
    const s = routerSetup();
    await s.router.handle({ id: 'f2', ...file() });
    await s.settle();
    assert.equal(s.router.tainted(), false);
    assert.equal(s.agent.calls.length, 1);
  });

  test('a media failure is shown to the owner and does not reach the agent as a prompt', async () => {
    const s = routerSetup();
    await s.router.handle({ id: 'v2', ...voice({ download: async () => { throw new Error('download failed'); } }) });
    await s.settle();
    assert.equal(s.agent.calls.length, 0);
    assert.ok(s.channel.sent.includes('Error: download failed'));
  });
});
