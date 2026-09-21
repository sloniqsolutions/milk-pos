/**
 * The stock cleanup script (backend/scripts/cleanup-stock-entries.js), tried on
 * throwaway data — a temp till database and a local throwaway Postgres.
 *
 *   cd backend
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres PGPOOL_MAX=1 \
 *     node scripts/run-script.js ../cloud/test/cleanup-script.js
 *
 * For the till and for the cloud it checks that:
 *   - the default (dry run) changes nothing
 *   - only the provably wrong entries go, each copied into cleanup_log
 *   - each order line with no correct entry gets one, linked to it and dated by the order
 *   - after a physical count the table adds up, each Opening is the previous Closing,
 *     Sold per day is the day's order lines, and the last Closing is the stock
 *   - --undo puts everything back exactly
 * Refuses to run unless DATABASE_URL is on this computer.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (!/@(127\.0\.0\.1|localhost)[:/]/.test(process.env.DATABASE_URL || '')) {
  console.error('Refusing to run: DATABASE_URL must point at a local throwaway Postgres.');
  process.exit(1);
}
process.env.TILL_API_KEY = 'made-up-key-for-tests';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-cleanup-'));
process.env.POS_USER_DATA_PATH = dataDir;

const BACKEND = path.join(__dirname, '..', '..', 'backend');
const SCRIPT = path.join(BACKEND, 'scripts', 'cleanup-stock-entries.js');
const till = require(path.join(BACKEND, 'db', 'database'));

let failures = 0;
const check = (label, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`); if (!cond) failures++; };
const near = (a, b) => Math.abs(a - b) < 0.0011;
const DEV = 'main-device';

// ---- one story, told to both databases
// order: id, device, day, status, lines: [id, menu, name, qty]
const ORDERS = [
  { id: 1, device: DEV, day: '2026-09-17', status: 'completed', lines: [[1, 'L1', '1 Litre', 3, 'Milk'], [2, 'DAHI', 'Dahi (750 g)', 0.75, 'Dahi']] },
  { id: 2, device: DEV, day: '2026-09-17', status: 'completed', lines: [[3, 'L2', '2 Litre', 1, 'Milk']] },
  { id: 3, device: DEV, day: '2026-09-18', status: 'completed', lines: [[4, 'L1', 'Milk (0.1818 L)', 0.1818, 'Milk']] },
  { id: 4, device: DEV, day: '2026-09-18', status: 'voided', lines: [[5, 'L1', '1 Litre', 5, 'Milk']] },
  { id: 5, device: 'legacy-device', day: '2026-09-19', status: 'completed', lines: [[6, 'L1', '1 Litre', 2, 'Milk']] },   // its till logged nothing
];
// entry: id, ingredient, type, amount, date, created_at
const BATCH = '2026-09-18 23:50:45';
const ENTRIES = [
  [1, 'Milk', 'stock', 100, '2026-09-16', '2026-09-17 08:00:00'],     // 15-16 Sep: ASK ME
  [2, 'Milk', 'sale', -3, '2026-09-17', BATCH],                        // right
  [3, 'Milk', 'sale', -1.5, '2026-09-17', BATCH],                      // 2 x the Dahi quantity: wrong
  [4, 'Yogurt', 'sale', -750, '2026-09-17', BATCH],                    // right
  [5, 'Yogurt', 'sale', -3000, '2026-09-17', BATCH],                   // Milk litres x 1000: wrong
  [6, 'Milk', 'sale', -2, '2026-09-17', BATCH],                        // right
  [7, 'Milk', 'sale', -2, '2026-09-17', BATCH],                        // a second one for the same line
  [8, 'Milk', 'sale', -0.0909, '2026-09-18', BATCH],                   // half of the line: wrong
  [9, 'Milk', 'stock', 50, '2026-09-18', '2026-09-18 09:00:00'],       // real restock
  [10, 'Milk', 'waste', -1, '2026-09-18', '2026-09-18 22:00:00'],      // real waste
];
const WRONG = [3, 5, 7, 8];
const CREATED_LINES = [4, 6]; // lines that end up with no correct entry: the half-logged one, and the legacy till's
const RECOUNT = { Milk: 140, Yogurt: 1000 };

const run = (args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: BACKEND, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  return { status: r.status, text: (r.stdout || '') + (r.stderr || '') };
};

function tillSetup() {
  const menu = Object.fromEntries([['L1', ['1 Litre', 'Milk']], ['L2', ['2 Litre', 'Milk']], ['DAHI', ['Dahi', 'Dahi']]]
    .map(([k, [n, c]]) => [k, till.prepare('SELECT id FROM menu_items WHERE name = ? AND category = ?').get(n, c).id]));
  ORDERS.forEach((o) => {
    till.prepare("INSERT INTO orders (id, total, discount, payment_method, status, cashier_name, created_at) VALUES (?, 100, 0, 'Cash', ?, 'x', ?)").run(o.id, o.status, `${o.day} 10:00:00`);
    o.lines.forEach(([id, m, name, qty]) => till.prepare('INSERT INTO order_items (id, order_id, menu_item_id, name, price, quantity, is_deal) VALUES (?, ?, ?, ?, 100, ?, 0)').run(id, o.id, menu[m], name, qty));
  });
  const ing = (n) => till.prepare('SELECT id FROM ingredients WHERE name = ?').get(n).id;
  ENTRIES.forEach(([id, n, type, amt, date, at]) => till.prepare('INSERT INTO inventory_entries (id, ingredient_id, type, amount, entry_date, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, ing(n), type, amt, date, at));
  for (const n of ['Milk', 'Yogurt']) till.prepare('UPDATE ingredients SET stock = (SELECT COALESCE(SUM(amount),0) FROM inventory_entries WHERE ingredient_id = ?) WHERE id = ?').run(ing(n), ing(n));
}

function cloudSetup() { // in its own process, which exits so the next one can connect
  const story = path.join(dataDir, 'story.json');
  fs.writeFileSync(story, JSON.stringify({ ORDERS, ENTRIES, DEV }));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'cleanup-script-seed.js'), story], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('cloud seed failed: ' + r.stderr + r.stdout);
}

/** The stock table as the till's own report route would draw it, checked against the order lines. */
function tillTableProblems() {
  const problems = [];
  const days = till.prepare("SELECT DISTINCT entry_date d FROM inventory_entries ORDER BY 1").all().map((r) => r.d);
  for (const name of ['Milk', 'Yogurt']) {
    const id = till.prepare('SELECT id FROM ingredients WHERE name = ?').get(name).id;
    let closing = 0;
    for (const d of days) {
      const day = till.prepare('SELECT COALESCE(SUM(amount),0) s, COALESCE(-SUM(CASE WHEN type = \'sale\' THEN amount END),0) sold FROM inventory_entries WHERE ingredient_id = ? AND entry_date = ?').get(id, d);
      closing += day.s;
      const lines = till.prepare(`SELECT COALESCE(SUM(CASE WHEN oi.name LIKE 'Dahi%' THEN oi.quantity * 1000 ELSE oi.quantity * CASE WHEN oi.name LIKE '2 Litre' THEN 2 ELSE 1 END END), 0) used
        FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.status != 'voided' AND DATE(o.created_at) = ? AND ${name === 'Milk' ? "oi.name NOT LIKE 'Dahi%'" : "oi.name LIKE 'Dahi%'"}`).get(d).used;
      if (!near(day.sold, lines)) problems.push(`${name} ${d}: Sold ${day.sold} but the day's order lines used ${lines}`);
    }
    const counter = till.prepare('SELECT stock FROM ingredients WHERE id = ?').get(id).stock;
    if (!near(closing, counter)) problems.push(`${name}: last Closing ${closing} but the stock is ${counter}`);
  }
  return problems;
}

(async () => {
  tillSetup();
  const dump = () => JSON.stringify(till.prepare('SELECT * FROM inventory_entries ORDER BY id').all()) + JSON.stringify(till.prepare('SELECT name, stock FROM ingredients ORDER BY name').all());
  const dbFile = path.join(dataDir, 'pos_database.db');
  const beforeTill = dump();
  const common = ['--till', dbFile, '--device', DEV];

  console.log('\nThe till: dry run');
  let r = run(common);
  check('the dry run runs', r.status === 0 && /DRY RUN/.test(r.text), r.text.split('\n').slice(-3).join(' | '));
  check('and changes nothing', dump() === beforeTill);
  const verdictOf = (id) => (r.text.split('\n').find((l) => new RegExp(`^${id}\\s+\\|`).test(l)) || '').split('|')[8].trim();
  check('each wrong entry is marked DELETE', WRONG.every((id) => verdictOf(id) === 'DELETE'), WRONG.map(verdictOf).join(','));
  check('the right sale entries are KEEP', [2, 4, 6].every((id) => /KEEP/.test(r.text.split('\n').find((l) => new RegExp(`^${id}\\s+\\|`).test(l)) || '')));
  check('the 15-16 Sep restock is ASK ME and is not deleted', /^1\s+\|.*ASK ME/m.test(r.text));
  check('it names the lines that will get an entry', /ORDER LINES WITH NO CORRECT SALE ENTRY AFTER THE DELETIONS: 2/.test(r.text));

  console.log('\nThe till: apply with a physical count');
  r = run([...common, '--apply', '--recount', `Milk=${RECOUNT.Milk},Yogurt=${RECOUNT.Yogurt}`]);
  const runId = (r.text.match(/APPLIED as (\S+):/) || [])[1];
  check('it applies', r.status === 0 && !!runId, r.text.split('\n').slice(-3).join(' | '));
  const left = till.prepare('SELECT id FROM inventory_entries ORDER BY id').all().map((x) => x.id);
  check('only the provably wrong entries are gone', WRONG.every((id) => !left.includes(id)) && [1, 2, 4, 6, 9, 10].every((id) => left.includes(id)));
  const logged = till.prepare("SELECT COUNT(*) n FROM cleanup_log WHERE action = 'DELETED' AND json_valid(row_json)").get().n;
  check('every removed row is kept in cleanup_log as JSON', logged === WRONG.length, `${logged}`);
  const made = till.prepare("SELECT e.*, o.created_at AS ocreated FROM inventory_entries e JOIN orders o ON o.id = e.order_id WHERE e.id > 9000000 AND e.type = 'sale'").all();
  check('each order line with no correct entry got one, linked and dated by its order',
    made.length === CREATED_LINES.length && made.every((e) => e.order_item_id != null && e.entry_date === e.ocreated.slice(0, 10) && e.created_at === e.ocreated), `${made.length}`);
  const recount = till.prepare("SELECT COUNT(*) n FROM inventory_entries WHERE reason = 'Recount'").get().n;
  check('the counts became one visible Recount entry per ingredient', recount === 2, `${recount}`);
  const problems = tillTableProblems();
  check('after the cleanup: Sold per day equals the order lines, and the last Closing is the stock', problems.length === 0, problems.join(' ; '));

  console.log('\nThe till: undo');
  r = run([...common, '--undo', runId, '--apply']);
  check('undo runs', r.status === 0 && /Undone/.test(r.text), r.text.trim().split('\n').pop());
  check('everything is exactly as it was', dump() === beforeTill);

  // ------------------------------------------------------------------- cloud
  console.log('\nThe cloud: dry run');
  cloudSetup();
  const cloudBackup = (label) => { const f = path.join(dataDir, `cloud-${label}.json`); const b = run(['--cloud', '--backup', f]); if (b.status !== 0) throw new Error(b.text); return JSON.parse(fs.readFileSync(f, 'utf8')).rows; };
  const beforeCloud = JSON.stringify(cloudBackup('before'));
  r = run(['--cloud']);
  check('the dry run runs', r.status === 0 && /DRY RUN/.test(r.text), r.text.split('\n').slice(-3).join(' | '));
  check('and cannot change anything', JSON.stringify(cloudBackup('after-dry')) === beforeCloud);
  check('each wrong entry is marked DELETE', WRONG.every((id) => /DELETE/.test(r.text.split('\n').find((l) => new RegExp(`^${id}\\s+\\|`).test(l)) || '')));
  check("the legacy till's order line is listed as needing an entry", /legacy-d\s*\|\s*2026-09-19 \| Milk/.test(r.text));

  console.log('\nThe cloud: apply with a physical count');
  r = run(['--cloud', '--apply', '--recount', `Milk=${RECOUNT.Milk},Yogurt=${RECOUNT.Yogurt}`]);
  const cloudRun = (r.text.match(/APPLIED as (\S+):/) || [])[1];
  check('it applies', r.status === 0 && !!cloudRun, r.text.split('\n').slice(-3).join(' | '));
  const after = cloudBackup('after');
  const keys = after.map((e) => `${e.device_id}#${e.local_id}`);
  check('only the provably wrong entries are gone', WRONG.every((id) => !keys.includes(`${DEV}#${id}`)) && [1, 2, 4, 6, 9, 10].every((id) => keys.includes(`${DEV}#${id}`)));
  const createdCloud = after.filter((e) => Number(e.local_id) > 9000000);
  check('the created entries are linked to their order line and dated by the order',
    createdCloud.length === 2 && createdCloud.every((e) => e.order_item_local_id != null && e.type === 'sale'));
  check("the legacy till's line got its entry under the legacy device", createdCloud.some((e) => e.device_id === 'legacy-device' && near(e.amount, -2) && e.entry_date === '2026-09-19'));
  const sumOf = (ing) => after.filter((e) => Number(e.ingredient_local_id) === ing).reduce((s, e) => s + Number(e.amount), 0);
  check('the last Closing equals the counted stock', near(sumOf(1), RECOUNT.Milk) && near(sumOf(2), RECOUNT.Yogurt), `${sumOf(1)} / ${sumOf(2)}`);

  console.log('\nThe cloud: undo');
  r = run(['--cloud', '--undo', cloudRun, '--apply']);
  check('undo runs', r.status === 0 && /Undone/.test(r.text), r.text.trim().split('\n').pop());
  const norm = (rows) => JSON.stringify(rows.map((e) => [e.device_id, e.local_id, e.ingredient_local_id, e.type, e.amount, e.entry_date, e.created_at]).sort());
  check('everything is exactly as it was', norm(cloudBackup('undone')) === norm(JSON.parse(beforeCloud)));

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
