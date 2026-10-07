/** Read-only: does missing-entry rate correlate with order bursts? */
require('../env').loadEnv();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const dev = '425ef447-1d62-43b5-a1e0-b53a77d68c00';

  const r = await c.query(`
    WITH o AS (
      SELECT o.id, o.local_id, o.created_at::timestamp AS t
        FROM orders o
       WHERE o.branch_id = 1 AND o.device_id = $1 AND o.status = 'completed'
         AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.branch_id = 1 AND oi.is_deal = 0)
    ), m AS (
      SELECT o.*,
             EXISTS (SELECT 1 FROM order_items oi
                      WHERE oi.order_id = o.id AND oi.branch_id = 1 AND oi.is_deal = 0
                        AND NOT EXISTS (SELECT 1 FROM inventory_entries ie
                                         WHERE ie.branch_id = 1 AND ie.order_local_id = o.local_id
                                           AND ie.order_item_local_id = oi.local_id)) AS missing,
             (SELECT COUNT(*) FROM o o2 WHERE o2.id <> o.id AND ABS(EXTRACT(EPOCH FROM (o2.t - o.t))) <= 120) AS neighbours
        FROM o
    )
    SELECT local_id, t, missing, neighbours FROM m ORDER BY local_id`, [dev]);

  const bucket = (n) => (n === 0 ? '0 neighbours (isolated)' : n <= 2 ? '1-2 neighbours' : '3+ neighbours (burst)');
  const stats = {};
  for (const x of r.rows) {
    const k = bucket(Number(x.neighbours));
    stats[k] = stats[k] || { total: 0, missing: 0 };
    stats[k].total++;
    if (x.missing) stats[k].missing++;
  }
  console.log('Orders by how many other orders were within 2 minutes:\n');
  for (const k of Object.keys(stats)) {
    const s = stats[k];
    console.log('  ' + k.padEnd(26) + s.total + ' orders, ' + s.missing + ' missing  (' + (100 * s.missing / s.total).toFixed(1) + '%)');
  }

  console.log('\nOrders #809-#817 (after the fix period):');
  for (const x of r.rows.filter(x => x.local_id >= 809)) {
    console.log('  #' + x.local_id + '  ' + String(x.t).slice(0, 24) + '  neighbours=' + x.neighbours + '  ' + (x.missing ? 'MISSING' : 'ok'));
  }

  const lag = await c.query(`
    SELECT ie.order_local_id, o.created_at, to_timestamp(ie.received_at/1000.0) AS received
      FROM inventory_entries ie
      JOIN orders o ON o.branch_id = ie.branch_id AND o.device_id = ie.device_id AND o.local_id = ie.order_local_id
     WHERE ie.branch_id = 1 AND ie.device_id = $1 AND ie.order_local_id >= 809
     ORDER BY ie.order_local_id`, [dev]);
  console.log('\nEntry received_at vs order time (#809+):');
  for (const x of lag.rows) console.log('  #' + x.order_local_id + '  order ' + String(x.created_at).slice(0, 19) + '  received ' + x.received.toISOString());

  await c.end();
})();
