import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, formatLocal, fromWall, parseHM, parseLocal, wall } from '../src/time.js';

const JLM = 'Asia/Jerusalem';
const NY = 'America/New_York';

test('wall: the same moment shows different clocks in different zones', () => {
  const ms = Date.UTC(2026, 0, 15, 12, 30); // winter: Jerusalem UTC+2, New York UTC-5
  assert.deepEqual(wall(ms, 'UTC'), { y: 2026, mo: 1, d: 15, h: 12, mi: 30, wd: 4 });
  assert.deepEqual(wall(ms, JLM), { y: 2026, mo: 1, d: 15, h: 14, mi: 30, wd: 4 });
  assert.deepEqual(wall(ms, NY), { y: 2026, mo: 1, d: 15, h: 7, mi: 30, wd: 4 });
});

test('wall: midnight is hour 0 (h23), and the weekday follows the zone', () => {
  const ms = Date.UTC(2026, 0, 15, 22, 0); // Thursday 22:00 UTC = Friday 00:00 in Jerusalem
  const w = wall(ms, JLM);
  assert.equal(w.h, 0);
  assert.equal(w.wd, 5);
});

test('fromWall: round trip in both zones over a normal day', () => {
  for (const tz of [JLM, NY, 'UTC']) {
    for (const h of [0, 3, 12, 23]) {
      const ms = fromWall({ y: 2026, mo: 6, d: 10, h, mi: 15 }, tz);
      assert.deepEqual(wall(ms, tz), { y: 2026, mo: 6, d: 10, h, mi: 15, wd: 3 }, `${tz} ${h}`);
    }
  }
});

test('fromWall: known offsets in summer and winter', () => {
  assert.equal(fromWall({ y: 2026, mo: 7, d: 1, h: 12 }, JLM), Date.UTC(2026, 6, 1, 9)); // UTC+3
  assert.equal(fromWall({ y: 2026, mo: 1, d: 1, h: 12 }, JLM), Date.UTC(2026, 0, 1, 10)); // UTC+2
  assert.equal(fromWall({ y: 2026, mo: 7, d: 1, h: 12 }, NY), Date.UTC(2026, 6, 1, 16)); // UTC-4
  assert.equal(fromWall({ y: 2026, mo: 1, d: 1, h: 12 }, NY), Date.UTC(2026, 0, 1, 17)); // UTC-5
});

// New York: spring forward 2026-03-08 (02:00 -> 03:00), fall back 2026-11-01 (02:00 -> 01:00).
// Jerusalem: spring forward 2026-03-27 (02:00 -> 03:00), fall back 2026-10-25 (02:00 -> 01:00).
test('fromWall: round trip for every existing hour of a DST day', () => {
  const cases = [[NY, 3, 8, [2]], [NY, 11, 1, []], [JLM, 3, 27, [2]], [JLM, 10, 25, []]];
  for (const [tz, mo, d, missing] of cases) {
    for (let h = 0; h < 24; h++) {
      if (missing.includes(h)) continue; // this hour does not exist that day
      for (const mi of [0, 30]) {
        const ms = fromWall({ y: 2026, mo, d, h, mi }, tz);
        const w = wall(ms, tz);
        assert.deepEqual([w.mo, w.d, w.h, w.mi], [mo, d, h, mi], `${tz} ${mo}/${d} ${h}:${mi}`);
      }
    }
  }
});

test('fromWall: days around a DST change keep their wall time (09:00 every day)', () => {
  let day = { y: 2026, mo: 3, d: 6 };
  const times = [];
  for (let i = 0; i < 5; i++) {
    times.push(fromWall({ ...day, h: 9 }, NY));
    day = addDays(day, 1);
  }
  const gaps = times.slice(1).map((t, i) => (t - times[i]) / 3600_000);
  assert.deepEqual(gaps, [24, 23, 24, 24]); // the day of 03-08 is 23 hours long
});

test('fromWall: the skipped hour lands on a real moment next to it', () => {
  const ms = fromWall({ y: 2026, mo: 3, d: 8, h: 2, mi: 30 }, NY);
  const w = wall(ms, NY);
  assert.equal(w.d, 8);
  assert.ok(w.h === 1 || w.h === 3, `got hour ${w.h}`);
});

test('fromWall: the repeated hour gives one of its two moments', () => {
  const ms = fromWall({ y: 2026, mo: 11, d: 1, h: 1, mi: 30 }, NY);
  const w = wall(ms, NY);
  assert.deepEqual([w.d, w.h, w.mi], [1, 1, 30]);
});

test('addDays: crosses month and year, returns the weekday', () => {
  assert.deepEqual(addDays({ y: 2026, mo: 12, d: 31 }, 1), { y: 2027, mo: 1, d: 1, wd: 5 });
  assert.deepEqual(addDays({ y: 2026, mo: 3, d: 1 }, -1), { y: 2026, mo: 2, d: 28, wd: 6 });
});

test('parseHM: valid and invalid', () => {
  assert.deepEqual(parseHM('09:05'), { h: 9, mi: 5 });
  assert.deepEqual(parseHM(' 9:05 '), { h: 9, mi: 5 });
  assert.deepEqual(parseHM('00:00'), { h: 0, mi: 0 });
  assert.deepEqual(parseHM('23:59'), { h: 23, mi: 59 });
  for (const bad of ['24:00', '12:60', '9', '12:5', 'ab:cd', '', '12:30:00', undefined, null]) {
    assert.equal(parseHM(bad), null, String(bad));
  }
});

test('parseLocal: valid forms', () => {
  assert.equal(parseLocal('2026-11-04 09:30', 'UTC'), Date.UTC(2026, 10, 4, 9, 30));
  assert.equal(parseLocal('2026-11-04T09:30', 'UTC'), Date.UTC(2026, 10, 4, 9, 30));
  assert.equal(parseLocal('2026-11-04 9:30:15', 'UTC'), Date.UTC(2026, 10, 4, 9, 30));
  assert.equal(parseLocal('2026-07-01 12:00', JLM), Date.UTC(2026, 6, 1, 9));
});

test('parseLocal: invalid input gives null', () => {
  for (const bad of ['', 'tomorrow', '2026-13-01 10:00', '2026-00-10 10:00', '2026-01-32 10:00', '2026-01-10 24:00', '2026-01-10 10:60', '2026-01-10', '04/11/2026 10:00']) {
    assert.equal(parseLocal(bad, 'UTC'), null, bad);
  }
});

test('parseLocal: a day that does not exist is refused', () => {
  assert.equal(parseLocal('2026-02-31 10:00', 'UTC'), null);
});

test('formatLocal: pads and uses the zone', () => {
  assert.equal(formatLocal(Date.UTC(2026, 0, 5, 7, 5), 'UTC'), '2026-01-05 07:05');
  assert.equal(formatLocal(Date.UTC(2026, 0, 5, 7, 5), JLM), '2026-01-05 09:05');
  const ms = parseLocal('2026-11-04 09:30', NY);
  assert.equal(formatLocal(ms, NY), '2026-11-04 09:30');
});
