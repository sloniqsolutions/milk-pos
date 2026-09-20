// Run:  node --test backend/test/*.test.js      (plain Node: nothing here touches the database)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createClassifier } = require('../db/line-classifier');
const { unitAmount } = require('../db/item-quantities');

const { classifyLine, splitOrderLines } = createClassifier(unitAmount);
const cls = (name, category, quantity = 1, extra = {}) => classifyLine({ name, category, quantity, ...extra });

test('the menu category is the primary rule', () => {
  assert.equal(cls('2 Litre', 'Milk', 3).group, 'Milk');
  assert.equal(cls('2 Litre', 'Milk', 3).amount, 6);            // 3 packs of 2 L, not 3
  assert.equal(cls('2 Litre', 'Milk', 3).inferred, false);
  assert.equal(cls('0.5 KG', 'Dahi', 2).group, 'Dahi');
  assert.equal(cls('0.5 KG', 'Dahi', 2).amount, 1);              // 2 x 500 g = 1 kg
  assert.equal(cls('Margherita', 'Pizza').group, 'Other');       // a real, different category
  assert.equal(cls('Margherita', 'Pizza').review, false);
});

test('a custom line stores its amount in quantity itself', () => {
  assert.equal(cls('Milk (0.6300 L)', 'Milk', 0.63).amount, 0.63);
  assert.ok(Math.abs(cls('Dahi (192 g)', 'Dahi', 0.1923).amount - 0.1923) < 1e-9); // kilograms
});

test('an orphan line is inferred ONLY from names this app writes, and marked inferred', () => {
  for (const [name, group] of [
    ['1 Litre', 'Milk'], ['0.5 Litre', 'Milk'], ['2 Litre', 'Milk'], ['Milk (0.6300 L)', 'Milk'],
    ['Dahi', 'Dahi'], ['0.5 KG', 'Dahi'], ['2 KG', 'Dahi'], ['Dahi (192 g)', 'Dahi'],
  ]) {
    for (const category of ['Removed Item', null, undefined, '']) {
      const c = cls(name, category);
      assert.equal(c.group, group, `${name} / ${category}`);
      assert.equal(c.inferred, true, `${name} / ${category}`);
    }
  }
});

test('case and spacing variants of a known name are still recognised', () => {
  assert.equal(cls('  MILK ( 0.63  L )  ', 'Removed Item', 0.63).group, 'Milk');
  assert.equal(cls('dahi', null).group, 'Dahi');
  assert.equal(cls('2  litre', null).group, 'Milk');
});

test('ambiguous orphan names are NOT guessed: Other, flagged for review, never dropped', () => {
  for (const name of ['milk', 'milk ', '1 Liter', '2 Ltr', 'Yogurt', 'Curd', 'Doodh', 'Full Cream Milk']) {
    const c = cls(name, 'Removed Item');
    assert.equal(c.group, 'Other', name);
    assert.equal(c.inferred, false, name);
    assert.equal(c.review, true, name);
    assert.equal(c.amount, 0, name);
  }
  // an orphan that does not look like either is simply Other, with nothing to review
  assert.equal(cls('Delivery box', 'Removed Item').review, false);
});

test('a deal is always Other, whatever it is called, and is not flagged', () => {
  const c = cls('1 Litre', 'Deals', 1, { is_deal: 1 });
  assert.equal(c.group, 'Other');
  assert.equal(c.inferred, false);
  assert.equal(c.review, false);
  assert.equal(cls('Family Deal', null, 1, { is_deal: 1 }).group, 'Other');
});

test('a line with a menu category is never re-guessed from its name', () => {
  assert.equal(cls('Yogurt Drink', 'Milk').group, 'Milk');       // the category wins
  assert.equal(cls('Dahi', 'Pizza').group, 'Other');            // and so does a different one
});

test('amount_assumed is raised when the name gave no size and unitAmount used its default', () => {
  assert.equal(cls('Full Cream', 'Milk', 2).amount_assumed, true);   // counts as 1 L each
  assert.equal(cls('Full Cream', 'Milk', 2).amount, 2);
  assert.equal(cls('1 Litre', 'Milk', 2).amount_assumed, false);
  assert.equal(cls('Dahi Special', 'Dahi', 1).amount_assumed, true);
  assert.equal(cls('Dahi (192 g)', 'Dahi', 0.19).amount_assumed, false);
  assert.equal(cls('Milk (0.63 L)', 'Milk', 0.63).amount_assumed, false);
});

test('every line lands in exactly one bucket: Milk + Dahi + Other = All (value and lines)', () => {
  const lines = [
    { key: 1, category: 'Milk', name: '2 Litre', quantity: 3, price: 400 },
    { key: 1, category: null, name: 'milk ', quantity: 1, price: 200 },
    { key: 1, category: null, name: 'Milk (0.6300 L)', quantity: 0.63, price: 200 },
    { key: 2, category: 'Dahi', name: '0.5 KG', quantity: 2, price: 150 },
    { key: 2, category: null, name: '', quantity: 1, price: 10 },
    { key: 3, category: null, is_deal: 1, name: 'Family Deal', quantity: 1, price: 900 },
    { key: 3, category: 'Milk', name: '1 Litre', quantity: 2, price: 0 },
  ];
  const split = splitOrderLines(lines);
  let value = 0; let count = 0;
  for (const o of split.values()) {
    value += o.milk_value + o.dahi_value + o.other_value;
    count += o.milk_lines + o.dahi_lines + o.other_lines;
  }
  assert.equal(count, lines.length);
  assert.ok(Math.abs(value - lines.reduce((s, l) => s + l.price * l.quantity, 0)) < 1e-9);
  assert.equal(split.get(1).milk_lines, 2);     // the 2 Litre pack and the inferred custom line
  assert.equal(split.get(1).other_lines, 1);    // 'milk ' — not guessed
  assert.equal(split.get(1).milk_qty, 6.63);
});

test('the till and cloud copies stay identical', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
  assert.equal(read('backend/db/line-classifier.js'), read('cloud/db/line-classifier.js'));
  assert.equal(read('backend/db/stock-statement.js'), read('cloud/db/stock-statement.js'));
  // unitAmount's two copies are deliberately identical — the classifier depends on that.
  // Compared with comments stripped: the two copies word their comments differently.
  const fn = (src) => src.slice(src.indexOf('function unitAmount'), src.indexOf('\n}\n', src.indexOf('function unitAmount')) + 3)
    .replace(/\s*\/\/[^\n]*/g, '');
  assert.equal(fn(read('backend/db/item-quantities.js')), fn(read('cloud/db/derived-usage.js')));
});
