/**
 * The two Reports cards "Milk Sold to Customers" and "Credit Collected" (customer count).
 *
 *   cd backend
 *   node scripts/run-script.js test/customer-kpi-cards.js
 *
 * Runs on its own empty throwaway database (never the shop's). Five orders: three to
 * registered customers (some cash, some credit), two walk-in. Then credit payments, then a
 * void. The card figures are also cross-checked against /reports/detailed, which is the
 * source the card is meant to share. Exits non-zero on any failure.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.POS_USER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-customer-kpi-'));

const db = require('../db/database');
const express = require('express');

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
  if (!cond) failures++;
};
const near = (a, b) => Math.abs(a - b) < 0.0001;

(async () => {
  const menuId = (name, category) => db.prepare('SELECT id FROM menu_items WHERE name = ? AND category = ?').get(name, category).id;
  const L1 = menuId('1 Litre', 'Milk');
  const L2 = menuId('2 Litre', 'Milk');
  const DAHI = menuId('Dahi', 'Dahi');

  const DAY = '2026-09-18';
  const OTHER_DAY = '2026-09-10';

  db.prepare("INSERT INTO staff (id, name, role, pin) VALUES (5, 'Owner', 'Owner', 'x')").run();
  db.prepare("INSERT INTO customers (id, name, phone) VALUES (1, 'Suleman', '03002222222'), (2, 'Ali', '03003333333'), (3, 'Bilal', '03004444444')").run();

  const insOrder = db.prepare(`INSERT INTO orders (total, discount, payment_method, status, cashier_id, cashier_name, created_at, customer_id)
                               VALUES (?, 0, ?, 'completed', 5, 'Owner', ?, ?)`);
  const insLine = db.prepare('INSERT INTO order_items (order_id, menu_item_id, name, price, quantity, is_deal) VALUES (?, ?, ?, ?, ?, 0)');
  const order = (customerId, payment, lines, when = `${DAY} 10:00:00`) => {
    const total = lines.reduce((s, l) => s + l[2] * l[3], 0);
    const id = insOrder.run(total, payment, when, customerId).lastInsertRowid;
    lines.forEach(([mid, name, price, qty]) => insLine.run(id, mid, name, price, qty));
    return Number(id);
  };

  // Three to registered customers, two walk-in. Dahi on one customer order must not count as milk.
  const A = order(1, 'Credit', [[L1, '1 Litre', 200, 2]]);                                            // 2 L   Rs 400
  const B = order(2, 'Cash', [[L1, 'Milk (0.6300 L)', 200, 0.63]]);                                   // 0.63 L Rs 126
  const C = order(1, 'Credit', [[L2, '2 Litre', 400, 1], [DAHI, 'Dahi (192 g)', 520, 0.1923]]);        // 2 L   Rs 400 (+ dahi)
  const D = order(null, 'Cash', [[L1, '1 Litre', 200, 5]]);                                           // walk-in
  const E = order(null, 'Cash', [[L2, '2 Litre', 400, 3]]);                                           // walk-in
  // Same customer on a different day: outside the range under test.
  order(1, 'Credit', [[L1, '1 Litre', 200, 7]], `${OTHER_DAY} 10:00:00`);

  const pay = db.prepare('INSERT INTO credit_payments (customer_id, amount, note, created_at) VALUES (?, ?, ?, ?)');
  pay.run(1, 300, null, `${DAY} 12:00:00`);
  pay.run(2, 150, null, `${DAY} 13:00:00`);
  pay.run(1, 50, null, `${DAY} 14:00:00`);                                         // same customer again
  pay.run(3, 999, null, `${OTHER_DAY} 12:00:00`);                                  // out of range
  pay.run(3, 777, 'Restored from cloud backup — individual payment history before this date is not available.', `${DAY} 15:00:00`);

  const app = express();
  app.use((req, _r, next) => { req.user = { staffId: 5, role: 'Admin', name: 'Owner' }; next(); });
  app.use('/api/reports', require('../routes/reports'));
  const server = app.listen(0);
  const get = async (p) => (await fetch(`http://127.0.0.1:${server.address().port}/api/reports${p}`)).json();
  const RANGE = `?from=${DAY}&to=${DAY}`;

  console.log('\nMilk Sold to Customers: 3 customer orders, 2 walk-in');
  let k = await get('/kpi' + RANGE);
  check('litres = 4.63 (2 + 0.63 + 2) — walk-in and other-day orders left out', near(k.customer_milk_litres, 4.63), String(k.customer_milk_litres));
  check('value = Rs 926 (400 + 126 + 400) — the dahi on order C is not counted', near(k.customer_milk_value, 926), String(k.customer_milk_value));

  console.log('\nThe card shares the Detailed report\'s numbers');
  const detailed = await get('/detailed' + RANGE);
  const mine = detailed.filter((o) => [A, B, C].includes(o.id));
  check('the 3 customer orders are in Detailed', mine.length === 3);
  check('card litres = sum of Detailed milk_qty over those orders', near(k.customer_milk_litres, mine.reduce((s, o) => s + o.milk_qty, 0)));
  check('card value = sum of Detailed milk_value over those orders', near(k.customer_milk_value, mine.reduce((s, o) => s + o.milk_value, 0)));

  console.log('\nCredit Collected: 3 payments from 2 customers in range');
  check('collected = Rs 500 (300 + 150 + 50), out-of-range and restore stand-in left out', near(k.credit_collected, 500), String(k.credit_collected));
  check('customers = 2 (Suleman paid twice)', k.credit_customers === 2, String(k.credit_customers));

  console.log('\nThe date range drives both');
  k = await get(`/kpi?from=${OTHER_DAY}&to=${OTHER_DAY}`);
  check('other day: milk = 7 L, Rs 1400', near(k.customer_milk_litres, 7) && near(k.customer_milk_value, 1400), `${k.customer_milk_litres} / ${k.customer_milk_value}`);
  check('other day: credit = Rs 999 from 1 customer', near(k.credit_collected, 999) && k.credit_customers === 1);
  k = await get('/kpi?from=2026-01-01&to=2026-01-02');
  check('an empty range reads 0 / 0 / 0', k.customer_milk_litres === 0 && k.customer_milk_value === 0 && k.credit_customers === 0);

  console.log('\nVoiding a customer order updates the card');
  db.prepare("UPDATE orders SET status = 'voided' WHERE id = ?").run(C);
  k = await get('/kpi' + RANGE);
  check('litres = 2.63 after voiding C', near(k.customer_milk_litres, 2.63), String(k.customer_milk_litres));
  check('value = Rs 526 after voiding C', near(k.customer_milk_value, 526), String(k.customer_milk_value));
  check('credit collected is unchanged by a void', near(k.credit_collected, 500) && k.credit_customers === 2);

  console.log('\nExisting figures are untouched');
  check('orders processed counts the 4 non-voided orders of the day', k.total_orders === 4, String(k.total_orders));
  check('revenue is the 4 non-voided orders: 400 + 126 + 1000 + 1200', near(k.total_revenue, 2726), String(k.total_revenue));

  server.close();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
