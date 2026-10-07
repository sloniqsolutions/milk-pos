/** Compare today's orders: which have their inventory entries, which don't. */
require('../env').loadEnv();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const branchId = 1;
  const tillDev = '425ef447-1d62-43b5-a1e0-b53a77d68c00';

  const items = await c.query(`
    SELECT o.local_id AS order_id, oi.local_id AS item_lid, oi.name, oi.quantity,
           oi.category, oi.is_deal,
           o.created_at,
           EXISTS (
             SELECT 1 FROM inventory_entries ie
              WHERE ie.branch_id = $1
                AND ie.order_local_id = o.local_id AND ie.order_item_local_id = oi.local_id
           ) AS has_entry
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id AND oi.branch_id = o.branch_id
     WHERE o.branch_id = $1 AND o.device_id = $2 AND o.status = 'completed'
       AND o.created_at::date = CURRENT_DATE
     ORDER BY o.local_id, oi.local_id
  `, [branchId, tillDev]);

  let currentOrder = null;
  for (const r of items.rows) {
    if (r.order_id !== currentOrder) {
      currentOrder = r.order_id;
      console.log('');
      console.log('Order #' + r.order_id + '  (' + String(r.created_at).slice(11, 19) + ')');
    }
    const status = r.is_deal ? 'DEAL (no entry needed)' : (r.has_entry ? 'OK' : 'MISSING');
    console.log('  ' + status.padEnd(24) + r.name + ' x' + r.quantity + '  [' + r.category + ']');
  }

  await c.end();
})();
