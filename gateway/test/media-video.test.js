import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import media from '../modules/media/index.js';
import { chainTranscriber, SetupError } from '../modules/media/transcribe.js';
import { isVideo, videoSeconds } from '../modules/media/video.js';

const tmps = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'media-vid-')); tmps.push(d); return d; };
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
const nolog = () => {};

// A fake ffmpeg: a small node script. It logs its arguments to calls.jsonl beside it and acts on
// mode.json: { seconds, frames, noSound, noPicture }.
//   -i only (no output) → "Duration:" on stderr, exit 1, as the real one does
//   …%d.jpg → writes up to -frames:v jpgs; .wav → a header and some sound
function fakeFfmpeg(mode = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'mode.json'), JSON.stringify({ seconds: 42, frames: 3, ...mode }));
  const p = path.join(dir, 'ffmpeg');
  fs.writeFileSync(p, `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const dir = ${JSON.stringify(dir)};
const mode = JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const out = args.at(-1);
const noStream = () => { process.stderr.write('Output file #0 does not contain any stream\\n'); process.exit(1); };
if (args.at(-2) === '-i') {
  const s = mode.seconds; const hh = String(Math.floor(s / 3600)).padStart(2, '0'); const mm = String(Math.floor(s / 60) % 60).padStart(2, '0'); const ss = (s % 60).toFixed(2).padStart(5, '0');
  process.stderr.write('Input #0, mov,mp4\\n  Duration: ' + hh + ':' + mm + ':' + ss + ', start: 0.000000, bitrate: 900 kb/s\\n');
  process.exit(1);
}
if (out.endsWith('%d.jpg')) {
  if (mode.noPicture) noStream();
  const n = Math.min(mode.frames, Number(args[args.indexOf('-frames:v') + 1]));
  for (let i = 1; i <= n; i++) fs.writeFileSync(out.replace('%d', String(i)), 'JPEG');
} else if (out.endsWith('.wav')) {
  if (mode.noSound) noStream();
  fs.writeFileSync(out, Buffer.alloc(44 + 3200));
}
`, { mode: 0o755 });
  const calls = () => (fs.existsSync(path.join(dir, 'calls.jsonl')) ? fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { bin: p, calls };
}

const fake = (name, { text = '', error } = {}) => ({ name, check: () => null, seen: [],
  async transcribe(buf, mimetype) { this.seen.push({ buf, mimetype }); if (error) throw error; return text; } });

function setup(opts = {}, { ffmpeg = fakeFfmpeg(), transcriber = chainTranscriber([fake('t', { text: 'hello from the video' })], { log: nolog }) } = {}) {
  const agentCwd = tmp();
  const lines = [];
  const mod = media({ agentCwd, dataDir: tmp(), language: 'en', ffmpegBin: ffmpeg.bin, ...opts }, { transcriber, log: (l) => lines.push(l) });
  const router = { sent: [], async send(x) { this.sent.push(x); } };
  mod.start(router);
  mod.stop();
  return { mod, router, agentCwd, ffmpeg, transcriber, lines, inbox: path.join(agentCwd, 'inbox') };
}
const video = (o = {}, text = '') => ({ text, file: { name: 'clip.mp4', mimetype: 'video/mp4', bytes: 10, download: async () => Buffer.from('MP4DATA'), ...o } });

describe('isVideo / videoSeconds', () => {
  test('by type, or by name when the type is generic', () => {
    assert.ok(isVideo('video/mp4'));
    assert.ok(isVideo('application/octet-stream', 'a.MOV'));
    assert.ok(!isVideo('application/pdf', 'a.pdf'));
  });

  test('reads the Duration line; 0 when ffmpeg is missing or says nothing', async () => {
    const ff = fakeFfmpeg({ seconds: 3723.5 });
    assert.equal(await videoSeconds('/x.mp4', { ffmpeg: ff.bin }), 3723.5);
    assert.equal(await videoSeconds('/x.mp4', { ffmpeg: '/nonexistent/ffmpeg' }), 0);
  });
});

describe('media module: video', () => {
  test('saved, frames beside it, sound transcribed; the turn says where and gives the transcript', async () => {
    const s = setup();
    const p = await s.mod.media(video({}, ' what is this? '));
    const saved = fs.readdirSync(s.inbox).find((n) => n.endsWith('-clip.mp4'));
    assert.ok(saved);
    const frames = fs.readdirSync(s.inbox).filter((n) => n.endsWith('.jpg')).sort();
    assert.equal(frames.length, 3);
    assert.ok(frames.every((n) => n.startsWith(saved.replace(/\.mp4$/, '-frame'))));
    assert.match(p, /^\[The owner sent a video: \S+-clip\.mp4 \(video\/mp4, 1 KB, 42 s\)\. Frames from it, one every 7 s: /);
    for (const f of frames) assert.ok(p.includes(path.join(s.inbox, f)), f);
    assert.match(p, /Read them to see it\.\]\n\[Its sound, automatic transcript that may contain mistakes; the speaker may not be the owner:\]\nhello from the video\nwhat is this\?$/);
    // the sound went to the transcriber as a wav; nothing is sent to the owner
    const t = s.transcriber.list[0];
    assert.equal(t.seen[0].mimetype, 'audio/wav');
    assert.equal(t.seen[0].buf.length, 44 + 3200);
    assert.deepEqual(s.router.sent, []);
  });

  test('ffmpeg is told: half a step in, one frame per step, at most videoFrames, small JPEGs', async () => {
    const s = setup({ videoFrames: 4 }, { ffmpeg: fakeFfmpeg({ seconds: 40, frames: 9 }) });
    await s.mod.media(video());
    const frameCall = s.ffmpeg.calls().find((a) => a.at(-1).endsWith('%d.jpg'));
    assert.equal(frameCall[frameCall.indexOf('-ss') + 1], '5');
    assert.equal(frameCall[frameCall.indexOf('-t') + 1], '35');
    assert.match(frameCall[frameCall.indexOf('-vf') + 1], /^fps=1\/10,scale='min\(640,iw\)':-2$/);
    assert.equal(frameCall[frameCall.indexOf('-frames:v') + 1], '4');
    assert.equal(fs.readdirSync(s.inbox).filter((n) => n.endsWith('.jpg')).length, 4);
  });

  test('longer than maxMinutes: only the first minutes are looked at, and the turn says so', async () => {
    const s = setup({ maxMinutes: 1 }, { ffmpeg: fakeFfmpeg({ seconds: 600 }) });
    const p = await s.mod.media(video());
    assert.match(p, /600 s\)\. Only its first 1 minutes were looked at\./);
    const calls = s.ffmpeg.calls();
    const wav = calls.find((a) => a.at(-1).endsWith('.wav'));
    assert.equal(wav[wav.indexOf('-t') + 1], '60');
    const frames = calls.find((a) => a.at(-1).endsWith('%d.jpg'));
    assert.match(frames[frames.indexOf('-vf') + 1], /^fps=1\/10,/);
  });

  test('a length the channel knows is used; ffmpeg is not asked for it', async () => {
    const s = setup();
    assert.match(await s.mod.media(video({ seconds: 12 })), /, 12 s\)/);
    assert.ok(!s.ffmpeg.calls().some((a) => a.at(-2) === '-i'));
  });

  test('no ffmpeg: the file is saved and the turn says there are no frames', async () => {
    const s = setup({}, { ffmpeg: { bin: path.join(tmp(), 'no-ffmpeg') } });
    await s.mod.checked;
    const p = await s.mod.media(video());
    assert.match(p, /^\[The owner sent a video: \S+-clip\.mp4 \(video\/mp4, 1 KB\)\. ffmpeg is not installed here, so there are no frames and no transcript of it\.\]$/);
    assert.deepEqual(fs.readdirSync(s.inbox).length, 1);
    assert.ok(s.lines.some((l) => /no-ffmpeg not found: videos are saved without frames or sound/.test(l)));
  });

  test('no sound track, or no picture', async () => {
    const quiet = setup({}, { ffmpeg: fakeFfmpeg({ noSound: true }) });
    assert.match(await quiet.mod.media(video()), /Read them to see it\. It has no sound track\.\]$/);
    const blind = setup({}, { ffmpeg: fakeFfmpeg({ noPicture: true }) });
    const p = await blind.mod.media(video());
    assert.match(p, /No frames could be taken from it\.\]\n\[Its sound/);
    assert.ok(blind.lines.some((l) => l.startsWith('media: no frames from')));
  });

  test('transcriber off, not set up, or no speech: the turn says which', async () => {
    assert.match(await setup({}, { transcriber: null }).mod.media(video()), /Its sound was not transcribed: voice transcription is off\.\]$/);
    const broken = chainTranscriber([fake('w', { error: new SetupError('whisper-cli not found') })], { log: nolog });
    assert.match(await setup({}, { transcriber: broken }).mod.media(video()), /Its sound could not be transcribed \(speech-to-text is not set up here\)\.\]$/);
    const flaky = chainTranscriber([fake('h', { error: new Error('HTTP 500') })], { log: nolog });
    assert.match(await setup({}, { transcriber: flaky }).mod.media(video()), /\(the transcriber failed\)\.\]$/);
    const silent = chainTranscriber([fake('t', { text: '  ' })], { log: nolog });
    assert.match(await setup({}, { transcriber: silent }).mod.media(video()), /No speech was heard in it\.\]$/);
  });

  test('a video sent as a document (octet-stream, .mov name) is a video too', async () => {
    const s = setup();
    assert.match(await s.mod.media(video({ name: 'trip.mov', mimetype: 'application/octet-stream' })), /^\[The owner sent a video: \S+-trip\.mov/);
  });

  test('bigger than maxFileMB once downloaded (the size was unknown): refused, nothing saved', async () => {
    const s = setup({ maxFileMB: 1 });
    assert.equal(await s.mod.media(video({ bytes: 0, download: async () => Buffer.alloc((1 << 20) + 1) })), null);
    assert.deepEqual(s.router.sent, ['📎 The file is bigger than 1 MB.']);
    assert.ok(!fs.existsSync(s.inbox));
  });
});
