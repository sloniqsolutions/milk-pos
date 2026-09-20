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

const report = {
  database: dbPath,
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
  console.log('\nCredit payments by day:', JSON.stringify(byDay));
  console.log('\n----- JSON (paste everything below back) -----');
  console.log(JSON.stringify(report));
}
db.close();
