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
    name: (a, b) => byName(a, b) || byBalance(a, b),
  };
  return withDays.sort(comparators[sortKey] || comparators.balance);
}
