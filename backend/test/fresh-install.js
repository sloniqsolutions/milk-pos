/**
 * "Does a brand-new install load its data by itself?" — run this before building an installer.
 *
 *   cd backend
 *   node scripts/run-script.js test/fresh-install.js
 *
 * It starts the REAL backend (server.js) on an empty data folder, paired to a MOCK cloud the
 * way the installer pairs a fresh machine, and checks — without anyone pressing Restore —
 * that the till catches up on its own:
 *
 *   - the cloud is SLOW (25s before it sends anything, past the shared client's old 20s
 *     allowance), as a real shop's full history is;
 *   - sign-in is held while that is happening, and works once it lands;
 *   - today's orders are there, and every credit customer's litres / Dahi / balance come out
 *     right — including customers whose phone is written differently or who have none;
 *   - "credit collected" is right on the day filters (yesterday, today, both) and does not
 *     count the stand-in payment a restore writes for history it cannot itemise;
 *   - the same person held twice by the cloud is one customer on the till.
 *
 * Set DELAY_MS=0 to skip the slow-cloud part. Exits non-zero on any failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const BE = path.join(__dirname, '..');
const bcrypt = require(path.join(BE, 'node_modules', 'bcryptjs'));
const Database = require(path.join(BE, 'node_modules', 'better-sqlite3'));

const DELAY_MS = process.env.DELAY_MS != null ? Number(process.env.DELAY_MS) : 25000;
const PORT = 3497;

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
  if (!cond) failures++;
};
const near = (a, b) => Math.abs(a - b) < 0.005;

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const now = new Date();
const yesterdayDate = new Date(now.getTime() - 864e5);
const TODAY = stamp(now).slice(0, 10);
const YESTERDAY = stamp(yesterdayDate).slice(0, 10);

// ------------------------------------------------------------------ the branch's history, as the cloud holds it
const cust = (device, id, name, phone, paid) => ({ local_id: id, device_id: device, name, phone, active: 1, total_paid: paid });
const HIST = {
  staff: [{ local_id: 1, device_id: 'DEV', name: 'Owner', role: 'Owner', color: '#111', active: 1, pin_hash: bcrypt.hashSync('4321', 8) }],
  customers: [
    cust('DEV', 1, 'Staff Milk', '0300-1111111', 50),
    cust('legacy', 1, 'Staff Milk', '03001111111', 50),      // the same person, pushed by an older build
    cust('DEV', 2, 'Suleman', '03002222222', 430),
    cust('DEV', 3, 'Hina', null, 0),                         // no phone
    cust(null, 10001, 'Bilal', '03004444444', 0),            // created on the dashboard
  ],
  ingredients: [{ local_id: 1, name: 'Milk', unit: 'L', stock: 80, low_stock_threshold: 5, cost_per_unit: 0 },
    { local_id: 2, name: 'Yogurt', unit: 'g', stock: 5000, low_stock_threshold: 0, cost_per_unit: 0 }],
  shifts: [{ local_id: 1, device_id: 'DEV', staff_id: 1, staff_name: 'Owner', opening_cash: 0, closing_cash: 100, expected_cash: 100, variance: 0, opened_at: stamp(yesterdayDate), closed_at: stamp(yesterdayDate), status: 'closed', received_at: 1 }],
  expenses: [], orders: [], order_items: [], inventory_entries: [],
  // What the cloud holds for payments: Suleman paid 100 yesterday and 230 today (430 in all — 100 of it
  // from before payments were kept one by one); Staff Milk 50 today. One of them was pushed twice.
  credit_payments: [
    { local_id: 1, device_id: 'DEV', customer_local_id: 2, local_shift_id: 1, amount: 100, note: null, received_by: 'Owner', created_at: `${YESTERDAY} 11:00:00`, received_at: 1 },
    { local_id: 1, device_id: 'legacy', customer_local_id: 2, local_shift_id: 1, amount: 100, note: null, received_by: 'Owner', created_at: `${YESTERDAY} 11:00:00`, received_at: 2 },
    { local_id: 2, device_id: 'DEV', customer_local_id: 2, local_shift_id: 1, amount: 230, note: null, received_by: 'Owner', created_at: `${TODAY} 09:30:00`, received_at: 3 },
    { local_id: 3, device_id: 'DEV', customer_local_id: 1, local_shift_id: 1, amount: 50, note: null, received_by: 'Owner', created_at: `${TODAY} 10:00:00`, received_at: 4 },
  ],
};
let oid = 0; let iid = 0;
const order = (when, payment, name, phone, lines) => {
  const id = ++oid;
  HIST.orders.push({ local_id: id, device_id: 'DEV', total: lines.reduce((s, l) => s + l[1] * l[2], 0), discount: 0, payment_method: payment, status: 'completed',
    cashier_name: 'Owner', cashier_id: 1, created_at: stamp(when), order_type: 'Walk-in', delivery_charge: 0, local_shift_id: 1, tax_rate: 0, tax_amount: 0,
    is_employee: 0, employee_discount: 0, employee_discount_rate: 0, customer_name: name, customer_phone: phone, received_at: id });
  lines.forEach(([n, price, qty, cat]) => HIST.order_items.push({ local_id: ++iid, order_local_id: id, order_device_id: 'DEV', menu_item_id: 77, name: n, price, quantity: qty, is_deal: 0, variant_id: null, category: cat }));
};
order(yesterdayDate, 'Credit', 'Suleman', '0300 2222222', [['2 Litre', 400, 3, 'Milk'], ['0.5 KG', 300, 2, 'Dahi']]);  // 6 L, 1 kg — phone written differently
order(now, 'Credit', 'Hina', null, [['Milk (0.6300 L)', 200, 0.63, 'Milk'], ['Dahi (192 g)', 520, 0.1923, 'Dahi']]);   // no phone at all
order(now, 'Credit', 'Staff Milk', '03001111111', [['1 Litre', 200, 2, 'Milk']]);
order(now, 'Credit', 'Bilal', '03004444444', [['1 Litre', 200, 1, null]]);                                               // its menu item was deleted
for (let i = 0; i < 3; i++) order(now, 'Cash', null, null, [['2 Litre', 400, 1, 'Milk']]);

// ------------------------------------------------------------------ the mock cloud
const cloud = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!/^Bearer /.test(req.headers.authorization || '')) return send(401, { error: 'no key' });
  if (req.url.startsWith('/api/restore/full')) return setTimeout(() => send(200, { branch_id: 1, ...HIST }), DELAY_MS);
  if (/\/version$/.test(req.url)) return send(200, { version: 0 });
  if (/snapshot/.test(req.url)) return send(200, { version: 0, MENU: [], staff: [], ingredients: [], customers: [], expenses: [], settings: {}, deleted: [] });
  return send(req.method === 'POST' ? 200 : 404, { ok: true });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => cloud.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-fresh-install-'));
  // What the installer's first launch writes.
  fs.writeFileSync(path.join(dir, 'cloud-sync.json'), JSON.stringify({
    enabled: true, cloud_url: `http://127.0.0.1:${cloud.address().port}`, branch_id: 1, branch_name: 'Pure Milk', api_key: 'k'.repeat(64) }));

  const child = spawn(process.execPath, [path.join(BE, 'server.js')], {
    cwd: BE, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT), POS_USER_DATA_PATH: dir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });

  const api = async (method, p, body, token) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch (e) { /* starting */ } await wait(500); }

    console.log('\nWhile the cloud is still gathering the history');
    const during = (await api('GET', '/health')).body.setup || {};
    if (DELAY_MS > 0) {
      check('the till reports it is setting up', during.state === 'running' || during.state === 'pending', JSON.stringify(during));
      const early = await api('POST', '/staff/login', { pin: '1234', staff_id: 1 });
      check('sign-in is held meanwhile (503, nothing half-loaded)', early.status === 503 && early.body.code === 'SETUP_IN_PROGRESS', `${early.status}`);
    }

    // Wait for it to finish by itself — nobody presses Restore.
    for (let i = 0; i < 120; i++) { if ((await api('GET', '/health')).body.setup?.state === 'done') break; await wait(1000); }

    console.log('\nAfter the automatic first-run load');
    check('setup finished on its own', (await api('GET', '/health')).body.setup?.state === 'done');
    const db = new Database(path.join(dir, 'pos_database.db'), { readonly: true });
    const one = (sql) => db.prepare(sql).get();
    check('every order arrived', one('SELECT COUNT(*) n FROM orders').n === HIST.orders.length, `${one('SELECT COUNT(*) n FROM orders').n} of ${HIST.orders.length}`);
    const wantToday = HIST.orders.filter((o) => o.created_at.startsWith(TODAY)).length;
    check("today's orders are there", one(`SELECT COUNT(*) n FROM orders WHERE DATE(created_at) = '${TODAY}'`).n === wantToday, `${wantToday} expected`);
    const names = db.prepare('SELECT name FROM customers WHERE active = 1').all().map((c) => c.name).sort();
    check('one customer per person (Staff Milk once)', names.join(',') === 'Bilal,Hina,Staff Milk,Suleman', names.join(','));
    check('no credit order was left without its customer', one("SELECT COUNT(*) n FROM orders WHERE payment_method = 'Credit' AND customer_id IS NULL").n === 0);
    check('the payment pushed twice is kept once', one("SELECT COUNT(*) n FROM credit_payments WHERE note IS NULL AND amount = 100").n === 1);
    db.close();

    const login = await api('POST', '/staff/login', { pin: '4321', staff_id: 1 });
    check("the shop's own account can sign in (real roster, real PIN)", login.status === 200 && !!login.body.token, `${login.status}`);
    const token = login.body.token;

    console.log('\nCredit collected, on the day filters');
    const kpi = async (from, to) => (await api('GET', `/reports/kpi?from=${from}&to=${to}`, null, token)).body.credit_collected;
    check(`yesterday = 100`, near(await kpi(YESTERDAY, YESTERDAY), 100));
    check(`today = 280 (230 + 50)`, near(await kpi(TODAY, TODAY), 280));
    check(`both days = 380`, near(await kpi(YESTERDAY, TODAY), 380));
    check("the 100 of history it cannot itemise is NOT counted as collected", near(await kpi('2000-01-01', TODAY), 380));

    console.log('\nCustomers: balance, litres, Dahi');
    const list = (await api('GET', '/customers', null, token)).body;
    const by = Object.fromEntries(list.map((c) => [c.name, c]));
    check('Suleman balance = 1800 credited - 430 paid = 1370', near(by.Suleman.balance, 1370), String(by.Suleman.balance));
    check('Staff Milk balance = 400 - 50 = 350 (paid not doubled)', near(by['Staff Milk'].balance, 350), String(by['Staff Milk'].balance));
    check('Hina (no phone) balance = 225.996', near(by.Hina.balance, 225.996), String(by.Hina.balance));
    check('Suleman litres = 6 (a 2 Litre pack x3, phone written differently)', near(by.Suleman.total_litres, 6), String(by.Suleman.total_litres));
    check('Hina litres = 0.63 (custom line, no phone)', near(by.Hina.total_litres, 0.63), String(by.Hina.total_litres));
    check('Staff Milk litres = 2', near(by['Staff Milk'].total_litres, 2));
    check('Bilal litres = 1 (his menu item was deleted; counted by its name)', near(by.Bilal.total_litres, 1), String(by.Bilal.total_litres));
    check('Suleman Dahi = 1 kg (2 x 0.5 KG)', near(by.Suleman.total_dahi_kg, 1), String(by.Suleman.total_dahi_kg));
    check('Hina Dahi = 0.1923 kg (custom line)', near(by.Hina.total_dahi_kg, 0.1923), String(by.Hina.total_dahi_kg));
    const ledger = (await api('GET', `/customers/${by.Suleman.id}`, null, token)).body;
    check('the customer screen agrees with the list', near(ledger.total_litres, 6) && near(ledger.total_dahi_kg, 1) && near(ledger.balance, 1370));
  } finally {
    child.kill(); cloud.close();
  }
  if (failures) console.log('\n--- backend log ---\n' + log.split('\n').filter((l) => /Cloud|estore|rror/.test(l)).slice(0, 15).join('\n'));
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
