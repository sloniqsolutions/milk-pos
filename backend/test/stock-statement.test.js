// Run:  node --test backend/test/*.test.js      (plain Node: nothing here touches the database)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildStatement, round4 } = require('../db/stock-statement');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const row = (date, extra = {}) => ({
  date, ingredient_id: 1, name: 'Milk', unit: 'Litre',
  sold: 0, restocked: 0, removed: 0, converted: 0, waste: 0, day_delta: 0, ...extra,
});

test('the till and cloud statement helpers are identical', () => {
  assert.equal(read('backend/db/stock-statement.js').replace(/\r\n/g, '\n'), read('cloud/db/stock-statement.js').replace(/\r\n/g, '\n'));
});

test('every row adds up, and each Opening is the previous Closing', () => {
  const days = [
    row('2026-09-19', { restocked: 420, day_delta: 420 }),
    row('2026-09-20', { sold: 100.5, waste: 2, removed: 3, converted: -10, day_delta: -115.5 }),
    row('2026-09-22', { sold: 5, day_delta: -5 }),
  ];
  const out = buildStatement(days, { 1: 0 }, 4);
  let prev = null;
  for (const r of out) {
    assert.ok(Math.abs(r.opening_balance + r.restocked + r.converted - r.sold - r.waste - r.removed - r.closing_balance) < 1e-9);
    if (prev) assert.equal(r.opening_balance, prev.closing_balance);
    prev = r;
  }
  assert.equal(out[2].closing_balance, 299.5);
});

test('Opening is everything before the range, and nothing is clamped or plugged', () => {
  const out = buildStatement([row('2026-09-19', { sold: 50, day_delta: -50 })], { 1: 20 }, 1);
  assert.equal(out[0].opening_balance, 20);
  assert.equal(out[0].closing_balance, -30);            // shown as it is, never floored to 0
  assert.equal(out[0].days_remaining, null);            // no stock left to last
  assert.deepEqual(Object.keys(out[0]).filter((k) => /other|adjust|estimat|unexplain/i.test(k)), []);
});

test('floating point dust does not leak into a figure', () => {
  const out = buildStatement([row('2026-09-19', { sold: 0.1 + 0.2, day_delta: -(0.1 + 0.2) })], { 1: 1 }, 1);
  assert.equal(out[0].sold, 0.3);
  assert.equal(out[0].closing_balance, 0.7);
  assert.equal(round4(66.789), 66.789);
});

test('stock lasts about N days comes from the range average', () => {
  const out = buildStatement([row('2026-09-19', { sold: 20, day_delta: -20 })], { 1: 120 }, 2); // 10/day, 100 left
  assert.equal(out[0].days_remaining, 10);
});

test('the estimate path and the filler column are gone from the code', () => {
  for (const f of ['backend/db/derived-usage.js', 'cloud/db/derived-usage.js']) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', '..', f)), false, f);
  }
  for (const f of ['backend/routes/reports.js', 'cloud/routes/reports.js', 'backend/db/stock-statement.js', 'frontend/src/components/StockMovementTable.jsx']) {
    const src = read(f);
    assert.doesNotMatch(src, /unloggedSold|withStatement|closingLookup|adjustment|Unexplained|estimated/i, f);
  }
  const table = read('frontend/src/components/StockMovementTable.jsx');
  assert.doesNotMatch(table, />\s*Other\s*</);
  assert.match(table, /Opening \+ Restocked \+\/- Converted - Sold - Waste - Removed = Closing/);
});
