// Wall-clock time in a named time zone, with Intl only. Weekdays: 0 = Sunday … 6 = Saturday.
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmts = new Map();
const fmt = (tz) => {
  if (!fmts.has(tz)) {
    fmts.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
  }
  return fmts.get(tz);
};

// { y, mo, d, h, mi, wd } of the moment ms as seen in tz.
export function wall(ms, tz) {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, wd: WEEKDAYS[p.weekday] };
}

// The moment (ms) when the clock in tz shows y-mo-d h:mi.
export function fromWall({ y, mo, d, h = 0, mi = 0 }, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (t) => { const w = wall(t, tz); return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(t / 60_000) * 60_000; };
  const t = guess - offset(guess);
  const again = guess - offset(t);
  return again !== t ? again : t; // a DST change between the guess and the answer
}

export function addDays({ y, mo, d }, n) {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() };
}

// "HH:MM" → { h, mi } or null.
export function parseHM(s = '') {
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/);
  return m && +m[1] <= 23 && +m[2] <= 59 ? { h: +m[1], mi: +m[2] } : null;
}

// "YYYY-MM-DD HH:MM" as wall time in tz → ms, or null.
export function parseLocal(s = '', tz) {
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null; // 2026-02-31 does not exist
  return fromWall({ y, mo, d, h, mi }, tz);
}

const pad = (n) => String(n).padStart(2, '0');
// "2026-11-04 09:30"
export function formatLocal(ms, tz) {
  const w = wall(ms, tz);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}`;
}
