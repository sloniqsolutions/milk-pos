/**
 * One-off: fix all missing inventory entries.
 *
 * Step 1: delete the incorrectly created entries from fix-missing.js
 *         (they used the till's device_id with wrong local_ids)
 * Step 2: re-insert under device_id='cloud' so they can never collide
 *         with future till entries
 * Step 3: also handle Dahi items (category 'Dahi' → ingredient 'Yogurt')
 */
require('../env').loadEnv();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const tillDev = '425ef447-1d62-43b5-a1e0-b53a77d68c00';
  const branchId = 1;

  await c.query('BEGIN');

  // Step 1: remove the wrongly-created entries from the first fix script
  const deleted = await c.query(
    'DELETE FROM inventory_entries WHERE branch_id = $1 AND device_id = $2 AND local_id >= 9000726',
    [branchId, tillDev]);
  console.log('Removed ' + deleted.rowCount + ' wrongly-created entries from first fix.\n');

  // Also remove the single entry created by fix-789.js (local_id 9000717)
  await c.query(
    'DELETE FROM inventory_entries WHERE branch_id = $1 AND device_id = $2 AND local_id = 9000717',
    [branchId, tillDev]);

  // Step 2: find ALL missing entries
  const missing = await c.query(`
    SELECT o.local_id AS order_id, oi.local_id AS item_lid, oi.name, oi.quantity,
           o.created_at, oi.category
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id AND oi.branch_id = o.branch_id
     WHERE o.branch_id = $1 AND o.device_id = $2 AND o.status = 'completed'
       AND oi.is_deal = 0
       AND NOT EXISTS (
         SELECT 1 FROM inventory_entries ie
          WHERE ie.branch_id = $1 AND ie.device_id = $2
            AND ie.order_local_id = o.local_id AND ie.order_item_local_id = oi.local_id
       )
     ORDER BY o.local_id
  `, [branchId, tillDev]);

  console.log('Found ' + missing.rows.length + ' missing entries.\n');

  // Map category → ingredient local_id
  const ings = await c.query('SELECT local_id, name FROM ingredients WHERE branch_id = $1', [branchId]);
  const ingMap = {};
  for (const r of ings.rows) ingMap[r.name] = r.local_id;
  // Category 'Dahi' maps to ingredient 'Yogurt', 'Milk' maps to 'Milk'
  const categoryToIng = { Milk: ingMap['Milk'], Dahi: ingMap['Yogurt'], Yogurt: ingMap['Yogurt'] };

  // Allocate cloud local_ids
  const maxCloud = await c.query(
    "SELECT COALESCE(MAX(local_id), 0) AS m FROM inventory_entries WHERE branch_id = $1 AND device_id = 'cloud'",
    [branchId]);
  let nextId = Number(maxCloud.rows[0].m) + 1;

  let inserted = 0;
  for (const m of missing.rows) {
    const ingredientId = categoryToIng[m.category];
    if (!ingredientId) {
      console.log('  SKIP: order #' + m.order_id + ' ' + m.name + ' — unknown category "' + m.category + '"');
      continue;
    }

    const amount = -Number(m.quantity);
    const entryDate = String(m.created_at).slice(0, 10);

    await c.query(`
      INSERT INTO inventory_entries
        (branch_id, local_id, device_id, ingredient_local_id, type, amount,
         entry_date, created_at, received_at, order_local_id, order_item_local_id, reason)
      VALUES ($1, $2, 'cloud', $3, 'sale', $4, $5, $6, $7, $8, $9, 'Sync recovery')
    `, [branchId, nextId, ingredientId, amount,
        entryDate, m.created_at, Date.now(), m.order_id, m.item_lid]);

    console.log('  order #' + m.order_id + '  ' + m.name + ' (' + m.category + ')  → ' + amount);
    nextId++;
    inserted++;
  }

  console.log('\nInserted ' + inserted + ' entries under device_id=cloud.\n');

  // Step 3: recompute all stock
  await c.query(`
    UPDATE ingredients i
       SET stock = ROUND(COALESCE((SELECT SUM(e.amount)
                     FROM inventory_entries e
                    WHERE e.branch_id = i.branch_id
                      AND e.ingredient_local_id = i.local_id
                      AND e.superseded_by IS NULL), 0)::numeric, 6)
     WHERE i.branch_id = $1
  `, [branchId]);

  await c.query('COMMIT');

  const after = await c.query('SELECT name, stock, unit FROM ingredients WHERE branch_id = $1 ORDER BY name', [branchId]);
  console.log('Cloud stock now:');
  for (const r of after.rows) console.log('  ' + r.name + ': ' + r.stock + ' ' + r.unit);

  // Verify: check if any are still missing
  const stillMissing = await c.query(`
    SELECT COUNT(*) AS cnt
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id AND oi.branch_id = o.branch_id
     WHERE o.branch_id = $1 AND o.device_id = $2 AND o.status = 'completed'
       AND oi.is_deal = 0
       AND NOT EXISTS (
         SELECT 1 FROM inventory_entries ie
          WHERE ie.branch_id = $1
            AND ie.order_local_id = o.local_id AND ie.order_item_local_id = oi.local_id
       )
  `, [branchId, tillDev]);
  console.log('\nStill missing (should be 0): ' + stillMissing.rows[0].cnt);

  await c.end();
})();
