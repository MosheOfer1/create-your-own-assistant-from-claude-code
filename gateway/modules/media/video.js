import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TIMEOUT = 5 * 60_000; // a stuck ffmpeg does not hold the message forever

// WhatsApp sends most videos as video/mp4; a video sent as a document may say octet-stream.
export const isVideo = (mimetype = '', name = '') => /^video\//.test(mimetype) || /\.(mp4|m4v|mov|webm|mkv|3gp|avi)$/i.test(name);

// The length in seconds, from ffmpeg's own "Duration:" line, so ffprobe is not needed. 0 when unknown.
export async function videoSeconds(file, { ffmpeg = 'ffmpeg', exec = run } = {}) {
  let err = '';
  try { err = (await exec(ffmpeg, ['-hide_banner', '-i', file], { timeout: 30_000 })).stderr; } catch (e) { err = e.stderr; } // no output file: ffmpeg exits 1
  const m = /Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(String(err || ''));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

// Up to `max` small JPEGs spread over the video (its first `limit` seconds), next to it in the inbox.
// seconds: its length, 0 when unknown (then one frame every 5 s). The first frame is half a step in,
// since a video often starts black. → { files, step }
export async function videoFrames(file, seconds, { ffmpeg = 'ffmpeg', exec = run, max = 6, width = 640, limit = 600 } = {}) {
  const span = seconds > 0 ? Math.min(seconds, limit) : 0;
  const step = span ? Math.max(1, Math.round(span / max)) : 5;
  const start = span ? Math.min(step / 2, span / 2) : 0;
  const base = file.replace(/\.[^./]+$/, '');
  const out = (i) => `${base}-frame${i}.jpg`;
  await exec(ffmpeg, ['-loglevel', 'error', '-y', '-ss', String(start), '-t', String((span || limit) - start), '-i', file,
    '-vf', `fps=1/${step},scale='min(${width},iw)':-2`, '-frames:v', String(max), '-q:v', '5', `${base}-frame%d.jpg`], { timeout: TIMEOUT });
  return { files: Array.from({ length: max }, (_, i) => out(i + 1)).filter((f) => fs.existsSync(f)), step };
}

// The sound of the first `limit` seconds as a 16 kHz mono wav, for the transcriber. null: no sound track.
export async function videoSound(file, { ffmpeg = 'ffmpeg', exec = run, limit = 600 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-'));
  const wav = path.join(dir, 'sound.wav');
  try {
    await exec(ffmpeg, ['-loglevel', 'error', '-y', '-t', String(limit), '-i', file,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { timeout: TIMEOUT });
    const buf = fs.existsSync(wav) ? fs.readFileSync(wav) : null;
    return buf && buf.length > 44 ? buf : null; // 44 bytes: a wav header with no sound in it
  } catch (e) {
    if (/does not contain any stream|matches no streams/i.test(String(e.stderr || e.message))) return null;
    throw e;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
