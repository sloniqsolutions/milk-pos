/**
 * Merges customers that are the same person listed more than once.
 *
 *   node scripts/run-script.js scripts/merge-duplicate-customers.js            (DRY RUN — changes nothing)
 *   node scripts/run-script.js scripts/merge-duplicate-customers.js --apply    (does it, after a backup)
 *   ... add --db "<path to pos_database.db>" to name the database
 *
 * Same person = same phone number, or (no phone) the same name — the rule in
 * db/person-key.js. For each group one customer SURVIVES (the one with the most
 * history, then the lowest number) and the others are merged into it:
 *
 *   - every order of a duplicate is re-pointed at the survivor;
 *   - every real credit payment of a duplicate is re-pointed at the survivor;
 *   - the "Restored from cloud backup" stand-in payments are the one exception.
 *     Each duplicate row carried its own copy of the same history, so counting
 *     them all would double what the customer has paid. The largest one goes to
 *     the survivor; the others stay attached to the duplicate, not lost;
 *   - the duplicate is deactivated (never deleted) and its notes say where it went.
 *
 * The plan prints each person's balance before and after. Merging must not
 * change what anyone owes beyond removing the double-counting, so read it
 * before --apply. The dry run opens the database read-only.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { personKey } = require('../db/person-key');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

const dbPath = [
  option('--db'),
  process.env.POS_USER_DATA_PATH && path.join(process.env.POS_USER_DATA_PATH, 'pos_database.db'),
  process.env.APPDATA && path.join(process.env.APPDATA, 'pure-milk-pos', 'data', 'pos_database.db'),
  path.join(__dirname, '..', 'pos_database.db'),
].filter(Boolean).find((p) => fs.existsSync(p));
if (!dbPath) { console.error('Could not find pos_database.db. Pass --db "<full path>".'); process.exit(1); }

const isPlaceholder = (p) => String(p.note || '').startsWith('Restored from cloud backup');

function planFor(db) {
  const customers = db.prepare('SELECT id, name, phone, active FROM customers WHERE active = 1 ORDER BY id').all();
  const orders = db.prepare(
    `SELECT customer_id, COUNT(*) AS n, COALESCE(SUM(CASE WHEN payment_method = 'Credit' AND status = 'completed' THEN total ELSE 0 END), 0) AS credited
       FROM orders WHERE customer_id IS NOT NULL GROUP BY customer_id`).all();
  const ordersBy = new Map(orders.map((o) => [o.customer_id, o]));
  const payments = db.prepare('SELECT id, customer_id, amount, note FROM credit_payments').all();

  const groups = new Map();
  for (const c of customers) {
    const key = personKey(c.name, c.phone);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const plans = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const stat = (c) => {
      const mine = payments.filter((p) => p.customer_id === c.id);
      return {
        ...c,
        orders: (ordersBy.get(c.id) || { n: 0 }).n,
        credited: (ordersBy.get(c.id) || { credited: 0 }).credited,
        real: mine.filter((p) => !isPlaceholder(p)),
        placeholders: mine.filter(isPlaceholder),
      };
    };
    const all = members.map(stat);
    const weight = (c) => c.orders + c.real.length;
    const survivor = [...all].sort((a, b) => weight(b) - weight(a) || a.id - b.id)[0];
    const others = all.filter((c) => c.id !== survivor.id);

    const allPlaceholders = all.flatMap((c) => c.placeholders);
    const keep = allPlaceholders.sort((a, b) => b.amount - a.amount)[0] || null;
    const realPaid = all.reduce((n, c) => n + c.real.reduce((m, p) => m + p.amount, 0), 0);
    const paidAfter = realPaid + (keep ? keep.amount : 0);
    const creditedAfter = all.reduce((n, c) => n + c.credited, 0);

    plans.push({
      key, survivor, others, keepPlaceholder: keep,
      before: all.map((c) => ({ id: c.id, name: c.name, orders: c.orders, credited: c.credited,
        paid: c.real.concat(c.placeholders).reduce((n, p) => n + p.amount, 0),
        balance: c.credited - c.real.concat(c.placeholders).reduce((n, p) => n + p.amount, 0) })),
      after: { id: survivor.id, credited: creditedAfter, paid: paidAfter, balance: creditedAfter - paidAfter },
      movePayments: others.flatMap((c) => c.real.map((p) => p.id)),
      // placeholders: the kept one ends on the survivor, every other one on a duplicate.
      placeholderMoves: allPlaceholders.map((p) => ({
        id: p.id, to: keep && p.id === keep.id ? survivor.id : others[0].id,
      })),
    });
  }
  return plans;
}

function print(plans) {
  if (!plans.length) { console.log('No duplicate customers found. Nothing to do.'); return; }
  for (const p of plans) {
    console.log(`\n${p.survivor.name}  (${p.key})`);
    p.before.forEach((b) => console.log(`   before  #${b.id}  orders=${b.orders}  credited=${b.credited}  paid=${b.paid}  balance=${b.balance}${b.id === p.survivor.id ? '   <- survivor' : ''}`));
    console.log(`   after   #${p.after.id}  credited=${p.after.credited}  paid=${p.after.paid}  balance=${p.after.balance}   (merging #${p.others.map((o) => o.id).join(', #')} into it and deactivating them)`);
  }
}

if (!APPLY) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  console.log(`DRY RUN — nothing is changed. Database: ${dbPath}`);
  print(planFor(db));
  console.log('\nRe-run with --apply to merge (a backup is taken first).');
  db.close();
} else {
  // The app's own database module, so the guard indexes, backups and cloud push
  // behave exactly as they do in the running till.
  process.env.POS_USER_DATA_PATH = path.dirname(dbPath);
  const db = require('../db/database');
  const { syncUpsert } = require('../db/cloud-sync');
  const { getCustomerSummary } = require('../db/customer-summary');

  (async () => {
    const plans = planFor(db);
    print(plans);
    if (!plans.length) return;

    const backup = path.join(path.dirname(dbPath), `pos_database.before-customer-merge-${Date.now()}.db`);
    await db.backup(backup);
    console.log(`\nBackup written: ${backup}`);

    const moveOrders = db.prepare('UPDATE orders SET customer_id = ? WHERE customer_id = ?');
    const movePayment = db.prepare('UPDATE credit_payments SET customer_id = ? WHERE id = ?');
    const retire = db.prepare("UPDATE customers SET active = 0, notes = TRIM(COALESCE(notes, '') || ' [Merged into #' || ? || ' on ' || DATE('now', 'localtime') || ']') WHERE id = ?");
    db.transaction(() => {
      for (const p of plans) {
        for (const o of p.others) {
          moveOrders.run(p.survivor.id, o.id);
          retire.run(p.survivor.id, o.id);
        }
        p.movePayments.forEach((id) => movePayment.run(p.survivor.id, id));
        p.placeholderMoves.forEach((m) => movePayment.run(m.to, m.id));
      }
    })();

    // Verify against what the plan promised, then tell the cloud.
    let bad = 0;
    for (const p of plans) {
      const s = getCustomerSummary(p.survivor.id);
      const ok = Math.abs(s.balance - p.after.balance) < 0.005;
      console.log(`  #${p.survivor.id} ${s.name}: balance now ${s.balance} (planned ${p.after.balance}) ${ok ? 'OK' : 'MISMATCH'}`);
      if (!ok) bad++;
      syncUpsert('customers', s);
      p.others.forEach((o) => syncUpsert('customers', getCustomerSummary(o.id)));
    }
    console.log(bad ? `\n${bad} mismatch(es) — restore the backup above.` : '\nMerged. Balances match the plan.');
  })().catch((e) => { console.error(e); process.exit(1); });
}
