import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { strings } from '../../src/i18n.js';
import { officeKind, officeText } from './office.js';
import { findBin, isSetup, makeTranscriber } from './transcribe.js';
import { isVideo, videoFrames, videoSeconds, videoSound } from './video.js';

export { makeTranscriber } from './transcribe.js';

const run = promisify(execFile);

// Voice notes → text; files → <agentCwd>/inbox for the agent to Read (images and PDFs too);
// videos → a few frames and a transcript of their sound; office files → a .txt beside them.
// Options (config.modules.media):
//   transcriber: 'whisper' (whisper.cpp here, the default) | 'http' | 'sherpa' | 'off', or a list tried
//     in order: ['http', 'sherpa']
//   whisperBin ('whisper-cli'), whisperModel (<dataDir>/models/ggml-base.bin), ffmpegBin ('ffmpeg')
//   httpUrl (an OpenAI-compatible /v1/audio/transcriptions URL), httpModel ('whisper-1');
//   its key is TRANSCRIBE_API_KEY in the environment.
//   sherpaModelDir (<dataDir>/models/sherpa), sherpaLanguages (['he']), sherpaThreads (2), sherpaModelType ('zipformer2')
//   voiceLanguage (default: the owner's language; 'auto' = whisper detects it)
//   maxMinutes (10), maxFileMB (50), keepDays (7), videoFrames (6), maxTextKB (1000)

// The module's own lines to the owner, by config.language (the core's table is src/i18n.js).
const SAY = {
  en: {
    voiceNotReady: '🎤 I cannot turn voice notes into text here yet: speech-to-text is not set up on this machine. Please write text.',
    voiceFailed: '🎤 I could not turn this voice note into text right now. Please try again or write text.',
  },
  he: {
    voiceNotReady: '🎤 אני עוד לא יכול להפוך כאן הודעות קוליות לטקסט: תמלול לא מוגדר במחשב הזה. תכתוב לי טקסט.',
    voiceFailed: '🎤 לא הצלחתי להפוך את ההודעה הקולית לטקסט כרגע. תנסה שוב או תכתוב.',
  },
};
const say = (language = 'en') => ({ ...SAY.en, ...(SAY[String(language).slice(0, 2)] || {}) });

// A file name that is safe in a path: letters, digits, dot, dash; never a dot first.
export const safeName = (name = '', fallback = 'file') => (String(name).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+/, '').slice(-80) || fallback);
const EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf', 'text/plain': '.txt',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/3gpp': '.3gp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/vnd.oasis.opendocument.presentation': '.odp',
};
const kb = (n) => Math.ceil(n / 1024);

// deps (tests): exec, fetchFn, transcriber (replaces the chain from config), log.
const isAudioFile = (f) => (/^audio\//.test(f.mimetype || '') || /\.(mp3|m4a|ogg|oga|opus|wav|aac|flac)$/i.test(f.name || '')) && !(f.bytes > 25 << 20); // a big one is only saved

export default function media(config, { exec = run, fetchFn, transcriber, log = console.log } = {}) {
  const t = strings(config.language);
  const s = say(config.language);
  const inbox = path.join(config.agentCwd, 'inbox');
  const transcribe = transcriber !== undefined ? transcriber : makeTranscriber(config, { exec, fetchFn, log });
  const ffmpeg = config.ffmpegBin || 'ffmpeg';
  const maxSeconds = (config.maxMinutes || 10) * 60;
  const maxBytes = (config.maxFileMB || 50) << 20;
  let router = null;
  let usable = null; // the transcribers start() found able to run; null before that check
  let stopped = false;

  // The owner gets a plain line; the technical reason is in the log (the chain logs each failure).
  // "Not set up" when every transcriber failed for a setup reason, or none could run at start.
  const notReady = (e) => isSetup(e) || usable?.length === 0;
  const failLine = (e) => (notReady(e) ? s.voiceNotReady : s.voiceFailed);

  async function voice(audio) {
    if (!transcribe) { await router?.send(t.voiceOff); return null; }
    if (audio.seconds > maxSeconds) { await router?.send(t.voiceLong(maxSeconds / 60)); return null; }
    const buf = await audio.download(); // a failed download is the router's error line
    let text;
    try { text = (await transcribe.transcribe(buf, audio.mimetype)).trim(); } catch (e) { await router?.send(failLine(e)); return null; }
    if (!text) { await router?.send(t.voiceEmpty); return null; }
    await router?.send(`🎤 ${text}`);
    return `[Voice message, automatic transcript that may contain mistakes:]\n${text}`;
  }

  // <inbox>/<time>-<clean name>, the extension from the type when the name has none.
  function save(buf, f) {
    fs.mkdirSync(inbox, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    let name = safeName(f.name, `file${EXT[f.mimetype] || ''}`);
    if (!path.extname(name) && EXT[f.mimetype]) name += EXT[f.mimetype];
    const p = path.join(inbox, `${stamp}-${name}`);
    fs.writeFileSync(p, buf);
    return p;
  }

  async function file(f, caption) {
    if (f.bytes > maxBytes) { await router?.send(t.fileBig(maxBytes >> 20)); return null; }
    const buf = await f.download();
    if (buf.length > maxBytes) { await router?.send(t.fileBig(maxBytes >> 20)); return null; } // the size was not known before
    const p = save(buf, f);
    const head = `${p} (${f.mimetype}, ${kb(buf.length)} KB`;
    const kind = officeKind(f.mimetype, f.name || p);
    const note = isVideo(f.mimetype, f.name || p) ? await videoNote(p, head, f.seconds)
      : kind ? officeNote(p, head, buf, kind)
        : `[The owner sent a file: ${head}). Read it if the task needs it.]`;
    return `${note}${caption ? `\n${caption}` : ''}`;
  }

  // The text goes to <file>.txt beside it, so the agent Reads it like any inbox file (outside text).
  function officeNote(p, head, buf, kind) {
    try {
      const text = officeText(buf, kind, (config.maxTextKB || 1000) * 1000);
      fs.writeFileSync(`${p}.txt`, text);
      return `[The owner sent a file: ${head}). Its text is in ${p}.txt: Read that if the task needs it.]`;
    } catch (e) {
      log(`media: no text from ${path.basename(p)}: ${e.message}`);
      return `[The owner sent a file: ${head}). Its text could not be taken out (${e.message}).]`;
    }
  }

  // Frames to Read and the sound as a transcript. Only the first maxMinutes are looked at.
  async function videoNote(p, head, known = 0) {
    if (!findBin(ffmpeg)) return `[The owner sent a video: ${head}). ffmpeg is not installed here, so there are no frames and no transcript of it.]`;
    const seconds = known || await videoSeconds(p, { ffmpeg, exec });
    const lines = [`[The owner sent a video: ${head}${seconds ? `, ${Math.round(seconds)} s` : ''}).`];
    if (seconds > maxSeconds) lines.push(`Only its first ${maxSeconds / 60} minutes were looked at.`);
    const shots = await videoFrames(p, seconds, { ffmpeg, exec, max: config.videoFrames || 6, limit: maxSeconds })
      .catch((e) => { log(`media: no frames from ${path.basename(p)}: ${e.message}`); return { files: [] }; });
    lines.push(shots.files.length ? `Frames from it, one every ${shots.step} s: ${shots.files.join(', ')}. Read them to see it.` : 'No frames could be taken from it.');
    const sound = await soundNote(p);
    return sound.text ? `${lines.join(' ')}]\n${sound.text}` : `${lines.join(' ')} ${sound.note}]`;
  }

  // → { text } with the transcript, or { note } that says why there is none.
  async function soundNote(p) {
    if (!transcribe) return { note: 'Its sound was not transcribed: voice transcription is off.' };
    let buf;
    try { buf = await videoSound(p, { ffmpeg, exec, limit: maxSeconds }); } catch (e) {
      log(`media: no sound from ${path.basename(p)}: ${e.message}`);
      return { note: 'Its sound could not be taken out.' };
    }
    if (!buf) return { note: 'It has no sound track.' };
    let text;
    try { text = (await transcribe.transcribe(buf, 'audio/wav')).trim(); } catch (e) {
      return { note: `Its sound could not be transcribed (${notReady(e) ? 'speech-to-text is not set up here' : 'the transcriber failed'}).` };
    }
    if (!text) return { note: 'No speech was heard in it.' };
    // The speaker may be anyone in the video: the transcript is marked so.
    return { text: `[Its sound, automatic transcript that may contain mistakes; the speaker may not be the owner:]\n${text}` };
  }

  // Files older than keepDays leave the inbox.
  function tidy(now = Date.now()) {
    const keep = (config.keepDays || 7) * 86_400_000;
    for (const n of fs.existsSync(inbox) ? fs.readdirSync(inbox) : []) {
      const p = path.join(inbox, n);
      try { if (now - fs.statSync(p).mtimeMs > keep) fs.rmSync(p, { force: true }); } catch { /* gone */ }
    }
  }

  // Once at start: which transcribers can run, and whether videos get frames. Ready ones load now.
  async function checkTools() {
    if (!findBin(ffmpeg)) log(`media: ${ffmpeg} not found: videos are saved without frames or sound`);
    if (!transcribe) return log('media: voice notes off (transcriber: off)');
    const res = await transcribe.check();
    usable = res.filter((r) => !r.reason).map((r) => r.name);
    log(`media: transcribers ${res.map((r) => `${r.name}: ${r.reason ? `no (${r.reason})` : 'ready'}`).join(', ')}`
      + (usable.length ? '' : ' - voice notes get a "not set up" reply'));
    if (!stopped) transcribe.warm?.();
  }

  return {
    // An audio file sent as a document (an mp3 recording) is heard like a voice note.
    media: (msg) => (msg.audio ? voice(msg.audio) : msg.file && isAudioFile(msg.file) ? voice(msg.file) : msg.file ? file(msg.file, (msg.text || '').trim()) : null),
    tidy,
    start(r) {
      router = r;
      tidy();
      this.checked = checkTools().catch((e) => log(`media: tool check failed: ${e.message}`));
      this.timer = setInterval(tidy, 6 * 3600_000);
      this.timer.unref?.();
    },
    stop() { stopped = true; clearInterval(this.timer); transcribe?.stop?.(); },
  };
}
