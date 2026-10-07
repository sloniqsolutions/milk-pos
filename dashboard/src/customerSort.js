/**
 * Days-since-last-order and the sort choices for the Customers tab.
 *
 * Display only: it reorders and annotates the rows the cloud already returned and
 * changes nothing about them.
 *
 * `last_order_at` is the till's own wall-clock text ("2026-10-05 16:28:21"), pushed by the
 * till as that customer's most recent completed credit order. A "day" here is a calendar
 * day, not 24 hours: an order at 23:50 last night is 1 day ago at 00:10 this morning.
 */

const DAY_MS = 86400000;

/** Calendar days from `last` ("YYYY-MM-DD..." text) to `today` ("YYYY-MM-DD"), or null if there is no usable date. */
export function daysSince(last, today) {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(last || ''));
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(today || ''));
  if (!a || !b) return null;
  // Date.UTC on both sides, so a daylight-saving change can never make a day 23 or 25 hours.
  const from = Date.UTC(+a[1], +a[2] - 1, +a[3]);
  const to = Date.UTC(+b[1], +b[2] - 1, +b[3]);
  return Math.round((to - from) / DAY_MS);
}

/** The shop's own calendar day as YYYY-MM-DD (the browser's local day, not UTC's). */
export function localDay(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The calendar day `n` days before `day` (YYYY-MM-DD), by plain date arithmetic. */
export function daysBefore(day, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] - n));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export const PERIODS = [
  { key: 'all', label: 'All' },
  { key: 'today', label: 'Today' },
  { key: 'days3', label: '3 Days' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'custom', label: 'Custom' },
];

/**
 * The inclusive from/to for a period, ending today — the same convention as the Reports tab
 * (a "week" is today and the six days before it). null for "All", and for a custom range
 * that is incomplete or backwards, so nothing is asked of the cloud until it makes sense.
 */
export function periodRange(key, today, custom = {}) {
  switch (key) {
    case 'today': return { from: today, to: today };
    case 'days3': return { from: daysBefore(today, 2), to: today };
    case 'week': return { from: daysBefore(today, 6), to: today };
    case 'month': return { from: daysBefore(today, 29), to: today };
    case 'custom': {
      const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
      if (!ok(custom.from) || !ok(custom.to) || custom.from > custom.to) return null;
      return { from: custom.from, to: custom.to };
    }
    default: return null;
  }
}

/** "Today", "1 day ago", "12 days ago" — or an em dash when there has never been an order. */
export function daysLabel(days) {
  if (days == null) return '—';
  if (days <= 0) return 'Today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

export const SORTS = [
  { key: 'balance', label: 'Balance: highest first' },
  { key: 'days_desc', label: 'Last order: longest ago first' },
  { key: 'days_asc', label: 'Last order: most recent first' },
  { key: 'litres', label: 'Litres: highest first' },
  { key: 'name', label: 'Name: A to Z' },
];

/** Extra sorts that only mean something while a period is chosen. */
export const PERIOD_SORTS = [
  { key: 'credited', label: 'Credited: highest first' },
  { key: 'paid', label: 'Paid: highest first' },
];

/**
 * Customers who did something in the period — had a credit order or paid something — shaped for the
 * same table: credited / paid / balance / last order are the PERIOD's figures (balance is as it
 * stood at the end of the period). Needs the fields the cloud adds when asked for a period.
 */
export function periodView(rows) {
  return rows
    .filter((r) => (Number(r.period_orders) || 0) > 0 || (Number(r.period_payments) || 0) > 0)
    .map((r) => ({
      ...r,
      total_credited: Number(r.period_credited) || 0,
      total_paid: Number(r.period_paid) || 0,
      balance: Number(r.closing_balance) || 0,
      last_order_at: r.period_last_order_at || null,
    }));
}

/** The strip above the table for a period, over EVERY customer the cloud returned. */
export function periodTotals(rows) {
  const round2 = (n) => Math.round(n * 100) / 100;
  const sum = (f) => round2(rows.reduce((n, r) => n + (Number(f(r)) || 0), 0));
  return {
    active: periodView(rows).length,
    credited: sum((r) => r.period_credited),
    paid: sum((r) => r.period_paid),
    outstanding: sum((r) => r.closing_balance),
    owing: rows.filter((r) => (Number(r.closing_balance) || 0) > 0).length,
  };
}

const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
const byBalance = (a, b) => (Number(b.balance) || 0) - (Number(a.balance) || 0);

/**
 * A new, sorted array of `{ ...row, days }`. Never mutates `rows`.
 * Customers who have never ordered have days = null and always go last in the two
 * "last order" sorts, whichever direction — they have no date to rank by.
 * Ties fall back to balance (highest first), then name, so the order is stable.
 */
export function sortCustomers(rows, sortKey, today) {
  const withDays = rows.map((r) => ({ ...r, days: daysSince(r.last_order_at, today) }));
  const tie = (a, b) => byBalance(a, b) || byName(a, b);

  const daysSort = (dir) => (a, b) => {
    if (a.days == null && b.days == null) return tie(a, b);
    if (a.days == null) return 1;
    if (b.days == null) return -1;
    return dir * (a.days - b.days) || tie(a, b);
  };

  const comparators = {
    balance: (a, b) => byBalance(a, b) || byName(a, b),
    days_desc: daysSort(-1),
    days_asc: daysSort(1),
    litres: (a, b) => (Number(b.total_litres) || 0) - (Number(a.total_litres) || 0) || tie(a, b),
    credited: (a, b) => (Number(b.total_credited) || 0) - (Number(a.total_credited) || 0) || tie(a, b),
    paid: (a, b) => (Number(b.total_paid) || 0) - (Number(a.total_paid) || 0) || tie(a, b),
    name: (a, b) => byName(a, b) || byBalance(a, b),
  };
  return withDays.sort(comparators[sortKey] || comparators.balance);
}
