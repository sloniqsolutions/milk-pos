/**
 * Simulates a BRAND-NEW install of the till, so you can run it and click through everything.
 *
 *   cd backend
 *   npm run simulate:fresh                 (till + mock cloud + the UI)
 *   npm run simulate:fresh -- --no-ui      (till + mock cloud only; start the UI yourself)
 *   npm run simulate:fresh -- --delay=30   (make the cloud take 30s to send the history; default 12)
 *   npm run simulate:fresh -- --keep       (keep the simulated till's data from the last run)
 *
 * What it does, the way the installer's first launch does:
 *   1. wipes `backend/.simulated-till/` — an EMPTY data folder (your real database is never touched);
 *   2. writes the cloud pairing into it, pointing at a MOCK cloud started here (never the real one);
 *   3. starts the real backend on port 3001 (the port the UI talks to) using that folder;
 *   4. starts the UI (vite) at http://localhost:5173 — a browser, not Electron.
 *
 * The mock cloud holds a made-up branch: 10 days of milk / dahi sales, credit customers (some held twice
 * by the cloud, one with no phone, one created on the dashboard), credit payments on different days, a
 * deal, a deleted-menu-item line, a voided order and a staff purchase. It is deliberately SLOW, like a
 * real shop's full history, so you see the "Setting up your till" screen and the automatic load.
 *
 * Nothing is sent to the real cloud: every push the till makes is caught by the mock and counted.
 * Stop your normal backend first (it also uses port 3001). Ctrl+C stops everything.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const BACKEND = path.join(__dirname, '..');
const FRONTEND = path.join(BACKEND, '..', 'frontend');
const DATA_DIR = path.join(BACKEND, '.simulated-till');
const bcrypt = require(path.join(BACKEND, 'node_modules', 'bcryptjs'));

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const a = args.find((x) => x.startsWith(n + '=')); return a ? a.split('=')[1] : d; };
const DELAY_MS = Number(opt('--delay', 12)) * 1000;
const CLOUD_PORT = 4555;
const TILL_PORT = 3001;

// ---------------------------------------------------------------------------------------------- the made-up branch
const pad = (n) => String(n).padStart(2, '0');
const day = (back) => { const d = new Date(Date.now() - back * 864e5); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const at = (back, hh, mm) => `${day(back)} ${pad(hh)}:${pad(mm)}:00`;

// A line: [name, price, quantity, category, litres, kg]. The last two are what the line REALLY is (worked out
// by hand here, not by the app), so the expected figures printed below are independent of the code under test.
const LINE = {
  L05: (q) => ['0.5 Litre', 100, q, 'Milk', 0.5 * q, 0],
  L1: (q) => ['1 Litre', 200, q, 'Milk', 1 * q, 0],
  L2: (q) => ['2 Litre', 400, q, 'Milk', 2 * q, 0],
  MILKC: (l) => ['Milk (' + l.toFixed(4) + ' L)', 200, l, 'Milk', l, 0],
  KG05: (q) => ['0.5 KG', 300, q, 'Dahi', 0, 0.5 * q],
  DAHIC: (g) => ['Dahi (' + g + ' g)', 520, g / 1000, 'Dahi', 0, g / 1000],
  ORPHAN_L1: (q) => ['1 Litre', 200, q, null, q, 0],        // its menu item was deleted: counted by its name
  DEAL: () => ['Family Deal', 900, 1, null, 0, 0],
};

const HIST = {
  staff: [
    { local_id: 1, device_id: 'DEV', name: 'Owner', role: 'Owner', color: '#1B4C82', active: 1, pin_hash: bcrypt.hashSync('4321', 8) },
    { local_id: 2, device_id: 'DEV', name: 'Sara', role: 'Manager', color: '#7C3AED', active: 1, pin_hash: bcrypt.hashSync('1111', 8) },
  ],
  customers: [
    { local_id: 1, device_id: 'DEV', name: 'Staff Milk', phone: '0300-1111111', active: 1, total_paid: 50 },
    { local_id: 1, device_id: 'legacy', name: 'Staff Milk', phone: '03001111111', active: 1, total_paid: 50 },   // same person, older build
    { local_id: 2, device_id: 'DEV', name: 'Suleman', phone: '03002222222', active: 1, total_paid: 430 },
    { local_id: 2, device_id: 'legacy', name: 'Suleman', phone: '0300 2222222', active: 1, total_paid: 430 },
    { local_id: 3, device_id: 'DEV', name: 'Ali', phone: '03003333333', active: 1, total_paid: 200 },
    { local_id: 4, device_id: 'DEV', name: 'Hina', phone: null, active: 1, total_paid: 0 },                    // no phone
    { local_id: 10001, device_id: null, name: 'Bilal', phone: '03004444444', active: 1, total_paid: 0 },       // made on the dashboard
    { local_id: 5, device_id: 'DEV', name: 'Zara', phone: '03005555555', active: 1, total_paid: 0 },
  ],
  ingredients: [], shifts: [], expenses: [], orders: [], order_items: [], inventory_entries: [], credit_payments: [],
};
HIST.shifts.push({ local_id: 1, device_id: 'DEV', staff_id: 1, staff_name: 'Owner', opening_cash: 5000, closing_cash: 9000, expected_cash: 9000, variance: 0, opened_at: at(9, 8, 0), closed_at: at(9, 22, 0), status: 'closed', received_at: 1 });

const truth = { orders: [], byDay: {}, customers: {}, payments: {} };   // what the screens should show
const cust = (name) => (truth.customers[name] = truth.customers[name] || { credited: 0, paid: 0, litres: 0, kg: 0 });
let oid = 0; let iid = 0;
function order({ back, hh = 10, payment = 'Cash', customer = null, phone = null, cashier = 1, status = 'completed', employee = 0, discount = 0, lines }) {
  const id = ++oid;
  const subtotal = lines.reduce((s, l) => s + l[1] * l[2], 0);
  const total = Math.round((subtotal - discount) * 100) / 100;
  const cashierName = cashier === 1 ? 'Owner' : 'Sara';
  HIST.orders.push({ local_id: id, device_id: 'DEV', total, discount, payment_method: payment, status, cashier_name: cashierName, cashier_id: cashier,
    created_at: at(back, hh, (id * 7) % 60), order_type: 'Walk-in', delivery_charge: 0, local_shift_id: 1, tax_rate: 0, tax_amount: 0,
    is_employee: employee, employee_discount: employee ? discount : 0, employee_discount_rate: 0, customer_name: customer, customer_phone: phone,
    voided_at: status === 'voided' ? at(back, hh + 1, 0) : null, voided_by: status === 'voided' ? 'Owner' : null, received_at: id });
  lines.forEach(([name, price, quantity, category]) => HIST.order_items.push({ local_id: ++iid, order_local_id: id, order_device_id: 'DEV',
    menu_item_id: 77, name, price, quantity, is_deal: name === 'Family Deal' ? 1 : 0, variant_id: null, category }));
  if (status === 'voided') return id;
  const d = (truth.byDay[day(back)] = truth.byDay[day(back)] || { orders: 0, net: 0, litres: 0, kg: 0, credit: 0 });
  d.orders++; d.net += total;
  lines.forEach((l) => { d.litres += l[4]; d.kg += l[5]; });
  if (payment === 'Credit') { const c = cust(customer); c.credited += total; lines.forEach((l) => { c.litres += l[4]; c.kg += l[5]; }); }
  return id;
}
function payment(customer, customerLocalId, back, hh, amount, dupe = false) {
  const base = { customer_local_id: customerLocalId, local_shift_id: 1, amount, note: null, received_by: 'Owner', created_at: at(back, hh, 5) };
  HIST.credit_payments.push({ ...base, local_id: HIST.credit_payments.length + 1, device_id: 'DEV', received_at: 100 + HIST.credit_payments.length });
  if (dupe) HIST.credit_payments.push({ ...base, local_id: 1000 + HIST.credit_payments.length, device_id: 'legacy', received_at: 200 + HIST.credit_payments.length });
  cust(customer).paid += amount;
  const d = (truth.byDay[day(back)] = truth.byDay[day(back)] || { orders: 0, net: 0, litres: 0, kg: 0, credit: 0 });
  d.credit += amount;
}

// Nine days of everyday cash sales, some rung up by the manager.
for (let back = 9; back >= 1; back--) {
  order({ back, hh: 9, lines: [LINE.L1(2), LINE.L05(1)] });
  order({ back, hh: 11, cashier: 2, lines: [LINE.L2(1), LINE.KG05(1)] });
  order({ back, hh: 15, lines: [LINE.L1(1), LINE.MILKC(0.63)] });
}
// Credit sales.
order({ back: 6, payment: 'Credit', customer: 'Ali', phone: '03003333333', lines: [LINE.L2(1), LINE.L1(1)] });                                  // 600
order({ back: 5, payment: 'Credit', customer: 'Suleman', phone: '03002222222', lines: [LINE.L2(3), LINE.KG05(2)] });                             // 1800, 6 L, 1 kg
order({ back: 2, payment: 'Credit', customer: 'Staff Milk', phone: '0300-1111111', lines: [LINE.L1(2)] });                                       // 400
order({ back: 1, payment: 'Credit', customer: 'Suleman', phone: '0300 2222222', cashier: 2, lines: [LINE.L1(2), LINE.DAHIC(500)] });             // phone written differently
// Today.
order({ back: 0, hh: 8, lines: [LINE.L2(2), LINE.L1(1)] });
order({ back: 0, hh: 9, cashier: 2, lines: [LINE.L1(3), LINE.KG05(2)] });
order({ back: 0, hh: 10, payment: 'Credit', customer: 'Hina', phone: null, lines: [LINE.MILKC(0.63), LINE.DAHIC(192)] });                        // no phone at all
order({ back: 0, hh: 10, payment: 'Credit', customer: 'Bilal', phone: '03004444444', lines: [LINE.ORPHAN_L1(1)] });                              // menu item deleted
order({ back: 0, hh: 11, employee: 1, discount: 40, lines: [LINE.L1(2)] });                                                                       // a staff purchase
order({ back: 0, hh: 12, lines: [LINE.DEAL(), LINE.L05(2)] });                                                                                     // a deal
order({ back: 0, hh: 13, status: 'voided', lines: [LINE.L2(5)] });                                                                                // voided: counted nowhere
// Credit payments: real ones, on real days (Suleman's cloud total, 430, is 100 more than these — history from before payments were kept one by one).
payment('Ali', 3, 3, 12, 200);
payment('Suleman', 2, 1, 11, 100, true);           // pushed twice (an older build): must count once
payment('Suleman', 2, 0, 9, 230);
payment('Staff Milk', 1, 0, 10, 50);
truth.payments = { yesterday: 100, today: 280 };
// The cloud's running total paid can exceed the payments it can itemise (Suleman: 430 against 330). The till keeps
// the difference as one marked stand-in so the balance is right, and Reports leave it out of "credit collected".
HIST.customers.forEach((c) => { const t = cust(c.name); t.paid = Math.max(t.paid, c.total_paid || 0); });

// Stock: a restock, then every day's sales come off, plus one waste and one manual removal (which shows up as "Other").
let milkStock = 0; let yogStock = 0; let eid = 0;
const entry = (ing, type, amount, back) => HIST.inventory_entries.push({ local_id: ++eid, device_id: 'DEV', ingredient_local_id: ing, type, amount, entry_date: day(back), created_at: at(back, 8, 0), received_at: 500 + eid });
entry(1, 'stock', 300, 10); milkStock += 300; entry(2, 'stock', 20000, 10); yogStock += 20000;
for (let back = 9; back >= 0; back--) {
  const d = truth.byDay[day(back)] || { litres: 0, kg: 0 };
  if (d.litres) { entry(1, 'sale', -d.litres, back); milkStock -= d.litres; }
  if (d.kg) { entry(2, 'sale', -d.kg * 1000, back); yogStock -= d.kg * 1000; }
}
entry(1, 'waste', -2.5, 4); milkStock -= 2.5;
entry(1, 'stock', -4, 3); milkStock -= 4;
HIST.ingredients.push({ local_id: 1, name: 'Milk', unit: 'L', stock: Math.round(milkStock * 10000) / 10000, low_stock_threshold: 10, cost_per_unit: 0 });
HIST.ingredients.push({ local_id: 2, name: 'Yogurt', unit: 'g', stock: Math.round(yogStock * 10000) / 10000, low_stock_threshold: 0, cost_per_unit: 0 });

// ---------------------------------------------------------------------------------------------- the mock cloud
const pushes = {};
const cloud = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const url = req.url.split('?')[0];
    if (url === '/api/activation/activate') return send(200, { activated: true, label: 'Simulated install' });
    if (!/^Bearer /.test(req.headers.authorization || '')) return send(401, { error: 'no key' });
    if (url === '/api/restore/full') {
      console.log(`[mock cloud] till asked for the branch history — sending it in ${DELAY_MS / 1000}s (like a real, large shop)`);
      return setTimeout(() => { console.log('[mock cloud] history sent'); send(200, { branch_id: 1, ...HIST }); }, DELAY_MS);
    }
    if (/\/version$/.test(url)) return send(200, { version: 0 });
    if (/snapshot/.test(url)) return send(200, { version: 0, MENU: [], staff: [], ingredients: [], customers: [], expenses: [], settings: {}, deleted: [] });
    if (req.method === 'POST') {
      let table = url;
      try { table = url === '/api/ingest/batch' ? 'ingest:' + JSON.parse(raw).table : url; } catch (e) { /* not json */ }
      pushes[table] = (pushes[table] || 0) + 1;
      return send(200, { ok: true, accepted: 0 });
    }
    return send(404, { error: 'nope' });
  });
});

// ---------------------------------------------------------------------------------------------- what to expect
const money = (n) => Math.round(n * 100) / 100;
function printExpectations() {
  const live = Object.values(truth.byDay);
  const today = truth.byDay[day(0)]; const yest = truth.byDay[day(1)];
  console.log('\n================  WHAT YOU SHOULD SEE  ================');
  console.log('Sign in:  Owner PIN 4321 (administrator)   |   Sara PIN 1111 (manager)');
  console.log('Activation screen (if shown): type any key, e.g. TEST-1234');
  console.log(`\nOrders, "Today" filter: ${today.orders} orders (the voided one is not counted).  Yesterday: ${yest.orders}.  All 10 days: ${live.reduce((n, d) => n + d.orders, 0)}.`);
  console.log(`Reports -> Credit collected:  today ${money(today.credit)}   yesterday ${money(yest.credit)}   last 7 days ${money([0, 1, 2, 3, 4, 5, 6].reduce((n, b) => n + ((truth.byDay[day(b)] || {}).credit || 0), 0))}   (Suleman's 100 was pushed twice: counted once)`);
  console.log(`Reports -> today's net sales: ${money(today.net)}   milk sold today: ${money(today.litres)} L   dahi: ${money(today.kg)} kg`);
  console.log('\nCustomers (14 cloud rows -> 6 people; nobody appears twice):');
  for (const [name, c] of Object.entries(truth.customers)) {
    console.log(`  ${name.padEnd(11)} balance ${String(money(c.credited - c.paid)).padStart(8)}   Litres ${String(money(c.litres)).padStart(5)} L   Dahi ${String(money(c.kg * 1000) / 1000).padStart(6)} kg`);
  }
  console.log('  (Suleman paid 430 in all: 330 itemised on real days + 100 of older history that is not itemised and is not "collected" on any day.)');
  console.log('\nSummary tab: Milk Opening/Closing chain from 300 L on day 10; Other shows -4 L on day 4 (a manual removal); waste -2.5 L.');
  console.log('=======================================================\n');
}

// ---------------------------------------------------------------------------------------------- run
const children = [];
function stopAll() { children.forEach((c) => { try { c.kill(); } catch (e) { /* gone */ } }); try { cloud.close(); } catch (e) { /* closed */ } }
process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('SIGTERM', () => { stopAll(); process.exit(0); });

(async () => {
  if (!flag('--keep')) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  await new Promise((r, j) => { cloud.once('error', j); cloud.listen(CLOUD_PORT, '127.0.0.1', r); });

  // What the installer's first launch writes (frontend/electron/main.js ensureCloudSyncConfig), aimed at the MOCK.
  const cfg = path.join(DATA_DIR, 'cloud-sync.json');
  if (!fs.existsSync(cfg)) {
    fs.writeFileSync(cfg, JSON.stringify({ enabled: true, cloud_url: `http://127.0.0.1:${CLOUD_PORT}`, branch_id: 1, branch_name: 'Pure Milk (simulated)', api_key: 'sim'.repeat(20) }, null, 2));
  }

  console.log(`Simulated till data folder: ${DATA_DIR}`);
  console.log(`Mock cloud: http://127.0.0.1:${CLOUD_PORT}   (history takes ${DELAY_MS / 1000}s to arrive)`);
  const till = spawn(process.execPath, [path.join(BACKEND, 'server.js')], {
    cwd: BACKEND, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(TILL_PORT), POS_USER_DATA_PATH: DATA_DIR, MILKPOS_ACTIVATION_URL: `http://127.0.0.1:${CLOUD_PORT}` },
  });
  children.push(till);
  const tell = (d) => String(d).split('\n').filter((l) => /\[Cloud\]|Restore|restore|rror|POS Backend running/.test(l)).forEach((l) => console.log('[till] ' + l.trim()));
  till.stdout.on('data', tell); till.stderr.on('data', tell);
  till.on('exit', (code) => { console.log(`[till] exited (${code})`); stopAll(); process.exit(code || 0); });

  printExpectations();

  if (!flag('--no-ui')) {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const ui = spawn(npx, ['vite', '--port', '5173', '--strictPort'], { cwd: FRONTEND, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    children.push(ui);
    ui.stdout.on('data', (d) => { if (/Local:|ready/.test(String(d))) console.log('[ui] ' + String(d).trim().split('\n').filter((l) => /Local:|ready/.test(l)).join(' ')); });
    ui.stderr.on('data', (d) => console.log('[ui] ' + String(d).trim()));
    console.log('>>> Open http://localhost:5173 in your browser. You will see "Setting up your till" while the history loads.');
  } else {
    console.log('>>> Till is on http://localhost:3001. Start the UI yourself:  cd frontend && npx vite   then open http://localhost:5173');
  }
  console.log('>>> Ctrl+C stops everything. Pushes the till makes are caught by the mock and listed when you stop.\n');

  const report = () => { if (Object.keys(pushes).length) console.log('[mock cloud] pushes received so far:', JSON.stringify(pushes)); };
  setInterval(report, 60000).unref();
  process.on('exit', report);
})().catch((e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${CLOUD_PORT} is busy — is a previous simulation still running?` : e); process.exit(1); });
