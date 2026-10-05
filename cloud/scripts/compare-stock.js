/** Compare cloud stock, recent orders, and recent inventory entries. */
require('../env').loadEnv();
const { Client } = require('pg');

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // 1. Current stock
  const { rows: ingredients } = await client.query(
    'SELECT local_id, name, stock, unit FROM ingredients WHERE branch_id = 1 ORDER BY name'
  );
  console.log('=== CLOUD STOCK ===');
  for (const i of ingredients) console.log('  ' + i.name + ': ' + i.stock + ' ' + i.unit);

  // 2. Recent orders (last 10)
  const { rows: orders } = await client.query(`
    SELECT o.local_id, o.status, o.total, o.created_at, o.cashier_name, o.device_id
      FROM orders o
     WHERE o.branch_id = 1
     ORDER BY o.created_at DESC
     LIMIT 10
  `);
  console.log('\n=== RECENT ORDERS (last 10) ===');
  for (const o of orders) {
    console.log('  #' + o.local_id + '  ' + o.status.padEnd(10) + '  Rs ' + o.total + '  ' + String(o.created_at).slice(0, 19) + '  [' + (o.device_id || '?') + ']');
  }

  // 3. Recent inventory entries (last 20) — sales, restocks, everything
  const { rows: entries } = await client.query(`
    SELECT ie.local_id, ie.device_id, ie.type, ie.amount, ie.entry_date, ie.created_at,
           ie.reason, ie.ingredient_local_id, ie.superseded_by,
           i.name AS ingredient_name, i.unit
      FROM inventory_entries ie
      LEFT JOIN ingredients i ON i.branch_id = ie.branch_id AND i.local_id = ie.ingredient_local_id
     WHERE ie.branch_id = 1
     ORDER BY ie.created_at DESC, ie.local_id DESC
     LIMIT 30
  `);
  console.log('\n=== RECENT INVENTORY ENTRIES (last 30) ===');
  for (const e of entries) {
    const sup = e.superseded_by ? ' [SUPERSEDED]' : '';
    const reason = e.reason ? ' (' + e.reason + ')' : '';
    console.log('  ' + String(e.entry_date).padEnd(12) + (e.ingredient_name || '?').padEnd(8) +
      e.type.padEnd(20) + (e.amount >= 0 ? '+' : '') + e.amount + ' ' + (e.unit || '') +
      '  [' + (e.device_id || '?') + ']' + reason + sup);
  }

  // 4. Sum of all non-superseded entries per ingredient (what recomputeStock calculates)
  const { rows: sums } = await client.query(`
    SELECT i.name, i.stock AS stored_stock,
           COALESCE(SUM(e.amount), 0) AS computed_stock,
           i.stock - COALESCE(SUM(e.amount), 0) AS difference
      FROM ingredients i
      LEFT JOIN inventory_entries e ON e.branch_id = i.branch_id
           AND e.ingredient_local_id = i.local_id
           AND e.superseded_by IS NULL
     WHERE i.branch_id = 1
     GROUP BY i.local_id, i.name, i.stock, i.unit
     ORDER BY i.name
  `);
  console.log('\n=== STOCK vs LEDGER SUM ===');
  for (const s of sums) {
    console.log('  ' + s.name + ': stored=' + s.stored_stock + '  ledger=' + s.computed_stock + '  diff=' + s.difference);
  }

  await client.end();
})();
