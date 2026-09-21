/**
 * The till and the dashboard show the same stock numbers.
 *
 *   cd backend
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres PGPOOL_MAX=1 \
 *     node scripts/run-script.js ../cloud/test/stock-till-vs-cloud.js
 *
 * A throwaway till database (temp SQLite) does a week of real sales, voids, restocks,
 * removals, waste, conversions and counts through the till's own routes. Its rows are
 * pushed to a throwaway cloud (a local Postgres, or PGlite), the way db/cloud-sync.js
 * pushes them. Then:
 *   - the till's and the cloud's stock table are identical, field by field
 *   - the cloud's stock is the sum of its entries, and a till pushing a bare stock
 *     number cannot change it
 *   - sending the same batch twice changes nothing
 *   - a till restored from the cloud rebuilds the same table, with every sale entry
 *     still pointing at its order line
 * It refuses to run unless DATABASE_URL points at this computer, and it wipes the
 * cloud tables it uses.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (!/@(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('Refusing to run: DATABASE_URL must point at a local throwaway Postgres.');
  process.exit(1);
}
// A made-up key, set before the cloud loads: the real one in cloud/.env is never used here.
const KEY = crypto.randomBytes(24).toString('hex');
process.env.TILL_API_KEY = KEY;
process.env.POS_USER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-till-vs-cloud-'));

const CLOUD = path.join(__dirname, '..');
const cloudDb = require(path.join(CLOUD, 'db', 'pg'));
const { createSchema } = require(path.join(CLOUD, 'db', 'schema'));
const bcrypt = require(path.join(CLOUD, 'node_modules', 'bcryptjs'));
const express = require(path.join(CLOUD, 'node_modules', 'express'));

const till = require('../../backend/db/database');
const { buildOrderSyncPayload } = require('../../backend/db/order-sync-payload');
const { applyCloudRestore } = require('../../backend/db/cloud-restore');

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
  if (!cond) failures++;
};
const near = (a, b) => Math.abs(a - b) < 0.0011;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('en-CA'); };
const today = daysAgo(0);
const DEVICE_A = 'device-a';
const DEVICE_B = 'device-b';

(async () => {
  await createSchema(cloudDb);
  await cloudDb.run('TRUNCATE order_items, orders, shifts, expenses, staff, ingredients, inventory_entries, credit_payments, customers, live_status, sync_cursor, sessions, users, branches RESTART IDENTITY CASCADE');
  await cloudDb.run('INSERT INTO branches (id,name,api_key_hash) VALUES (?,?,?)', [1, 'Test Branch', crypto.createHash('sha256').update(KEY).digest('hex')]);
  await cloudDb.run('INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?,?)',
    ['owner@test.local', bcrypt.hashSync('owner-password-long', 10), 'Owner', 'owner']);

  const cloudApp = require(path.join(CLOUD, 'app'));
  const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const cloudServer = await listen(cloudApp);
  const CLOUD_URL = `http://127.0.0.1:${cloudServer.address().port}/api`;

  const tillApp = express();
  tillApp.use(express.json());
  tillApp.use((req, _r, next) => { req.user = { staffId: 1, role: 'Admin', name: 'Owner' }; next(); });
  tillApp.use('/api/orders', require('../../backend/routes/orders'));
  tillApp.use('/api/inventory', require('../../backend/routes/inventory'));
  tillApp.use('/api/reports', require('../../backend/routes/reports'));
  const tillServer = await listen(tillApp);
  const TILL_URL = `http://127.0.0.1:${tillServer.address().port}/api`;

  const call = async (base, method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const tillCall = (m, p, b) => call(TILL_URL, m, p, b);

  const login = await call(CLOUD_URL, 'POST', '/auth/login', { email: 'owner@test.local', password: 'owner-password-long' });
  const cookie = login.cookie;
  check('the cloud takes the owner in', login.status === 200 && !!cookie, `status ${login.status}`);
  const cloudGet = (p) => call(CLOUD_URL, 'GET', p, null, { Cookie: cookie });

  // Pushes exactly what db/cloud-sync.js sends: whole rows, entries carrying the ingredient's name.
  const push = (table, rows, device = DEVICE_A) => call(CLOUD_URL, 'POST', '/ingest/batch',
    { table, rows, device_id: device }, { Authorization: `Bearer ${KEY}` });
  const pushEverything = async () => {
    const names = new Map(till.prepare('SELECT id, name FROM ingredients').all().map((i) => [i.id, i.name]));
    const results = [
      await push('ingredients', till.prepare('SELECT * FROM ingredients').all()),
      await push('orders', till.prepare('SELECT id FROM orders ORDER BY id').all().map((o) => buildOrderSyncPayload(o.id))),
      await push('inventory_entries', till.prepare('SELECT * FROM inventory_entries ORDER BY id').all()
        .map((e) => ({ ...e, ingredient_name: names.get(e.ingredient_id) }))),
    ];
    results.filter((r) => r.status !== 200).forEach((r) => console.log('   push failed:', r.status, JSON.stringify(r.body)));
    return results.every((r) => r.status === 200);
  };

  // ------------------------------------------------------ a week at the till
  till.prepare("INSERT INTO shifts (staff_id, staff_name, opening_cash, opened_at, status) VALUES (1, 'Owner', 0, datetime('now','localtime'), 'open')").run();
  const milk = till.prepare("SELECT * FROM ingredients WHERE name = 'Milk'").get();
  const yogurt = till.prepare("SELECT * FROM ingredients WHERE name = 'Yogurt'").get();
  const menu = (n, c) => till.prepare('SELECT id, price FROM menu_items WHERE name = ? AND category = ?').get(n, c);
  const L1 = menu('1 Litre', 'Milk'); const L2 = menu('2 Litre', 'Milk'); const DAHI = menu('Dahi', 'Dahi'); const KG05 = menu('0.5 KG', 'Dahi');
  const line = (m, name, qty) => ({ id: m.id, name, price: m.price, quantity: qty, is_deal: false });
  const sell = async (lines, day) => {
    const r = await tillCall('POST', '/orders', { items: lines, total: lines.reduce((s, l) => s + l.price * l.quantity, 0), payment_method: 'Cash', order_type: 'Walk-in' });
    if (day) {
      till.prepare('UPDATE orders SET created_at = ? || substr(created_at, 11) WHERE id = ?').run(day, r.body.id);
      till.prepare("UPDATE inventory_entries SET entry_date = ?, created_at = ? || substr(created_at, 11) WHERE order_id = ? AND type = 'sale' AND amount < 0").run(day, day, r.body.id);
    }
    return r;
  };
  console.log('\nA week at the till');
  await tillCall('PUT', `/inventory/${milk.id}/stock`, { action: 'add', amount: 300, date: daysAgo(4) });
  await tillCall('PUT', `/inventory/${yogurt.id}/stock`, { action: 'add', amount: 20000, date: daysAgo(4) });
  await sell([line(L2, '2 Litre', 3), line(L1, '1 Litre', 2), line(DAHI, 'Dahi', 1)], daysAgo(3));
  await sell([line(L1, 'Milk (0.6300 L)', 0.63), line(KG05, '0.5 KG', 2)], daysAgo(3));
  const voided = await sell([line(L2, '2 Litre', 2), line(DAHI, 'Dahi (192 g)', 0.1923)], daysAgo(2));
  await tillCall('PUT', `/orders/${voided.body.id}/void`);
  await sell([line(L1, '1 Litre', 4)], daysAgo(2));
  await tillCall('PUT', `/inventory/${milk.id}/stock`, { action: 'subtract', amount: 4, date: daysAgo(2) });
  await tillCall('POST', '/inventory/waste', { ingredient_id: milk.id, amount: 66.789, date: daysAgo(1) });
  await tillCall('POST', '/inventory/convert-to-yogurt', { milk_amount: 20, yogurt_amount: 2000, date: daysAgo(1) });
  await sell([line(L1, '1 Litre', 5), line(DAHI, 'Dahi', 1)]);
  await tillCall('PUT', `/inventory/${milk.id}/stock`, { stock: till.prepare('SELECT stock FROM ingredients WHERE id = ?').get(milk.id).stock - 1.5, date: today });
  check('the till made its week', till.prepare('SELECT COUNT(*) n FROM inventory_entries').get().n >= 15);

  // ------------------------------------------------------ till vs cloud
  console.log('\nThe till and the dashboard agree');
  check('the whole week reaches the cloud', await pushEverything());
  const RANGE = `from=${daysAgo(4)}&to=${today}`;
  const tillTable = (await tillCall('GET', `/reports/stock-movement?${RANGE}`)).body;
  const cloudRes = await cloudGet(`/reports/stock-movement?${RANGE}`);
  check('the dashboard answers', cloudRes.status === 200, `status ${cloudRes.status}`);
  const cloudTable = cloudRes.body;
  check('same number of rows', Array.isArray(cloudTable) && tillTable.length === cloudTable.length, `${tillTable.length} vs ${cloudTable.length}`);
  const strip = (rows) => JSON.parse(JSON.stringify(rows.map(({ ingredient_id, ...rest }) => rest)));
  check('every figure is identical, row by row', JSON.stringify(strip(tillTable)) === JSON.stringify(strip(cloudTable)),
    JSON.stringify(strip(tillTable).find((r, i) => JSON.stringify(r) !== JSON.stringify(strip(cloudTable)[i])) || ''));
  for (const name of ['Milk', 'Yogurt']) {
    const rows = cloudTable.filter((r) => r.name === name);
    let prev = null;
    let allAdd = true; let chained = true;
    for (const r of rows) {
      if (!near(r.opening_balance + r.restocked + r.converted - r.sold - r.waste - r.removed, r.closing_balance)) allAdd = false;
      if (prev && !near(prev.closing_balance, r.opening_balance)) chained = false;
      prev = r;
    }
    check(`${name} on the dashboard: every row adds up`, allAdd);
    check(`${name} on the dashboard: each Opening is the previous Closing`, chained);
    const counter = till.prepare('SELECT stock FROM ingredients WHERE name = ?').get(name).stock;
    check(`${name}: the dashboard's latest Closing is the till's stock`, prev && near(prev.closing_balance, counter), `${prev && prev.closing_balance} vs ${counter}`);
  }
  const kpi = (await cloudGet(`/reports/kpi?${RANGE}`)).body;
  const cloudStock = Object.fromEntries((kpi.ingredient_usage || []).map((i) => [i.name, i.current_stock]));
  check("the dashboard's stock equals the till's stock",
    near(cloudStock.Milk, till.prepare("SELECT stock FROM ingredients WHERE name='Milk'").get().stock)
    && near(cloudStock.Yogurt, till.prepare("SELECT stock FROM ingredients WHERE name='Yogurt'").get().stock),
    JSON.stringify(cloudStock));
  const linked = (await cloudDb.one("SELECT COUNT(*)::int AS n FROM inventory_entries WHERE type='sale' AND amount < 0 AND (order_local_id IS NULL OR order_item_local_id IS NULL)")).n;
  check('every sale entry on the cloud names its order line', linked === 0, `${linked} without`);

  // -------------------------------------------------- pushed stock numbers
  console.log('\nThe cloud never takes a stock number from a till');
  const before = JSON.stringify(cloudStock);
  await push('ingredients', [{ id: milk.id, name: 'Milk', unit: 'Litre', stock: 12345, low_stock_threshold: 0, cost_per_unit: 0 }], DEVICE_B);
  const kpi2 = (await cloudGet(`/reports/kpi?${RANGE}`)).body;
  check('a till pushing "stock: 12345" changes nothing', JSON.stringify(Object.fromEntries(kpi2.ingredient_usage.map((i) => [i.name, i.current_stock]))) === before);
  await push('inventory_entries', [{ id: 1, ingredient_id: milk.id, ingredient_name: 'Milk', type: 'stock', amount: 50, entry_date: today, created_at: `${today} 10:00:00` }], DEVICE_B);
  const kpi3 = (await cloudGet(`/reports/kpi?${RANGE}`)).body;
  check("a second till's restock adds to the cloud's stock (sum of every till's entries)",
    near(kpi3.ingredient_usage.find((i) => i.name === 'Milk').current_stock, cloudStock.Milk + 50));
  await cloudDb.run("DELETE FROM inventory_entries WHERE device_id = ?", [DEVICE_B]);
  await push('inventory_entries', [], DEVICE_A);
  await cloudDb.run("UPDATE ingredients SET stock = (SELECT COALESCE(SUM(amount),0) FROM inventory_entries e WHERE e.branch_id = ingredients.branch_id AND e.ingredient_local_id = ingredients.local_id)");

  // ------------------------------------------------------ same batch twice
  console.log('\nThe same batch twice');
  check('sent again', await pushEverything());
  const again = (await cloudGet(`/reports/stock-movement?${RANGE}`)).body;
  check('nothing doubled', JSON.stringify(again) === JSON.stringify(cloudTable));

  // ------------------------------------------------------ restore
  console.log('\nA till restored from the cloud');
  const full = await call(CLOUD_URL, 'GET', '/restore/full', null, { Authorization: `Bearer ${KEY}` });
  check('the cloud hands over the whole history', full.status === 200 && full.body.inventory_entries.length > 0);
  await applyCloudRestore(full.body);
  const restored = (await tillCall('GET', `/reports/stock-movement?${RANGE}`)).body;
  check('the restored till builds the same table as the dashboard', JSON.stringify(strip(restored)) === JSON.stringify(strip(cloudTable)));
  check('restored counters equal the sum of their entries',
    till.prepare('SELECT * FROM ingredients').all().every((i) => near(i.stock, till.prepare('SELECT COALESCE(SUM(amount),0) s FROM inventory_entries WHERE ingredient_id = ?').get(i.id).s)));
  const orphans = till.prepare(`SELECT COUNT(*) n FROM inventory_entries e
    WHERE e.type = 'sale' AND e.amount < 0 AND (e.order_id IS NULL OR e.order_item_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.id = e.order_item_id AND oi.order_id = e.order_id))`).get().n;
  check('every restored sale entry still points at its order line', orphans === 0, `${orphans} broken`);

  tillServer.close(); cloudServer.close();
  await cloudDb.close();
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await cloudDb.close(); } catch (x) { /* already closed */ } process.exit(1); });
