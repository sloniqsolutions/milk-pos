/** Set cloud Milk stock to match till (61.0838 L). */
require('../env').loadEnv();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('UPDATE ingredients SET stock = 61.0838 WHERE branch_id = 1 AND name = $1', ['Milk']);
  const r = await c.query('SELECT name, stock, unit FROM ingredients WHERE branch_id = 1 ORDER BY name');
  console.log('Cloud stock now:');
  for (const x of r.rows) console.log('  ' + x.name + ': ' + x.stock + ' ' + x.unit);
  await c.end();
})();
