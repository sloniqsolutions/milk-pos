/**
 * Payments the cloud has that a till failed to take in — the cases where the POS card is lower than the dashboard.
 *
 *   node scripts/run-script.js test/credit-gaps.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-credit-gaps-'));
process.env.POS_USER_DATA_PATH = dir;
const pad = (n) => String(n).padStart(2, '0');
const day = (back) => { const x = new Date(Date.now() - back * 864e5); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
let failures = 0;
const check = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`); if (!cond) failures++; };
const near = (a, b) => Math.abs(a - b) < 0.005;

(async () => {
  const { getDeviceId } = require('../db/activation-config');
  const ME = getDeviceId();                                    // this till's own device id
  const CLOUD = { customers: [], payments: [] };
  const cloud = http.createServer((req, res) => {
    const after = Number(new URL(req.url, 'http://x').searchParams.get('after')) || 0;
    const payments = CLOUD.payments.filter((p) => p.received_at > after);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ payments, customers: payments.length ? CLOUD.customers : [], next_after: payments.length ? Math.max(...payments.map((p) => p.received_at)) : after }));
  });
  await new Promise((r) => cloud.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(dir, 'cloud-sync.json'), JSON.stringify({ enabled: true, cloud_url: `http://127.0.0.1:${cloud.address().port}`, branch_id: 1, branch_name: 'x', api_key: 'k'.repeat(64) }));

  const db = require('../db/database');
  const { catchUpCreditPayments } = require('../sync/payments-catchup');
  const sum = () => db.prepare("SELECT COALESCE(SUM(amount),0) s FROM credit_payments WHERE COALESCE(note,'') NOT LIKE 'Restored from cloud backup%'").get().s;
  const count = () => db.prepare("SELECT COUNT(*) n FROM credit_payments WHERE COALESCE(note,'') NOT LIKE 'Restored from cloud backup%'").get().n;

  db.prepare("INSERT INTO customers (id, name, phone) VALUES (1, 'Suleman', '03002222222'), (2, 'Ali', '03003333333')").run();
  CLOUD.customers = [
    { local_id: 1, device_id: ME, name: 'Suleman', phone: '03002222222', total_paid: 0 },
    { local_id: 2, device_id: ME, name: 'Ali', phone: '03003333333', total_paid: 0 },
    { local_id: 3, device_id: ME, name: 'Ghost', phone: '03009999999', total_paid: 0 },     // a customer this till does not have (yet)
  ];
  const pay = (id, device, cust, amount, back, time, at) => ({ local_id: id, device_id: device, customer_local_id: cust, amount, received_by: 'Owner', created_at: `${day(back)} ${time}`, received_at: at });

  console.log('\nA. Payments THIS till pushed, but which an earlier restore wiped locally');
  // The cloud has them (pushed under this till's own id); the local table has only a lump stand-in.
  CLOUD.payments = [pay(1, ME, 1, 400, 20, '10:00:00', 1), pay(2, ME, 2, 300, 12, '10:00:00', 2), pay(3, ME, 1, 330, 1, '11:00:00', 3)];
  db.prepare("INSERT INTO credit_payments (customer_id, amount, note, created_at) VALUES (1, 730, 'Restored from cloud backup — x', ?)").run(`${day(0)} 08:00:00`);
  await catchUpCreditPayments({ force: true });
  check('all three come back (1030), not just what other tills pushed', near(sum(), 1030), String(sum()));

  console.log('\nB. The same payment must not be counted twice (own copy still there, its time slightly different)');
  db.prepare('DELETE FROM credit_payments').run();
  db.prepare("INSERT INTO credit_payments (customer_id, amount, note, received_by, created_at) VALUES (1, 330, NULL, 'Owner', ?)").run(`${day(1)} 06:00:00`);   // same day, an hour shifted
  CLOUD.payments = [pay(3, ME, 1, 330, 1, '11:00:00', 3)];
  db.prepare("DELETE FROM settings WHERE key = 'cloud_credit_payment_cursor'").run();
  await catchUpCreditPayments({ force: true });
  check('still one payment of 330', count() === 1 && near(sum(), 330), `${count()} rows, ${sum()}`);

  console.log('\nC. Two genuine payments of the same amount on one day are BOTH kept');
  db.prepare('DELETE FROM credit_payments').run();
  CLOUD.payments = [pay(10, ME, 2, 100, 2, '09:00:00', 10), pay(11, ME, 2, 100, 2, '17:00:00', 11)];
  db.prepare("DELETE FROM settings WHERE key = 'cloud_credit_payment_cursor'").run();
  await catchUpCreditPayments({ force: true });
  check('two payments of 100', count() === 2 && near(sum(), 200), `${count()} rows, ${sum()}`);

  console.log('\nD. A payment whose customer is not here YET is retried, not lost');
  db.prepare('DELETE FROM credit_payments').run();
  CLOUD.payments = [pay(20, ME, 3, 500, 3, '12:00:00', 20), pay(21, ME, 1, 50, 1, '12:00:00', 21)];
  db.prepare("DELETE FROM settings WHERE key = 'cloud_credit_payment_cursor'").run();
  await catchUpCreditPayments({ force: true });
  check('the resolvable one is in (50); the Ghost one is waiting', near(sum(), 50), String(sum()));
  db.prepare("INSERT INTO customers (id, name, phone) VALUES (3, 'Ghost', '03009999999')").run();   // the customer arrives later
  await catchUpCreditPayments({ force: true });
  check('once the customer exists, the earlier payment is picked up (550)', near(sum(), 550), String(sum()));

  cloud.close();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
