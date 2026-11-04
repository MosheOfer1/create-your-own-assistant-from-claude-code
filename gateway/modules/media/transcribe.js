import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';

const run = promisify(execFile);

// A transcriber is { name, check() → null when it can run, else the reason; transcribe(buf, mimetype) → text,
// warm?(), stop?() }. config.transcriber names one, or a list tried in order ("http, sherpa").

// A failure that trying again does not fix: a program, a model or a package is missing.
export class SetupError extends Error {
  constructor(message) { super(message); this.setup = true; }
}
// `spawn whisper-cli ENOENT` is a missing program, so it is a setup failure too.
export const isSetup = (e) => !!(e?.setup || e?.code === 'ENOENT');

// The path of a program: as given when it holds a "/", else the first match on PATH. null when absent.
export function findBin(bin, env = process.env) {
  if (!bin) return null;
  const ok = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
  if (bin.includes('/')) return ok(bin) ? bin : null;
  for (const dir of (env.PATH || '').split(path.delimiter)) if (dir && ok(path.join(dir, bin))) return path.join(dir, bin);
  return null;
}

// A temp dir for one job, always removed, also after a failure.
async function inTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The language whisper is told. Default: the owner's language (whisper's own detection often misses
// on short notes); voiceLanguage: 'auto' lets whisper detect it.
export function whisperLang(o) {
  const v = o.voiceLanguage || o.language;
  return !v || v === 'auto' ? 'auto' : String(v).slice(0, 2).toLowerCase();
}

// whisper.cpp on this machine: ffmpeg makes a 16 kHz wav, whisper-cli reads it.
export function whisperTranscriber(o, { exec = run } = {}) {
  const ffmpeg = o.ffmpegBin || 'ffmpeg';
  const bin = o.whisperBin || 'whisper-cli';
  const model = () => o.whisperModel || path.join(o.dataDir, 'models', 'ggml-base.bin');
  return {
    name: 'whisper',
    languages: ['*'], // about 99 languages; small models are weak in some (Hebrew among them)
    check: () => (!findBin(ffmpeg) ? `${ffmpeg} not found` : !findBin(bin) ? `${bin} not found`
      : !fs.existsSync(model()) ? `no model file ${model()}` : null),
    transcribe: (buf) => inTemp(async (dir) => {
      fs.writeFileSync(path.join(dir, 'in'), buf);
      await exec(ffmpeg, ['-loglevel', 'error', '-i', path.join(dir, 'in'), '-ar', '16000', '-ac', '1', path.join(dir, 'a.wav')]);
      const { stdout } = await exec(bin, ['-m', model(), '-f', path.join(dir, 'a.wav'), '-l', whisperLang(o), '-nt', '-np'], { maxBuffer: 16 << 20 });
      return stdout.replace(/\s+/g, ' ').trim();
    }),
  };
}

// An OpenAI-compatible /v1/audio/transcriptions service. Its key is TRANSCRIBE_API_KEY in the environment.
export function httpTranscriber(o, { fetchFn = fetch } = {}) {
  return {
    name: 'http',
    languages: ['*'], // an OpenAI-compatible whisper service: multilingual
    check: () => (o.httpUrl ? null : 'httpUrl is not set'),
    async transcribe(buf, mimetype) {
      if (!o.httpUrl) throw new SetupError('httpUrl is not set');
      const form = new FormData();
      form.append('file', new Blob([buf], { type: mimetype }), 'audio');
      form.append('model', o.httpModel || 'whisper-1');
      if (whisperLang(o) !== 'auto') form.append('language', whisperLang(o)); // a hint, as for whisper-cli
      const r = await fetchFn(o.httpUrl, { method: 'POST', headers: { authorization: `Bearer ${process.env.TRANSCRIBE_API_KEY || ''}` }, body: form, signal: AbortSignal.timeout(180_000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error?.message || `transcription failed (HTTP ${r.status})`);
      return String(j.text || '');
    },
  };
}

// The files of a sherpa-onnx transducer model (int8 or full), or the names that are missing.
const PARTS = ['encoder', 'decoder', 'joiner'];
export function sherpaFiles(dir) {
  const pick = (names) => names.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
  const files = Object.fromEntries(PARTS.map((p) => [p, pick([`${p}.int8.onnx`, `${p}.onnx`])]));
  files.tokens = pick(['tokens.txt']);
  const missing = Object.entries(files).filter(([, p]) => !p).map(([k]) => (k === 'tokens' ? 'tokens.txt' : `${k}(.int8).onnx`));
  return { files, missing };
}

// Any audio → 16 kHz mono float32 samples (what sherpa reads), via ffmpeg.
async function toPcm16k(buf, { ffmpeg, exec }) {
  return inTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, 'in'), buf);
    await exec(ffmpeg, ['-loglevel', 'error', '-i', path.join(dir, 'in'), '-f', 'f32le', '-ac', '1', '-ar', '16000', path.join(dir, 'a.raw')]);
    const raw = fs.readFileSync(path.join(dir, 'a.raw'));
    // A copy into an aligned buffer: a Float32Array needs a 4-byte aligned offset.
    return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length - (raw.length % 4)));
  });
}

// sherpa-onnx on this machine: offline, CPU only, also on arm64. It needs the optional npm package
// sherpa-onnx-node (prebuilt binaries, no install script) and a streaming transducer model in
// sherpaModelDir. Decoding runs in a worker thread, so a long note does not stall the channels.
// The package loads only inside the worker, with a dynamic import: without it the gateway still
// installs and runs, and this transcriber says so in check().
export function sherpaTranscriber(o, { exec = run, workerUrl = new URL('./sherpa-worker.js', import.meta.url),
  resolvePkg = () => import.meta.resolve('sherpa-onnx-node'), log = console.log } = {}) {
  const ffmpeg = o.ffmpegBin || 'ffmpeg';
  const dir = o.sherpaModelDir || path.join(o.dataDir || '', 'models', 'sherpa');
  let worker = null;
  let seq = 0;
  const waiting = new Map();

  function check() {
    try { resolvePkg(); } catch { return 'the npm package sherpa-onnx-node is not installed'; }
    const { missing } = sherpaFiles(dir);
    if (missing.length) return `model files missing in ${dir}: ${missing.join(', ')}`;
    return findBin(ffmpeg) ? null : `${ffmpeg} not found`;
  }

  const failAll = (e) => { for (const w of waiting.values()) w.reject(e); waiting.clear(); };
  // The files are checked first: sherpa may end the whole process on a model file it cannot open.
  function start() {
    const w = new Worker(workerUrl, { workerData: { files: sherpaFiles(dir).files, threads: o.sherpaThreads || 2, modelType: o.sherpaModelType ?? 'zipformer2' } });
    // { fatal } once when the package or model does not load; then every job answers { error, setup }.
    w.on('message', ({ id, text, error, setup, fatal }) => {
      if (fatal) return log(`media: sherpa could not load: ${fatal}`);
      const job = waiting.get(id);
      if (!job) return;
      waiting.delete(id);
      if (!waiting.size) w.unref();
      if (error) job.reject(setup ? new SetupError(error) : new Error(error));
      else job.resolve(text);
    });
    w.on('error', (e) => { failAll(e); if (worker === w) worker = null; });
    w.on('exit', (code) => { failAll(new Error(`sherpa worker ended (${code})`)); if (worker === w) worker = null; });
    w.unref(); // an idle worker does not keep the gateway alive
    worker = w;
  }

  return {
    name: 'sherpa',
    // One model, one language: the suggested zipformer2-66m-streaming-he is Hebrew only.
    languages: transcriberNames(o.sherpaLanguages || ['he']).map((l) => (l === '*' ? l : l.slice(0, 2).toLowerCase())),
    check,
    // Load the model at start, not on the first voice note.
    warm() { if (!worker && !check()) start(); },
    stop() { worker?.terminate(); worker = null; },
    async transcribe(buf) {
      const why = check();
      if (why) throw new SetupError(why);
      const samples = await toPcm16k(buf, { ffmpeg, exec });
      if (!worker) start();
      worker.ref();
      const id = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker.postMessage({ id, samples }, [samples.buffer]);
      });
    },
  };
}

// A name that is not a transcriber: it never runs, and the start log says why.
const unknown = (name) => ({ name, languages: ['*'], check: () => `unknown transcriber "${name}"`, transcribe: async () => { throw new SetupError(`unknown transcriber "${name}"`); } });

// "whisper" | "http, sherpa" | ["http", "sherpa"] → the names, in order.
export const transcriberNames = (v = 'whisper') => (Array.isArray(v) ? v : String(v).split(','))
  .map((s) => String(s).trim()).filter(Boolean);

// Can it do this language? languages: ['*'] (many, like whisper) or codes (['he']); missing = '*'.
const multi = (t) => !t.languages || t.languages.includes('*');
const does = (t, lang) => multi(t) || t.languages.includes(lang);

// The order the chain tries them, for the voice language (a 2-letter code, or 'auto'):
// - a set language: an engine that does not do it is skipped (a Hebrew-only model on English
//   speech gives nonsense, not an error, so the next engine would never get its turn);
// - 'auto': single-language engines go after the multilingual ones, unless it is the only one.
export function transcriberPlan(list, language = 'auto') {
  if (language !== 'auto') return { order: list.filter((t) => does(t, language)), skipped: list.filter((t) => !does(t, language)) };
  return { order: list.length > 1 ? [...list.filter(multi), ...list.filter((t) => !multi(t))] : list, skipped: [] };
}

// Tries each transcriber in order. One that fails passes to the next, with a log line.
// When all fail, the error is `setup` only if every one failed for a setup reason.
export function chainTranscriber(list, { log = console.log, language = 'auto' } = {}) {
  const { order, skipped } = transcriberPlan(list, language);
  const skipWhy = (t) => `skipped: it does not do "${language}" (languages: ${t.languages.join(', ')})`;
  for (const t of skipped) log(`media: transcriber ${t.name} ${skipWhy(t)}`);
  return {
    name: order.map((t) => t.name).join(' → ') || 'none',
    list: order,
    async transcribe(buf, mimetype) {
      const errors = skipped.map((t) => `${t.name}: ${skipWhy(t)}`);
      let setup = true; // a skipped engine is a setup matter too: the config does not fit the speech
      for (const t of order) {
        try { return await t.transcribe(buf, mimetype); } catch (e) {
          errors.push(`${t.name}: ${e.message}`);
          log(`media: transcriber ${t.name} failed: ${e.message}`);
          setup &&= isSetup(e);
        }
      }
      throw Object.assign(new Error(errors.join('; ') || 'no transcriber'), { setup });
    },
    // [{ name, reason }]: reason null means it can run.
    check: async () => [
      ...await Promise.all(order.map(async (t) => ({ name: t.name, reason: await t.check() }))),
      ...skipped.map((t) => ({ name: t.name, reason: skipWhy(t) })),
    ],
    warm() { for (const t of order) t.warm?.(); },
    stop() { for (const t of order) t.stop?.(); },
  };
}

// config.modules.media → a chain, or null when transcriber is 'off'.
export function makeTranscriber(o, deps = {}) {
  const names = transcriberNames(o.transcriber);
  if (names.includes('off')) return null;
  const make = { whisper: whisperTranscriber, http: httpTranscriber, sherpa: sherpaTranscriber };
  const list = (names.length ? names : ['whisper']).map((n) => (make[n] ? make[n](o, deps) : unknown(n)));
  return chainTranscriber(list, { ...deps, language: whisperLang(o) });
}
