/**
 * Formatting helpers.
 *
 * The currency is hardcoded to Rs here. The till reads it from its settings
 * table, but those settings are branch-owned and not yet synced up — when they
 * are, this should read the shop's own symbol rather than assuming.
 */

export function money(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return 'Rs ' + Number(value).toLocaleString('en-PK', { maximumFractionDigits: 0 });
}

export function count(value) {
  if (value == null) return '—';
  return Number(value).toLocaleString('en-PK');
}

/** "12s ago", "4 min ago", "2h 10m ago" — short enough to sit in a badge. */
export function ago(ms) {
  if (ms == null) return 'never';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

/** How long a shift has been open, from the till's local wall-clock string. */
export function duration(openedAt) {
  if (!openedAt) return null;
  // "2026-09-07 14:02:11" — parsed as local time, which is the till's own
  // timezone. Both branches are in one city, so this is safe here; it would
  // not be if the shop ever crossed a timezone.
  const start = new Date(String(openedAt).replace(' ', 'T'));
  if (Number.isNaN(start.getTime())) return null;
  const mins = Math.max(0, Math.round((Date.now() - start.getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Just the clock part of a till timestamp, for "opened 14:02". */
export function clockTime(stamp) {
  if (!stamp) return null;
  const m = /(\d{2}):(\d{2})/.exec(String(stamp));
  return m ? `${m[1]}:${m[2]}` : null;
}

export function timeOfDay(ms) {
  if (ms == null) return null;
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
