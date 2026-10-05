require('../env').loadEnv();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const dev = '425ef447-1d62-43b5-a1e0-b53a77d68c00';

  const items = await c.query(`
    SELECT oi.local_id, oi.name, oi.quantity, oi.price,
           o.local_id AS order_local_id, o.total AS order_total
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id AND o.branch_id = oi.branch_id
     WHERE oi.branch_id = 1 AND o.device_id = $1 AND o.local_id IN (787, 788, 789)
     ORDER BY oi.local_id
  `, [dev]);
  console.log('Items for orders 787-789:');
  for (const x of items.rows) {
    console.log('  order=#' + x.order_local_id + ' (Rs' + x.order_total + ')' +
      '  item_lid=' + x.local_id + '  ' + x.name + ' x' + x.quantity + '  Rs' + x.price);
  }

  // Confirm the entry_date for #789
  const ord = await c.query(
    'SELECT created_at FROM orders WHERE branch_id = 1 AND device_id = $1 AND local_id = 789', [dev]);
  console.log('\nOrder #789 created_at:', ord.rows[0] && ord.rows[0].created_at);

  await c.end();
})();
