import { parseHM, wall } from './time.js';

// Quiet hours: times when the assistant sends nothing on its own (a mail summary, the morning
// brief). Your own reminders still come at the time you set, and answers to you are never held.
// config.quietHours: [{ from: 'HH:MM', to: 'HH:MM', days?: [0..6] }]. days = the day a window
// starts (Sunday = 0), all days when absent. A window may cross midnight; to '24:00' is midnight.
// Shabbat, for example: [{ days: [5], from: '16:00', to: '24:00' }, { days: [6], from: '00:00', to: '20:30' }].

const mins = (s) => (s === '24:00' ? 1440 : (({ h, mi } = parseHM(s) || {}) => (h == null ? null : h * 60 + mi))());

// When the quiet time around `at` ends (ms), or null when it is not quiet now.
export function quietUntil(windows = [], tz, at = Date.now()) {
  if (!windows?.length) return null;
  let end = null;
  // Windows can chain (Friday evening into Saturday): follow them, a few steps at most.
  for (let t = at, step = 0; step < 8; step++) {
    const w = wall(t, tz);
    const m = w.h * 60 + w.mi;
    let next = null;
    for (const q of windows) {
      const f = mins(q.from);
      const e = mins(q.to);
      if (f == null || e == null) continue;
      const on = (d) => !q.days || q.days.includes(d);
      let left = null;
      if (f < e && on(w.wd) && m >= f && m < e) left = e - m;
      else if (f >= e && on(w.wd) && m >= f) left = 1440 - m + e;
      else if (f >= e && on((w.wd + 6) % 7) && m < e) left = e - m;
      if (left != null) next = Math.max(next ?? 0, t + left * 60_000);
    }
    if (next == null) break;
    end = next;
    t = next;
  }
  return end;
}
