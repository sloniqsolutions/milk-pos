/**
 * Every stock flow on a brand-new, throwaway till database, then the numbers
 * checked against each other.
 *
 *   cd backend
 *   node scripts/run-script.js test/stock-flows.js
 *
 * It drives the real routes (sale, void, restock, remove, set-the-count, waste,
 * yogurt conversion, ingredient create) and restore-from-cloud, then proves:
 *   - every row adds up:  Opening + Restocked +/- Converted - Sold - Waste - Removed = Closing
 *   - each day's Opening is the previous day's Closing
 *   - the latest Closing is the ingredient's current stock
 *   - Sold per day is what that day's non-voided order lines used (from their recipes),
 *     and any line with no recipe is listed, not hidden
 *   - a stock change and its entry are always the same amount; nothing is clamped
 *   - nothing but the one movement function changes a stock number
 * Exits non-zero on any failure.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.POS_USER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-stock-flows-'));

const db = require('../db/database');
const express = require('express');
const { moveStock, flushEntryPushes } = require('../db/inventory-entries');

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
  if (!cond) failures++;
};
const near = (a, b) => Math.abs(a - b) < 0.0011;
const today = new Date().toLocaleDateString('en-CA');
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('en-CA'); };

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
  const milk = db.prepare("SELECT * FROM ingredients WHERE name = 'Milk'").get();
  const yogurt = db.prepare("SELECT * FROM ingredients WHERE name = 'Yogurt'").get();
  const menu = (name, category) => db.prepare('SELECT id, price FROM menu_items WHERE name = ? AND category = ?').get(name, category);
  const L1 = menu('1 Litre', 'Milk'); const L2 = menu('2 Litre', 'Milk');
  const DAHI = menu('Dahi', 'Dahi'); const KG05 = menu('0.5 KG', 'Dahi');
  const stockOf = (id) => db.prepare('SELECT stock FROM ingredients WHERE id = ?').get(id).stock;
  const entrySum = (id) => db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM inventory_entries WHERE ingredient_id = ?').get(id).s;
  const line = (m, name, qty) => ({ id: m.id, name, price: m.price, quantity: qty, is_deal: false });
  const sell = (lines) => call('POST', '/orders', {
    items: lines, total: lines.reduce((s, l) => s + l.price * l.quantity, 0), payment_method: 'Cash', order_type: 'Walk-in',
  });
  // Puts a sale on an earlier day, as it would have been if it had been rung up then
  // (the order's own time is what dates its stock entries).
  const backdate = (orderId, day) => {
    db.prepare("UPDATE orders SET created_at = ? || substr(created_at, 11) WHERE id = ?").run(day, orderId);
    db.prepare("UPDATE inventory_entries SET entry_date = ?, created_at = ? || substr(created_at, 11) WHERE order_id = ? AND type = 'sale' AND amount < 0").run(day, day, orderId);
  };

  // ------------------------------------------------------- build a week
  console.log('\nA week of every kind of movement');
  check('restock milk 3 days ago', (await call('PUT', `/inventory/${milk.id}/stock`, { action: 'add', amount: 200, date: daysAgo(3) })).status === 200);
  check('restock yogurt 3 days ago', (await call('PUT', `/inventory/${yogurt.id}/stock`, { action: 'add', amount: 20000, date: daysAgo(3) })).status === 200);

  const o1 = await sell([line(L2, '2 Litre', 3), line(L1, '1 Litre', 2), line(DAHI, 'Dahi', 1)]);
  check('a sale goes through', o1.status === 201, JSON.stringify(o1.body).slice(0, 80));
  backdate(o1.body.id, daysAgo(2));
  const o2 = await sell([line(L1, 'Milk (0.6300 L)', 0.63), line(KG05, '0.5 KG', 2)]);
  backdate(o2.body.id, daysAgo(2));
  const o3 = await sell([line(L1, '1 Litre', 4), line(DAHI, 'Dahi (192 g)', 0.1923)]);
  backdate(o3.body.id, daysAgo(1));
  const o4 = await sell([line(L2, '2 Litre', 2)]);            // will be voided
  backdate(o4.body.id, daysAgo(1));
  check('void gives it back', (await call('PUT', `/orders/${o4.body.id}/void`)).status === 200);
  await sell([line(L1, '1 Litre', 5), line(DAHI, 'Dahi', 1)]);  // today

  check('remove stock by hand', (await call('PUT', `/inventory/${milk.id}/stock`, { action: 'subtract', amount: 4, date: daysAgo(1) })).status === 200);
  check('waste', (await call('POST', '/inventory/waste', { ingredient_id: milk.id, amount: 2.5, date: daysAgo(1) })).status === 200);
  check('convert milk to yogurt', (await call('POST', '/inventory/convert-to-yogurt', { milk_amount: 20, yogurt_amount: 2000, date: today })).status === 200);
  const counted = await call('PUT', `/inventory/${milk.id}/stock`, { stock: stockOf(milk.id) - 1.5, date: today });
  check('a count corrected down', counted.status === 200);
  check('a count corrected up', (await call('PUT', `/inventory/${yogurt.id}/stock`, { stock: stockOf(yogurt.id) + 100, date: today })).status === 200);
  const created = await call('POST', '/inventory', { name: 'Cream', unit: 'Litre', stock: 8, date: daysAgo(1) });
  check('a new ingredient with starting stock', created.status === 201);

  // --------------------------------------------- amounts and counters agree
  console.log('\nA stock number is always the sum of its entries');
  for (const ing of db.prepare('SELECT * FROM ingredients').all()) {
    check(`${ing.name}: counter equals the sum of its entries`, near(ing.stock, entrySum(ing.id)), `${ing.stock} vs ${entrySum(ing.id)}`);
  }
  check('a corrected count is one visible entry with the reason Recount',
    db.prepare("SELECT COUNT(*) n FROM inventory_entries WHERE reason = 'Recount'").get().n === 2);

  // ------------------------------------------------ the table proves itself
  console.log('\nThe stock table');
  const from = daysAgo(3);
  const rows = (await call('GET', `/reports/stock-movement?from=${from}&to=${today}`)).body;
  check('the table has rows', Array.isArray(rows) && rows.length > 0, `${rows.length} rows`);
  const columns = ['opening_balance', 'restocked', 'converted', 'sold', 'waste', 'removed', 'closing_balance'];
  check('rows carry the seven columns and nothing else that adds', rows.every((r) => columns.every((c) => c in r)) && rows.every((r) => !('adjustment' in r)));
  for (const ing of [milk, yogurt]) {
    const mine = rows.filter((r) => r.name === ing.name);
    let prev = null;
    for (const r of mine) {
      check(`${ing.name} ${r.date}: Opening + Restocked +/- Converted - Sold - Waste - Removed = Closing`,
        near(r.opening_balance + r.restocked + r.converted - r.sold - r.waste - r.removed, r.closing_balance),
        `${r.opening_balance} +${r.restocked} ${r.converted} -${r.sold} -${r.waste} -${r.removed} = ${r.closing_balance}`);
      if (prev) check(`${ing.name} ${r.date}: Opening equals the previous Closing`, near(prev.closing_balance, r.opening_balance));
      prev = r;
    }
    check(`${ing.name}: the latest Closing is the current stock`, prev && near(prev.closing_balance, stockOf(ing.id)), `${prev && prev.closing_balance} vs ${stockOf(ing.id)}`);
  }

  // Sold per day = the litres / grams of that day's non-voided order lines that have a recipe.
  const truth = db.prepare(`
    SELECT DATE(o.created_at) AS day, ri.ingredient_id AS ingredient_id, SUM(oi.quantity * ri.quantity_required) AS used
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      JOIN recipes r ON r.menu_item_id = oi.menu_item_id AND (r.variant_id = oi.variant_id OR r.variant_id IS NULL)
      JOIN recipe_ingredients ri ON ri.recipe_id = r.id
     WHERE o.status != 'voided' AND COALESCE(oi.is_deal, 0) = 0
     GROUP BY 1, 2`).all();
  for (const t of truth) {
    const name = t.ingredient_id === milk.id ? 'Milk' : 'Yogurt';
    const row = rows.find((r) => r.name === name && r.date === t.day);
    check(`${name} ${t.day}: Sold equals that day's order lines`, row && near(row.sold, t.used), `${row && row.sold} vs ${t.used}`);
  }
  const noRecipe = db.prepare(`
    SELECT oi.order_id, oi.name FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.status != 'voided' AND COALESCE(oi.is_deal, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM recipes r WHERE r.menu_item_id = oi.menu_item_id AND (r.variant_id = oi.variant_id OR r.variant_id IS NULL))`).all();
  console.log(`  INFO  order lines with no recipe (they move no stock): ${noRecipe.length}`);

  console.log('\nA sale and a void are exact');
  const saleEntries = db.prepare("SELECT * FROM inventory_entries WHERE order_id = ? AND type = 'sale'").all(o4.body.id);
  check('the voided sale has one sale entry and one return per ingredient',
    saleEntries.filter((e) => e.amount < 0).length === 1 && saleEntries.filter((e) => e.amount > 0).length === 1);
  check('the return is exactly the amount the sale took', near(saleEntries.reduce((s, e) => s + e.amount, 0), 0));
  check('every sale entry names its order line',
    db.prepare("SELECT COUNT(*) n FROM inventory_entries WHERE type = 'sale' AND amount < 0 AND (order_id IS NULL OR order_item_id IS NULL)").get().n === 0);
  check('a sale entry is dated by its order',
    db.prepare(`SELECT COUNT(*) n FROM inventory_entries e JOIN orders o ON o.id = e.order_id
                 WHERE e.type = 'sale' AND e.entry_date != DATE(o.created_at)`).get().n === 0);
  check('a second void is refused', (await call('PUT', `/orders/${o4.body.id}/void`)).status === 409);

  console.log('\nNothing is clamped: too big is refused');
  const before = { stock: stockOf(milk.id), entries: db.prepare('SELECT COUNT(*) n FROM inventory_entries').get().n, orders: db.prepare('SELECT COUNT(*) n FROM orders').get().n };
  const tooBig = await sell([line(L2, '2 Litre', 1000)]);
  check('a sale bigger than the stock is refused', tooBig.status === 400);
  let threw = null;
  try { moveStock(milk.id, 'sale', -(before.stock + 1), today); } catch (e) { threw = e; }
  check('a movement below zero is refused with INSUFFICIENT_STOCK', threw && threw.code === 'INSUFFICIENT_STOCK');
  check('and nothing changed: stock, entries and orders are as they were',
    stockOf(milk.id) === before.stock
      && db.prepare('SELECT COUNT(*) n FROM inventory_entries').get().n === before.entries
      && db.prepare('SELECT COUNT(*) n FROM orders').get().n === before.orders);
  const rollbackEntries = db.prepare('SELECT COUNT(*) n FROM inventory_entries').get().n;
  try { db.transaction(() => { moveStock(milk.id, 'waste', -1, today); throw new Error('sale failed later'); })(); } catch (e) { /* expected */ }
  flushEntryPushes();
  check('a movement inside a transaction that rolls back leaves nothing behind',
    db.prepare('SELECT COUNT(*) n FROM inventory_entries').get().n === rollbackEntries && near(stockOf(milk.id), before.stock));

  // ------------------------------------------------- restore from the cloud
  console.log('\nRestore-from-cloud never sets stock from a bare number');
  const { applyCloudRestore } = require('../db/cloud-restore');
  await applyCloudRestore({
    staff: [], customers: [], shifts: [], orders: [], order_items: [], expenses: [], credit_payments: [],
    ingredients: [{ local_id: 1, name: 'Milk', unit: 'Litre', stock: 9999, low_stock_threshold: 0, cost_per_unit: 0 },
                  { local_id: 2, name: 'Yogurt', unit: 'grams', stock: 8888, low_stock_threshold: 0, cost_per_unit: 0 }],
    inventory_entries: [
      { local_id: 1, device_id: 'dev-a', ingredient_local_id: 1, type: 'stock', amount: 100, entry_date: '2026-09-19', created_at: '2026-09-19 08:00:00' },
      { local_id: 2, device_id: 'dev-a', ingredient_local_id: 1, type: 'waste', amount: -7.5, entry_date: '2026-09-19', created_at: '2026-09-19 09:00:00' },
      { local_id: 3, device_id: 'dev-a', ingredient_local_id: 2, type: 'stock', amount: 3000, entry_date: '2026-09-19', created_at: '2026-09-19 08:00:00' },
    ],
  });
  check('Milk equals its restored entries (92.5), not the cloud number 9999', near(stockOf(milk.id), 92.5), `${stockOf(milk.id)}`);
  check('Yogurt equals its restored entries (3000), not 8888', near(stockOf(yogurt.id), 3000), `${stockOf(yogurt.id)}`);
  check('every counter still equals the sum of its entries',
    db.prepare('SELECT * FROM ingredients').all().every((i) => near(i.stock, entrySum(i.id))));

  // -------------------------------------------- nothing else moves a number
  console.log('\nOnly one function changes a stock number');
  const roots = ['db', 'routes', 'sync', 'server.js'].map((p) => path.join(__dirname, '..', p));
  const files = [];
  const walk = (p) => { if (fs.statSync(p).isDirectory()) fs.readdirSync(p).forEach((f) => walk(path.join(p, f))); else if (p.endsWith('.js')) files.push(p); };
  roots.forEach(walk);
  const offenders = files.filter((f) => /UPDATE\s+ingredients\s+SET\s+stock\b/i.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/'))
    .filter((f) => f !== 'db/inventory-entries.js' && f !== 'db/cloud-restore.js');
  check('no other code updates ingredients.stock', offenders.length === 0, offenders.join(', '));
  check('the restore only recomputes it from entries',
    /SET stock = COALESCE\(\(SELECT SUM\(amount\) FROM inventory_entries/.test(fs.readFileSync(path.join(__dirname, '..', 'db', 'cloud-restore.js'), 'utf8').replace(/\s+/g, ' ')));

  server.close();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
