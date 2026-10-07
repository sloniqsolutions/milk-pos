/** Read-only check: compare cloud stock vs till screenshot, and find any missing entries for today. */
require('../env').loadEnv();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const branchId = 1;
  const tillDev = '425ef447-1d62-43b5-a1e0-b53a77d68c00';

  // 1. Cloud stock
  const stock = await c.query(
    'SELECT name, stock, unit FROM ingredients WHERE branch_id = $1 ORDER BY name', [branchId]);
  console.log('=== CLOUD STOCK ===');
  for (const r of stock.rows) console.log('  ' + r.name + ': ' + r.stock + ' ' + r.unit);

  // 2. Missing entries: orders with non-deal items that have no matching inventory entry
  const missing = await c.query(`
    SELECT o.local_id AS order_id, oi.local_id AS item_lid, oi.name, oi.quantity,
           oi.category, o.created_at::date AS order_date
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id AND oi.branch_id = o.branch_id
     WHERE o.branch_id = $1 AND o.device_id = $2 AND o.status = 'completed'
       AND oi.is_deal = 0
       AND o.created_at::date = CURRENT_DATE
       AND NOT EXISTS (
         SELECT 1 FROM inventory_entries ie
          WHERE ie.branch_id = $1
            AND ie.order_local_id = o.local_id AND ie.order_item_local_id = oi.local_id
       )
     ORDER BY o.local_id
  `, [branchId, tillDev]);

  console.log('\n=== TODAY\'S MISSING ENTRIES ===');
  if (missing.rows.length === 0) {
    console.log('  None — all today\'s orders have their inventory entries.');
  } else {
    for (const m of missing.rows) {
      console.log('  MISSING: order #' + m.order_id + '  ' + m.name + ' x' + m.quantity + '  (' + m.category + ')');
    }
    console.log('\n  Total missing: ' + missing.rows.length);
  }

  // 3. Today's order count vs today's entry count
  const orderCount = await c.query(`
    SELECT COUNT(DISTINCT o.local_id) AS cnt
      FROM orders o
     WHERE o.branch_id = $1 AND o.device_id = $2 AND o.status = 'completed'
       AND o.created_at::date = CURRENT_DATE
  `, [branchId, tillDev]);

  const entryCount = await c.query(`
    SELECT COUNT(*) AS cnt
      FROM inventory_entries ie
     WHERE ie.branch_id = $1 AND ie.device_id = $2 AND ie.type = 'sale'
       AND ie.entry_date = CURRENT_DATE::text
  `, [branchId, tillDev]);

  console.log('\n=== TODAY\'S SUMMARY ===');
  console.log('  Orders: ' + orderCount.rows[0].cnt);
  console.log('  Sale entries: ' + entryCount.rows[0].cnt);

  await c.end();
})();
