import { addDays, fromWall, parseHM, wall } from '../../src/time.js';

// Jobs that run at a time, kept in a store so they survive restarts.
// job: { id, kind, at (ms of the next run), repeat?, ...what its handler reads }.
// repeat: { time: 'HH:MM', days: [0..6] } in the owner's time zone, or { everyMin: n };
// without repeat a job runs once and is removed.
export class Scheduler {
  constructor({ store, tz, now = Date.now, log = console.log }) {
    Object.assign(this, { store, tz, now, log });
    this.handlers = new Map();
  }

  get jobs() { return this.store.get('jobs') || {}; }
  save(jobs) { this.store.set('jobs', jobs); }

  on(kind, handler) { this.handlers.set(kind, handler); return this; }

  // The next run strictly after `after`; null for a one-off job.
  nextRun(repeat, after) {
    if (!repeat) return null;
    if (repeat.everyMin) return after + repeat.everyMin * 60_000;
    const t = parseHM(repeat.time);
    if (!t) return null;
    const today = wall(after, this.tz);
    for (let i = 0; i <= 7; i++) {
      const day = addDays(today, i);
      if (!repeat.days.includes(day.wd)) continue;
      const at = fromWall({ ...day, ...t }, this.tz);
      if (at > after) return at;
    }
    return null;
  }

  add(fields) {
    const id = String(this.store.get('nextJobId') || 1);
    this.store.set('nextJobId', Number(id) + 1);
    return this.upsert(id, fields);
  }

  // Create or replace a job by id (fixed jobs such as a morning brief use their own id).
  upsert(id, fields) {
    const at = fields.at ?? this.nextRun(fields.repeat, this.now());
    if (at == null) throw new Error('the job has no time');
    const job = { createdAt: this.now(), ...fields, id: String(id), at };
    this.save({ ...this.jobs, [job.id]: job });
    return job;
  }

  remove(id) {
    const { [String(id)]: job, ...rest } = this.jobs;
    if (job) this.save(rest);
    return job || null;
  }

  list(filter = () => true) { return Object.values(this.jobs).filter(filter).sort((a, b) => a.at - b.at); }

  // Runs every due job. Each one moves to its next run (or is removed) BEFORE its handler starts,
  // so a crash or a slow handler never runs it twice.
  async tick() {
    const now = this.now();
    const jobs = { ...this.jobs };
    const due = Object.values(jobs).filter((j) => j.at <= now);
    if (!due.length) return;
    for (const job of due) {
      const next = this.nextRun(job.repeat, now);
      if (next == null) delete jobs[job.id]; else jobs[job.id] = { ...job, at: next, lastRun: now };
    }
    this.save(jobs);
    await Promise.all(due.map(async (job) => {
      const h = this.handlers.get(job.kind);
      if (!h) return this.log(`scheduler: no handler for ${job.kind} (job ${job.id})`);
      try { await h(job, { late: now - job.at }); } catch (e) { this.log(`scheduler: job ${job.id} failed: ${e.stack || e}`); }
    }));
  }

  start(everyMs = 30_000) {
    const loop = () => this.tick().catch((e) => this.log(`scheduler: ${e.stack || e}`));
    this.timer = setInterval(loop, everyMs);
    this.timer.unref?.();
    setTimeout(loop, 2000).unref?.();
    return this;
  }

  stop() { clearInterval(this.timer); }
}
