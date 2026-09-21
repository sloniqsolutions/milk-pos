/**
 * Removes the stock entries that are provably wrong, and only those. DRY RUN by
 * default: nothing is changed unless --apply is given. Works on the cloud (Postgres)
 * and on a till's own database (SQLite) — a till's next sync would put removed rows
 * back on the cloud, so each till needs the same script.
 *
 *   cd backend
 *   # a till (copy the database file first and try the copy):
 *   node scripts/run-script.js scripts/cleanup-stock-entries.js --till <pos_database.db>
 *   # the cloud (reads DATABASE_URL from the environment or cloud/.env; never printed):
 *   node scripts/run-script.js scripts/cleanup-stock-entries.js --cloud
 *
 *   --apply                 do it (default is a dry run, which only reads)
 *   --backup <file.json>    write every inventory entry to a file and stop
 *   --undo <run id> --apply put back what an earlier run removed, remove what it created
 *   --delete <key,key>      also delete these ASK ME entries (keys are shown in the report)
 *   --recount Milk=N,Yogurt=N   with --apply: one visible "Recount" entry so the last
 *                           Closing equals the counted stock (N = the physical count)
 *   --device <id>           a till's own device id (default: read device-id.json beside the database)
 *   --branch <n>            cloud branch (default 1)
 *   --batch-at "<time>"     the one-batch creation time to point out (default 2026-09-18 23:50:45)
 *   --suspect <from>..<to>  dates that need a person's word (default 2026-09-15..2026-09-16)
 *   --collide <device>:<from>-<to>   numbers known to be filed twice by two tills
 *                           (default: the main till's #1-#7)
 *   --report <file>         also write the full report to a file
 *
 * Every removed row is copied, as JSON, into cleanup_log (kept). Nothing outside
 * inventory_entries is touched — no orders, revenue, payments, customers,
 * expenses or shifts — except the stock counters when --recount says what was counted.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { judge, createdEntryFor, tableAfter, CREATED_BASE } = require('../db/stock-cleanup');
const { createClassifier } = require('../db/line-classifier');
const { unitAmount } = require('../db/item-quantities');
const { classifyLine } = createClassifier(unitAmount);

// ------------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const APPLY = flag('apply');
const MAIN = '6c927c39-72d8-40c1-b873-251871df45b4';
const BATCH_AT = opt('batch-at', '2026-09-18 23:50:45');
const [SUSPECT_FROM, SUSPECT_TO] = opt('suspect', '2026-09-15..2026-09-16').split('..');
const COLLIDE = opt('collide', `${MAIN}:1-7`);
const BRANCH = Number(opt('branch', 1));
const lines_out = [];
const out = (s = '') => { lines_out.push(s); console.log(s); };
const pad = (s, n) => String(s).padEnd(n).slice(0, Math.max(n, String(s).length > n ? n : n));
const short = (d) => (String(d).length > 12 ? String(d).slice(0, 8) : d);
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;

const YOGURT_FACTOR = (unit) => (/^kg/i.test(String(unit || '')) ? 1 : 1000);

function orderLine({ device, order, item, localOrder, localItem, created_at, status, name, quantity, category, is_deal }, yogurtFactor) {
  const c = classifyLine({ name, category, quantity, is_deal });
  const amount = c.group === 'Milk' ? c.amount : c.group === 'Dahi' ? c.amount * yogurtFactor : 0;
  return { device, order, item, localOrder, localItem, day: String(created_at).slice(0, 10), created_at, status, group: c.group, name, quantity: Number(quantity), amount: Math.round(amount * 1e6) / 1e6 };
}

// ---------------------------------------------------------------- till source
function tillSource(dbPath) {
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(dbPath, { readonly: !APPLY, fileMustExist: true });
  const own = opt('device') || (() => {
    try { return JSON.parse(fs.readFileSync(path.join(path.dirname(dbPath), 'device-id.json'), 'utf8')).device_id; } catch (e) { return 'local'; }
  })();
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  const linked = has('inventory_entries', 'order_id');
  const hasIdentity = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cloud_identity'").get();
  const ident = (tbl, id) => (hasIdentity && id != null ? db.prepare('SELECT device_id, orig_id FROM cloud_identity WHERE tbl = ? AND local_id = ?').get(tbl, id) : null);
  const ingredients = Object.fromEntries(db.prepare('SELECT id, name, unit, stock FROM ingredients').all().map((i) => [i.name, i]));
  const yf = YOGURT_FACTOR(ingredients.Yogurt && ingredients.Yogurt.unit);

  return {
    kind: 'till', label: `till database ${path.basename(dbPath)} (own device ${short(own)})`, ingredients, yogurtUnit: ingredients.Yogurt && ingredients.Yogurt.unit,
    load() {
      const entries = db.prepare(`SELECT ie.*, i.name AS ingredient FROM inventory_entries ie JOIN ingredients i ON i.id = ie.ingredient_id ORDER BY ie.id`).all().map((e) => {
        const me = ident('inventory_entries', e.id);
        const o = linked && e.order_id != null ? ident('orders', e.order_id) : null;
        const it = linked && e.order_item_id != null ? ident('order_items', e.order_item_id) : null;
        const device = me ? me.device_id : own;
        return {
          key: `${device}#${me ? me.orig_id : e.id}`, device, id: me ? me.orig_id : e.id, localId: e.id, ingredient: e.ingredient, type: e.type, amount: e.amount,
          entry_date: e.entry_date, created_at: e.created_at, reason: e.reason || null,
          order: linked && e.order_id != null ? (o ? o.orig_id : e.order_id) : null, item: linked && e.order_item_id != null ? (it ? it.orig_id : e.order_item_id) : null,
        };
      });
      const lines = db.prepare(`
        SELECT oi.id AS local_item, oi.order_id AS local_order, oi.name, oi.quantity, oi.is_deal, o.created_at, o.status, m.category
          FROM order_items oi JOIN orders o ON o.id = oi.order_id
          LEFT JOIN menu_items m ON m.id = oi.menu_item_id AND COALESCE(oi.is_deal, 0) = 0`).all().map((r) => {
        const o = ident('orders', r.local_order); const it = ident('order_items', r.local_item);
        return orderLine({ device: o ? o.device_id : own, order: o ? o.orig_id : r.local_order, item: it ? it.orig_id : r.local_item, localOrder: r.local_order, localItem: r.local_item, ...r }, yf);
      });
      return { entries, lines };
    },
    counter: (name) => (ingredients[name] ? Number(db.prepare('SELECT stock FROM ingredients WHERE id = ?').get(ingredients[name].id).stock) : null),
    presence(spec) { // is this record here?
      const findOrig = (tbl, dev, orig) => (hasIdentity ? db.prepare('SELECT local_id FROM cloud_identity WHERE tbl = ? AND device_id = ? AND orig_id = ?').get(tbl, dev, orig) : null);
      if (spec.table === 'inventory_entries') return Boolean(findOrig('inventory_entries', spec.device, spec.id)) || (spec.device === own && db.prepare('SELECT 1 FROM inventory_entries WHERE id = ?').get(spec.id) !== undefined);
      const t = spec.table === 'orders' ? 'orders' : 'order_items';
      return Boolean(findOrig(t, spec.device, spec.id)) || (spec.device === own && db.prepare(`SELECT 1 FROM ${t} WHERE id = ?`).get(spec.id) !== undefined);
    },
    backup: () => db.prepare('SELECT * FROM inventory_entries ORDER BY id').all(),
    apply({ runId, del, created, recount }) {
      db.exec(`CREATE TABLE IF NOT EXISTS cleanup_log (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, run_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        source TEXT, action TEXT NOT NULL, device_id TEXT, local_id INTEGER, row_json TEXT, verdict TEXT, reason TEXT)`);
      if (!hasIdentity) db.exec('CREATE TABLE IF NOT EXISTS cloud_identity (tbl TEXT NOT NULL, local_id INTEGER NOT NULL, device_id TEXT NOT NULL, orig_id INTEGER NOT NULL, PRIMARY KEY (tbl, local_id))');
      if (!has('inventory_entries', 'order_id')) {
        for (const c of ['order_id INTEGER', 'order_item_id INTEGER', 'reason TEXT']) db.exec(`ALTER TABLE inventory_entries ADD COLUMN ${c}`);
      }
      const log = db.prepare('INSERT INTO cleanup_log (run_id, source, action, device_id, local_id, row_json, verdict, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const getRow = db.prepare('SELECT * FROM inventory_entries WHERE id = ?');
      const remember = db.prepare('INSERT OR REPLACE INTO cloud_identity (tbl, local_id, device_id, orig_id) VALUES (?, ?, ?, ?)');
      const ingId = (name) => ingredients[name].id;
      const insert = db.prepare(`INSERT INTO inventory_entries (id, ingredient_id, type, amount, entry_date, created_at, order_id, order_item_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      db.transaction(() => {
        for (const { e, verdict, reason } of del) {
          log.run(runId, 'till', 'DELETED', e.device, e.localId, JSON.stringify(getRow.get(e.localId)), verdict, reason);
          db.prepare('DELETE FROM inventory_entries WHERE id = ?').run(e.localId);
          if (hasIdentity) db.prepare("DELETE FROM cloud_identity WHERE tbl = 'inventory_entries' AND local_id = ?").run(e.localId);
        }
        let next = Math.max(CREATED_BASE, db.prepare('SELECT COALESCE(MAX(id), 0) m FROM inventory_entries').get().m);
        for (const c of created) {
          const id = ++next;
          insert.run(id, ingId(c.ingredient), 'sale', c.amount, c.entry_date, c.created_at, c.localOrder ?? null, c.localItem ?? null, null);
          remember.run('inventory_entries', id, c.device, c.id);
          log.run(runId, 'till', 'CREATED', c.device, id, JSON.stringify({ ...c, localId: id }), 'CREATED', `sale entry for order line #${c.item}`);
        }
        for (const [name, counted] of Object.entries(recount)) {
          const sum = db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM inventory_entries WHERE ingredient_id = ?').get(ingId(name)).s;
          const before = db.prepare('SELECT stock FROM ingredients WHERE id = ?').get(ingId(name)).stock;
          const amount = Math.round((counted - sum) * 1e6) / 1e6;
          const id = ++next;
          if (amount !== 0) {
            insert.run(id, ingId(name), 'stock', amount, new Date().toLocaleDateString('en-CA'), null, null, null, 'Recount');
            remember.run('inventory_entries', id, 'cleanup', ingId(name));
          }
          db.prepare('UPDATE ingredients SET stock = ? WHERE id = ?').run(counted, ingId(name));
          log.run(runId, 'till', 'RECOUNT', 'cleanup', amount !== 0 ? id : null, JSON.stringify({ name, counted, entry_amount: amount, counter_before: before }), 'RECOUNT', 'physical count');
        }
      })();
    },
    undo(runId) {
      const rows = db.prepare("SELECT * FROM cleanup_log WHERE run_id = ? ORDER BY id DESC").all(runId);
      if (!rows.length) throw new Error(`No log rows for run ${runId}.`);
      db.transaction(() => {
        for (const r of rows) {
          const j = JSON.parse(r.row_json);
          if (r.action === 'DELETED') {
            db.prepare(`INSERT OR IGNORE INTO inventory_entries (id, ingredient_id, type, amount, entry_date, created_at, order_id, order_item_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(j.id, j.ingredient_id, j.type, j.amount, j.entry_date, j.created_at, j.order_id ?? null, j.order_item_id ?? null, j.reason ?? null);
          } else if (r.action === 'CREATED' || (r.action === 'RECOUNT' && r.local_id)) {
            db.prepare('DELETE FROM inventory_entries WHERE id = ?').run(r.local_id);
            db.prepare("DELETE FROM cloud_identity WHERE tbl = 'inventory_entries' AND local_id = ?").run(r.local_id);
          }
          if (r.action === 'RECOUNT') db.prepare('UPDATE ingredients SET stock = ? WHERE name = ?').run(j.counter_before, j.name);
        }
        db.prepare('DELETE FROM cleanup_log WHERE run_id = ?').run(runId);
      })();
    },
    close: () => db.close(),
  };
}

// -------------------------------------------------------------- cloud source
async function cloudSource() {
  const cloudDir = path.join(__dirname, '..', '..', 'cloud');
  require(path.join(cloudDir, 'env')).loadEnv(); // fills DATABASE_URL from cloud/.env unless already set; never printed
  const { Client } = require(path.join(cloudDir, 'node_modules', 'pg'));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL);
  let client;
  for (let attempt = 1; ; attempt++) { // a busy or waking database gets a few more tries
    client = new Client({ connectionString: process.env.DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false } });
    try { await client.connect(); break; } catch (e) { if (attempt >= 5) throw e; await new Promise((res) => setTimeout(res, 1500)); }
  }
  await client.query(APPLY ? 'BEGIN' : 'BEGIN READ ONLY'); // a dry run cannot write, whatever this script does
  await client.query('SET extra_float_digits = 3');
  const q = async (sql, p = []) => (await client.query(sql, p)).rows;
  const ingredients = {};
  (await q('SELECT local_id, name, unit, stock FROM ingredients WHERE branch_id = $1', [BRANCH])).forEach((i) => { ingredients[i.name] = { id: Number(i.local_id), name: i.name, unit: i.unit, stock: i.stock }; });
  const byId = Object.fromEntries(Object.values(ingredients).map((i) => [i.id, i.name]));
  const yf = YOGURT_FACTOR(ingredients.Yogurt && ingredients.Yogurt.unit);
  const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'inventory_entries'")).map((c) => c.column_name);
  const linked = cols.includes('order_local_id');

  return {
    kind: 'cloud', label: `the cloud (branch ${BRANCH})`, ingredients,
    async load() {
      const entries = (await q('SELECT * FROM inventory_entries WHERE branch_id = $1 ORDER BY device_id, local_id', [BRANCH])).map((e) => ({
        key: `${e.device_id}#${e.local_id}`, device: e.device_id, id: Number(e.local_id), ingredient: byId[e.ingredient_local_id] || `#${e.ingredient_local_id}`,
        type: e.type, amount: Number(e.amount), entry_date: e.entry_date, created_at: e.created_at, reason: e.reason || null,
        order: linked && e.order_local_id != null ? Number(e.order_local_id) : null, item: linked && e.order_item_local_id != null ? Number(e.order_item_local_id) : null,
      }));
      const lines = (await q(`
        SELECT oi.device_id AS item_device, oi.local_id AS item, o.device_id AS order_device, o.local_id AS ord, o.created_at, o.status,
               oi.name, oi.quantity, oi.category, oi.is_deal
          FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.branch_id = $1`, [BRANCH])).map((r) => orderLine({
        device: r.order_device, order: Number(r.ord), item: Number(r.item), created_at: r.created_at, status: r.status,
        name: r.name, quantity: r.quantity, category: r.category, is_deal: r.is_deal,
      }, yf));
      return { entries, lines };
    },
    counter: (name) => (ingredients[name] ? Number(ingredients[name].stock) : null),
    async presence(spec) {
      const t = { inventory_entries: 'inventory_entries', orders: 'orders', order_items: 'order_items' }[spec.table];
      return (await q(`SELECT 1 FROM ${t} WHERE branch_id = $1 AND device_id = $2 AND local_id = $3`, [BRANCH, spec.device, spec.id])).length > 0;
    },
    async backup() { return q('SELECT * FROM inventory_entries WHERE branch_id = $1 ORDER BY device_id, local_id', [BRANCH]); },
    async apply({ runId, del, created, recount }) {
      await client.query(`CREATE TABLE IF NOT EXISTS cleanup_log (id SERIAL PRIMARY KEY, run_id TEXT NOT NULL, run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        source TEXT, action TEXT NOT NULL, device_id TEXT, local_id INTEGER, row_json TEXT, verdict TEXT, reason TEXT)`);
      for (const c of ['order_local_id INTEGER', 'order_item_local_id INTEGER', 'reason TEXT']) await client.query(`ALTER TABLE inventory_entries ADD COLUMN IF NOT EXISTS ${c}`);
      const log = (action, device, id, row, verdict, reason) => client.query(
        'INSERT INTO cleanup_log (run_id, source, action, device_id, local_id, row_json, verdict, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [runId, 'cloud', action, device, id, JSON.stringify(row), verdict, reason]);
      for (const { e, verdict, reason } of del) {
        const row = (await q('SELECT * FROM inventory_entries WHERE branch_id = $1 AND device_id = $2 AND local_id = $3', [BRANCH, e.device, e.id]))[0];
        await log('DELETED', e.device, e.id, row, verdict, reason);
        await client.query('DELETE FROM inventory_entries WHERE branch_id = $1 AND device_id = $2 AND local_id = $3', [BRANCH, e.device, e.id]);
      }
      const insert = (device, id, ingredient, type, amount, date, createdAt, order, item, reason) => client.query(
        `INSERT INTO inventory_entries (branch_id, device_id, local_id, ingredient_local_id, type, amount, entry_date, created_at, received_at, order_local_id, order_item_local_id, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (branch_id, device_id, local_id) DO NOTHING`,
        [BRANCH, device, id, ingredients[ingredient].id, type, amount, date, createdAt, Date.now(), order, item, reason]);
      for (const c of created) {
        await insert(c.device, c.id, c.ingredient, 'sale', c.amount, c.entry_date, c.created_at, c.order, c.item, null);
        await log('CREATED', c.device, c.id, c, 'CREATED', `sale entry for order line #${c.item}`);
      }
      for (const [name, counted] of Object.entries(recount)) {
        const sum = Number((await q('SELECT COALESCE(SUM(amount), 0)::float8 s FROM inventory_entries WHERE branch_id = $1 AND ingredient_local_id = $2', [BRANCH, ingredients[name].id]))[0].s);
        const amount = Math.round((counted - sum) * 1e6) / 1e6;
        if (amount !== 0) await insert('cleanup', ingredients[name].id, name, 'stock', amount, new Date().toLocaleDateString('en-CA'), null, null, null, 'Recount');
        await log('RECOUNT', 'cleanup', amount !== 0 ? ingredients[name].id : null, { name, counted, entry_amount: amount, counter_before: ingredients[name].stock }, 'RECOUNT', 'physical count');
      }
      // The cloud's stock is what its entries add up to.
      await client.query(`UPDATE ingredients i SET stock = COALESCE((SELECT SUM(e.amount) FROM inventory_entries e WHERE e.branch_id = i.branch_id AND e.ingredient_local_id = i.local_id), 0) WHERE i.branch_id = $1`, [BRANCH]);
    },
    async undo(runId) {
      const rows = await q('SELECT * FROM cleanup_log WHERE run_id = $1 ORDER BY id DESC', [runId]);
      if (!rows.length) throw new Error(`No log rows for run ${runId}.`);
      for (const r of rows) {
        const j = JSON.parse(r.row_json);
        if (r.action === 'DELETED') {
          const cols2 = Object.keys(j).filter((k) => k !== 'id');
          await client.query(`INSERT INTO inventory_entries (${cols2.join(',')}) VALUES (${cols2.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (branch_id, device_id, local_id) DO NOTHING`, cols2.map((k) => j[k]));
        } else if (r.action === 'CREATED' || (r.action === 'RECOUNT' && r.local_id)) {
          await client.query('DELETE FROM inventory_entries WHERE branch_id = $1 AND device_id = $2 AND local_id = $3', [BRANCH, r.device_id, r.local_id]);
        }
      }
      await client.query('DELETE FROM cleanup_log WHERE run_id = $1', [runId]);
      await client.query(`UPDATE ingredients i SET stock = COALESCE((SELECT SUM(e.amount) FROM inventory_entries e WHERE e.branch_id = i.branch_id AND e.ingredient_local_id = i.local_id), 0) WHERE i.branch_id = $1`, [BRANCH]);
    },
    async close() { await client.query(APPLY ? 'COMMIT' : 'ROLLBACK'); await client.end(); },
  };
}

// ----------------------------------------------------------------------- main
async function main() {
  const tillPath = opt('till');
  if (!tillPath && !flag('cloud')) { console.error('Say where: --till <pos_database.db> or --cloud. See the top of this file.'); process.exit(2); }
  const src = tillPath ? tillSource(tillPath) : await cloudSource();

  if (opt('backup')) {
    const rows = await src.backup();
    fs.writeFileSync(opt('backup'), JSON.stringify({ source: src.label, taken_at: new Date().toISOString(), table: 'inventory_entries', rows }, null, 1));
    console.log(`Backup of ${rows.length} inventory entries from ${src.label} written to ${opt('backup')}. Nothing was changed.`);
    await src.close(); return;
  }
  if (opt('undo')) {
    if (!APPLY) { console.log(`Would put back everything run ${opt('undo')} changed on ${src.label}. Add --apply to do it.`); await src.close(); return; }
    await src.undo(opt('undo')); console.log(`Undone: run ${opt('undo')} on ${src.label}.`); await src.close(); return;
  }

  const { entries, lines } = await src.load();
  const [cDev, cRange] = COLLIDE.split(':'); const [cFrom, cTo] = (cRange || '').split('-').map(Number);
  const collisionKeys = new Set(entries.filter((e) => e.device === cDev && e.id >= cFrom && e.id <= cTo).map((e) => e.key));
  const result = judge({ entries, lines, batchAt: BATCH_AT, suspectFrom: SUSPECT_FROM, suspectTo: SUSPECT_TO, collisionKeys });
  const { verdicts, missing } = result;
  const askDelete = new Set((opt('delete', '') || '').split(',').filter(Boolean));
  const willDelete = entries.filter((e) => verdicts.get(e.key).verdict === 'DELETE' || askDelete.has(e.key));
  const created = missing.map((l) => ({ ...createdEntryFor(l), localOrder: l.localOrder, localItem: l.localItem }));

  const isCandidate = (e) => result.isBatch(e) || collisionKeys.has(e.key) || (e.entry_date >= SUSPECT_FROM && e.entry_date <= SUSPECT_TO) || verdicts.get(e.key).verdict !== 'KEEP';
  const cands = entries.filter(isCandidate);
  const tag = (e) => [result.isBatch(e) ? 'batch' : '', collisionKeys.has(e.key) ? 'collision' : '', e.entry_date >= SUSPECT_FROM && e.entry_date <= SUSPECT_TO ? '15-16 Sep' : ''].filter(Boolean).join('+');

  out(`STOCK ENTRY CLEANUP — ${APPLY ? 'APPLY' : 'DRY RUN (nothing is changed)'} — ${src.label}`);
  out(`${entries.length} stock entries, ${lines.length} order lines read. Milk and Yogurt sales are judged against the order lines one by one.`);
  out();
  out(`CANDIDATE ENTRIES (${cands.length}): id | device | ingredient | type | amount | entry date | created at | order line | verdict | why`);
  for (const e of cands) {
    const v = verdicts.get(e.key);
    const l = v.line;
    out(`${pad(e.id, 8)} | ${pad(short(e.device), 8)} | ${pad(e.ingredient, 6)} | ${pad(e.type, 17)} | ${pad(r3(e.amount), 10)} | ${e.entry_date} | ${e.created_at} | ${l ? `order #${l.order} line #${l.item}` : 'none'} | ${askDelete.has(e.key) ? 'DELETE (you chose)' : v.verdict} | ${tag(e) ? `[${tag(e)}] ` : ''}${v.reason}`);
  }
  out();
  out('TOTALS PER VERDICT (candidates only)  count | Milk litres | Yogurt grams');
  for (const verdict of ['KEEP', 'DELETE', 'ASK ME']) {
    const set = cands.filter((e) => (askDelete.has(e.key) ? 'DELETE' : verdicts.get(e.key).verdict) === verdict);
    out(`${pad(verdict, 7)} ${pad(set.length, 5)} | ${pad(r3(set.filter((e) => e.ingredient === 'Milk').reduce((s, e) => s + e.amount, 0)), 10)} | ${r3(set.filter((e) => e.ingredient === 'Yogurt').reduce((s, e) => s + e.amount, 0))}`);
  }
  const rest = entries.length - cands.length;
  out(`(${rest} other entries are real restocks/waste/conversions or sales that match their order line: all KEEP.)`);
  out();

  // order lines left without a correct entry
  const byDay = {};
  for (const l of missing) { const k = `${l.device}|${l.day}|${l.ingredient}`; byDay[k] = byDay[k] || { n: 0, sum: 0 }; byDay[k].n++; byDay[k].sum += l.amount; }
  out(`ORDER LINES WITH NO CORRECT SALE ENTRY AFTER THE DELETIONS: ${missing.length}. One entry will be created for each, linked to the line and dated by the order:`);
  out('device | day | ingredient | lines | amount');
  Object.entries(byDay).sort().forEach(([k, v]) => { const [d, day, ing] = k.split('|'); out(`${pad(short(d), 8)} | ${day} | ${pad(ing, 6)} | ${pad(v.n, 4)} | ${r3(v.sum)}`); });
  out(`Entry numbers for these start at ${CREATED_BASE + 1} + the order line number, so a second copy of this script makes the same rows.`);
  out();

  // missing records
  out('RECORDS THAT NEVER REACHED THE CLOUD (main entry #19, newer till entry #186, order #320, order item #359):');
  const NEWER = '425ef447-1d62-43b5-a1e0-b53a77d68c00';
  for (const spec of [{ table: 'inventory_entries', device: MAIN, id: 19, label: 'main till entry #19' }, { table: 'inventory_entries', device: NEWER, id: 186, label: 'newer till entry #186' },
    { table: 'orders', device: NEWER, id: 320, label: 'newer till order #320' }, { table: 'order_items', device: NEWER, id: 359, label: 'newer till order item #359' }]) {
    const here = await src.presence(spec);
    out(`  ${pad(spec.label, 30)} ${here ? `present in ${src.kind === 'cloud' ? 'the cloud' : 'this till'}` : `NOT in ${src.kind === 'cloud' ? 'the cloud' : 'this database'}`}`);
  }
  out('  Resend plan: these can only be resent from the till that holds them. If the newer till still has them, update it and press "Sync now": every push is safe to repeat.');
  out();

  // the table after
  const after = entries.filter((e) => !willDelete.includes(e)).concat(created.map((c) => ({ ...c })));
  const table = tableAfter(after);
  out('THE STOCK TABLE AFTER THE CLEANUP (Opening = everything before the day; nothing clamped or plugged):');
  for (const name of ['Milk', 'Yogurt']) {
    const rows = table.filter((r) => r.name === name);
    if (!rows.length) { out(`${name}: no entries.`); continue; }
    out(`${name}: first day ${rows[0].date}, Opening ${rows[0].opening_balance}`);
    rows.forEach((r) => out(`   ${r.date}  Opening ${pad(r.opening_balance, 10)} Closing ${r.closing_balance}`));
    const last = rows[rows.length - 1].closing_balance;
    const counter = src.counter(name);
    const diff = r3(counter - last);
    out(`   Last Closing ${last}  vs  stock counter ${counter}  =>  ${Math.abs(diff) < 0.0011 ? 'they agree' : `DIFFERENCE ${diff} — nothing plugs it. Give me the physical count of ${name} and it becomes ONE visible "Recount" entry.`}`);
  }
  out();
  const asks = cands.filter((e) => verdicts.get(e.key).verdict === 'ASK ME' && !askDelete.has(e.key));
  out(`SUMMARY: ${willDelete.length} to delete, ${created.length} to create, ${asks.length} ASK ME (left exactly as they are unless you say otherwise).`);

  if (opt('report')) fs.writeFileSync(opt('report'), lines_out.join('\n') + '\n');

  if (!APPLY) { out('DRY RUN: nothing was changed. Add --apply to do it.'); await src.close(); return; }

  const recount = {};
  (opt('recount', '') || '').split(',').filter(Boolean).forEach((p) => { const [n, v] = p.split('='); recount[n] = Number(v); });
  const runId = `cleanup-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(2).toString('hex')}`;
  await src.apply({
    runId,
    del: willDelete.map((e) => ({ e, verdict: askDelete.has(e.key) ? 'DELETE (chosen)' : 'DELETE', reason: verdicts.get(e.key).reason })),
    created, recount,
  });
  out(`APPLIED as ${runId}: ${willDelete.length} removed (each copied into cleanup_log), ${created.length} created.`);
  out(`To put it all back: --undo ${runId} --apply`);
  await src.close();
}

main().catch((e) => { console.error('Stopped:', e.message); process.exit(1); });
