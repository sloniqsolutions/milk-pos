// Run:  node --test backend/test/*.test.js      (plain Node: nothing here touches a database)
const test = require('node:test');
const assert = require('node:assert/strict');
const { judge, createdEntryFor, tableAfter } = require('../db/stock-cleanup');

const M = 'main';
const line = (item, day, group, quantity, amount, extra = {}) => ({
  device: M, order: item, item, day, created_at: `${day} 10:00:00`, status: 'completed',
  group, name: group === 'Milk' ? '1 Litre' : 'Dahi', quantity, amount, ...extra,
});
let nextId = 1;
const entry = (ingredient, type, amount, entry_date, extra = {}) => {
  const id = nextId++;
  return { key: `${extra.device || M}#${id}`, device: M, id, ingredient, type, amount, entry_date, created_at: `${entry_date} 09:00:00`, order: null, item: null, ...extra };
};
const BATCH = '2026-09-18 23:50:45';
const inBatch = (e) => ({ ...e, created_at: BATCH });

test('an entry that matches its order line is kept, even from the 23:50:45 batch', () => {
  const lines = [line(1, '2026-09-17', 'Milk', 3, 3)];
  const e = inBatch(entry('Milk', 'sale', -3, '2026-09-17'));
  const { verdicts, isBatch } = judge({ entries: [e], lines, batchAt: BATCH });
  assert.equal(verdicts.get(e.key).verdict, 'KEEP');
  assert.equal(isBatch(e), true);
});

test('Milk copied from a Dahi line, and Yogurt carrying Milk litres x 1000, are deleted', () => {
  const lines = [line(1, '2026-09-17', 'Dahi', 0.75, 750), line(2, '2026-09-17', 'Milk', 4.5, 4.5)];
  const milkFromDahi = inBatch(entry('Milk', 'sale', -1.5, '2026-09-17'));           // 2 x 0.75
  const yogurtFromMilk = inBatch(entry('Yogurt', 'sale', -4500, '2026-09-17'));        // 4.5 L x 1000
  const good = inBatch(entry('Milk', 'sale', -4.5, '2026-09-17'));
  const goodY = inBatch(entry('Yogurt', 'sale', -750, '2026-09-17'));
  const { verdicts } = judge({ entries: [milkFromDahi, yogurtFromMilk, good, goodY], lines });
  assert.equal(verdicts.get(milkFromDahi.key).verdict, 'DELETE');
  assert.match(verdicts.get(milkFromDahi.key).reason, /\(a\).*Dahi/);
  assert.equal(verdicts.get(yogurtFromMilk.key).verdict, 'DELETE');
  assert.match(verdicts.get(yogurtFromMilk.key).reason, /\(a\).*Milk/);
  assert.equal(verdicts.get(good.key).verdict, 'KEEP');
  assert.equal(verdicts.get(goodY.key).verdict, 'KEEP');
});

test('a second entry for the same order line is a duplicate; the first is kept', () => {
  const lines = [line(1, '2026-09-17', 'Milk', 2, 2)];
  const first = entry('Milk', 'sale', -2, '2026-09-17');
  const second = entry('Milk', 'sale', -2, '2026-09-17');
  const { verdicts } = judge({ entries: [first, second], lines });
  assert.equal(verdicts.get(first.key).verdict, 'KEEP');
  assert.equal(verdicts.get(second.key).verdict, 'DELETE');
  assert.match(verdicts.get(second.key).reason, /\(b\)/);
});

test('an entry that names its line but disagrees with it is deleted', () => {
  const lines = [line(1, '2026-09-19', 'Milk', 2, 2)];
  const e = entry('Milk', 'sale', -9, '2026-09-19', { order: 1, item: 1 });
  assert.equal(judge({ entries: [e], lines }).verdicts.get(e.key).verdict, 'DELETE');
});

test('real restocks, waste and conversions are kept; the 15-16 Sep ones are ASK ME', () => {
  const real = [entry('Milk', 'stock', 420, '2026-09-19'), entry('Milk', 'waste', -66.789, '2026-09-18'), entry('Milk', 'yogurt_conversion', -20, '2026-09-19')];
  const suspect = [entry('Milk', 'stock', 260, '2026-09-15'), entry('Milk', 'stock', 100, '2026-09-16'), entry('Milk', 'yogurt_conversion', -12, '2026-09-16')];
  const { verdicts } = judge({ entries: [...real, ...suspect], lines: [], suspectFrom: '2026-09-15', suspectTo: '2026-09-16' });
  real.forEach((e) => assert.equal(verdicts.get(e.key).verdict, 'KEEP'));
  suspect.forEach((e) => assert.equal(verdicts.get(e.key).verdict, 'ASK ME'));
});

test('nothing is deleted on a guess: an unexplained sale entry is ASK ME', () => {
  const lines = [line(1, '2026-09-17', 'Milk', 3, 3)];
  const odd = entry('Milk', 'sale', -7.31, '2026-09-17');
  assert.equal(judge({ entries: [odd], lines }).verdicts.get(odd.key).verdict, 'ASK ME');
});

test('colliding entries are never deleted on their own; a sale that matches its line stays', () => {
  const lines = [line(1, '2026-09-17', 'Milk', 3, 3)];
  const restock = entry('Milk', 'stock', 50, '2026-09-17');
  const sale = entry('Milk', 'sale', -3, '2026-09-17');
  const { verdicts } = judge({ entries: [restock, sale], lines, collisionKeys: new Set([restock.key, sale.key]) });
  assert.equal(verdicts.get(restock.key).verdict, 'ASK ME');
  assert.equal(verdicts.get(sale.key).verdict, 'KEEP');
});

test('a sale entry filed under another device id still matches the real line', () => {
  const lines = [line(1, '2026-09-17', 'Milk', 3, 3, { device: 'legacy' })];
  const e = entry('Milk', 'sale', -3, '2026-09-17');
  assert.equal(judge({ entries: [e], lines }).verdicts.get(e.key).verdict, 'KEEP');
});

test('order lines with no correct entry get one, linked to the line and dated by the order; voided orders need none', () => {
  const lines = [
    line(1, '2026-09-18', 'Milk', 2, 2, { device: 'legacy' }),
    line(2, '2026-09-18', 'Dahi', 0.5, 500, { device: 'legacy' }),
    line(3, '2026-09-18', 'Milk', 5, 5, { device: 'legacy', status: 'voided' }),
  ];
  const { missing } = judge({ entries: [], lines });
  assert.deepEqual(missing.map((l) => l.item), [1, 2]);
  const made = missing.map(createdEntryFor);
  assert.equal(made[0].amount, -2);
  assert.equal(made[0].entry_date, '2026-09-18');
  assert.equal(made[0].item, 1);
  assert.equal(made[0].id, 9000001);
  assert.equal(made[1].ingredient, 'Yogurt');
});

test('after the cleanup the table adds up and Sold equals the order lines', () => {
  const lines = [line(1, '2026-09-19', 'Milk', 3, 3), line(2, '2026-09-19', 'Dahi', 1, 1000), line(3, '2026-09-20', 'Milk', 2, 2)];
  const restock = entry('Milk', 'stock', 100, '2026-09-19');
  const bad = entry('Milk', 'sale', -2, '2026-09-19');                       // 2 x Dahi 1 kg quantity: wrong
  const ok = entry('Milk', 'sale', -3, '2026-09-19');
  const { verdicts, missing } = judge({ entries: [restock, bad, ok], lines });
  assert.equal(verdicts.get(bad.key).verdict, 'DELETE');
  const kept = [restock, bad, ok].filter((e) => verdicts.get(e.key).verdict !== 'DELETE');
  const after = kept.concat(missing.map(createdEntryFor));
  const table = tableAfter(after).filter((r) => r.name === 'Milk');
  assert.deepEqual(table.map((r) => [r.date, r.sold]), [['2026-09-19', 3], ['2026-09-20', 2]]);
  let prev = null;
  for (const r of table) {
    assert.ok(Math.abs(r.opening_balance + r.restocked + r.converted - r.sold - r.waste - r.removed - r.closing_balance) < 1e-9);
    if (prev) assert.equal(r.opening_balance, prev.closing_balance);
    prev = r;
  }
  assert.equal(prev.closing_balance, 95);
});

test('an entry that is exactly half of a same-day line with no entry of its own is deleted; each line explains only one', () => {
  const lines = [line(1, '2026-09-17', 'Milk', 0.1818, 0.1818)];
  const half = entry('Milk', 'sale', -0.0909, '2026-09-17');
  const half2 = entry('Milk', 'sale', -0.0909, '2026-09-17');
  const { verdicts, missing } = judge({ entries: [half, half2], lines });
  assert.equal(verdicts.get(half.key).verdict, 'DELETE');
  assert.match(verdicts.get(half.key).reason, /exactly double/);
  assert.equal(verdicts.get(half2.key).verdict, 'ASK ME');       // the one line is already explained
  assert.equal(missing.length, 1);                                // and the line still gets a correct entry
});
