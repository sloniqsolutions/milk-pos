/**
 * One-off: insert the missing inventory entry for order #789.
 *
 * The till created this entry locally but the fire-and-forget push to the
 * cloud failed silently.  We insert it under the till's own device_id and
 * the local_id it would have used (9000717, following 9000715 and 9000716
 * for orders 787/788), so the cloud's upsert key (branch_id, device_id,
 * local_id) will match if the till ever re-pushes it — no duplicate.
 */
require('../env').loadEnv();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const branchId = 1;
  const deviceId = '425ef447-1d62-43b5-a1e0-b53a77d68c00';
  const localId = 9000717;
  const ingredientLocalId = 1; // Milk
  const amount = -0.7083;
  const orderLocalId = 789;
  const orderItemLocalId = 902;
  const entryDate = '2026-10-05';
  const createdAt = '2026-10-05 16:28:21';

  // Safety: check it doesn't already exist
  const exists = await c.query(
    'SELECT id FROM inventory_entries WHERE branch_id = $1 AND device_id = $2 AND local_id = $3',
    [branchId, deviceId, localId]);
  if (exists.rows.length > 0) {
    console.log('Entry already exists — nothing to do.');
    await c.end();
    return;
  }

  await c.query('BEGIN');

  await c.query(`
    INSERT INTO inventory_entries
      (branch_id, local_id, device_id, ingredient_local_id, type, amount,
       entry_date, created_at, received_at, order_local_id, order_item_local_id)
    VALUES ($1, $2, $3, $4, 'sale', $5, $6, $7, $8, $9, $10)
  `, [branchId, localId, deviceId, ingredientLocalId, amount,
      entryDate, createdAt, Date.now(), orderLocalId, orderItemLocalId]);

  // Recompute stock from the full ledger
  await c.query(`
    UPDATE ingredients i
       SET stock = ROUND(COALESCE((SELECT SUM(e.amount)
                     FROM inventory_entries e
                    WHERE e.branch_id = i.branch_id
                      AND e.ingredient_local_id = i.local_id
                      AND e.superseded_by IS NULL), 0)::numeric, 6)
     WHERE i.branch_id = $1 AND i.local_id = $2
  `, [branchId, ingredientLocalId]);

  await c.query('COMMIT');

  const stock = await c.query(
    'SELECT name, stock, unit FROM ingredients WHERE branch_id = $1 AND local_id = $2',
    [branchId, ingredientLocalId]);
  console.log('Entry inserted for order #789: ' + amount + ' L');
  console.log('Cloud Milk stock now:', stock.rows[0].stock, stock.rows[0].unit);

  await c.end();
})();
