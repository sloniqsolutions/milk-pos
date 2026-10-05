/**
 * Undo all manual fix attempts:
 * 1. Delete entries created by fix-missing-v2.js (device_id='cloud', reason='Sync recovery')
 * 2. Recompute stock from remaining entries
 * 3. Print current cloud stock so user can compare with till
 */
require('../env').loadEnv();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const branchId = 1;

  await c.query('BEGIN');

  // Delete all manually created recovery entries
  const del = await c.query(
    "DELETE FROM inventory_entries WHERE branch_id = $1 AND device_id = 'cloud' AND reason = 'Sync recovery'",
    [branchId]);
  console.log('Deleted ' + del.rowCount + ' recovery entries.\n');

  // Recompute stock from remaining entries
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

  // Show current state
  const stock = await c.query(
    'SELECT name, stock, unit FROM ingredients WHERE branch_id = $1 ORDER BY name',
    [branchId]);
  console.log('Cloud stock after undo:');
  for (const r of stock.rows) console.log('  ' + r.name + ': ' + r.stock + ' ' + r.unit);

  await c.end();
})();
