/**
 * Quick end-to-end check of the sales reports on a brand-new, throwaway till database.
 *
 *   cd backend
 *   node scripts/run-script.js test/reports-quick.js
 *
 * It makes its own empty database (never the shop's), seeds messy-but-realistic
 * orders, calls the real /reports routes as an administrator and as a manager, and
 * checks that the numbers reconcile — with SQL written independently of the routes.
 * The pure Item Sales arithmetic is loaded from the frontend, so what is checked is
 * what the screen uses. Exits non-zero on any failure.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

process.env.POS_USER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-reports-quick-'));

const db = require('../db/database');
const express = require('express');

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
  if (!cond) failures++;
};
const near = (a, b) => Math.abs(a - b) < 0.005;
const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);

(async () => {
  const { summarizeLineItems, filterLineItems } = await import(
    pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'src', 'lib', 'itemSalesView.js')).href);
  const detailedView = await import(
    pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'src', 'lib', 'detailedView.js')).href);

  const menuId = (name, category) => db.prepare('SELECT id FROM menu_items WHERE name = ? AND category = ?').get(name, category).id;
  const L1 = menuId('1 Litre', 'Milk'); const L2 = menuId('2 Litre', 'Milk');
  const DAHI = menuId('Dahi', 'Dahi'); const KG05 = menuId('0.5 KG', 'Dahi');

  const insOrder = db.prepare(`INSERT INTO orders (total, discount, payment_method, status, cashier_id, cashier_name, is_employee, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insLine = db.prepare('INSERT INTO order_items (order_id, menu_item_id, name, price, quantity, is_deal) VALUES (?, ?, ?, ?, ?, ?)');
  const DAY = '2026-09-18';
  const order = (cashier, status, lines, { employee = 0, discount = 0 } = {}) => {
    const total = sum(lines, (l) => l[2] * l[3]) - discount;
    const id = insOrder.run(total, discount, 'Cash', status, cashier, 'c' + cashier, employee, `${DAY} 10:00:00`).lastInsertRowid;
    lines.forEach(([mid, name, price, qty, deal]) => insLine.run(id, mid, name, price, qty, deal || 0));
    return id;
  };

  // The messy cases: packs, custom fractional lines, an orphan (menu item deleted) with a known
  // and an ambiguous name, a deal, a price-0 staff line, a voided order.
  order(1, 'completed', [[L2, '2 Litre', 400, 3], [L1, 'Milk (0.6300 L)', 200, 0.63], [DAHI, 'Dahi (192 g)', 520, 0.1923]]);
  order(1, 'completed', [[9999, '1 Litre', 200, 2], [9999, 'milk ', 200, 1], [9999, '2 Ltr', 400, 1], [9999, 'Yogurt', 520, 1]]);
  order(2, 'completed', [[KG05, '0.5 KG', 300, 2], [5, 'Family Deal', 900, 1, 1]], { discount: 50 });
  order(2, 'completed', [[L1, '1 Litre', 0, 2]], { employee: 1 });
  order(1, 'voided', [[L1, '1 Litre', 200, 5]]);
  // Volume: 130 orders x 5 lines = 650 more lines, past the screen's 500-row cap.
  for (let i = 0; i < 130; i++) {
    order(i % 2 ? 1 : 2, 'completed', [[L1, '1 Litre', 200, 1], [L2, '2 Litre', 400, 2], [DAHI, 'Dahi', 300, 0.5], [9999, 'Delivery box', 30, 1], [9999, '1 Litre', 200, 1]]);
  }

  const app = express();
  let user = { staffId: 1, role: 'Admin', name: 'Owner' };
  app.use((req, _r, next) => { req.user = user; next(); });
  app.use('/api/reports', require('../routes/reports'));
  const server = app.listen(0);
  const get = async (p) => (await fetch(`http://127.0.0.1:${server.address().port}/api/reports${p}`)).json();
  const RANGE = `?from=${DAY}&to=${DAY}`;

  // ---------------------------------------------------------------- Admin
  console.log('\nItem Sales vs Detailed, administrator');
  const lines = await get('/line-items' + RANGE);
  const orders = await get('/detailed' + RANGE);
  const truth = db.prepare(`SELECT COUNT(*) n, ROUND(SUM(oi.price * oi.quantity), 2) v FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status != 'voided'`).get();

  check(`every non-voided line is returned (${truth.n})`, lines.length === truth.n, `got ${lines.length}`);
  check('more than 500 lines, so the screen cap is exercised', lines.length > 500, String(lines.length));
  check('voided orders are excluded', !lines.some((l) => l.status === 'voided'));
  const withVoid = await get('/line-items' + RANGE + '&include_voided=1');
  check('include_voided=1 brings the voided line back', withVoid.length === truth.n + 1);

  const all = summarizeLineItems(lines, 'all');
  const milk = summarizeLineItems(lines, 'Milk');
  const dahi = summarizeLineItems(lines, 'Dahi');
  check('All = sum(price * quantity) over non-voided lines', near(all.total, truth.v), `${all.total} vs ${truth.v}`);
  check('Milk + Dahi + Other = All (value)', near(milk.total + dahi.total + all.otherValue, all.total));
  check('Milk + Dahi + Other = All (line count)', milk.lines + dahi.lines + all.otherLines === all.lines);
  check('every line is in exactly one group', lines.every((l) => ['Milk', 'Dahi', 'Other'].includes(l.category_group)));

  const detailedMilk = sum(orders, (o) => o.milk_value);
  const detailedDahi = sum(orders, (o) => o.dahi_value);
  const detailedOther = sum(orders, (o) => o.other_value);
  check('Item Sales Milk total == Detailed milk_value', near(milk.total, detailedMilk), `${milk.total} vs ${detailedMilk}`);
  check('Item Sales Dahi total == Detailed dahi_value', near(dahi.total, detailedDahi), `${dahi.total} vs ${detailedDahi}`);
  check('Item Sales Other total == Detailed other_value', near(all.otherValue, detailedOther));
  check('Milk line counts agree', milk.lines === sum(orders, (o) => o.milk_lines));
  check('Dahi line counts agree', dahi.lines === sum(orders, (o) => o.dahi_lines));
  check('litres agree between the two views', near(milk.quantity, sum(orders, (o) => o.milk_qty)), `${milk.quantity} L`);
  check('kilograms agree between the two views', near(dahi.quantity, sum(orders, (o) => o.dahi_qty)), `${dahi.quantity} kg`);
  const dSummary = detailedView.summarize(orders, 'Milk');
  check("the Detailed footer's Milk total agrees too", near(dSummary.total, milk.total));

  console.log('\nThe ambiguous names');
  const byName = (n) => lines.find((l) => l.item_name === n);
  check("orphan '1 Litre' is Milk, marked inferred", byName('1 Litre') && lines.filter((l) => l.item_name === '1 Litre' && l.category_inferred).every((l) => l.category_group === 'Milk'));
  check("'milk ' (no menu item) is NOT guessed: Other + CHECK NAME", byName('milk ').category_group === 'Other' && byName('milk ').category_review === true);
  check("'2 Ltr' is not guessed either", byName('2 Ltr').category_group === 'Other' && byName('2 Ltr').category_review === true);
  check("'Yogurt' is not guessed either", byName('Yogurt').category_group === 'Other' && byName('Yogurt').category_review === true);
  check("the deal is 'Deals', Other, not flagged", byName('Family Deal').category === 'Deals' && byName('Family Deal').category_group === 'Other' && !byName('Family Deal').category_review);
  check("'Delivery box' is plain Other with nothing to review", byName('Delivery box').category_group === 'Other' && !byName('Delivery box').category_review);
  const cust = byName('Milk (0.6300 L)');
  check('a custom Milk line: amount is its quantity in litres', cust.category_group === 'Milk' && near(cust.amount, 0.63));
  check("a '2 Litre' pack x3 is 6 litres, not 3", near(lines.find((l) => l.item_name === '2 Litre' && l.quantity === 3).amount, 6));
  check('a price-0 staff line stays in the counts (Milk, value 0)', lines.some((l) => l.unit_price === 0 && l.category_group === 'Milk'));

  console.log('\nTotals never depend on what is drawn');
  const drawn = lines.slice(0, 500);    // the screen draws at most this many rows
  const drawnTotal = Math.round(sum(drawn, (l) => l.line_total) * 100) / 100;
  const milkSql = db.prepare(`SELECT ROUND(SUM(oi.price * oi.quantity), 2) v FROM order_items oi JOIN orders o ON o.id = oi.order_id
                              LEFT JOIN menu_items m ON m.id = oi.menu_item_id AND oi.is_deal = 0
                              WHERE o.status != 'voided' AND (m.category = 'Milk' OR (m.id IS NULL AND oi.is_deal = 0 AND oi.name IN ('1 Litre','2 Litre','0.5 Litre') ))`).get().v;
  check('the footer total covers all lines, not the 500 drawn', all.lines > drawn.length && all.total > drawnTotal, `${all.lines} lines, total ${all.total}; the 500 drawn only sum to ${drawnTotal}`);
  check('and the filtered footer covers every Milk line too', milk.lines === filterLineItems(lines, 'Milk').length);
  check('Milk total matches independent SQL (menu category + confirmed orphan names)', near(milk.total, milkSql), `${milk.total} vs ${milkSql}`);

  // ------------------------------------------------------------- Manager
  console.log('\nManager scoping');
  user = { staffId: 2, role: 'Manager', name: 'Mgr' };
  const mLines = await get('/line-items' + RANGE);
  const mOrders = await get('/detailed' + RANGE);
  const mTruth = db.prepare(`SELECT COUNT(*) n, ROUND(SUM(oi.price * oi.quantity), 2) v FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status != 'voided' AND o.cashier_id = 2`).get();
  check("a manager sees only their own lines", mLines.length === mTruth.n && mLines.every((l) => l.cashier_name === 'c2'), `${mLines.length} of ${lines.length}`);
  check("and only their own value", near(summarizeLineItems(mLines, 'all').total, mTruth.v));
  const mm = summarizeLineItems(mLines, 'Milk');
  check("their Milk total agrees between Item Sales and Detailed", near(mm.total, sum(mOrders, (o) => o.milk_value)));
  check("their orders in Detailed are only their own", mOrders.every((o) => o.cashier_id === 2));
  user = { staffId: 1, role: 'Admin', name: 'Owner' };

  // -------------------------------------------------------- Stock movement
  console.log('\nStock statement');
  const milkId = db.prepare("SELECT id FROM ingredients WHERE name = 'Milk'").get().id;
  const ins = db.prepare('INSERT INTO inventory_entries (ingredient_id, type, amount, entry_date) VALUES (?, ?, ?, ?)');
  ins.run(milkId, 'stock', 100, '2026-09-16'); ins.run(milkId, 'sale', -30, '2026-09-16');
  ins.run(milkId, 'stock', -4, '2026-09-17'); ins.run(milkId, 'waste', -2, '2026-09-17'); ins.run(milkId, 'sale', -10, '2026-09-18');
  db.prepare('UPDATE ingredients SET stock = ? WHERE id = ?').run(54, milkId);
  const sm = (await get('/stock-movement?from=2026-09-16&to=2026-09-19')).filter((r) => r.name === 'Milk');
  let prev = null;
  for (const r of sm) {
    const adds = near(r.opening_balance + r.restocked + r.converted - r.sold - r.waste + r.adjustment, r.closing_balance);
    check(`${r.date}: Opening + Restocked ± Converted − Sold − Waste ± Other = Closing`, adds, `${r.opening_balance} -> ${r.closing_balance}`);
    if (prev) check(`${r.date}: Opening equals the previous Closing`, near(prev.closing_balance, r.opening_balance));
    prev = r;
  }
  check('the manual removal shows up as Other, not lost', near(sm.find((r) => r.date === '2026-09-17').adjustment, -4));

  server.close();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
