import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { State } from '../../src/state.js';
import { formatLocal, parseLocal, wall } from '../../src/time.js';
import { Scheduler } from './scheduler.js';

// Reminders and scheduled tasks. remind: at that time the text comes to the owner, nothing else.
// task: at that time the assistant runs the prompt as a new turn (asked once, when it is set).
// Options: { workDays: [1,2,3,4,5] } (which days "workdays" means; Sunday = 0).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALL = [0, 1, 2, 3, 4, 5, 6];

export default function reminders(config) {
  const scheduler = new Scheduler({ store: new State(path.join(config.dataDir, 'jobs.json')), tz: config.timezone });
  const workDays = config.workDays || [1, 2, 3, 4, 5];
  let router = null;

  // { when?, in_minutes?, repeat? } → { at, repeat } or an error text.
  const timing = (a) => {
    const at = a.in_minutes != null ? scheduler.now() + Number(a.in_minutes) * 60_000 : parseLocal(a.when, config.timezone);
    if (!at || Number.isNaN(at)) return 'give `when` as "YYYY-MM-DD HH:MM" (local time) or `in_minutes`';
    if (at < scheduler.now() - 60_000) return 'that time is in the past';
    if (!a.repeat || a.repeat === 'none') return { at };
    const w = wall(at, config.timezone);
    const time = `${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`;
    const days = { daily: ALL, workdays: workDays, weekly: [w.wd] }[a.repeat];
    return days ? { at, repeat: { time, days } } : `unknown repeat ${a.repeat}`;
  };

  const show = (j) => `#${j.id} ${formatLocal(j.at, config.timezone)}${j.repeat ? ` (${j.repeatName})` : ''} ${j.kind === 'task' ? '[task] ' : ''}${(j.text || j.prompt || '').slice(0, 80)}`;

  async function api(a) {
    if (a.action === 'list') {
      const list = scheduler.list((j) => ['remind', 'task'].includes(j.kind));
      return { ok: true, text: list.length ? list.map(show).join('\n') : 'nothing scheduled' };
    }
    if (a.action === 'cancel') return scheduler.remove(a.id) ? { ok: true, text: `cancelled #${a.id}` } : { ok: false, error: `no job #${a.id}` };
    if (!['remind', 'task'].includes(a.action)) return { ok: false, error: `unknown action ${a.action}` };
    const t = timing(a);
    if (typeof t === 'string') return { ok: false, error: t };
    const body = a.action === 'remind' ? { text: String(a.text || '') } : { prompt: String(a.prompt || '') };
    if (!body.text && !body.prompt) return { ok: false, error: 'empty' };
    const job = scheduler.add({ kind: a.action, ...t, ...body, repeatName: a.repeat && a.repeat !== 'none' ? a.repeat : undefined });
    return { ok: true, text: `set ${show(job)}` };
  }

  scheduler.on('remind', (job) => router.send(`⏰ ${job.text}`));
  scheduler.on('task', (job) => router.enqueue(() => router.turn(`[Scheduled task #${job.id}, set by the owner earlier. Do it now and report the result:]\n${job.prompt}`)));

  return {
    mcp: { schedule: { command: process.execPath, args: [path.join(HERE, 'mcp.js')], env: { TZ_NAME: config.timezone } } },
    // A reminder only writes to the owner, so it needs no approval. A task (a turn later) is asked once.
    allowed: ['mcp__schedule__remind', 'mcp__schedule__list', 'mcp__schedule__cancel'],
    routes: { '/schedule': api },
    prompt: '## Reminders\nFor "remind me" use mcp__schedule__remind; for something to do or check later use mcp__schedule__task. Times are the owner\'s local time.',
    describers: [(tool, input) => (tool === 'mcp__schedule__task' ? `⏰ Scheduled task (${input.when || `in ${input.in_minutes} min`}${input.repeat && input.repeat !== 'none' ? `, ${input.repeat}` : ''}):\n${String(input.prompt || '').slice(0, 300)}` : null)],
    scheduler,
    api,
    start(r) { router = r; scheduler.start(); },
    stop() { scheduler.stop(); },
  };
}
