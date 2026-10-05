/** One-off: round near-zero stock to exactly 0. */
require('../env').loadEnv();
const { Client } = require('pg');

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query('UPDATE ingredients SET stock = 0 WHERE ABS(stock) < 0.001');

  const { rows } = await client.query('SELECT name, stock, unit FROM ingredients ORDER BY name');
  for (const r of rows) console.log(r.name + ': ' + r.stock + ' ' + r.unit);

  await client.end();
})();
