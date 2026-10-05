/** Debug: compare till-pushed entries vs cloud stock for recent sales. */
require('../env').loadEnv();
const { Client } = require('pg');

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // 1. Current cloud stock
  const { rows: ingredients } = await client.query(
    "SELECT local_id, name, stock, unit FROM ingredients WHERE branch_id = 1 ORDER BY name"
  );
  console.log('=== CLOUD STOCK NOW ===');
  for (const i of ingredients) console.log('  ' + i.name + ': ' + i.stock + ' ' + i.unit);

  // 2. The 3 recent orders — show their line items
  const { rows: orders } = await client.query(`
    SELECT o.local_id, o.total, o.created_at, o.status
      FROM orders o WHERE o.branch_id = 1
     ORDER BY o.created_at DESC LIMIT 5
  `);
  console.log('\n=== LAST 5 ORDERS + ITEMS ===');
  for (const o of orders) {
    console.log('  Order #' + o.local_id + '  Rs ' + o.total + '  ' + String(o.created_at).slice(0, 19) + '  ' + o.status);
    const { rows: items } = await client.query(
      "SELECT name, quantity, price FROM order_items WHERE branch_id = 1 AND order_id = $1",
      [o.local_id]
    );
    for (const it of items) console.log('    - ' + it.name + ' x' + it.quantity + '  Rs ' + it.price);
  }

  // 3. ALL cloud-created entries (our recounts)
  const { rows: cloudEntries } = await client.query(`
    SELECT ie.amount, ie.entry_date, ie.reason, ie.ingredient_local_id, i.name
      FROM inventory_entries ie
      LEFT JOIN ingredients i ON i.branch_id = ie.branch_id AND i.local_id = ie.ingredient_local_id
     WHERE ie.branch_id = 1 AND ie.device_id = 'cloud'
     ORDER BY ie.local_id
  `);
  console.log('\n=== ALL CLOUD-CREATED ENTRIES (our adjustments) ===');
  let milkTotal = 0, yogurtTotal = 0;
  for (const e of cloudEntries) {
    console.log('  ' + (e.name || '?').padEnd(8) + (e.amount >= 0 ? '+' : '') + e.amount + '  ' + e.entry_date + '  ' + (e.reason || ''));
    if (e.name === 'Milk') milkTotal += Number(e.amount);
    if (e.name === 'Yogurt') yogurtTotal += Number(e.amount);
  }
  console.log('  Cloud entries net:  Milk=' + milkTotal + '  Yogurt=' + yogurtTotal);

  // 4. Sum of ALL till-pushed entries (not cloud)
  const { rows: tillSums } = await client.query(`
    SELECT i.name,
           SUM(e.amount) AS till_sum,
           COUNT(*) AS entry_count
      FROM inventory_entries e
      JOIN ingredients i ON i.branch_id = e.branch_id AND i.local_id = e.ingredient_local_id
     WHERE e.branch_id = 1 AND e.device_id != 'cloud' AND e.superseded_by IS NULL
     GROUP BY i.name ORDER BY i.name
  `);
  console.log('\n=== TILL-PUSHED ENTRY SUMS (what the till thinks stock is) ===');
  for (const s of tillSums) {
    console.log('  ' + s.name + ': SUM = ' + s.till_sum + '  (' + s.entry_count + ' entries)');
  }

  // 5. Compare: cloud stored vs till sum + cloud adjustments
  console.log('\n=== BREAKDOWN ===');
  for (const s of tillSums) {
    const cloudAdj = s.name === 'Milk' ? milkTotal : yogurtTotal;
    const expected = Number(s.till_sum) + cloudAdj;
    const stored = ingredients.find(i => i.name === s.name);
    console.log('  ' + s.name + ':');
    console.log('    Till entries sum:    ' + s.till_sum);
    console.log('    Cloud adjustments:  ' + (cloudAdj >= 0 ? '+' : '') + cloudAdj);
    console.log('    Expected total:      ' + expected);
    console.log('    Cloud stored:        ' + (stored ? stored.stock : '?'));
    console.log('    Difference:          ' + (stored ? (Number(stored.stock) - expected) : '?'));
  }

  await client.end();
})();
