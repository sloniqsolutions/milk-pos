/**
 * Puts the cleanup test's story into a throwaway cloud database, then exits so the
 * next process gets the (single) connection. Used only by cleanup-script.js.
 *   node cloud/test/cleanup-script-seed.js <story.json>
 */
const fs = require('fs');
const path = require('path');
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL || '')) { console.error('Refusing: DATABASE_URL must be local.'); process.exit(1); }
process.env.TILL_API_KEY = 'made-up-key-for-tests';
const cloudDb = require(path.join(__dirname, '..', 'db', 'pg'));
const { createSchema } = require(path.join(__dirname, '..', 'db', 'schema'));
const { ORDERS, ENTRIES, DEV } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

(async () => {
  await createSchema(cloudDb);
  await cloudDb.run('TRUNCATE order_items, orders, ingredients, inventory_entries, sync_cursor RESTART IDENTITY CASCADE');
  await cloudDb.run('DROP TABLE IF EXISTS cleanup_log');
  await cloudDb.run("INSERT INTO ingredients (branch_id, local_id, name, unit, stock, received_at) VALUES (1, 1, 'Milk', 'Litre', 0, 1), (1, 2, 'Yogurt', 'grams', 0, 1)");
  for (const o of ORDERS) {
    const oid = (await cloudDb.one('INSERT INTO orders (branch_id, device_id, local_id, total, status, created_at, received_at) VALUES (1, ?, ?, 100, ?, ?, 1) RETURNING id', [o.device, o.id, o.status, `${o.day} 10:00:00`])).id;
    for (const [id, , name, qty, cat] of o.lines) {
      await cloudDb.run('INSERT INTO order_items (branch_id, device_id, local_id, order_id, name, price, quantity, is_deal, category) VALUES (1, ?, ?, ?, ?, 100, ?, 0, ?)', [o.device, id, oid, name, qty, cat]);
    }
  }
  const ids = { Milk: 1, Yogurt: 2 };
  for (const [id, n, type, amt, date, at] of ENTRIES) {
    await cloudDb.run('INSERT INTO inventory_entries (branch_id, device_id, local_id, ingredient_local_id, type, amount, entry_date, created_at, received_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, 1)', [DEV, id, ids[n], type, amt, date, at]);
  }
  await cloudDb.close();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
