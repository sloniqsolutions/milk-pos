/**
 * Every live path that writes a stock entry, one check each, plus the mixed order
 * (a Milk item and a Dahi item in the same order) that used to file under the wrong
 * ingredient. SYNTHETIC data on a brand-new throwaway till database.
 *
 *   cd backend
 *   node scripts/run-script.js test/stock-paths.js
 *
 * For each path: exactly one entry per real movement; filed against the ingredient
 * the recipe says; the amount logged is exactly the amount the counter moved; a sale
 * cannot be logged twice; and the recipe agrees with the quantity the reports use.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.POS_USER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-stock-paths-'));

const db = require('../db/database');
const express = require('express');
const { unitAmount } = require('../db/item-quantities');

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
  if (!cond) failures++;
};
const near = (a, b) => Math.abs(a - b) < 0.0011;
const today = new Date().toLocaleDateString('en-CA');

(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _r, next) => { req.user = { staffId: 1, role: 'Admin', name: 'Owner' }; next(); });
  app.use('/api/orders', require('../routes/orders'));
  app.use('/api/inventory', require('../routes/inventory'));
  app.use('/api/reports', require('../routes/reports'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  db.prepare("INSERT INTO shifts (staff_id, staff_name, opening_cash, opened_at, status) VALUES (1, 'Owner', 0, datetime('now','localtime'), 'open')").run();
  const ing = (n) => db.prepare('SELECT * FROM ingredients WHERE name = ?').get(n);
  const milk = ing('Milk'); const yogurt = ing('Yogurt');
  const stock = (id) => db.prepare('SELECT stock FROM ingredients WHERE id = ?').get(id).stock;
  const entryCount = () => db.prepare('SELECT COUNT(*) n FROM inventory_entries').get().n;
  const menu = (n, c) => db.prepare('SELECT id, price FROM menu_items WHERE name = ? AND category = ?').get(n, c);
  const line = (m, name, qty) => ({ id: m.id, name, price: m.price, quantity: qty, is_deal: false });
  const sell = (lines) => call('POST', '/orders', { items: lines, total: lines.reduce((s, l) => s + l.price * l.quantity, 0), payment_method: 'Cash', order_type: 'Walk-in' });
  await call('PUT', `/inventory/${milk.id}/stock`, { action: 'add', amount: 500, date: today });
  await call('PUT', `/inventory/${yogurt.id}/stock`, { action: 'add', amount: 50000, date: today });

  // A movement: one entry, and the counter moves by exactly that amount.
  const movement = async (label, doIt, expect) => {
    const before = { n: entryCount(), milk: stock(milk.id), yogurt: stock(yogurt.id), maxId: db.prepare('SELECT COALESCE(MAX(id),0) m FROM inventory_entries').get().m };
    const res = await doIt();
    const made = db.prepare('SELECT * FROM inventory_entries WHERE id > ? ORDER BY id').all(before.maxId);
    check(`${label}: the request succeeds`, res.status === 200 || res.status === 201, `status ${res.status}`);
    check(`${label}: exactly ${expect.length} entr${expect.length === 1 ? 'y' : 'ies'}, one per real movement`, made.length === expect.length, `${made.length}`);
    expect.forEach((e, i) => {
      const m = made[i];
      const ingredient = ing(e.name);
      check(`${label}: filed under ${e.name}, type ${e.type}`, m && m.ingredient_id === ingredient.id && m.type === e.type);
      check(`${label}: ${e.name} logged ${e.amount} and the counter moved exactly that`,
        m && near(m.amount, e.amount) && near(stock(ingredient.id) - (e.name === 'Milk' ? before.milk : before.yogurt), m.amount));
    });
    return made;
  };

  console.log('\nRestock');
  await movement('restock', () => call('PUT', `/inventory/${milk.id}/stock`, { action: 'add', amount: 12 }), [{ name: 'Milk', type: 'stock', amount: 12 }]);
  console.log('\nRemove stock');
  await movement('remove', () => call('PUT', `/inventory/${milk.id}/stock`, { action: 'subtract', amount: 3 }), [{ name: 'Milk', type: 'stock', amount: -3 }]);
  console.log('\nSet the count');
  const counted = await movement('set the count', () => call('PUT', `/inventory/${yogurt.id}/stock`, { stock: stock(yogurt.id) - 500 }), [{ name: 'Yogurt', type: 'stock', amount: -500 }]);
  check('set the count: the reason is Recount', counted[0] && counted[0].reason === 'Recount');
  console.log('\nWaste');
  await movement('waste', () => call('POST', '/inventory/waste', { ingredient_id: milk.id, amount: 2.5 }), [{ name: 'Milk', type: 'waste', amount: -2.5 }]);
  console.log('\nYogurt conversion');
  await movement('conversion', () => call('POST', '/inventory/convert-to-yogurt', { milk_amount: 10, yogurt_amount: 1500 }),
    [{ name: 'Milk', type: 'yogurt_conversion', amount: -10 }, { name: 'Yogurt', type: 'yogurt_conversion', amount: 1500 }]);
  console.log('\nIngredient creation');
  const beforeCream = entryCount();
  const cream = await call('POST', '/inventory', { name: 'Cream', unit: 'Litre', stock: 7 });
  const creamRow = ing('Cream');
  check('ingredient creation: one entry for the starting stock, equal to the counter',
    cream.status === 201 && entryCount() === beforeCream + 1 && near(creamRow.stock, 7)
      && near(db.prepare('SELECT SUM(amount) s FROM inventory_entries WHERE ingredient_id = ?').get(creamRow.id).s, 7));
  const beforeZero = entryCount();
  await call('POST', '/inventory', { name: 'Salt', unit: 'kg', stock: 0 });
  check('ingredient creation with no starting stock logs nothing', entryCount() === beforeZero);

  console.log('\nSale');
  const one = await sell([line(menu('2 Litre', 'Milk'), '2 Litre', 3)]);
  const saleRows = db.prepare("SELECT * FROM inventory_entries WHERE order_id = ?").all(one.body.id);
  const item1 = db.prepare('SELECT id FROM order_items WHERE order_id = ?').get(one.body.id).id;
  check('sale: exactly one entry for the one line', saleRows.length === 1);
  check('sale: filed under Milk (the recipe), 6 litres, linked to its order line',
    saleRows[0].ingredient_id === milk.id && near(saleRows[0].amount, -6) && saleRows[0].order_item_id === item1);
  check('sale: dated and timed by the order itself',
    db.prepare('SELECT o.created_at c FROM orders o WHERE o.id = ?').get(one.body.id).c === saleRows[0].created_at
      && saleRows[0].entry_date === saleRows[0].created_at.slice(0, 10));
  let dupe = null;
  try {
    db.prepare("INSERT INTO inventory_entries (ingredient_id, type, amount, entry_date, order_id, order_item_id) VALUES (?, 'sale', -6, ?, ?, ?)").run(milk.id, today, one.body.id, item1);
  } catch (e) { dupe = e; }
  check('sale: cannot be logged twice for the same order line (refused by the database)', dupe && /UNIQUE/i.test(dupe.message), dupe && dupe.message);

  console.log('\nVoid');
  const before = { milk: stock(milk.id), n: entryCount() };
  const v = await call('PUT', `/orders/${one.body.id}/void`);
  const returns = db.prepare("SELECT * FROM inventory_entries WHERE order_id = ? AND amount > 0").all(one.body.id);
  check('void: succeeds', v.status === 200);
  check('void: exactly one return entry per line, Milk, exactly what the sale took, linked to the same line',
    returns.length === 1 && returns[0].ingredient_id === milk.id && near(returns[0].amount, 6) && returns[0].order_item_id === item1 && db.prepare('SELECT COUNT(*) n FROM inventory_entries').get().n === before.n + 1);
  check('void: the counter moved by exactly the amount logged', near(stock(milk.id) - before.milk, 6));
  check('void: a second void does nothing', (await call('PUT', `/orders/${one.body.id}/void`)).status === 409 && db.prepare("SELECT COUNT(*) n FROM inventory_entries WHERE order_id = ? AND amount > 0").get(one.body.id).n === 1);

  // ------------------------------------------------------- the mixed order
  console.log('\nThe mixed order: Milk and Dahi in one order');
  const b = { milk: stock(milk.id), yogurt: stock(yogurt.id) };
  const mixed = await sell([line(menu('1 Litre', 'Milk'), '1 Litre', 2), line(menu('Dahi', 'Dahi'), 'Dahi', 1), line(menu('2 Litre', 'Milk'), '2 Litre', 1), line(menu('0.5 KG', 'Dahi'), '0.5 KG', 3)]);
  check('the mixed order goes through', mixed.status === 201);
  const items = db.prepare('SELECT id, name FROM order_items WHERE order_id = ? ORDER BY id').all(mixed.body.id);
  const rowsFor = (name) => db.prepare('SELECT e.*, i.name AS ing FROM inventory_entries e JOIN ingredients i ON i.id = e.ingredient_id WHERE e.order_item_id = ?').all(items.find((x) => x.name === name).id);
  const expect = { '1 Litre': ['Milk', -2], 'Dahi': ['Yogurt', -1000], '2 Litre': ['Milk', -2], '0.5 KG': ['Yogurt', -1500] };
  for (const [name, [ingName, amount]] of Object.entries(expect)) {
    const r = rowsFor(name);
    check(`"${name}" is filed under ${ingName} for ${amount}, once, and nothing else`, r.length === 1 && r[0].ing === ingName && near(r[0].amount, amount), JSON.stringify(r.map((x) => [x.ing, x.amount])));
  }
  check('the order made exactly one entry per line, none for any other line', db.prepare('SELECT COUNT(*) n FROM inventory_entries WHERE order_id = ?').get(mixed.body.id).n === 4);
  check('no Milk line ever took Yogurt, and no Dahi line ever took Milk',
    db.prepare(`SELECT COUNT(*) n FROM inventory_entries e JOIN order_items oi ON oi.id = e.order_item_id JOIN menu_items m ON m.id = oi.menu_item_id JOIN ingredients i ON i.id = e.ingredient_id
                 WHERE e.type = 'sale' AND ((m.category = 'Milk' AND i.name != 'Milk') OR (m.category = 'Dahi' AND i.name != 'Yogurt'))`).get().n === 0);
  check('the amounts logged are exactly what the counters moved',
    near(stock(milk.id) - b.milk, -4) && near(stock(yogurt.id) - b.yogurt, -2500), `${stock(milk.id) - b.milk} / ${stock(yogurt.id) - b.yogurt}`);

  // ---------------------------------------- recipe vs the quantity reports use
  console.log('\nThe recipe agrees with the quantity the reports use');
  const recipes = db.prepare(`
    SELECT m.name, m.category, ri.quantity_required q, i.name AS ing
      FROM menu_items m JOIN recipes r ON r.menu_item_id = m.id JOIN recipe_ingredients ri ON ri.recipe_id = r.id JOIN ingredients i ON i.id = ri.ingredient_id
     WHERE m.category IN ('Milk', 'Dahi')`).all();
  const disagree = recipes.filter((r) => !(r.ing === (r.category === 'Milk' ? 'Milk' : 'Yogurt') && near(r.q, unitAmount(r.category, r.name))));
  check(`every Milk and Dahi menu item's recipe takes the right ingredient and the same amount the reports use (${recipes.length} checked)`, disagree.length === 0, JSON.stringify(disagree));
  const noRecipe = db.prepare(`SELECT m.name, m.category FROM menu_items m WHERE m.category IN ('Milk','Dahi') AND NOT EXISTS (SELECT 1 FROM recipes r WHERE r.menu_item_id = m.id)`).all();
  console.log(`  INFO  Milk/Dahi menu items with no recipe (listed, not hidden): ${noRecipe.length ? JSON.stringify(noRecipe) : 'none'}`);

  // ------------------------------------------- a corrected entry: totals vs history
  console.log('\nA corrected entry is left out of every total, and shown in the history');
  const wrong = db.prepare("INSERT INTO inventory_entries (ingredient_id, type, amount, entry_date) VALUES (?, 'sale', -50, ?)").run(milk.id, today).lastInsertRowid;
  const good = db.prepare("INSERT INTO inventory_entries (ingredient_id, type, amount, entry_date) VALUES (?, 'sale', -5, ?)").run(milk.id, today).lastInsertRowid;
  const usedOf = async () => (await call('GET', `/reports/kpi?from=${today}&to=${today}`)).body.ingredient_usage.find((i) => i.name === 'Milk').used;
  const usedBefore = await usedOf();
  const rowsBefore = (await call('GET', `/reports/stock-movement?from=${today}&to=${today}`)).body.find((r) => r.name === 'Milk');
  db.prepare('UPDATE inventory_entries SET superseded_by = ? WHERE id = ?').run(good, wrong);
  const rowsAfter = (await call('GET', `/reports/stock-movement?from=${today}&to=${today}`)).body.find((r) => r.name === 'Milk');
  check('the corrected entry is out of Sold', near(rowsBefore.sold - rowsAfter.sold, 50), `${rowsBefore.sold} -> ${rowsAfter.sold}`);
  check('and out of Closing, so the row still adds up',
    near(rowsAfter.opening_balance + rowsAfter.restocked + rowsAfter.converted - rowsAfter.sold - rowsAfter.waste - rowsAfter.removed, rowsAfter.closing_balance));
  const hist = (await call('GET', `/inventory/history?ingredient_id=${milk.id}`)).body;
  const shown = hist.find((h) => h.id === Number(wrong));
  check('the corrected entry is still in the stock history, pointing at its correction', shown && shown.superseded_by === Number(good), JSON.stringify(shown && shown.superseded_by));
  check('and out of the "used" figure on the report cards', near(usedBefore - (await usedOf()), 50));

  server.close();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
