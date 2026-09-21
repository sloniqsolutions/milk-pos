/**
 * The stock table, proven on the REAL data — read-only. Nothing is written.
 *
 *   cd backend
 *   ALLOW_REAL_CLOUD_READ=1 node scripts/run-script.js ../cloud/test/real-data-check.js
 *
 * REAL cloud: the cloud's own report and history routes are run in this process against
 *   the cloud database named in cloud/.env (only SELECTs run; the connection string is never printed).
 * REAL till: a temporary COPY of backend/pos_database.db, run through the till's own routes.
 *
 * It checks the same things as the synthetic tests, then says plainly what does not
 * match. A difference against the physical stock counter is printed as a GAP: it is a
 * fact to report, not something to make disappear.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

if (process.env.ALLOW_REAL_CLOUD_READ !== '1') {
  console.error('This reads the real cloud (read-only). Set ALLOW_REAL_CLOUD_READ=1 to run it.');
  process.exit(1);
}
const BACKEND = path.join(__dirname, '..', '..', 'backend');
const CLOUD = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-real-copy-'));
for (const f of ['pos_database.db', 'pos_database.db-wal', 'pos_database.db-shm']) {
  if (fs.existsSync(path.join(BACKEND, f))) fs.copyFileSync(path.join(BACKEND, f), path.join(tmp, f));
}
process.env.POS_USER_DATA_PATH = tmp;

const express = require(path.join(CLOUD, 'node_modules', 'express'));
const cloudDb = require(path.join(CLOUD, 'db', 'pg'));
const till = require(path.join(BACKEND, 'db', 'database'));
const { judge, orderLine, YOGURT_FACTOR } = require(path.join(BACKEND, 'db', 'stock-cleanup'));

let failures = 0; let gaps = 0;
const check = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`); if (!cond) failures++; };
const gap = (label, detail) => { console.log(`  GAP   ${label}   ${detail}`); gaps++; };
const near = (a, b) => Math.abs(a - b) < 0.0011;
const r3 = (n) => Math.round(n * 1000) / 1000;
const FROM = '2026-09-15';
const TO = new Date().toLocaleDateString('en-CA');

const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const get = async (server, p) => (await fetch(`http://127.0.0.1:${server.address().port}${p}`)).json();

function tableProblems(rows, label) {
  let bad = 0; let chain = 0;
  const last = {};
  for (const r of rows) {
    if (!near(r.opening_balance + r.restocked + r.converted - r.sold - r.waste - r.removed, r.closing_balance)) { bad++; console.log(`        row does not add up: ${label} ${r.name} ${r.date}`); }
    if (last[r.name] && !near(last[r.name].closing_balance, r.opening_balance)) chain++;
    last[r.name] = r;
  }
  return { bad, chain, last };
}

(async () => {
  // ---------------------------------------------------------------- cloud
  console.log('\nREAL CLOUD (read-only)');
  const cloudApp = express();
  cloudApp.use((req, _r, next) => { req.user = { branchId: 1, role: 'owner' }; next(); });
  cloudApp.use('/api/reports', require(path.join(CLOUD, 'routes', 'reports')));
  cloudApp.use('/api/inventory', require(path.join(CLOUD, 'routes', 'inventory')));
  const cloudServer = await listen(cloudApp);
  const cTable = await get(cloudServer, `/api/reports/stock-movement?from=${FROM}&to=${TO}`);
  check('the dashboard table has rows', Array.isArray(cTable) && cTable.length > 0, `${cTable.length} rows`);
  const cp = tableProblems(cTable, 'cloud');
  check('every row adds up: Opening + Restocked +/- Converted - Sold - Waste - Removed = Closing', cp.bad === 0, `${cTable.length} rows`);
  check("each day's Opening equals the previous day's Closing", cp.chain === 0);
  check('no Other / adjustment column exists', cTable.every((r) => !('adjustment' in r)));

  const kpi = await get(cloudServer, `/api/reports/kpi?from=${FROM}&to=${TO}`);
  const counter = Object.fromEntries(kpi.ingredient_usage.map((i) => [i.name, Number(i.current_stock)]));
  for (const name of ['Milk', 'Yogurt']) {
    const l = cp.last[name];
    check(`${name}: the latest Closing (${l && l.closing_balance}) equals the cloud's stock (${counter[name]})`, l && near(l.closing_balance, counter[name]));
  }

  // Sold per day = the day's non-voided order lines, using the line rules the reports use
  const ing = Object.fromEntries((await cloudDb.q('SELECT local_id, name, unit FROM ingredients WHERE branch_id = 1')).map((i) => [i.local_id, i]));
  const yf = YOGURT_FACTOR(Object.values(ing).find((i) => i.name === 'Yogurt').unit);
  const lines = (await cloudDb.q(`
    SELECT o.device_id AS device, o.local_id AS ord, oi.local_id AS item, o.created_at, o.status, oi.name, oi.quantity, oi.category, oi.is_deal
      FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.branch_id = 1`))
    .map((r) => orderLine({ device: r.device, order: Number(r.ord), item: Number(r.item), created_at: r.created_at, status: r.status, name: r.name, quantity: r.quantity, category: r.category, is_deal: r.is_deal }, yf));
  const entries = (await cloudDb.q('SELECT * FROM inventory_entries WHERE branch_id = 1 AND superseded_by IS NULL')).map((e) => ({
    key: `${e.device_id}#${e.local_id}`, device: e.device_id, id: Number(e.local_id), ingredient: (ing[e.ingredient_local_id] || {}).name, type: e.type, amount: Number(e.amount),
    entry_date: e.entry_date, created_at: e.created_at, order: e.order_local_id == null ? null : Number(e.order_local_id), item: e.order_item_local_id == null ? null : Number(e.order_item_local_id) }));
  const result = judge({ entries, lines, suspectFrom: '2026-09-15', suspectTo: '2026-09-16' });
  const verdicts = [...result.verdicts.values()].map((v) => v.verdict);
  check('no sale entry left that contradicts its order line', !verdicts.includes('DELETE'));
  check('no order line left without its sale entry', result.missing.length === 0, `${result.missing.length} without`);
  const linesSold = {}; const asked = {};
  for (const l of lines) if (l.status !== 'voided' && l.ingredient) linesSold[`${l.day}|${l.ingredient}`] = (linesSold[`${l.day}|${l.ingredient}`] || 0) + l.amount;
  for (const e of entries) if (e.type === 'sale' && result.verdicts.get(e.key).verdict === 'ASK ME') asked[`${e.entry_date}|${e.ingredient}`] = (asked[`${e.entry_date}|${e.ingredient}`] || 0) - e.amount;
  let soldOk = true;
  for (const r of cTable) {
    const expected = (linesSold[`${r.date}|${r.name}`] || 0) + (asked[`${r.date}|${r.name}`] || 0);
    if (!near(r.sold, expected)) { soldOk = false; console.log(`        ${r.name} ${r.date}: Sold ${r.sold}, order lines + unresolved ASK ME entries ${r3(expected)}`); }
  }
  check("Sold per day equals that day's non-voided order lines, plus only the ASK ME entries still left as they were", soldOk);
  const askDays = Object.entries(asked).map(([k, v]) => `${k} ${r3(v)}`).join('; ');
  console.log(`  INFO  Sold is above the order lines only by these untouched ASK ME sale entries: ${askDays || 'none'}`);

  const hist = await get(cloudServer, `/api/inventory/history?branch=1&from=${FROM}&to=${TO}`);
  const corrected = hist.filter((h) => h.superseded_by != null);
  check('the corrected entries are still in the history, each pointing at its correction', corrected.length === 54, `${corrected.length} corrected entries visible`);
  check('and none of them is in any total', ['Milk', 'Yogurt'].every((name) => {
    const sum = hist.filter((h) => h.ingredient_name === name && h.superseded_by == null).reduce((s, h) => s + Number(h.amount), 0);
    return cp.last[name] && near(sum, cp.last[name].closing_balance);
  }));

  // ----------------------------------------------------------------- till copy
  console.log('\nREAL TILL (a copy of backend/pos_database.db)');
  const tillApp = express();
  tillApp.use((req, _r, next) => { req.user = { staffId: 1, role: 'Admin', name: 'Owner' }; next(); });
  tillApp.use('/api/reports', require(path.join(BACKEND, 'routes', 'reports')));
  const tillServer = await listen(tillApp);
  const tTable = await get(tillServer, `/api/reports/stock-movement?from=${FROM}&to=${TO}`);
  const tp = tableProblems(tTable, 'till');
  check('every row adds up', tp.bad === 0, `${tTable.length} rows`);
  check("each day's Opening equals the previous day's Closing", tp.chain === 0);

  // the till and the dashboard show the same numbers for the same day
  const tillLast = till.prepare("SELECT MAX(DATE(created_at)) d FROM orders").get().d;
  // Same range on both (the till copy ends on its last day; "stock lasts" is worked out from the range).
  const strip = (rows) => rows.map(({ ingredient_id, ...rest }) => JSON.stringify(rest));
  const a = strip(await get(tillServer, `/api/reports/stock-movement?from=${FROM}&to=${tillLast}`));
  const b = strip(await get(cloudServer, `/api/reports/stock-movement?from=${FROM}&to=${tillLast}`));
  check(`the till and the dashboard show identical rows for every day up to the till's last day (${tillLast}): ${a.length} rows`, a.length === b.length && a.every((x, i) => x === b[i]),
    a.length === b.length ? ((i) => (i < 0 ? '' : `till ${a[i]}  cloud ${b[i]}`))(a.findIndex((x, i) => x !== b[i])) : `${a.length} vs ${b.length} rows`);

  // Sold per day = order lines that have a recipe; lines with no recipe are listed
  const used = till.prepare(`
    SELECT DATE(o.created_at) d, i.name ing, SUM(oi.quantity * ri.quantity_required) used
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      JOIN recipes r ON r.menu_item_id = oi.menu_item_id AND (r.variant_id = oi.variant_id OR r.variant_id IS NULL)
      JOIN recipe_ingredients ri ON ri.recipe_id = r.id JOIN ingredients i ON i.id = ri.ingredient_id
     WHERE o.status != 'voided' AND COALESCE(oi.is_deal, 0) = 0 GROUP BY 1, 2`).all();
  const askedTill = {};
  for (const r of tTable) askedTill[`${r.date}|${r.name}`] = r;
  let recipeOk = true;
  for (const u of used) {
    const row = askedTill[`${u.d}|${u.ing}`];
    const extra = asked[`${u.d}|${u.ing}`] || 0;
    if (!row || !near(row.sold, u.used + extra)) { recipeOk = false; console.log(`        ${u.ing} ${u.d}: Sold ${row && row.sold}, order lines with a recipe ${r3(u.used)} (+ ASK ME ${r3(extra)})`); }
  }
  check("Sold per day equals that day's non-voided order lines that have a recipe (plus only the untouched ASK ME entries)", recipeOk);
  const noRecipe = till.prepare(`
    SELECT DATE(o.created_at) d, oi.name, COUNT(*) n FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.status != 'voided' AND COALESCE(oi.is_deal, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM recipes r WHERE r.menu_item_id = oi.menu_item_id AND (r.variant_id = oi.variant_id OR r.variant_id IS NULL))
     GROUP BY 1, 2 ORDER BY 1, 2`).all();
  const nrMilkDahi = noRecipe.filter((x) => /milk|litre|dahi|kg/i.test(x.name));
  console.log(`  INFO  order lines with no recipe, listed (they move no stock): ${noRecipe.length} kinds, e.g. ${JSON.stringify(noRecipe.slice(0, 3))}`);
  console.log(`  INFO  of those, Milk/Dahi-looking lines: ${nrMilkDahi.length ? JSON.stringify(nrMilkDahi) : 'none'}`);

  // the physical stock counters
  console.log('\nTHE STOCK COUNTERS');
  for (const name of ['Milk', 'Yogurt']) {
    const c = till.prepare('SELECT stock FROM ingredients WHERE name = ?').get(name).stock;
    const l = tp.last[name].closing_balance;
    if (near(l, c)) check(`${name}: the till's latest Closing equals its stock counter`, true, `${l}`);
    else gap(`${name}: the till copy's latest Closing is ${l} but its stock counter is ${r3(c)}`, `gap ${r3(c - l)} ${name === 'Milk' ? 'litres' : 'grams'} (counter minus Closing). Not closed with an invented entry.`);
  }

  cloudServer.close(); tillServer.close();
  await cloudDb.close();
  console.log(`\n${failures ? failures + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'}${gaps ? `  (${gaps} GAP(s) reported above: facts, not failures)` : ''}`);
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await cloudDb.close(); } catch (x) { /* closed */ } process.exit(1); });
