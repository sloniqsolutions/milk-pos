/**
 * "Credit collected" on a till that was restored the OLD way (one lump stand-in payment per customer).
 *
 *   cd backend
 *   node scripts/run-script.js test/credit-collected.js
 *
 * Builds that state on a throwaway database, points the till at a mock cloud that holds the real payments,
 * runs the catch-up (sync/payments-catchup.js) and checks the Reports card and every balance. Exits non-zero on failure.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-credit-collected-'));
process.env.POS_USER_DATA_PATH = dir;

const pad = (n) => String(n).padStart(2, '0');
const day = (back) => { const x = new Date(Date.now() - back * 864e5); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };

let failures = 0;
const check = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`); if (!cond) failures++; };
const near = (a, b) => Math.abs(a - b) < 0.005;

// The cloud: Suleman paid 100 yesterday and 230 today (330 in all), and Ali 200 three days ago. Suleman's
// payment of 100 was pushed twice by an older build. One payment (50, today) was taken by ANOTHER till AFTER
// this till was restored: it is new money, not part of the lump.
const CLOUD = {
  customers: [
    { local_id: 1, device_id: 'DEV', name: 'Suleman', phone: '03002222222', total_paid: 380 },
    { local_id: 1, device_id: 'legacy', name: 'Suleman', phone: '0300 2222222', total_paid: 380 },
    { local_id: 2, device_id: 'DEV', name: 'Ali', phone: '03003333333', total_paid: 200 },
  ],
  payments: [
    { local_id: 1, device_id: 'DEV', customer_local_id: 2, amount: 200, received_by: 'Owner', created_at: `${day(3)} 12:05:00`, received_at: 10 },
    { local_id: 2, device_id: 'DEV', customer_local_id: 1, amount: 100, received_by: 'Owner', created_at: `${day(1)} 11:05:00`, received_at: 11 },
    { local_id: 7, device_id: 'legacy', customer_local_id: 1, amount: 100, received_by: 'Owner', created_at: `${day(1)} 11:05:00`, received_at: 12 },
    { local_id: 3, device_id: 'DEV', customer_local_id: 1, amount: 230, received_by: 'Owner', created_at: `${day(0)} 09:05:00`, received_at: 13 },
  ],
};
let asked = [];
const cloud = http.createServer((req, res) => {
  asked.push(req.url);
  const after = Number(new URL(req.url, 'http://x').searchParams.get('after')) || 0;
  const payments = CLOUD.payments.filter((p) => p.received_at > after);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ payments, customers: payments.length ? CLOUD.customers : [], next_after: payments.length ? Math.max(...payments.map((p) => p.received_at)) : after }));
});

(async () => {
  await new Promise((r) => cloud.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(dir, 'cloud-sync.json'), JSON.stringify({ enabled: true, cloud_url: `http://127.0.0.1:${cloud.address().port}`, branch_id: 1, branch_name: 'x', api_key: 'k'.repeat(64) }));

  const db = require('../db/database');
  const express = require('express');
  const { catchUpCreditPayments } = require('../sync/payments-catchup');

  // ---- the till as the OLD restore left it: the customers, their credit orders, and ONE lump payment each.
  db.prepare("INSERT INTO staff (id, name, role, pin) VALUES (5, 'Owner', 'Owner', 'x')").run();
  db.prepare("INSERT INTO customers (id, name, phone) VALUES (1, 'Suleman', '03002222222'), (2, 'Ali', '03003333333')").run();
  const order = db.prepare("INSERT INTO orders (total, payment_method, status, customer_id, created_at) VALUES (?, 'Credit', 'completed', ?, ?)");
  order.run(1000, 1, `${day(6)} 10:00:00`); order.run(600, 2, `${day(6)} 10:00:00`);
  const note = 'Restored from cloud backup — individual payment history before this date is not available.';
  const lumpTime = `${day(0)} 10:00:00`;                       // the moment of the restore: after every payment it stands for
  db.prepare('INSERT INTO credit_payments (customer_id, amount, note, created_at) VALUES (?, ?, ?, ?)').run(1, 330, note, lumpTime);
  db.prepare('INSERT INTO credit_payments (customer_id, amount, note, created_at) VALUES (?, ?, ?, ?)').run(2, 200, note, lumpTime);

  const app = express();
  app.use((req, _r, next) => { req.user = { staffId: 5, role: 'Admin', name: 'Owner' }; next(); });
  app.use('/api/reports', require('../routes/reports'));
  app.use('/api/customers', require('../routes/customers'));
  const server = app.listen(0);
  const get = async (p) => (await fetch(`http://127.0.0.1:${server.address().port}/api${p}`)).json();
  const kpi = async (from, to) => (await get(`/reports/kpi?from=${from}&to=${to}`)).credit_collected;
  const balances = async () => Object.fromEntries((await get('/customers')).map((c) => [c.name, c.balance]));

  console.log('\nBefore the catch-up (the reported problem)');
  check('credit collected reads 0 today', (await kpi(day(0), day(0))) === 0);
  check('credit collected reads 0 on every other filter', (await kpi(day(6), day(0))) === 0 && (await kpi(day(1), day(1))) === 0);
  const before = await balances();
  check('balances: Suleman 670, Ali 400', near(before.Suleman, 670) && near(before.Ali, 400), JSON.stringify(before));

  console.log('\nAfter the catch-up');
  const r = await catchUpCreditPayments({ force: true });
  check('the real payments were added (Ali 1 + Suleman 2; the duplicate skipped)', r.inserted === 4 - 1, `${r.inserted} added`);
  check('yesterday = 100', near(await kpi(day(1), day(1)), 100));
  check('today = 230', near(await kpi(day(0), day(0)), 230));
  check('three days ago (Ali) = 200', near(await kpi(day(3), day(3)), 200));
  check('last 7 days = 530', near(await kpi(day(6), day(0)), 530));
  const after = await balances();
  check('balances are exactly what they were: Suleman 670, Ali 400 (the lump shrank by what was itemised)',
    near(after.Suleman, 670) && near(after.Ali, 400), JSON.stringify(after));
  const lumps = db.prepare("SELECT customer_id, amount FROM credit_payments WHERE note LIKE 'Restored from cloud backup%' ORDER BY customer_id").all();
  check('the leftover lump sum is 0 for both (all history is now itemised)', lumps.every((l) => near(l.amount, 0)), JSON.stringify(lumps));
  check('the payments carry who took them', db.prepare("SELECT COUNT(*) n FROM credit_payments WHERE received_by = 'Owner' AND received_by_id = 5").get().n === 3);

  console.log('\nRepeating it changes nothing');
  const again = await catchUpCreditPayments({ force: true });
  check('a second pass adds nothing and asks only for what is new', again.inserted === 0 && asked[asked.length - 1].includes('after=13'), asked[asked.length - 1]);
  check('credit collected and balances are unchanged', near(await kpi(day(6), day(0)), 530) && near((await balances()).Suleman, 670));

  console.log('\nA payment taken elsewhere AFTER the restore is new money');
  CLOUD.payments.push({ local_id: 4, device_id: 'DEV', customer_local_id: 1, amount: 50, received_by: 'Owner', created_at: `${day(0)} 15:00:00`, received_at: 14 });
  const late = await catchUpCreditPayments({ force: true });
  check('it is added', late.inserted === 1);
  check('today = 280', near(await kpi(day(0), day(0)), 280));
  check('and it lowers the balance by 50 (Suleman 620)', near((await balances()).Suleman, 620));

  server.close(); cloud.close();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
