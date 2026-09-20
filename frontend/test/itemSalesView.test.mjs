// Run:  node --test frontend/test
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLineItems, filterLineItems, hasLineCategoryData, orderKeyOf } from '../src/lib/itemSalesView.js';

let n = 0;
const line = (group, price, quantity, amount, extra = {}) => ({
  order_id: extra.order_id ?? ++n, item_name: 'x', category_group: group,
  unit_price: price, quantity, line_total: price * quantity, amount, ...extra,
});

const rows = [
  line('Milk', 400, 3, 6, { order_id: 1, order_key: 'a' }),       // 3 x "2 Litre" = 6 L
  line('Milk', 200, 0.63, 0.63, { order_id: 1, order_key: 'a' }), // custom Milk (0.63 L)
  line('Dahi', 520, 0.1923, 0.1923, { order_id: 2, order_key: 'b' }),
  line('Other', 900, 1, 0, { order_id: 3, order_key: 'c' }),
  line('Other', 50, 2, 0, { order_id: 2, order_key: 'b', category_review: true }),
];

test('Milk + Dahi + Other = All, for price and for line count', () => {
  const all = summarizeLineItems(rows, 'all');
  const m = summarizeLineItems(rows, 'Milk');
  const d = summarizeLineItems(rows, 'Dahi');
  assert.equal(all.lines, 5);
  assert.equal(m.lines + d.lines + all.otherLines, all.lines);
  assert.equal(Math.round((m.total + d.total + all.otherValue) * 100) / 100, all.total);
  assert.equal(all.total, all.allValue);
  assert.equal(all.total, 2426);           // 1200 + 126 + 99.996 + 900 + 100
});

test('quantity is the real amount, never the raw quantity column', () => {
  const m = summarizeLineItems(rows, 'Milk');
  assert.equal(m.quantity, 6.63);            // raw quantities would add to 3.63
  assert.equal(m.unit, 'L');
  assert.equal(summarizeLineItems(rows, 'Dahi').unit, 'kg');
  assert.equal(summarizeLineItems(rows, 'all').quantity, null); // mixed units are not added
});

test('orders counts distinct orders, not lines; and follows the filter', () => {
  assert.equal(summarizeLineItems(rows, 'all').orders, 3);
  assert.equal(summarizeLineItems(rows, 'Milk').orders, 1);
  assert.equal(summarizeLineItems(rows, 'Dahi').orders, 1);
});

test('two tills can both have an order 7: order_key keeps them apart', () => {
  const two = [line('Milk', 1, 1, 1, { order_id: 7, order_key: 101 }), line('Milk', 1, 1, 1, { order_id: 7, order_key: 202 })];
  assert.equal(summarizeLineItems(two, 'all').orders, 2);
  // an older server with no order_key falls back to branch + order number
  assert.equal(orderKeyOf({ order_id: 7, branch_name: 'A' }), 'A|7');
});

test('totals are over every row, whatever the screen draws (more than 500 lines)', () => {
  const many = Array.from({ length: 1234 }, (_, i) => line(i % 2 ? 'Milk' : 'Other', 10, 1, i % 2 ? 1 : 0, { order_id: i }));
  const s = summarizeLineItems(many, 'Milk');
  assert.equal(s.lines, 617);
  assert.equal(s.total, 6170);
  assert.equal(s.quantity, 617);
  assert.equal(summarizeLineItems(many, 'all').total, 12340);
});

test('filter returns only that group, and "all" returns the rows untouched', () => {
  assert.equal(filterLineItems(rows, 'all'), rows);
  assert.deepEqual(filterLineItems(rows, 'Dahi').map((r) => r.category_group), ['Dahi']);
});

test('an older server (no classification) hides the filter and never invents Milk/Dahi', () => {
  const old = [{ order_id: 1, item_name: '1 Litre', quantity: 2, unit_price: 200, line_total: 400 }];
  assert.equal(hasLineCategoryData(old), false);
  const s = summarizeLineItems(old, 'Milk');   // a stale filter choice must not filter everything away
  assert.equal(s.filter, 'all');
  assert.equal(s.lines, 1);
  assert.equal(s.total, 400);
  assert.equal(s.hasCategories, false);
});

test('empty range', () => {
  const s = summarizeLineItems([], 'Milk');
  assert.equal(s.lines, 0); assert.equal(s.total, 0); assert.equal(s.orders, 0);
});

test('review / assumed flags are counted within the filter', () => {
  assert.equal(summarizeLineItems(rows, 'all').reviewLines, 1);
  assert.equal(summarizeLineItems(rows, 'Milk').reviewLines, 0);
});
