import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { strings } from '../../src/i18n.js';

const run = promisify(execFile);

// Voice notes → text, files → <agentCwd>/inbox for the agent to Read (images and PDFs too).
// Options (config.modules.media):
//   transcriber: 'whisper' (whisper.cpp on this machine, the default) | 'http' | 'off'
//   whisperBin ('whisper-cli'), whisperModel (<dataDir>/models/ggml-base.bin), ffmpegBin ('ffmpeg')
//   httpUrl (an OpenAI-compatible /v1/audio/transcriptions URL), httpModel ('whisper-1');
//   its key is TRANSCRIBE_API_KEY in the environment.
//   maxMinutes (10), maxFileMB (50), keepDays (7)
export function makeTranscriber(o, { exec = run, fetchFn = fetch } = {}) {
  if (o.transcriber === 'off') return null;
  if (o.transcriber === 'http') {
    return async (buf, mimetype) => {
      const form = new FormData();
      form.append('file', new Blob([buf], { type: mimetype }), 'audio');
      form.append('model', o.httpModel || 'whisper-1');
      const r = await fetchFn(o.httpUrl, { method: 'POST', headers: { authorization: `Bearer ${process.env.TRANSCRIBE_API_KEY || ''}` }, body: form });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error?.message || `transcription failed (HTTP ${r.status})`);
      return String(j.text || '');
    };
  }
  return async (buf) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'));
    try {
      fs.writeFileSync(path.join(dir, 'in'), buf);
      await exec(o.ffmpegBin || 'ffmpeg', ['-loglevel', 'error', '-i', path.join(dir, 'in'), '-ar', '16000', '-ac', '1', path.join(dir, 'a.wav')]);
      const lang = o.language ? String(o.language).slice(0, 2) : 'auto';
      const { stdout } = await exec(o.whisperBin || 'whisper-cli', ['-m', o.whisperModel || path.join(o.dataDir, 'models', 'ggml-base.bin'), '-f', path.join(dir, 'a.wav'), '-l', lang, '-nt', '-np'], { maxBuffer: 16 << 20 });
      return stdout.replace(/\s+/g, ' ').trim();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

// A file name that is safe in a path: letters, digits, dot, dash; never a dot first.
export const safeName = (name = '', fallback = 'file') => (String(name).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+/, '').slice(-80) || fallback);
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf', 'video/mp4': '.mp4', 'text/plain': '.txt' };

export default function media(config, { exec, fetchFn } = {}) {
  const t = strings(config.language);
  const inbox = path.join(config.agentCwd, 'inbox');
  const transcribe = makeTranscriber(config, { exec, fetchFn });
  const maxSeconds = (config.maxMinutes || 10) * 60;
  const maxBytes = (config.maxFileMB || 50) << 20;
  let router = null;

  async function voice(audio) {
    if (!transcribe) { await router?.send(t.voiceOff); return null; }
    if (audio.seconds > maxSeconds) { await router?.send(t.voiceLong(maxSeconds / 60)); return null; }
    const text = (await transcribe(await audio.download(), audio.mimetype)).trim();
    if (!text) { await router?.send(t.voiceEmpty); return null; }
    await router?.send(`🎤 ${text}`);
    return `[Voice message, automatic transcript that may contain mistakes:]\n${text}`;
  }

  async function file(f, caption) {
    if (f.bytes > maxBytes) { await router?.send(t.fileBig(maxBytes >> 20)); return null; }
    const buf = await f.download();
    fs.mkdirSync(inbox, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    let name = safeName(f.name, `file${EXT[f.mimetype] || ''}`);
    if (!path.extname(name) && EXT[f.mimetype]) name += EXT[f.mimetype];
    const p = path.join(inbox, `${stamp}-${name}`);
    fs.writeFileSync(p, buf);
    return `[The owner sent a file: ${p} (${f.mimetype}, ${Math.ceil(buf.length / 1024)} KB). Read it if the task needs it.]${caption ? `\n${caption}` : ''}`;
  }

  // Files older than keepDays leave the inbox.
  function tidy(now = Date.now()) {
    const keep = (config.keepDays || 7) * 86_400_000;
    for (const n of fs.existsSync(inbox) ? fs.readdirSync(inbox) : []) {
      const p = path.join(inbox, n);
      try { if (now - fs.statSync(p).mtimeMs > keep) fs.rmSync(p, { force: true }); } catch { /* gone */ }
    }
  }

  return {
    media: (msg) => (msg.audio ? voice(msg.audio) : msg.file ? file(msg.file, (msg.text || '').trim()) : null),
    tidy,
    start(r) {
      router = r;
      tidy();
      this.timer = setInterval(tidy, 6 * 3600_000);
      this.timer.unref?.();
    },
    stop() { clearInterval(this.timer); },
  };
}
