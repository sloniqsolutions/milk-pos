/**
 * "After Restore from cloud, every customer shows no balance and no history."
 *
 *   cd backend
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/postgres node test/restore-customer-links.js
 *
 * The whole trip, through the real code on both sides: till A rings up credit sales and
 * payments through its own HTTP API and pushes them to the REAL cloud (cloud/server.js),
 * then a brand-new till B presses "Restore from cloud" — and every customer's balance,
 * litres and credit orders must come back exactly as till A had them. Then till B is
 * restarted on this checkout's backend, the way a shop picks up an update, and they must
 * still be right (for a till restored by an older build, that restart is what heals it —
 * see db/relink-credit-orders.js).
 *
 * The customers are the kinds a restore has to find an order's owner for: a phone written
 * with a dash, two with no phone at all (the shop's own "Staff milk" is one), an ordinary
 * one, and one who never bought anything.
 *
 * RESTORE_BACKEND=<path to another build's backend folder> makes till B restore with that
 * build instead, e.g. the installed app's
 *   "%LOCALAPPDATA%/Programs/Pure Milk POS/resources/backend"
 * which is how the bug is shown on the build that has it.
 *
 * Local databases only. DATABASE_URL must point at localhost, and branch 1 there must be
 * empty; anything else is refused before a single row is written. A throwaway Postgres
 * needs no install:  npx -y @electric-sql/pglite-socket --port=55432
 * Exits non-zero on any failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const BE = path.join(__dirname, '..');
const CLOUD_ROOT = path.join(BE, '..', 'cloud');
const RESTORE_BACKEND = process.env.RESTORE_BACKEND ? path.resolve(process.env.RESTORE_BACKEND) : BE;
const DATABASE_URL = process.env.DATABASE_URL || '';
const CLOUD_PORT = 4481;
const A_PORT = 3481;
const B_PORT = 3482;
const KEY = crypto.randomBytes(32).toString('hex');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL)) {
  console.error('Refusing to run: DATABASE_URL must be a LOCAL Postgres (localhost / 127.0.0.1). See the header.');
  process.exit(1);
}

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ processes
const cloudEnv = { ...process.env, DATABASE_URL, TILL_API_KEY: KEY, PORT: String(CLOUD_PORT) };
delete cloudEnv.ELECTRON_RUN_AS_NODE;
delete cloudEnv.POS_USER_DATA_PATH;

const running = [];
function start(args, cwd, env) {
  const p = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'ignore', process.env.VERBOSE ? 'inherit' : 'ignore'] });
  running.push(p);
  return p;
}
/** A till runs under Electron (scripts/run-script.js), a grandchild — so the whole tree goes. */
function stop(p) {
  if (!p || p.exitCode != null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
  else p.kill('SIGKILL');
}
function cloudExec(js) {
  const r = spawnSync(process.execPath, ['-e', js], { cwd: CLOUD_ROOT, env: cloudEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('cloud script failed: ' + (r.stderr || r.stdout));
  return r.stdout.trim();
}
async function waitFor(url, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true; } catch (e) { /* not up yet */ }
    await sleep(300);
  }
  return false;
}
async function call(base, method, p, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const must = (r, what) => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

// ------------------------------------------------------------------ tills
const dirs = [];
function newTillDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pos-restore-links-${tag}-`));
  dirs.push(d);
  fs.writeFileSync(path.join(d, 'cloud-sync.json'), JSON.stringify({
    enabled: true, cloud_url: `http://127.0.0.1:${CLOUD_PORT}`, branch_id: 1, branch_name: 'Restore test', api_key: KEY,
  }));
  return d;
}
async function startTill(dir, port, backend = BE) {
  const env = { ...process.env, POS_USER_DATA_PATH: dir, PORT: String(port) };
  const p = start(['scripts/run-script.js', path.join(backend, 'server.js')], BE, env);
  if (!await waitFor(`http://127.0.0.1:${port}/api/health`)) throw new Error(`till on ${port} would not start`);
  return p;
}
/** Signs in as whichever active account has PIN 1234 (a fresh till's admin, or a restore's fallback admin). */
async function signIn(base) {
  const roster = must(await call(base, 'GET', '/api/staff/directory'), 'staff directory');
  const ids = (Array.isArray(roster) ? roster : roster.staff || []).map((s) => s.id);
  for (let attempt = 0; attempt < 120; attempt++) {
    let held = false;
    for (const id of ids.length ? ids : [1]) {
      const r = await call(base, 'POST', '/api/staff/login', null, { pin: '1234', staff_id: id });
      if (r.status === 200) return r.body.token;
      if (r.status === 503) held = true; // a first-run restore is still loading
    }
    if (!held) break;
    await sleep(500);
  }
  throw new Error(`could not sign in to ${base}`);
}
/** What the Customers screen shows for each customer: the list row and the ledger it opens. */
async function customerFigures(base, token) {
  const list = must(await call(base, 'GET', '/api/customers', token), 'customer list');
  const out = {};
  for (const c of list) {
    const d = must(await call(base, 'GET', `/api/customers/${c.id}`, token), 'customer ledger');
    out[c.name] = {
      list_balance: Math.round(c.balance * 100) / 100,
      list_litres: Math.round(c.total_litres * 1000) / 1000,
      balance: Math.round(d.balance * 100) / 100,
      litres: Math.round(d.total_litres * 1000) / 1000,
      credit_orders: d.orders.length,
    };
  }
  return out;
}
function compare(before, after) {
  for (const name of Object.keys(before)) {
    const b = before[name];
    const a = after[name];
    if (!a) { check(`${name} is on the customer list`, false); continue; }
    check(`${name}: balance ${b.balance}`, a.balance === b.balance && a.list_balance === b.list_balance,
      `got ${a.balance} (list ${a.list_balance})`);
    check(`${name}: litres ${b.litres}`, a.litres === b.litres && a.list_litres === b.list_litres,
      `got ${a.litres} (list ${a.list_litres})`);
    check(`${name}: ${b.credit_orders} credit orders`, a.credit_orders === b.credit_orders, `got ${a.credit_orders}`);
  }
}

// Every branch-1 row, in every cloud table that has one — the branch was empty when we started.
const CLEAR_BRANCH = `
  const db = require('./db/pg');
  (async () => {
    const tables = await db.q("SELECT table_name FROM information_schema.columns WHERE column_name = 'branch_id' AND table_schema = 'public'");
    for (const { table_name } of tables) await db.run('DELETE FROM ' + table_name + ' WHERE branch_id = 1');
    await db.close();
  })().catch((e) => { console.error(e.message); process.exit(1); });`;

(async () => {
  let cloudWritten = false;
  try {
    // ---------------------------------------------------------------- the cloud, on the local database
    const existing = cloudExec(`
      const db = require('./db/pg');
      const { createSchema } = require('./db/schema');
      (async () => {
        await createSchema(db);
        const n = await db.one('SELECT COUNT(*)::int AS n FROM orders WHERE branch_id = 1');
        const c = await db.one('SELECT COUNT(*)::int AS n FROM customers WHERE branch_id = 1');
        console.log(n.n + c.n);
        await db.close();
      })().catch((e) => { console.error(e.message); process.exit(1); });`);
    if (Number(existing) !== 0) throw new Error('branch 1 on this database already has data — use an empty, throwaway database');
    cloudWritten = true;
    cloudExec(`
      const db = require('./db/pg');
      db.run("INSERT INTO branches (id, name, code, api_key_hash) VALUES (1, 'Restore test', 'RT', 'x') ON CONFLICT (id) DO NOTHING")
        .then(() => db.close()).catch((e) => { console.error(e.message); process.exit(1); });`);
    start(['server.js'], CLOUD_ROOT, cloudEnv);
    if (!await waitFor(`http://127.0.0.1:${CLOUD_PORT}/api/health`)) throw new Error('cloud would not start');
    console.log(`\nTill B restores with: ${RESTORE_BACKEND === BE ? 'this checkout' : RESTORE_BACKEND}`);

    // ---------------------------------------------------------------- till A trades
    console.log('\nA. Till A sells on credit and takes payments');
    const tillA = await startTill(newTillDir('A'), A_PORT);
    const A = `http://127.0.0.1:${A_PORT}`;
    const TA = await signIn(A);
    must(await call(A, 'POST', '/api/shifts/open', TA, { opening_cash: 0 }), 'open shift');
    for (const ing of must(await call(A, 'GET', '/api/inventory', TA), 'inventory')) {
      must(await call(A, 'PUT', `/api/inventory/${ing.id}/stock`, TA, { action: 'add', amount: 1000 }), 'restock');
    }
    const menu = must(await call(A, 'GET', '/api/menu', TA), 'menu');
    const items = Array.isArray(menu) ? menu : (menu.items || []);
    const milk = items.find((m) => m.category === 'Milk' && m.active && /litre/i.test(m.name));
    const dahi = items.find((m) => m.category === 'Dahi' && m.active);

    const customer = async (name, phone) => {
      const id = must(await call(A, 'POST', '/api/customers', TA, phone ? { name, phone } : { name }), 'add customer').id;
      return { id, name, phone: phone || '' };
    };
    const suleman = await customer('Suleman', '0300-1234567');
    const staffMilk = await customer('Staff milk');
    const aniti = await customer('Aniti');
    const rizwan = await customer('Rizwan', '03214934809');
    await customer('Never Bought', '03019998888');

    // The same fields the sale screen sends for a credit sale (pages/SaleScreen.tsx).
    const sell = async (c, lines, method = 'Credit') => must(await call(A, 'POST', '/api/orders', TA, {
      items: lines.map(([m, q]) => ({ id: m.id, name: m.name, price: m.price, quantity: q, is_deal: false })),
      payment_method: method,
      customer_id: method === 'Credit' ? c.id : null,
      customer_name: c ? c.name : null,
      customer_phone: c ? c.phone || null : null,
    }), 'sale');
    await sell(suleman, [[milk, 2]]);
    await sell(suleman, [[milk, 1], [dahi, 1]]);
    await sell(staffMilk, [[milk, 3]]);
    await sell(staffMilk, [[milk, 1]]);
    await sell(aniti, [[milk, 2]]);
    await sell(rizwan, [[milk, 4]]);
    await sell(null, [[milk, 1]], 'Cash');
    must(await call(A, 'POST', `/api/customers/${suleman.id}/payments`, TA, { amount: 100 }), 'payment');
    must(await call(A, 'POST', `/api/customers/${staffMilk.id}/payments`, TA, { amount: 50 }), 'payment');

    const before = await customerFigures(A, TA);
    console.table(before);

    // Every push is fire-and-forget; wait until the cloud's export stops growing.
    let exported = null;
    let lastShape = '';
    for (let i = 0; i < 40; i++) {
      await sleep(750);
      exported = must(await call(`http://127.0.0.1:${CLOUD_PORT}`, 'GET', '/api/restore/full', KEY), 'cloud export');
      const shape = ['customers', 'orders', 'order_items', 'credit_payments'].map((k) => exported[k].length).join(',');
      if (shape === lastShape && exported.orders.length === 7 && exported.credit_payments.length === 2) break;
      lastShape = shape;
    }
    check('the cloud has every customer, order and payment',
      exported.customers.length === 5 && exported.orders.length === 7 && exported.credit_payments.length === 2,
      `${exported.customers.length} customers, ${exported.orders.length} orders, ${exported.credit_payments.length} payments`);
    stop(tillA);

    // ---------------------------------------------------------------- a new till restores
    console.log('\nB. A brand-new till presses "Restore from cloud"');
    const dirB = newTillDir('B');
    let tillB = await startTill(dirB, B_PORT, RESTORE_BACKEND);
    const B = `http://127.0.0.1:${B_PORT}`;
    const restore = must(await call(B, 'POST', '/api/cloud/restore-from-cloud', await signIn(B), { pin: '1234' }), 'restore');
    console.log(`   restored: ${JSON.stringify(restore.restored)}`);
    const after = await customerFigures(B, await signIn(B));
    console.table(after);
    compare(before, after);

    // ---------------------------------------------------------------- and picks up this build
    console.log('\nC. The same till restarted on this checkout (an update) — still right');
    stop(tillB);
    await sleep(500);
    tillB = await startTill(dirB, B_PORT, BE);
    const healed = await customerFigures(B, await signIn(B));
    console.table(healed);
    compare(before, healed);
    stop(tillB);
  } catch (err) {
    console.error('THREW:', err.stack || err.message);
    failures++;
  } finally {
    running.slice().reverse().forEach(stop);
    if (cloudWritten) {
      try { cloudExec(CLEAR_BRANCH); } catch (e) { console.error('Could not clear the test branch:', e.message); }
    }
    await sleep(300);
    dirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* still locked */ } });
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    process.exit(failures ? 1 : 0);
  }
})();
