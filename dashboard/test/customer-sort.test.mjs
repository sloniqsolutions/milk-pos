import test from 'node:test';
import assert from 'node:assert/strict';
import { daysSince, daysLabel, localDay, sortCustomers, daysBefore, periodRange } from '../src/customerSort.js';

test('daysBefore steps back across month, year and leap-day boundaries', () => {
  assert.equal(daysBefore('2026-10-07', 0), '2026-10-07');
  assert.equal(daysBefore('2026-10-07', 6), '2026-10-01');
  assert.equal(daysBefore('2026-10-07', 7), '2026-09-30');
  assert.equal(daysBefore('2026-01-02', 2), '2025-12-31');
  assert.equal(daysBefore('2024-03-01', 1), '2024-02-29');
  assert.equal(daysBefore('2026-03-01', 1), '2026-02-28');
  assert.equal(daysBefore('nope', 1), null);
});

test('period ranges are inclusive and end today, like the Reports tab', () => {
  const T = '2026-10-07';
  assert.deepEqual(periodRange('today', T), { from: '2026-10-07', to: '2026-10-07' });
  assert.deepEqual(periodRange('days3', T), { from: '2026-10-05', to: '2026-10-07' });
  assert.deepEqual(periodRange('week', T), { from: '2026-10-01', to: '2026-10-07' });
  assert.deepEqual(periodRange('month', T), { from: '2026-09-08', to: '2026-10-07' });
  assert.equal(periodRange('all', T), null);
});

test('a custom range is used only when both dates are real and in order', () => {
  const T = '2026-10-07';
  assert.deepEqual(periodRange('custom', T, { from: '2026-10-01', to: '2026-10-05' }), { from: '2026-10-01', to: '2026-10-05' });
  assert.deepEqual(periodRange('custom', T, { from: '2026-10-03', to: '2026-10-03' }), { from: '2026-10-03', to: '2026-10-03' });
  assert.equal(periodRange('custom', T, { from: '2026-10-05', to: '2026-10-01' }), null);
  assert.equal(periodRange('custom', T, { from: '2026-10-05', to: '' }), null);
  assert.equal(periodRange('custom', T, {}), null);
});

const TODAY = '2026-10-07';

test('daysSince counts calendar days, not 24-hour blocks', () => {
  assert.equal(daysSince('2026-10-07 00:05:00', TODAY), 0);
  assert.equal(daysSince('2026-10-06 23:50:00', TODAY), 1);
  assert.equal(daysSince('2026-10-06 00:01:00', TODAY), 1);
  assert.equal(daysSince('2026-10-05 16:28:21', TODAY), 2);
  assert.equal(daysSince('2026-09-07', TODAY), 30);
  assert.equal(daysSince('2025-10-07', TODAY), 365);
});

test('daysSince crosses month, year and leap-day boundaries correctly', () => {
  assert.equal(daysSince('2026-09-30', '2026-10-01'), 1);
  assert.equal(daysSince('2025-12-31', '2026-01-01'), 1);
  assert.equal(daysSince('2024-02-28', '2024-03-01'), 2);   // 2024 is a leap year
  assert.equal(daysSince('2025-02-28', '2025-03-01'), 1);
});

test('daysSince reads the date part of a "T" timestamp too', () => {
  assert.equal(daysSince('2026-10-04T10:00:00.000Z', TODAY), 3);
});

test('daysSince is null when there is no usable date', () => {
  assert.equal(daysSince(null, TODAY), null);
  assert.equal(daysSince('', TODAY), null);
  assert.equal(daysSince('not a date', TODAY), null);
});

test('daysLabel', () => {
  assert.equal(daysLabel(null), '—');
  assert.equal(daysLabel(0), 'Today');
  assert.equal(daysLabel(-1), 'Today');
  assert.equal(daysLabel(1), '1 day ago');
  assert.equal(daysLabel(12), '12 days ago');
});

test('localDay is the local calendar day', () => {
  assert.equal(localDay(new Date(2026, 9, 7, 0, 5)), '2026-10-07');
  assert.equal(localDay(new Date(2026, 0, 3, 23, 59)), '2026-01-03');
});

const rows = [
  { group_key: 'a', name: 'Ali',    balance: 500,  total_litres: 10, last_order_at: '2026-10-06 10:00:00' }, // 1
  { group_key: 'b', name: 'Bilal',  balance: 0,    total_litres: 90, last_order_at: '2026-09-07 10:00:00' }, // 30
  { group_key: 'c', name: 'Chand',  balance: 1200, total_litres: 40, last_order_at: null },                  // never
  { group_key: 'd', name: 'Danish', balance: 300,  total_litres: 40, last_order_at: '2026-10-07 09:00:00' }, // 0
  { group_key: 'e', name: 'Eman',   balance: 300,  total_litres: 5,  last_order_at: '2026-09-07 08:00:00' }, // 30
];
const keys = (list) => list.map((r) => r.group_key).join('');

test('longest ago first; never-ordered last; ties by balance then name', () => {
  // 30 days: Eman (300) and Bilal (0) -> Eman first by balance; then 1 day Ali; 0 days Danish; never: Chand
  assert.equal(keys(sortCustomers(rows, 'days_desc', TODAY)), 'ebadc');
});

test('most recent first; never-ordered still last', () => {
  assert.equal(keys(sortCustomers(rows, 'days_asc', TODAY)), 'daebc');
});

test('balance, litres and name sorts', () => {
  assert.equal(keys(sortCustomers(rows, 'balance', TODAY)), 'cadeb');
  assert.equal(keys(sortCustomers(rows, 'litres', TODAY)), 'bcdae');
  assert.equal(keys(sortCustomers(rows, 'name', TODAY)), 'abcde');
});

test('an unknown sort key falls back to balance; input rows are not mutated or changed', () => {
  const snapshot = JSON.stringify(rows);
  assert.equal(keys(sortCustomers(rows, 'nonsense', TODAY)), 'cadeb');
  assert.equal(JSON.stringify(rows), snapshot);
  const out = sortCustomers(rows, 'balance', TODAY);
  assert.equal(out.find((r) => r.group_key === 'a').days, 1);
  assert.equal(out.find((r) => r.group_key === 'c').days, null);
  assert.equal(out.find((r) => r.group_key === 'a').balance, 500);
});
