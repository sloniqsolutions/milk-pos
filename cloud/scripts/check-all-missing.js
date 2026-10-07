/** Check ALL missing inventory entries (not just today) and sum the gap. */
require('../env').loadEnv();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const branchId = 1;
  const tillDev = '425ef447-1d62-43b5-a1e0-b53a77d68c00';

  const missing = await c.query(`
    SELECT o.local_id AS order_id, oi.local_id AS item_lid, oi.name, oi.quantity,
           oi.category, o.created_at::date AS order_date
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id AND oi.branch_id = o.branch_id
     WHERE o.branch_id = $1 AND o.device_id = $2 AND o.status = 'completed'
       AND oi.is_deal = 0
       AND NOT EXISTS (
         SELECT 1 FROM inventory_entries ie
          WHERE ie.branch_id = $1
            AND ie.order_local_id = o.local_id AND ie.order_item_local_id = oi.local_id
       )
     ORDER BY o.local_id
  `, [branchId, tillDev]);

  let milkTotal = 0;
  let yogurtTotal = 0;
  let milkCount = 0;
  let yogurtCount = 0;

  console.log('ALL missing entries (' + missing.rows.length + ' total):\n');
  for (const m of missing.rows) {
    const amt = Number(m.quantity);
    if (m.category === 'Milk') { milkTotal += amt; milkCount++; }
    else if (m.category === 'Dahi' || m.category === 'Yogurt') { yogurtTotal += amt; yogurtCount++; }
    console.log('  #' + String(m.order_id).padEnd(6) + m.order_date + '  ' + m.name.padEnd(25) + ' x' + m.quantity + '  [' + m.category + ']');
  }

  console.log('\n=== SUMMARY ===');
  console.log('  Missing Milk entries: ' + milkCount + '  (total deduction: -' + milkTotal.toFixed(4) + ' L)');
  console.log('  Missing Yogurt/Dahi entries: ' + yogurtCount + '  (total deduction: -' + yogurtTotal.toFixed(4) + ' g)');

  const stock = await c.query(
    'SELECT name, stock, unit FROM ingredients WHERE branch_id = $1 ORDER BY name', [branchId]);
  console.log('\n=== CLOUD STOCK ===');
  for (const r of stock.rows) {
    console.log('  ' + r.name + ': ' + r.stock + ' ' + r.unit);
  }

  const milkStock = stock.rows.find(r => r.name === 'Milk');
  const yogurtStock = stock.rows.find(r => r.name === 'Yogurt');
  if (milkStock) console.log('\n  Correct Milk = ' + (Number(milkStock.stock) - milkTotal).toFixed(4) + ' L');
  if (yogurtStock) console.log('  Correct Yogurt = ' + (Number(yogurtStock.stock) - yogurtTotal).toFixed(4) + ' g');

  await c.end();
})();
