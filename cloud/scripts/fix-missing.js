/**
 * One-off: find and insert all missing inventory entries from till orders.
 * Uses the till's device_id and sequential local_ids so the cloud's upsert
 * key matches if the till ever re-pushes them.
 */
require('../env').loadEnv();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const dev = '425ef447-1d62-43b5-a1e0-b53a77d68c00';
  const branchId = 1;

  // Find orders whose non-deal items have no matching inventory entry
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
     ORDER BY o.local_id DESC
     LIMIT 50
  `, [branchId, dev]);

  if (missing.rows.length === 0) {
    console.log('No missing entries found.');
    await c.end();
    return;
  }

  // Get ingredient local_ids by name
  const ings = await c.query('SELECT local_id, name FROM ingredients WHERE branch_id = $1', [branchId]);
  const ingByName = Object.fromEntries(ings.rows.map(r => [r.name, r.local_id]));

  // Find next available local_id for this device
  const maxId = await c.query(
    'SELECT COALESCE(MAX(local_id), 0) AS m FROM inventory_entries WHERE branch_id = $1 AND device_id = $2',
    [branchId, dev]);
  let nextId = Number(maxId.rows[0].m) + 1;

  console.log('Found ' + missing.rows.length + ' missing entries. Inserting...\n');

  await c.query('BEGIN');

  for (const m of missing.rows) {
    // Determine the ingredient from the category
    const ingredientId = ingByName[m.category];
    if (!ingredientId) {
      console.log('  SKIP: order #' + m.order_id + ' item=' + m.name + ' — no ingredient for category "' + m.category + '"');
      continue;
    }

    // The deduction amount = item quantity (the item name encodes the volume)
    const amount = -Number(m.quantity);
    const entryDate = String(m.created_at).slice(0, 10);

    await c.query(`
      INSERT INTO inventory_entries
        (branch_id, local_id, device_id, ingredient_local_id, type, amount,
         entry_date, created_at, received_at, order_local_id, order_item_local_id)
      VALUES ($1, $2, $3, $4, 'sale', $5, $6, $7, $8, $9, $10)
      ON CONFLICT (branch_id, device_id, local_id) DO NOTHING
    `, [branchId, nextId, dev, ingredientId, amount,
        entryDate, m.created_at, Date.now(), m.order_id, m.item_lid]);

    console.log('  order #' + m.order_id + '  ' + m.name + ' x' + m.quantity +
      '  → entry ' + amount + ' (local_id=' + nextId + ')');
    nextId++;
  }

  // Recompute stock
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
  console.log('\nCloud stock now:');
  for (const r of after.rows) console.log('  ' + r.name + ': ' + r.stock + ' ' + r.unit);

  await c.end();
})();
