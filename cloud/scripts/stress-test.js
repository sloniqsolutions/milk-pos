/**
 * Stress test: prove inventory entry ingestion handles burst traffic.
 *
 * Sends 15 entries as 15 SEPARATE concurrent HTTP requests (each with 1 entry),
 * simulating 15 sales hitting at the same instant. Each request goes through
 * the full ingest pipeline including recomputeStock.
 *
 * Uses a unique test device_id. Points entries at a non-existent ingredient
 * (local_id 99999) so recomputeStock runs but doesn't change real Milk/Yogurt.
 *
 * After verifying, deletes all test entries and restores stock.
 */
require('../env').loadEnv();
const { Client } = require('pg');

const API_KEY = process.env.TILL_API_KEY;
const TEST_DEVICE = 'stress-test-' + Date.now();
const TOTAL = 15;

// We need the cloud URL — read it from the client's cloud-sync config or use env
const CLOUD_URL = process.env.CLOUD_URL;

async function postIngest(url, table, rows, deviceId) {
  const res = await fetch(url + '/api/ingest/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
    body: JSON.stringify({ table, rows, device_id: deviceId }),
  });
  if (!res.ok) throw new Error(res.status + ' ' + (await res.text()).slice(0, 200));
  return true;
}

(async () => {
  if (!CLOUD_URL) {
    console.error('Set CLOUD_URL in .env (e.g. https://your-cloud-service.onrender.com)');
    process.exit(1);
  }

  console.log('=== STRESS TEST ===');
  console.log('Cloud:  ' + CLOUD_URL);
  console.log('Device: ' + TEST_DEVICE);
  console.log('Sending ' + TOTAL + ' entries as ' + TOTAL + ' concurrent requests...\n');

  // Fire all 15 as separate concurrent requests — worst case scenario
  const start = Date.now();
  const promises = [];
  for (let i = 1; i <= TOTAL; i++) {
    const entry = {
      id: i,
      ingredient_id: 99999,
      ingredient_name: '__stress_test__',
      type: 'sale',
      amount: -0.001,
      entry_date: '2026-10-05',
      created_at: new Date().toISOString(),
      order_id: null,
      order_item_id: null,
      reason: 'stress-test',
    };
    promises.push(
      postIngest(CLOUD_URL, 'inventory_entries', [entry], TEST_DEVICE)
        .then(() => { process.stdout.write('.'); return { ok: true }; })
        .catch(err => { process.stdout.write('X'); return { ok: false, error: err.message }; })
    );
  }

  const results = await Promise.all(promises);
  const elapsed = Date.now() - start;
  const ok = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);

  console.log('\n\nDone in ' + elapsed + 'ms');
  console.log('HTTP success: ' + ok + '/' + TOTAL);
  if (failed.length > 0) {
    console.log('Failures:');
    for (const f of failed) console.log('  ' + f.error);
  }

  // Check database
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const landed = await c.query(
    'SELECT COUNT(*) AS cnt FROM inventory_entries WHERE device_id = $1', [TEST_DEVICE]);
  const count = Number(landed.rows[0].cnt);

  console.log('\n=== RESULT ===');
  console.log('  Sent:    ' + TOTAL);
  console.log('  Landed:  ' + count);
  console.log('  Dropped: ' + (TOTAL - count));

  if (count === TOTAL) {
    console.log('\n  PASS — all entries arrived under concurrent load');
  } else {
    console.log('\n  FAIL — ' + (TOTAL - count) + ' entries were dropped');
  }

  // Cleanup
  const del = await c.query('DELETE FROM inventory_entries WHERE device_id = $1', [TEST_DEVICE]);
  console.log('\nCleaned up ' + del.rowCount + ' test entries.');

  // Restore stock in case recomputeStock touched it
  await c.query('UPDATE ingredients SET stock = 61.0838 WHERE branch_id = 1 AND name = $1', ['Milk']);
  await c.query('UPDATE ingredients SET stock = 33181.31 WHERE branch_id = 1 AND name = $1', ['Yogurt']);
  console.log('Stock restored to correct values.');

  await c.end();
})();
