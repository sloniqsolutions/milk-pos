/** Check if any recent orders are missing their inventory entries. */
require('../env').loadEnv();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const dev = '425ef447-1d62-43b5-a1e0-b53a77d68c00';

  // Get last 20 orders with their items (non-deal items only, since deals don't deduct stock)
  const orders = await c.query(`
    SELECT o.local_id AS order_id, oi.local_id AS item_lid, oi.name, oi.quantity, oi.is_deal
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id AND oi.branch_id = o.branch_id
     WHERE o.branch_id = 1 AND o.device_id = $1 AND o.status = 'completed' AND oi.is_deal = 0
     ORDER BY o.local_id DESC
     LIMIT 40
  `, [dev]);

  // Get all inventory entries for these orders
  const orderIds = [...new Set(orders.rows.map(r => r.order_id))];
  const entries = await c.query(`
    SELECT order_local_id, order_item_local_id, amount, ingredient_local_id
      FROM inventory_entries
     WHERE branch_id = 1 AND device_id = $1 AND order_local_id = ANY($2)
  `, [dev, orderIds]);

  const entrySet = new Set(entries.rows.map(e => e.order_local_id + ':' + e.order_item_local_id));

  console.log('Checking last ' + orderIds.length + ' orders for missing entries...\n');
  let missing = 0;
  for (const item of orders.rows) {
    const key = item.order_id + ':' + item.item_lid;
    const has = entrySet.has(key);
    if (!has) {
      console.log('  MISSING: order #' + item.order_id + '  item=' + item.name + ' x' + item.quantity + '  item_lid=' + item.item_lid);
      missing++;
    }
  }
  if (missing === 0) console.log('  All entries present.');
  else console.log('\n' + missing + ' missing entries found.');

  await c.end();
})();
