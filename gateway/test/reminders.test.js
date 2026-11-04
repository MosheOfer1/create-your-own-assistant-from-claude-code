import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { hooksOf } from '../src/gateway.js';
import { MemoryState } from '../src/state.js';
import reminders from '../modules/reminders/index.js';
import { Scheduler } from '../modules/reminders/scheduler.js';

const tmps = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-')); tmps.push(d); return d; };
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 4, 10, 0); // Wednesday 2026-11-04 10:00 UTC

function sched({ tz = 'UTC', now = NOW } = {}) {
  const clock = { t: now };
  const logs = [];
  const s = new Scheduler({ store: new MemoryState(), tz, now: () => clock.t, log: (m) => logs.push(m) });
  return { s, clock, logs };
}

describe('Scheduler store', () => {
  test('add gives increasing string ids and keeps fields', () => {
    const { s } = sched();
    const a = s.add({ kind: 'remind', at: NOW + MIN, text: 'a' });
    const b = s.add({ kind: 'remind', at: NOW + 2 * MIN, text: 'b' });
    assert.equal(a.id, '1');
    assert.equal(b.id, '2');
    assert.equal(a.createdAt, NOW);
    assert.equal(s.jobs['1'].text, 'a');
  });

  test('add without at and without repeat throws', () => {
    const { s } = sched();
    assert.throws(() => s.add({ kind: 'remind' }), /no time/);
  });

  test('add with repeat and no at computes the first run', () => {
    const { s } = sched();
    const j = s.add({ kind: 'x', repeat: { time: '12:00', days: [0, 1, 2, 3, 4, 5, 6] } });
    assert.equal(j.at, Date.UTC(2026, 10, 4, 12, 0));
  });

  test('upsert replaces a job with the same id', () => {
    const { s } = sched();
    s.upsert('brief', { kind: 'brief', at: NOW + MIN });
    s.upsert('brief', { kind: 'brief', at: NOW + 5 * MIN });
    assert.equal(s.list().length, 1);
    assert.equal(s.jobs.brief.at, NOW + 5 * MIN);
  });

  test('remove returns the job, or null for an unknown id; numbers work as ids', () => {
    const { s } = sched();
    const j = s.add({ kind: 'x', at: NOW + MIN });
    assert.equal(s.remove(99), null);
    assert.equal(s.remove(Number(j.id)).id, j.id);
    assert.equal(s.list().length, 0);
  });

  test('list is sorted by time and can filter', () => {
    const { s } = sched();
    s.add({ kind: 'a', at: NOW + 3 * MIN });
    s.add({ kind: 'b', at: NOW + MIN });
    s.add({ kind: 'a', at: NOW + 2 * MIN });
    assert.deepEqual(s.list().map((j) => j.at - NOW), [MIN, 2 * MIN, 3 * MIN]);
    assert.equal(s.list((j) => j.kind === 'a').length, 2);
  });
});

describe('Scheduler nextRun', () => {
  const ALL = [0, 1, 2, 3, 4, 5, 6];
  test('no repeat gives null', () => assert.equal(sched().s.nextRun(null, NOW), null));

  test('daily: later today if the time is ahead, else tomorrow, always strictly after', () => {
    const { s } = sched();
    assert.equal(s.nextRun({ time: '12:00', days: ALL }, NOW), Date.UTC(2026, 10, 4, 12));
    assert.equal(s.nextRun({ time: '09:00', days: ALL }, NOW), Date.UTC(2026, 10, 5, 9));
    assert.equal(s.nextRun({ time: '10:00', days: ALL }, NOW), Date.UTC(2026, 10, 5, 10));
  });

  test('specific days: Wed 2026-11-04 → next Friday and next Monday', () => {
    const { s } = sched();
    assert.equal(s.nextRun({ time: '09:00', days: [5] }, NOW), Date.UTC(2026, 10, 6, 9));
    assert.equal(s.nextRun({ time: '09:00', days: [1] }, NOW), Date.UTC(2026, 10, 9, 9));
    assert.equal(s.nextRun({ time: '09:00', days: [3] }, NOW), Date.UTC(2026, 10, 11, 9)); // same weekday, time passed
  });

  test('everyMin adds minutes; bad time or empty days gives null', () => {
    const { s } = sched();
    assert.equal(s.nextRun({ everyMin: 15 }, NOW), NOW + 15 * MIN);
    assert.equal(s.nextRun({ time: '99:99', days: ALL }, NOW), null);
    assert.equal(s.nextRun({ time: '09:00', days: [] }, NOW), null);
  });

  test('daily in Jerusalem follows the zone and the DST change', () => {
    const { s } = sched({ tz: 'Asia/Jerusalem' });
    const first = s.nextRun({ time: '09:00', days: ALL }, Date.UTC(2026, 9, 23, 12));
    assert.equal(first, Date.UTC(2026, 9, 24, 6)); // 09:00 on 10-24 is UTC+3
    assert.equal(s.nextRun({ time: '09:00', days: ALL }, first), Date.UTC(2026, 9, 25, 7)); // 10-25 09:00 is UTC+2
  });
});

describe('Scheduler tick', () => {
  test('a due one-off runs once and is removed', async () => {
    const { s, clock } = sched();
    const runs = [];
    s.on('x', (j, info) => runs.push([j.id, info.late]));
    s.add({ kind: 'x', at: NOW + MIN });
    await s.tick();
    assert.equal(runs.length, 0); // not due yet
    clock.t = NOW + 3 * MIN;
    await s.tick();
    await s.tick();
    assert.deepEqual(runs, [['1', 2 * MIN]]);
    assert.equal(s.list().length, 0);
  });

  test('a repeating job moves forward BEFORE its handler runs', async () => {
    const { s, clock } = sched();
    let seen = null;
    s.on('x', () => { seen = s.jobs['1']; });
    s.add({ kind: 'x', at: NOW + MIN, repeat: { everyMin: 10 } });
    clock.t = NOW + MIN;
    await s.tick();
    assert.equal(seen.at, NOW + 11 * MIN);
    assert.equal(seen.lastRun, NOW + MIN);
  });

  test('a one-off is already removed while its handler runs', async () => {
    const { s, clock } = sched();
    let during = null;
    s.on('x', () => { during = s.list().length; });
    s.add({ kind: 'x', at: NOW });
    clock.t = NOW;
    await s.tick();
    assert.equal(during, 0);
  });

  test('a throwing handler does not stop the others, and is logged', async () => {
    const { s, clock, logs } = sched();
    const ran = [];
    s.on('bad', () => { throw new Error('boom'); });
    s.on('good', (j) => ran.push(j.id));
    s.add({ kind: 'bad', at: NOW });
    s.add({ kind: 'good', at: NOW });
    s.add({ kind: 'good', at: NOW });
    clock.t = NOW + 1;
    await s.tick();
    assert.deepEqual(ran.sort(), ['2', '3']);
    assert.ok(logs.some((l) => /job 1 failed/.test(l) && /boom/.test(l)));
    assert.equal(s.list().length, 0);
  });

  test('an async handler that rejects is logged too', async () => {
    const { s, clock, logs } = sched();
    s.on('bad', async () => { throw new Error('late boom'); });
    s.add({ kind: 'bad', at: NOW });
    clock.t = NOW;
    await s.tick();
    assert.ok(logs.some((l) => /late boom/.test(l)));
  });

  test('a job without a handler is logged and removed', async () => {
    const { s, clock, logs } = sched();
    s.add({ kind: 'ghost', at: NOW });
    clock.t = NOW;
    await s.tick();
    assert.ok(logs.some((l) => /no handler for ghost/.test(l)));
    assert.equal(s.list().length, 0);
  });
});

describe('reminders module', () => {
  function setup(extra = {}) {
    const dir = tmp();
    const mod = reminders({ dataDir: dir, agentCwd: dir, timezone: 'UTC', language: 'en', ...extra });
    mod.scheduler.now = () => NOW;
    const router = {
      sent: [], jobs: [], turns: [],
      async send(t) { this.sent.push(t); },
      enqueue(job) { this.jobs.push(job); return job(); },
      async turn(t) { this.turns.push(t); },
    };
    return { mod, router, dir };
  }

  test('remind with in_minutes', async () => {
    const { mod } = setup();
    const r = await mod.api({ action: 'remind', text: 'tea', in_minutes: 30 });
    assert.equal(r.ok, true);
    assert.match(r.text, /^set #1 2026-11-04 10:30 tea$/);
    assert.equal(mod.scheduler.jobs['1'].at, NOW + 30 * MIN);
  });

  test('remind with when (local time)', async () => {
    const { mod } = setup();
    const r = await mod.api({ action: 'remind', text: 'call', when: '2026-11-05 08:15' });
    assert.equal(r.ok, true);
    assert.equal(mod.scheduler.jobs['1'].at, Date.UTC(2026, 10, 5, 8, 15));
  });

  test('past time, bad when and missing time are refused', async () => {
    const { mod } = setup();
    assert.deepEqual(await mod.api({ action: 'remind', text: 'x', when: '2026-11-04 08:00' }), { ok: false, error: 'that time is in the past' });
    assert.match((await mod.api({ action: 'remind', text: 'x', when: 'tomorrow morning' })).error, /give `when`/);
    assert.match((await mod.api({ action: 'remind', text: 'x' })).error, /give `when`/);
    assert.match((await mod.api({ action: 'remind', text: 'x', in_minutes: 'soon' })).error, /give `when`/);
    assert.equal(mod.scheduler.list().length, 0);
  });

  test('a time less than a minute in the past still counts (grace)', async () => {
    const { mod } = setup();
    assert.equal((await mod.api({ action: 'remind', text: 'x', in_minutes: -0.5 })).ok, true);
  });

  test('empty text is refused', async () => {
    const { mod } = setup();
    assert.deepEqual(await mod.api({ action: 'remind', text: '', in_minutes: 5 }), { ok: false, error: 'empty' });
  });

  test('repeat daily, workdays, weekly', async () => {
    const { mod } = setup();
    await mod.api({ action: 'remind', text: 'd', when: '2026-11-06 09:00', repeat: 'daily' }); // Friday
    await mod.api({ action: 'remind', text: 'w', when: '2026-11-06 09:00', repeat: 'workdays' });
    await mod.api({ action: 'remind', text: 'k', when: '2026-11-06 09:00', repeat: 'weekly' });
    const j = mod.scheduler.jobs;
    assert.deepEqual(j['1'].repeat, { time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] });
    assert.deepEqual(j['2'].repeat, { time: '09:00', days: [1, 2, 3, 4, 5] });
    assert.deepEqual(j['3'].repeat, { time: '09:00', days: [5] });
    assert.equal(j['3'].repeatName, 'weekly');
  });

  test('workdays honours the workDays option (Sunday-Thursday)', async () => {
    const { mod } = setup({ workDays: [0, 1, 2, 3, 4] });
    await mod.api({ action: 'remind', text: 'w', when: '2026-11-06 09:00', repeat: 'workdays' });
    assert.deepEqual(mod.scheduler.jobs['1'].repeat.days, [0, 1, 2, 3, 4]);
  });

  test('repeat none is a one-off; an unknown repeat is refused', async () => {
    const { mod } = setup();
    await mod.api({ action: 'remind', text: 'n', in_minutes: 5, repeat: 'none' });
    assert.equal(mod.scheduler.jobs['1'].repeat, undefined);
    assert.deepEqual(await mod.api({ action: 'remind', text: 'x', in_minutes: 5, repeat: 'monthly' }), { ok: false, error: 'unknown repeat monthly' });
  });

  test('list shows reminders and tasks; cancel removes one', async () => {
    const { mod } = setup();
    assert.equal((await mod.api({ action: 'list' })).text, 'nothing scheduled');
    await mod.api({ action: 'remind', text: 'tea', in_minutes: 5, repeat: 'daily' });
    await mod.api({ action: 'task', prompt: 'check the news', in_minutes: 60 });
    mod.scheduler.add({ kind: 'other', at: NOW + MIN, text: 'hidden' });
    const list = (await mod.api({ action: 'list' })).text.split('\n');
    assert.equal(list.length, 2);
    assert.match(list[0], /^#1 .*\(daily\) tea$/);
    assert.match(list[1], /^#2 .*\[task\] check the news$/);
    assert.deepEqual(await mod.api({ action: 'cancel', id: '1' }), { ok: true, text: 'cancelled #1' });
    assert.deepEqual(await mod.api({ action: 'cancel', id: '1' }), { ok: false, error: 'no job #1' });
  });

  test('unknown action and empty task are refused', async () => {
    const { mod } = setup();
    assert.match((await mod.api({ action: 'dance' })).error, /unknown action dance/);
    assert.deepEqual(await mod.api({ action: 'task', in_minutes: 5 }), { ok: false, error: 'empty' });
  });

  test('a due reminder is sent as "⏰ text"; a task enqueues a turn with the prompt', async () => {
    const { mod, router } = setup();
    mod.start(router);
    mod.stop(); // only the handlers are needed, not the 30 s timer
    await mod.api({ action: 'remind', text: 'tea', in_minutes: 1 });
    await mod.api({ action: 'task', prompt: 'summarise mail', in_minutes: 1 });
    mod.scheduler.now = () => NOW + 2 * MIN;
    await mod.scheduler.tick();
    assert.deepEqual(router.sent, ['⏰ tea']);
    assert.equal(router.jobs.length, 1);
    assert.match(router.turns[0], /^\[Scheduled task #2, .*\]\nsummarise mail$/);
    assert.equal(mod.scheduler.list().length, 0);
  });

  test('jobs persist in dataDir/jobs.json across a restart', async () => {
    const { mod, dir } = setup();
    await mod.api({ action: 'remind', text: 'keep', in_minutes: 10 });
    const again = reminders({ dataDir: dir, agentCwd: dir, timezone: 'UTC', language: 'en' });
    assert.equal(again.scheduler.list()[0].text, 'keep');
  });

  test('allowed has remind/list/cancel and NOT task', () => {
    const { mod } = setup();
    assert.deepEqual([...mod.allowed].sort(), ['mcp__schedule__cancel', 'mcp__schedule__list', 'mcp__schedule__remind']);
    assert.ok(!mod.allowed.includes('mcp__schedule__task'));
  });

  test('describer shows a task and ignores other tools (also through hooksOf)', () => {
    const { mod } = setup();
    const [d] = mod.describers;
    assert.equal(d('mcp__schedule__remind', {}), null);
    assert.equal(d('Bash', {}), null);
    assert.equal(d('mcp__schedule__task', { prompt: 'p', when: '2026-11-05 08:00' }), '⏰ Scheduled task (2026-11-05 08:00):\np');
    assert.equal(d('mcp__schedule__task', { prompt: 'p', in_minutes: 5, repeat: 'daily' }), '⏰ Scheduled task (in 5 min, daily):\np');
    assert.match(d('mcp__schedule__task', { prompt: 'p'.repeat(500), in_minutes: 5, repeat: 'none' }), /^⏰ Scheduled task \(in 5 min\):\np{300}$/);
    assert.equal(hooksOf([mod]).describers.length, 1);
  });
});
