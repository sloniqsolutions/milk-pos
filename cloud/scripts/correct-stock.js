/**
 * Add correction entries so recomputeStock produces the correct result.
 *
 * Instead of setting stock directly (which gets overwritten by recomputeStock),
 * this inserts a 'stock' entry with the difference. The entry becomes part of
 * the ledger, so every future recompute includes it.
 */
require('../env').loadEnv();
const { Client } = require('pg');

const TARGETS = [
  { name: 'Milk',   correctStock: 57.7506 },
  { name: 'Yogurt', correctStock: 32645.61 },
];

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const branchId = 1;

  // Get current cloud stock (as recomputeStock sees it)
  const current = await c.query(
    'SELECT local_id, name, stock, unit FROM ingredients WHERE branch_id = $1 ORDER BY name', [branchId]);

  console.log('Cloud stock now:');
  for (const r of current.rows) console.log('  ' + r.name + ': ' + r.stock + ' ' + r.unit);

  await c.query('BEGIN');

  // Get next cloud entry local_id
  const maxRow = await c.query(
    "SELECT COALESCE(MAX(local_id), 0) AS m FROM inventory_entries WHERE branch_id = $1 AND device_id = 'cloud'",
    [branchId]);
  let nextId = Number(maxRow.rows[0].m) + 1;

  for (const target of TARGETS) {
    const ing = current.rows.find(r => r.name === target.name);
    if (!ing) { console.log('  ' + target.name + ': not found'); continue; }

    const cloudStock = Number(ing.stock);
    const correction = Math.round((target.correctStock - cloudStock) * 1e6) / 1e6;

    if (Math.abs(correction) < 0.0001) {
      console.log('\n' + target.name + ': already correct (' + cloudStock + ')');
      continue;
    }

    await c.query(`
      INSERT INTO inventory_entries
        (branch_id, local_id, device_id, ingredient_local_id, type, amount,
         entry_date, created_at, received_at, reason)
      VALUES ($1, $2, 'cloud', $3, 'stock', $4, $5, $6, $7, 'Sync correction')
    `, [branchId, nextId, ing.local_id, correction,
        new Date().toLocaleDateString('en-CA'),
        new Date().toISOString(), Date.now()]);

    console.log('\n' + target.name + ':');
    console.log('  Cloud had:    ' + cloudStock + ' ' + ing.unit);
    console.log('  Till has:     ' + target.correctStock + ' ' + ing.unit);
    console.log('  Correction:   ' + (correction >= 0 ? '+' : '') + correction);
    nextId++;
  }

  // Recompute — now includes the correction entries
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

  // Verify
  const after = await c.query(
    'SELECT name, stock, unit FROM ingredients WHERE branch_id = $1 ORDER BY name', [branchId]);
  console.log('\nCloud stock AFTER correction:');
  for (const r of after.rows) console.log('  ' + r.name + ': ' + r.stock + ' ' + r.unit);

  await c.end();
})();
