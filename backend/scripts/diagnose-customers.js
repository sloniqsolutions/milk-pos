/**
 * READ-ONLY look at customers, credit payments and how this till was seeded
 * from the cloud. Changes nothing (opened with `readonly: true`; db/database.js,
 * which runs migrations, is not loaded). Never prints the cloud API key.
 *
 *   node scripts/run-script.js scripts/diagnose-customers.js [--db "<path>"] [--json]
 *
 * Database lookup is the same as scripts/audit-item-names.js.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

const dbPath = [
  option('--db'),
  process.env.POS_USER_DATA_PATH && path.join(process.env.POS_USER_DATA_PATH, 'pos_database.db'),
  process.env.APPDATA && path.join(process.env.APPDATA, 'pure-milk-pos', 'data', 'pos_database.db'),
  path.join(__dirname, '..', 'pos_database.db'),
].filter(Boolean).find((p) => fs.existsSync(p));
if (!dbPath) { console.error('Could not find pos_database.db. Pass --db "<full path>".'); process.exit(1); }

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const all = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (e) { return [{ error: e.message }]; } };

const customers = all(`
  SELECT c.id, c.name, c.phone, c.active, c.created_at,
         (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS orders,
         (SELECT COALESCE(SUM(total), 0) FROM orders o WHERE o.customer_id = c.id AND o.payment_method = 'Credit' AND o.status = 'completed') AS credited,
         (SELECT COALESCE(SUM(amount), 0) FROM credit_payments p WHERE p.customer_id = c.id) AS paid,
         (SELECT COUNT(*) FROM credit_payments p WHERE p.customer_id = c.id) AS payments,
         (SELECT device_id || '#' || orig_id FROM cloud_identity i WHERE i.tbl = 'customers' AND i.local_id = c.id) AS cloud_row
    FROM customers c ORDER BY lower(trim(c.name)), c.id`);

const payments = all(`
  SELECT id, customer_id, amount, received_by, received_by_id, shift_id, created_at,
         CASE WHEN COALESCE(note, '') LIKE 'Restored from cloud backup%' THEN 1 ELSE 0 END AS restored_placeholder
    FROM credit_payments ORDER BY created_at`);

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const groups = new Map();
for (const c of customers) {
  const key = norm(c.name);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(c);
}
const duplicateNames = [...groups.values()].filter((g) => g.length > 1);

const byDay = all(`
  SELECT DATE(created_at) AS day,
         ROUND(SUM(amount), 2) AS all_payments,
         ROUND(SUM(CASE WHEN COALESCE(note, '') LIKE 'Restored from cloud backup%' THEN amount ELSE 0 END), 2) AS restored_placeholders,
         ROUND(SUM(CASE WHEN received_by_id IS NULL THEN amount ELSE 0 END), 2) AS no_receiver
    FROM credit_payments GROUP BY DATE(created_at) ORDER BY day`);

// What the Reports "Credit Collected" card reads for each date filter, worked out the way the card does it
// (payments dated in the range, the restore's stand-in excluded) — so a card that looks wrong can be compared
// with what the database really holds.
const cardFor = (from, to) => (all(
  `SELECT COALESCE(SUM(amount), 0) AS v, COUNT(*) AS n FROM credit_payments
    WHERE DATE(created_at) BETWEEN DATE(${from}) AND DATE(${to})
      AND COALESCE(note, '') NOT LIKE 'Restored from cloud backup%'`)[0]);
const creditCollectedByFilter = {
  'Today': cardFor("'now', 'localtime'", "'now', 'localtime'"),
  'Yesterday': cardFor("'now', 'localtime', '-1 day'", "'now', 'localtime', '-1 day'"),
  'Last 7 Days': cardFor("'now', 'localtime', '-6 days'", "'now', 'localtime'"),
  'Last 30 Days': cardFor("'now', 'localtime', '-29 days'", "'now', 'localtime'"),
  'This Month': cardFor("'now', 'localtime', 'start of month'", "'now', 'localtime'"),
  'This Year': cardFor("'now', 'localtime', 'start of year'", "'now', 'localtime'"),
};
const recentPayments = all(`
  SELECT p.id, p.created_at, p.amount, c.name AS customer, p.received_by,
         CASE WHEN COALESCE(p.note, '') LIKE 'Restored from cloud backup%' THEN 'stand-in (not counted)' ELSE 'real' END AS kind
    FROM credit_payments p LEFT JOIN customers c ON c.id = p.customer_id
   ORDER BY p.created_at DESC LIMIT 25`);

const report = {
  database: dbPath,
  credit_collected_by_filter: creditCollectedByFilter,
  recent_payments: recentPayments,
  settings: all("SELECT key, value FROM settings WHERE key LIKE 'cloud%' OR key LIKE 'migration%'"),
  customers,
  duplicate_names: duplicateNames,
  credit_payments: payments,
  credit_payments_by_day: byDay,
  staff: all('SELECT id, name, role, active FROM staff'),
};

if (argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Database: ${dbPath}`);
  console.log('Settings:', JSON.stringify(report.settings));
  console.log(`\nCustomers (${customers.length}):`);
  customers.forEach((c) => console.log(`  #${c.id} ${c.name} | ${c.phone || 'no phone'} | active=${c.active} | orders=${c.orders} | credited=${c.credited} paid=${c.paid} (${c.payments} pmts) | cloud=${c.cloud_row || 'made here'}`));
  console.log(`\nSame name more than once: ${duplicateNames.length ? duplicateNames.map((g) => g.map((c) => `#${c.id}`).join(' & ') + ' ' + g[0].name).join('; ') : 'none'}`);
  console.log('\nWhat the Credit Collected card should read, per filter (real payments only):');
  for (const [name, r] of Object.entries(creditCollectedByFilter)) console.log(`  ${name.padEnd(13)} ${String(r.v).padStart(10)}   (${r.n} payment${r.n === 1 ? '' : 's'})`);
  console.log('\nThe 25 most recent payments (date, amount, who, real or stand-in):');
  recentPayments.forEach((p) => console.log(`  ${p.created_at}  ${String(p.amount).padStart(8)}  ${String(p.customer).padEnd(16)} ${String(p.received_by || '-').padEnd(10)} ${p.kind}`));
  console.log('\nCredit payments by day:', JSON.stringify(byDay));
  console.log('\n----- JSON (paste everything below back) -----');
  console.log(JSON.stringify(report));
}
db.close();
