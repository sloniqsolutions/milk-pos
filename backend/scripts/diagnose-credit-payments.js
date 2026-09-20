/**
 * Compares this till's credit payments with the cloud's, and says what is missing and why.
 * Read-only unless you add --apply.
 *
 *   node scripts/run-script.js scripts/diagnose-credit-payments.js            (report only — changes nothing)
 *   node scripts/run-script.js scripts/diagnose-credit-payments.js --apply    (then add what is missing)
 *
 * Close the till first (this opens its database like the app does). It asks the cloud, with this till's own
 * pairing, for the payments the dashboard adds up, and prints for each filter what the dashboard's card reads
 * against what this till's card reads, then every cloud payment this till does not have, and every one it cannot
 * place. The cloud key is never printed. `--db "<path>"` names the database if it is not the default one.
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const optDb = (() => { const i = argv.indexOf('--db'); return i >= 0 ? argv[i + 1] : null; })();

const candidates = [
  optDb,
  process.env.POS_USER_DATA_PATH && path.join(process.env.POS_USER_DATA_PATH, 'pos_database.db'),
  process.env.APPDATA && path.join(process.env.APPDATA, 'pure-milk-pos', 'data', 'pos_database.db'),
  path.join(__dirname, '..', 'pos_database.db'),
].filter(Boolean);
const dbPath = candidates.find((p) => fs.existsSync(p));
if (!dbPath) { console.error('Could not find pos_database.db. Pass --db "<full path>".'); process.exit(1); }
process.env.POS_USER_DATA_PATH = path.dirname(dbPath);

const db = require('../db/database');
const { readCloudConfig } = require('../db/cloud-config');
const { getJson } = require('../db/cloud-http');
const { applyCreditPayments, catchUpCreditPayments } = require('../sync/payments-catchup');

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const back = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
const FILTERS = {
  'Today': [back(0), back(0)],
  'Yesterday': [back(1), back(1)],
  'Last 7 Days': [back(6), back(0)],
  'Last 30 Days': [back(29), back(0)],
  'This Month': [`${ymd(new Date()).slice(0, 8)}01`, back(0)],
  'This Year': [`${new Date().getFullYear()}-01-01`, back(0)],
};

(async () => {
  const config = readCloudConfig();
  if (!config) { console.error('This till is not paired to a cloud (no cloud-sync.json), so there is nothing to compare with.'); process.exit(1); }
  console.log(`Database: ${dbPath}\nCloud:    ${config.cloudUrl}  (branch ${config.branchId})\n`);

  const payload = await getJson(config.cloudUrl, '/api/restore/credit-payments?after=0', config.apiKey, { timeoutMs: 120000 });
  const cloudPayments = payload.payments || [];
  if (!Array.isArray(payload.payments)) {
    console.error('The cloud did not answer with a payment list. It probably has not been updated with /api/restore/credit-payments yet — deploy the cloud first.');
    process.exit(1);
  }

  const localReal = () => db.prepare("SELECT created_at, amount FROM credit_payments WHERE COALESCE(note, '') NOT LIKE 'Restored from cloud backup%'").all();
  const sumIn = (rows, from, to) => rows.filter((r) => String(r.created_at).slice(0, 10) >= from && String(r.created_at).slice(0, 10) <= to).reduce((n, r) => n + Number(r.amount), 0);

  const plan = applyCreditPayments(payload, { dryRun: true });
  const local = localReal();
  console.log('Credit Collected, per filter:');
  console.log('  FILTER         DASHBOARD (cloud)   THIS TILL');
  for (const [name, [from, to]] of Object.entries(FILTERS)) {
    const c = Math.round(sumIn(cloudPayments, from, to) * 100) / 100;
    const l = Math.round(sumIn(local, from, to) * 100) / 100;
    console.log(`  ${name.padEnd(14)} ${String(c).padStart(12)} ${String(l).padStart(14)}   ${c === l ? '' : '<-- differs'}`);
  }

  console.log(`\nThe cloud holds ${cloudPayments.length} payment(s). This till already has ${plan.matched}.`);
  console.log(`Missing here: ${plan.wouldInsert.length}${plan.wouldInsert.length ? '' : '  (nothing to add)'}`);
  plan.wouldInsert.slice(0, 40).forEach((p) => console.log(`   + ${p.created_at}  ${String(p.amount).padStart(8)}  ${String(p.by || '-').padEnd(12)} pushed by ${p.device}`));
  console.log(`Cannot be placed (customer not on this till): ${plan.unresolved.length}`);
  plan.unresolved.slice(0, 40).forEach((p) => console.log(`   ? ${p.created_at}  ${String(p.amount).padStart(8)}  cloud customer #${p.customer_local_id} (pushed by ${p.device_id})`));

  if (APPLY) {
    const r = await catchUpCreditPayments({ force: true });
    console.log(`\nApplied: ${r.inserted} payment(s) added${r.standInReduced ? `, ${r.standInReduced} moved off the restore's lump sum` : ''}. Re-run without --apply to compare again.`);
  } else if (plan.wouldInsert.length) {
    console.log('\nNothing was changed. Re-run with --apply to add the missing payments (the till also does this by itself once it is running).');
  }
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
