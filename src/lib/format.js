// Time-zone aware date keys and display formatting.

const DAY_MS = 86400000;

/** "+0800", "+08:00", "GMT+08:00", "-0330" → minutes east of UTC; null when unknown. */
export function tzOffsetMinutes(tz) {
  if (tz == null || tz === '') return null;
  if (typeof tz === 'number' && Number.isFinite(tz)) return tz;
  const m = /([+-])(\d{1,2}):?(\d{2})?/.exec(String(tz));
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3] || 0);
  return m[1] === '-' ? -minutes : minutes;
}

/** Offset to use when a record carries no time zone: the viewer's own, at that instant. */
export function fallbackOffset(ms) {
  return -new Date(ms).getTimezoneOffset();
}

function shifted(ms, offsetMin) {
  const off = offsetMin == null ? fallbackOffset(ms) : offsetMin;
  return new Date(ms + off * 60000);
}

/** Local calendar date "YYYY-MM-DD" of an instant in the given offset. */
export function localDateKey(ms, offsetMin) {
  return shifted(ms, offsetMin).toISOString().slice(0, 10);
}

/** Local hour 0–23 of an instant in the given offset. */
export function localHour(ms, offsetMin) {
  return shifted(ms, offsetMin).getUTCHours();
}

/** Minutes since local midnight. */
export function localMinuteOfDay(ms, offsetMin) {
  const d = shifted(ms, offsetMin);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Epoch ms of local midnight for the day containing `ms`. */
export function localMidnight(ms, offsetMin) {
  const off = offsetMin == null ? fallbackOffset(ms) : offsetMin;
  const local = ms + off * 60000;
  return local - (((local % DAY_MS) + DAY_MS) % DAY_MS) - off * 60000;
}

/** 20250226 or "20250226" → "2025-02-26"; null when malformed. */
export function recordDayKey(day) {
  const s = String(day ?? '');
  if (!/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export function monthKey(dateKey) {
  return dateKey.slice(0, 7);
}

/** Add `n` days to a "YYYY-MM-DD" key. */
export function addDays(dateKey, n) {
  const d = new Date(dateKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b (both "YYYY-MM-DD"). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(dateKey) {
  return (new Date(dateKey + 'T00:00:00Z').getUTCDay() + 6) % 7;
}

/** Monday of the ISO week containing the date. */
export function weekStart(dateKey) {
  return addDays(dateKey, -weekdayIndex(dateKey));
}

export function todayKey(now = Date.now()) {
  return localDateKey(now, null);
}

// ---------------------------------------------------------------- display

const pad2 = (n) => String(n).padStart(2, '0');

/** Seconds → "1:02:03" or "2:03". */
export function fmtDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}

/** Seconds → "1 h 05 min" / "42 min". */
export function fmtHoursMinutes(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return `${h} h ${pad2(m)} min`;
}

/** Minutes → "7 h 32" (sleep style). */
export function fmtSleep(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return '—';
  const m = Math.round(minutes);
  return `${Math.floor(m / 60)} h ${pad2(m % 60)}`;
}

/** Seconds per km → "5:12". */
export function fmtPace(secPerKm) {
  if (secPerKm == null || !Number.isFinite(secPerKm) || secPerKm <= 0 || secPerKm > 3600) return '—';
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/** Metres → "12.34" km string (no unit). */
export function fmtKm(metres, digits = 2) {
  if (metres == null || !Number.isFinite(metres)) return '—';
  return (metres / 1000).toFixed(digits);
}

/** m/s → km/h string. */
export function fmtSpeed(mps, digits = 1) {
  if (mps == null || !Number.isFinite(mps)) return '—';
  return (mps * 3.6).toFixed(digits);
}

const nf0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export function fmtInt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return nf0.format(n);
}

export function fmtOne(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return nf1.format(n);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function monthName(i) {
  return MONTHS[i];
}

export function weekdayName(i) {
  return WEEKDAYS[i];
}

/** "2025-03-09" → "9 Mar 2025" (or "9 Mar" when short). */
export function fmtDate(dateKey, { short = false, weekday = false } = {}) {
  if (!dateKey) return '—';
  const [y, m, d] = dateKey.split('-').map(Number);
  const wd = weekday ? WEEKDAYS[weekdayIndex(dateKey)] + ' ' : '';
  return short ? `${wd}${d} ${MONTHS[m - 1]}` : `${wd}${d} ${MONTHS[m - 1]} ${y}`;
}

/** Local clock time "HH:MM" of an instant. */
export function fmtClock(ms, offsetMin) {
  if (ms == null) return '—';
  const d = shifted(ms, offsetMin);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** Minutes since midnight (may exceed 1440 or be negative) → "HH:MM". */
export function fmtMinuteOfDay(min) {
  if (min == null || !Number.isFinite(min)) return '—';
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}
