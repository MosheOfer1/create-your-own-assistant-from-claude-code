import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Approvals } from '../src/approvals.js';
import { hooksOf } from '../src/gateway.js';
import { Policy } from '../src/policy.js';
import { Router } from '../src/router.js';
import { MemoryState } from '../src/state.js';
import media from '../modules/media/index.js';
import { chainTranscriber, findBin, makeTranscriber, SetupError, sherpaFiles, sherpaTranscriber, transcriberNames, transcriberPlan } from '../modules/media/transcribe.js';

const tmps = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'media-tr-')); tmps.push(d); return d; };
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const nolog = () => {};
const buf = (s = 'audio') => Buffer.from(s);
const exe = (dir, name, body = '#!/bin/sh\nexit 0\n') => { const p = path.join(dir, name); fs.writeFileSync(p, body, { mode: 0o755 }); return p; };
// A fake transcriber: answers `text`, or throws `error`.
const fake = (name, { text = '', error, reason = null } = {}) => ({ name, check: () => reason, calls: 0,
  async transcribe() { this.calls++; if (error) throw error; return text; } });
const enoent = () => Object.assign(new Error('spawn whisper-cli ENOENT'), { code: 'ENOENT' });

describe('transcriberNames', () => {
  test('one name, a comma list, an array; whisper by default', () => {
    assert.deepEqual(transcriberNames(), ['whisper']);
    assert.deepEqual(transcriberNames('sherpa'), ['sherpa']);
    assert.deepEqual(transcriberNames(' http , sherpa '), ['http', 'sherpa']);
    assert.deepEqual(transcriberNames(['http', 'sherpa']), ['http', 'sherpa']);
  });
});

describe('findBin', () => {
  test('a path is checked as given; a name is looked up on PATH; not executable does not count', () => {
    const d = tmp();
    const p = exe(d, 'tool');
    fs.writeFileSync(path.join(d, 'plain'), 'x', { mode: 0o644 });
    assert.equal(findBin(p), p);
    assert.equal(findBin(path.join(d, 'missing')), null);
    assert.equal(findBin('tool', { PATH: `/nonexistent${path.delimiter}${d}` }), p);
    assert.equal(findBin('plain', { PATH: d }), null);
    assert.equal(findBin('tool', { PATH: '' }), null);
    assert.equal(findBin(''), null);
  });
});

describe('chainTranscriber', () => {
  test('a failing one passes to the next, with a log line', async () => {
    const lines = [];
    const a = fake('http', { error: new Error('HTTP 500') });
    const b = fake('sherpa', { text: 'שלום' });
    const c = chainTranscriber([a, b], { log: (l) => lines.push(l) });
    assert.equal(c.name, 'http → sherpa');
    assert.equal(await c.transcribe(buf()), 'שלום');
    assert.deepEqual(lines, ['media: transcriber http failed: HTTP 500']);
    assert.equal(a.calls + b.calls, 2);
  });

  test('the first that works ends the chain', async () => {
    const b = fake('b', { text: 'x' });
    assert.equal(await chainTranscriber([fake('a', { text: 'first' }), b], { log: nolog }).transcribe(buf()), 'first');
    assert.equal(b.calls, 0);
  });

  test('all fail: one error naming each; setup only when every reason is a setup one', async () => {
    const all = chainTranscriber([fake('whisper', { error: enoent() }), fake('sherpa', { error: new SetupError('model files missing') })], { log: nolog });
    const e1 = await all.transcribe(buf()).catch((e) => e);
    assert.equal(e1.message, 'whisper: spawn whisper-cli ENOENT; sherpa: model files missing');
    assert.equal(e1.setup, true);
    const mixed = chainTranscriber([fake('whisper', { error: enoent() }), fake('http', { error: new Error('timeout') })], { log: nolog });
    assert.equal((await mixed.transcribe(buf()).catch((e) => e)).setup, false);
  });

  test('check() gives each name with its reason', async () => {
    const c = chainTranscriber([fake('a'), fake('b', { reason: 'b not found' })]);
    assert.deepEqual(await c.check(), [{ name: 'a', reason: null }, { name: 'b', reason: 'b not found' }]);
  });
});

describe('makeTranscriber checks', () => {
  test('whisper: missing ffmpeg, missing whisper-cli, missing model, then ready', async () => {
    const d = tmp();
    const ff = exe(d, 'ff');
    const wh = exe(d, 'wh');
    const check = async (o) => (await makeTranscriber({ dataDir: d, ...o }).check())[0].reason;
    assert.match(await check({ ffmpegBin: path.join(d, 'none') }), /none not found/);
    assert.match(await check({ ffmpegBin: ff, whisperBin: path.join(d, 'nowh') }), /nowh not found/);
    assert.match(await check({ ffmpegBin: ff, whisperBin: wh }), /no model file .*ggml-base\.bin/);
    fs.writeFileSync(path.join(d, 'm.bin'), 'm');
    assert.equal(await check({ ffmpegBin: ff, whisperBin: wh, whisperModel: path.join(d, 'm.bin') }), null);
  });

  test('http without httpUrl: not ready, and a setup error when used', async () => {
    const c = makeTranscriber({ transcriber: 'http' }, { log: nolog });
    assert.deepEqual(await c.check(), [{ name: 'http', reason: 'httpUrl is not set' }]);
    assert.equal((await c.transcribe(buf(), 'audio/ogg').catch((e) => e)).setup, true);
  });

  test('an unknown name never runs and says so', async () => {
    const c = makeTranscriber({ transcriber: ['nope'] }, { log: nolog });
    assert.deepEqual(await c.check(), [{ name: 'nope', reason: 'unknown transcriber "nope"' }]);
    assert.equal((await c.transcribe(buf()).catch((e) => e)).setup, true);
  });

  test('off anywhere in the list turns voice off', () => {
    assert.equal(makeTranscriber({ transcriber: ['http', 'off'] }), null);
  });

  test('a list builds the chain in order (multilingual first when the language is auto)', () => {
    assert.equal(makeTranscriber({ transcriber: 'http,whisper', dataDir: '/d' }).name, 'http → whisper');
    assert.equal(makeTranscriber({ transcriber: 'sherpa,http,whisper', dataDir: '/d' }, { log: nolog }).name, 'http → whisper → sherpa');
  });
});

describe('languages', () => {
  const he = (name = 'sherpa') => ({ ...fake(name, { text: 'עברית' }), languages: ['he'] });
  const any = (name, o) => ({ ...fake(name, o), languages: ['*'] });

  test('each engine says what it can do: whisper and http many, sherpa from sherpaLanguages (he by default)', () => {
    const c = makeTranscriber({ transcriber: 'whisper,http,sherpa', dataDir: '/d', voiceLanguage: 'auto' }, { log: nolog });
    assert.deepEqual(c.list.map((t) => [t.name, t.languages]), [['whisper', ['*']], ['http', ['*']], ['sherpa', ['he']]]);
    const ar = makeTranscriber({ transcriber: 'sherpa', dataDir: '/d', sherpaLanguages: ['AR-eg'], voiceLanguage: 'auto' }, { log: nolog });
    assert.deepEqual(ar.list[0].languages, ['ar']);
  });

  test('transcriberPlan: a set language skips engines that do not do it, order kept', () => {
    const [s, h, w] = [he(), any('http'), any('whisper')];
    assert.deepEqual(transcriberPlan([s, h, w], 'he').order, [s, h, w]);
    const en = transcriberPlan([s, h, w], 'en');
    assert.deepEqual(en.order, [h, w]);
    assert.deepEqual(en.skipped, [s]);
  });

  test('transcriberPlan auto: single-language engines go last, unless one is alone', () => {
    const [s, h, w] = [he(), any('http'), any('whisper')];
    assert.deepEqual(transcriberPlan([s, h, w], 'auto').order, [h, w, s]);
    assert.deepEqual(transcriberPlan([s], 'auto').order, [s]);
  });

  test('a skipped engine: one log line at build; it is never called', async () => {
    const lines = [];
    const s = he();
    const c = chainTranscriber([s, any('http', { text: 'hello' })], { log: (l) => lines.push(l), language: 'en' });
    assert.equal(await c.transcribe(buf()), 'hello');
    assert.equal(s.calls, 0);
    assert.deepEqual(lines, ['media: transcriber sherpa skipped: it does not do "en" (languages: he)']);
    assert.deepEqual((await c.check()).map((r) => r.name), ['http', 'sherpa']);
    assert.match((await c.check())[1].reason, /skipped/);
  });

  test('auto: the Hebrew-only engine runs only after the multilingual one fails', async () => {
    const s = he();
    const h = any('http', { error: new Error('down') });
    const c = chainTranscriber([s, h], { log: nolog, language: 'auto' });
    assert.equal(await c.transcribe(buf()), 'עברית');
    assert.equal(h.calls, 1);
    const ok = chainTranscriber([he('sherpa2'), any('whisper', { text: 'multi' })], { log: nolog });
    assert.equal(await ok.transcribe(buf()), 'multi');
  });

  test('every engine skipped: a setup error, so the owner gets "not set up"', async () => {
    const e = await chainTranscriber([he()], { log: nolog, language: 'en' }).transcribe(buf()).catch((x) => x);
    assert.equal(e.setup, true);
    assert.match(e.message, /sherpa: skipped/);
  });

  test('the voice language comes from voiceLanguage, else the chat language', () => {
    const lines = [];
    makeTranscriber({ transcriber: 'sherpa,http', dataDir: '/d', language: 'en-US' }, { log: (l) => lines.push(l) });
    assert.equal(lines.length, 1);
    lines.length = 0;
    makeTranscriber({ transcriber: 'sherpa,http', dataDir: '/d', language: 'en', voiceLanguage: 'he' }, { log: (l) => lines.push(l) });
    assert.equal(lines.length, 0);
  });

  test('http sends the language as a hint, not when auto', async () => {
    const bodies = [];
    const fetchFn = async (u, i) => { bodies.push(i.body); return { ok: true, json: async () => ({ text: 'x' }) }; };
    await makeTranscriber({ transcriber: 'http', httpUrl: 'u', language: 'he' }, { fetchFn }).transcribe(buf(), 'audio/ogg');
    await makeTranscriber({ transcriber: 'http', httpUrl: 'u', voiceLanguage: 'auto' }, { fetchFn }).transcribe(buf(), 'audio/ogg');
    assert.equal(bodies[0].get('language'), 'he');
    assert.equal(bodies[1].get('language'), null);
  });
});

describe('sherpa', () => {
  // A model dir with the four files (empty: the fake worker never opens them).
  function modelDir(names = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']) {
    const d = tmp();
    for (const n of names) fs.writeFileSync(path.join(d, n), '');
    return d;
  }
  // ffmpeg → 3 floats and one stray byte (the reader keeps whole floats only).
  const pcmExec = async (bin, args) => {
    const out = args.at(-1);
    assert.equal(args[args.indexOf('-f') + 1], 'f32le');
    fs.writeFileSync(out, Buffer.concat([Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer), Buffer.from([7])]));
    return { stdout: '' };
  };
  // A fake worker script, so no native package and no model are needed.
  function worker(body) {
    const p = path.join(tmp(), 'worker.mjs');
    fs.writeFileSync(p, `import { parentPort, workerData } from 'node:worker_threads';\n${body}\n`);
    return pathToFileURL(p);
  }
  const ECHO = "parentPort.on('message', ({ id, samples }) => parentPort.postMessage({ id, text: `heard ${samples.length} ${workerData.modelType} ${workerData.threads} ${workerData.files.encoder.endsWith('encoder.int8.onnx')}` }));";
  const base = (o = {}) => ({ sherpaModelDir: modelDir(), ffmpegBin: exe(tmp(), 'ffmpeg'), ...o });
  const made = [];
  after(() => { for (const t of made) t.stop(); });
  const make = (o, deps) => { const t = sherpaTranscriber(base(o), { exec: pcmExec, resolvePkg: () => 'ok', log: nolog, ...deps }); made.push(t); return t; };

  test('sherpaFiles takes int8 or full files and names what is missing', () => {
    const full = modelDir(['encoder.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt']);
    const { files, missing } = sherpaFiles(full);
    assert.deepEqual(missing, []);
    assert.equal(path.basename(files.encoder), 'encoder.onnx');
    assert.equal(path.basename(files.joiner), 'joiner.int8.onnx');
    assert.deepEqual(sherpaFiles(modelDir(['tokens.txt'])).missing, ['encoder(.int8).onnx', 'decoder(.int8).onnx', 'joiner(.int8).onnx']);
  });

  test('check: no package, no model, no ffmpeg, then ready', () => {
    assert.match(make({}, { resolvePkg: () => { throw new Error('ERR_MODULE_NOT_FOUND'); } }).check(), /sherpa-onnx-node is not installed/);
    assert.match(make({ sherpaModelDir: tmp() }).check(), /model files missing in .*: encoder/);
    assert.match(make({ ffmpegBin: '/nonexistent/ffmpeg' }).check(), /ffmpeg not found/);
    assert.equal(make({}).check(), null);
  });

  test('the default model dir is <dataDir>/models/sherpa', () => {
    const t = sherpaTranscriber({ dataDir: '/data', ffmpegBin: '/bin/sh' }, { resolvePkg: () => 'ok' });
    assert.match(t.check(), /model files missing in \/data\/models\/sherpa:/);
  });

  test('a setup failure throws a SetupError before any worker starts', async () => {
    const e = await make({ sherpaModelDir: tmp() }, { workerUrl: worker('throw new Error("must not start");') }).transcribe(buf()).catch((x) => x);
    assert.ok(e instanceof SetupError);
    assert.match(e.message, /model files missing/);
  });

  test('audio → ffmpeg → samples → worker → text; the worker is reused', async () => {
    const t = make({ sherpaThreads: 3 }, { workerUrl: worker(ECHO) });
    assert.equal(await t.transcribe(buf()), 'heard 3 zipformer2 3 true');
    assert.equal(await t.transcribe(buf()), 'heard 3 zipformer2 3 true');
  });

  test('a package or model that does not load: logged once, and each job is a setup error', async () => {
    const lines = [];
    const t = make({}, { log: (l) => lines.push(l), workerUrl: worker(
      "parentPort.postMessage({ fatal: 'no addon' });\nparentPort.on('message', ({ id }) => parentPort.postMessage({ id, error: 'sherpa could not load: no addon', setup: true }));") });
    const e = await t.transcribe(buf()).catch((x) => x);
    assert.ok(e instanceof SetupError);
    assert.match(e.message, /could not load: no addon/);
    assert.deepEqual(lines, ['media: sherpa could not load: no addon']);
  });

  test('a decode error is a plain error, not a setup one', async () => {
    const t = make({}, { workerUrl: worker("parentPort.on('message', ({ id }) => parentPort.postMessage({ id, error: 'bad audio' }));") });
    const e = await t.transcribe(buf()).catch((x) => x);
    assert.equal(e.message, 'bad audio');
    assert.ok(!e.setup);
  });

  test('a worker that dies fails its job; the next job starts a new one', async () => {
    const flag = path.join(tmp(), 'died');
    const t = make({}, { workerUrl: worker(`import fs from 'node:fs';
parentPort.on('message', ({ id }) => {
  if (!fs.existsSync(${JSON.stringify(flag)})) { fs.writeFileSync(${JSON.stringify(flag)}, '1'); process.exit(3); }
  parentPort.postMessage({ id, text: 'again' });
});`) });
    await assert.rejects(t.transcribe(buf()), /worker ended \(3\)/);
    assert.equal(await t.transcribe(buf()), 'again');
  });

  test('warm() starts the worker only when the check passes', async () => {
    const started = path.join(tmp(), 'started');
    const body = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(started)}, '1'); ${ECHO}`;
    make({ sherpaModelDir: tmp() }, { workerUrl: worker(body) }).warm();
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!fs.existsSync(started));
    make({}, { workerUrl: worker(body) }).warm();
    for (let i = 0; i < 100 && !fs.existsSync(started); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(started));
  });
});

describe('media module: when voice cannot be transcribed', () => {
  function setup(opts = {}, deps = {}) {
    const lines = [];
    const mod = media({ agentCwd: tmp(), dataDir: tmp(), language: 'en', ...opts }, { log: (l) => lines.push(l), ...deps });
    const router = { sent: [], async send(x) { this.sent.push(x); } };
    mod.start(router);
    mod.stop();
    return { mod, router, lines };
  }
  const voice = () => ({ audio: { seconds: 5, mimetype: 'audio/ogg', download: async () => buf() } });
  const say = { en: '🎤 I cannot turn voice notes into text here yet: speech-to-text is not set up on this machine. Please write text.' };

  test('a missing whisper-cli (spawn ENOENT): a plain line, the reason in the log', async () => {
    const { mod, router, lines } = setup({ whisperBin: 'no-such-whisper-cli-xyz', ffmpegBin: '/bin/true', whisperModel: '/dev/null' });
    await mod.checked;
    assert.equal(await mod.media(voice()), null);
    assert.deepEqual(router.sent, [say.en]);
    assert.ok(!router.sent.join('').includes('ENOENT'));
    assert.ok(lines.some((l) => /transcriber whisper failed: .*ENOENT/.test(l)), lines.join('\n'));
  });

  test('the start check logs once which transcribers can run', async () => {
    const { mod, lines } = setup({}, { transcriber: chainTranscriber([fake('http'), fake('sherpa', { reason: 'model files missing in /m' })]) });
    await mod.checked;
    assert.deepEqual(lines.filter((l) => l.includes('transcribers')), ['media: transcribers http: ready, sherpa: no (model files missing in /m)']);
  });

  test('none can run at start: the log says so, and even a plain failure gets the "not set up" line', async () => {
    const { mod, router, lines } = setup({}, { transcriber: chainTranscriber([fake('whisper', { reason: 'whisper-cli not found', error: new Error('exit 1') })], { log: nolog }) });
    await mod.checked;
    assert.match(lines.find((l) => l.includes('transcribers')), /whisper: no \(whisper-cli not found\) - voice notes get a "not set up" reply/);
    await mod.media(voice());
    assert.deepEqual(router.sent, [say.en]);
  });

  test('a ready transcriber that fails this time: "try again"', async () => {
    const { mod, router } = setup({}, { transcriber: chainTranscriber([fake('http', { error: new Error('HTTP 503') })], { log: nolog }) });
    await mod.checked;
    await mod.media(voice());
    assert.deepEqual(router.sent, ['🎤 I could not turn this voice note into text right now. Please try again or write text.']);
  });

  test('the line follows config.language (Hebrew)', async () => {
    const { mod, router } = setup({ language: 'he' }, { transcriber: chainTranscriber([fake('whisper', { error: enoent() })], { log: nolog }) });
    await mod.media(voice());
    assert.match(router.sent[0], /^🎤 .*תמלול לא מוגדר/);
    const other = setup({ language: 'he' }, { transcriber: chainTranscriber([fake('http', { error: new Error('x') })], { log: nolog }) });
    await other.mod.checked;
    await other.mod.media(voice());
    assert.match(other.router.sent[0], /לא הצלחתי/);
  });

  test('fallback through the module: the second transcriber answers', async () => {
    const { mod, router } = setup({}, { transcriber: chainTranscriber([fake('http', { error: new Error('down') }), fake('sherpa', { text: 'buy milk' })], { log: nolog }) });
    assert.match(await mod.media(voice()), /\nbuy milk$/);
    assert.deepEqual(router.sent, ['🎤 buy milk']);
  });

  test('through the Router: the owner sees the plain line, not "Error: spawn ... ENOENT"', async () => {
    const agentCwd = tmp();
    const mod = media({ agentCwd, dataDir: tmp(), language: 'en', whisperBin: 'no-such-whisper-cli-xyz', ffmpegBin: '/bin/true', whisperModel: '/dev/null' }, { log: nolog });
    const state = new MemoryState();
    const channel = { sent: [], async send(x) { this.sent.push(x); return 'id'; }, async react() {}, async typing() {} };
    const agent = { calls: [], async run(o) { this.calls.push(o); return { text: 'ok', sessionId: 's', context: 1 }; } };
    const policy = new Policy({ agentCwd, root: path.join(os.tmpdir(), 'no-code'), modules: [mod] });
    const router = new Router({ config: { language: 'en', batchMs: 0 }, state, approvals: new Approvals({ timeoutMs: 5000, store: state }), policy, agent, channel, hooks: hooksOf([mod]), log: nolog });
    mod.start(router);
    mod.stop();
    await router.handle({ id: 'v', ...voice() });
    assert.deepEqual(channel.sent, [say.en]);
    assert.equal(agent.calls.length, 0);
  });
});
