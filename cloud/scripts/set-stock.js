/** One-off: set cloud stock to match the till's verified figures. */
require('../env').loadEnv();
const { Client } = require('pg');

const TARGETS = [
  { name: 'Milk',   stock: 74.7921 },
  { name: 'Yogurt', stock: 35002.71 },
];

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const branchId = 1;

  const before = await c.query(
    'SELECT name, stock, unit FROM ingredients WHERE branch_id = $1 ORDER BY name', [branchId]);
  console.log('Cloud stock BEFORE:');
  for (const r of before.rows) console.log('  ' + r.name + ': ' + r.stock + ' ' + r.unit);

  await c.query('BEGIN');
  for (const t of TARGETS) {
    await c.query(
      'UPDATE ingredients SET stock = $1 WHERE branch_id = $2 AND name = $3',
      [t.stock, branchId, t.name]);
  }
  await c.query('COMMIT');

  const after = await c.query(
    'SELECT name, stock, unit FROM ingredients WHERE branch_id = $1 ORDER BY name', [branchId]);
  console.log('\nCloud stock AFTER:');
  for (const r of after.rows) console.log('  ' + r.name + ': ' + r.stock + ' ' + r.unit);

  await c.end();
})();
