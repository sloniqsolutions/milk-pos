/** Read-only: last 5 orders and whether each item has its inventory entry. */
require('../env').loadEnv();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const branchId = 1;
  const tillDev = '425ef447-1d62-43b5-a1e0-b53a77d68c00';

  const last5 = await c.query(
    `SELECT id, local_id, created_at FROM orders
      WHERE branch_id = $1 AND device_id = $2 AND status = 'completed'
      ORDER BY local_id DESC LIMIT 8`, [branchId, tillDev]);

  for (const o of last5.rows.reverse()) {
    const items = await c.query(
      `SELECT oi.local_id, oi.name, oi.quantity, oi.is_deal,
              EXISTS (SELECT 1 FROM inventory_entries ie
                       WHERE ie.branch_id = $1 AND ie.order_local_id = $2
                         AND ie.order_item_local_id = oi.local_id) AS has_entry
         FROM order_items oi WHERE oi.order_id = $3 AND oi.branch_id = $1`,
      [branchId, o.local_id, o.id]);
    console.log('Order #' + o.local_id + '  ' + o.created_at);
    for (const i of items.rows) {
      const s = i.is_deal ? 'DEAL' : (i.has_entry ? 'OK' : 'MISSING');
      console.log('  ' + s.padEnd(8) + i.name + ' x' + i.quantity);
    }
  }

  const stock = await c.query('SELECT name, stock, unit FROM ingredients WHERE branch_id = $1 ORDER BY name', [branchId]);
  console.log('\nCloud stock:');
  for (const r of stock.rows) console.log('  ' + r.name + ': ' + r.stock + ' ' + r.unit);

  await c.end();
})();
