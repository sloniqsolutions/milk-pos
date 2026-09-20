/**
 * "Credit collected" on EVERY date filter the Reports screen offers, with payments placed exactly on
 * each boundary (last second of a day, first second of the next, the edge of every range).
 *
 *   cd backend
 *   node scripts/run-script.js test/credit-filters.js
 *
 * The ranges are computed with the same moment() code as frontend/src/pages/Reports.jsx. The expected figure for
 * each is worked out here, independently, by comparing plain date strings — not with the route's SQL.
 * Payments are recorded both ways a till gets them: directly dated (as a restore / catch-up writes them) and
 * through the real POST /customers/:id/payments route (as a cashier does it). Exits non-zero on any failure.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.POS_USER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-credit-filters-'));

const db = require('../db/database');
const express = require('express');
const moment = require(path.join(__dirname, '..', '..', 'frontend', 'node_modules', 'moment'));

let failures = 0;
const check = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`); if (!cond) failures++; };

// ---- exactly Reports.jsx's filter -> range mapping
const rangeFor = (filter, customFrom, customTo) => {
  if (filter === 'custom') return { from: customFrom, to: customTo };
  const today = moment().format('YYYY-MM-DD');
  switch (filter) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const y = moment().subtract(1, 'days').format('YYYY-MM-DD'); return { from: y, to: y }; }
    case 'last7': return { from: moment().subtract(6, 'days').format('YYYY-MM-DD'), to: today };
    case 'last30': return { from: moment().subtract(29, 'days').format('YYYY-MM-DD'), to: today };
    case 'thisMonth': return { from: moment().startOf('month').format('YYYY-MM-DD'), to: today };
    case 'thisYear': return { from: moment().startOf('year').format('YYYY-MM-DD'), to: today };
    default: throw new Error(filter);
  }
};

(async () => {
  db.prepare("INSERT INTO staff (id, name, role, pin) VALUES (7, 'Owner', 'Owner', 'x1'), (8, 'Sara', 'Manager', 'x2')").run();
  db.prepare("INSERT INTO customers (id, name, phone) VALUES (1, 'A', '03000000001'), (2, 'B', '03000000002')").run();
  // Plenty of credit sales so every payment is allowed by the route's "cannot exceed the balance" rule.
  db.prepare("INSERT INTO orders (total, payment_method, status, customer_id, created_at) VALUES (1000000, 'Credit', 'completed', 1, '2020-01-01 10:00:00'), (1000000, 'Credit', 'completed', 2, '2020-01-01 10:00:00')").run();

  const ins = db.prepare('INSERT INTO credit_payments (customer_id, amount, note, received_by, received_by_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const payments = []; // what the oracle checks: { date, amount, receiver, counts }
  const add = (whenMoment, amount, { receiver = 7, note = null, counts = true } = {}) => {
    const created = whenMoment.format('YYYY-MM-DD HH:mm:ss');
    ins.run(1, amount, note, receiver === 7 ? 'Owner' : 'Sara', receiver, created);
    payments.push({ date: created.slice(0, 10), amount, receiver, counts });
  };
  const at = (m, time) => moment(`${m.format('YYYY-MM-DD')} ${time}`, 'YYYY-MM-DD HH:mm:ss');
  const today = moment();

  // Boundaries of every filter: the first and last instant either side of each edge.
  const edges = [
    today, today.clone().subtract(1, 'days'),
    today.clone().subtract(5, 'days'), today.clone().subtract(6, 'days'), today.clone().subtract(7, 'days'),         // last-7 edge
    today.clone().subtract(28, 'days'), today.clone().subtract(29, 'days'), today.clone().subtract(30, 'days'),      // last-30 edge
    today.clone().startOf('month'), today.clone().startOf('month').subtract(1, 'days'),                              // this-month edge
    today.clone().startOf('year'), today.clone().startOf('year').subtract(1, 'days'),                                // this-year edge
  ];
  let amount = 1;
  for (const e of edges) {
    add(at(e, '00:00:00'), amount++);        // first second of the day
    add(at(e, '23:59:59'), amount++);        // last second of the day
  }
  add(today.clone().subtract(2, 'days'), 9000, { note: 'Restored from cloud backup — individual payment history before this date is not available.', counts: false });   // the stand-in: never "collected"
  add(today.clone().subtract(3, 'days'), 500, { receiver: 8 });                                                                                             // taken by the manager
  add(today.clone().subtract(3, 'days'), 40, { receiver: 7 });

  // Through the real route, as a cashier does it: lands "now", in local time.
  const app = express(); app.use(express.json());
  let user = { staffId: 7, role: 'Admin', name: 'Owner' };
  app.use((req, _r, next) => { req.user = user; next(); });
  app.use('/api/reports', require('../routes/reports'));
  app.use('/api/customers', require('../routes/customers'));
  const server = app.listen(0);
  const url = (p) => `http://127.0.0.1:${server.address().port}/api${p}`;
  const kpi = async (r) => (await (await fetch(url(`/reports/kpi?from=${r.from}&to=${r.to}`))).json()).credit_collected;

  const routePay = await fetch(url('/customers/2/payments'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 777 }) });
  check('a payment recorded through the real route is accepted', routePay.status === 201);
  payments.push({ date: moment().format('YYYY-MM-DD'), amount: 777, receiver: 7, counts: true });

  const oracle = (r, receiver) => Math.round(payments
    .filter((p) => p.counts && p.date >= r.from && p.date <= r.to && (receiver == null || p.receiver === receiver))
    .reduce((s, p) => s + p.amount, 0) * 100) / 100;

  console.log(`\nToday is ${today.format('YYYY-MM-DD')}. Administrator, every filter:`);
  const filters = [['Today', 'today'], ['Yesterday', 'yesterday'], ['Last 7 Days', 'last7'], ['Last 30 Days', 'last30'], ['This Month', 'thisMonth'], ['This Year', 'thisYear']];
  for (const [label, key] of filters) {
    const r = rangeFor(key);
    const got = await kpi(r); const want = oracle(r);
    check(`${label.padEnd(12)} ${r.from} to ${r.to}`, got === want, `card ${got}, expected ${want}`);
  }
  const custom = [
    { from: today.clone().subtract(10, 'days').format('YYYY-MM-DD'), to: today.clone().subtract(3, 'days').format('YYYY-MM-DD') },
    { from: today.clone().subtract(3, 'days').format('YYYY-MM-DD'), to: today.clone().subtract(3, 'days').format('YYYY-MM-DD') },
    { from: '2000-01-01', to: today.format('YYYY-MM-DD') },
  ];
  for (const r of custom) {
    const got = await kpi(r); const want = oracle(r);
    check(`Custom       ${r.from} to ${r.to}`, got === want, `card ${got}, expected ${want}`);
  }

  console.log('\nThe boundaries, one day at a time:');
  const yesterday = rangeFor('yesterday');
  check("yesterday's 23:59:59 counts as yesterday, not today", (await kpi(yesterday)) === oracle(yesterday));
  const t = rangeFor('today');
  check("today's 00:00:00 counts as today, not yesterday", (await kpi(t)) === oracle(t));
  const l7 = rangeFor('last7'); const day7 = { from: today.clone().subtract(7, 'days').format('YYYY-MM-DD'), to: today.clone().subtract(7, 'days').format('YYYY-MM-DD') };
  check('a payment 7 days ago is outside Last 7 Days (which is today + the six before)', (await kpi(l7)) === oracle(l7) && (await kpi(day7)) === oracle(day7));

  console.log('\nThe stand-in is never collected, and a manager sees only their own:');
  const wide = { from: '2000-01-01', to: today.format('YYYY-MM-DD') };
  check('the 9000 restore stand-in is in no total', (await kpi(wide)) === oracle(wide) && oracle(wide) < 9000 + 100000);
  user = { staffId: 8, role: 'Manager', name: 'Sara' };
  const three = { from: today.clone().subtract(3, 'days').format('YYYY-MM-DD'), to: today.clone().subtract(3, 'days').format('YYYY-MM-DD') };
  check("a manager's card counts only what they took (500, not 540)", (await kpi(three)) === oracle(three, 8) && oracle(three, 8) === 500, `card ${await kpi(three)}`);
  user = { staffId: 7, role: 'Admin', name: 'Owner' };
  check('an administrator sees everyone (540)', (await kpi(three)) === oracle(three) && oracle(three) === 540);

  console.log('\nThe undated history is reported beside the card, and in no filter:');
  const full = await (await fetch(url(`/reports/kpi?from=${today.format('YYYY-MM-DD')}&to=${today.format('YYYY-MM-DD')}`))).json();
  check('the 9000 stand-in is reported as undated history', full.credit_undated === 9000, String(full.credit_undated));
  user = { staffId: 8, role: 'Manager', name: 'Sara' };
  const mgr = await (await fetch(url(`/reports/kpi?from=${today.format('YYYY-MM-DD')}&to=${today.format('YYYY-MM-DD')}`))).json();
  check("a manager's card does not show it (their card is only what they took)", mgr.credit_undated === 0);
  user = { staffId: 7, role: 'Admin', name: 'Owner' };

  server.close();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
