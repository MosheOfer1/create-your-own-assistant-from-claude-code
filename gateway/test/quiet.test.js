import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quietUntil } from '../src/quiet.js';
import { fromWall } from '../src/time.js';

const TZ = 'Asia/Jerusalem';
// 2026-11-06 is a Friday.
const at = (d, h, mi = 0) => fromWall({ y: 2026, mo: 11, d, h, mi }, TZ);

test('no windows: never quiet', () => {
  assert.equal(quietUntil([], TZ, at(6, 23)), null);
  assert.equal(quietUntil(undefined, TZ, at(6, 23)), null);
});

test('a night window across midnight', () => {
  const night = [{ from: '22:00', to: '07:00' }];
  assert.equal(quietUntil(night, TZ, at(4, 21, 59)), null);
  assert.equal(quietUntil(night, TZ, at(4, 22)), at(5, 7));
  assert.equal(quietUntil(night, TZ, at(5, 3)), at(5, 7));
  assert.equal(quietUntil(night, TZ, at(5, 7)), null);
});

test('Shabbat: Friday evening chains into Saturday, and into the night window', () => {
  const shabbat = [{ days: [5], from: '16:00', to: '24:00' }, { days: [6], from: '00:00', to: '20:30' }];
  assert.equal(quietUntil(shabbat, TZ, at(6, 15)), null);
  assert.equal(quietUntil(shabbat, TZ, at(6, 17)), at(7, 20, 30));
  assert.equal(quietUntil(shabbat, TZ, at(7, 12)), at(7, 20, 30));
  assert.equal(quietUntil(shabbat, TZ, at(5, 17)), null); // a Thursday
  const both = [...shabbat, { from: '22:00', to: '07:00' }];
  assert.equal(quietUntil(both, TZ, at(6, 23)), at(7, 20, 30));
});

test('a bad window is ignored', () => {
  assert.equal(quietUntil([{ from: 'late', to: '07:00' }], TZ, at(6, 23)), null);
});
