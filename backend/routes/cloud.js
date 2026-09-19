/**
 * Connecting this till to the cloud, from the Settings screen.
 *
 * There is one branch and one fixed key (TILL_API_KEY — see
 * cloud/middleware/branch-auth.js), generated once and never rotated. So
 * this is not a pairing exchange any more, just saving a cloud address and
 * that key into cloud-sync.json by hand — but verified against the cloud
 * before it is written, so a typo in either field is caught here rather than
 * showing up later as every sync silently failing.
 */

const express = require('express');
const router = express.Router();
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { readCloudConfig, CONFIG_PATH } = require('../db/cloud-config');
const { pushInitialBackfill } = require('../db/cloud-sync');
const { requireAdmin } = require('../middleware/auth');
const db = require('../db/database');

function request(method, baseUrl, path, apiKey, body) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(path, baseUrl);
    } catch (e) {
      reject(new Error('That does not look like a valid cloud address.'));
      return;
    }
    const payload = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const lib = url.protocol === 'https:' ? https : http;
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    // A full branch export can be large; the connect check and every other
    // call through here is small, so this only matters for /restore/full.
    const req = lib.request(url, { method, headers, timeout: 60000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch (e) { /* non-JSON error page */ }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(new Error(parsed.error || `The cloud answered with an error (HTTP ${res.statusCode}).`));
        }
      });
    });
    req.on('error', () => reject(new Error('Could not reach that address. Check the URL and your internet connection.')));
    req.on('timeout', () => req.destroy(new Error('The cloud did not respond in time.')));
    if (payload) req.write(payload);
    req.end();
  });
}

const postJson = (baseUrl, path, body, apiKey) => request('POST', baseUrl, path, apiKey, body);
const getJson = (baseUrl, path, apiKey) => request('GET', baseUrl, path, apiKey, null);

/**
 * What the Settings screen shows. Never the API key itself — same reasoning
 * as everywhere else a credential is handled here: showing it back is one
 * more place it could leak from, and the screen only ever needs to say
 * "paired as X" or "not paired."
 */
router.get('/status', (req, res) => {
  const config = readCloudConfig();
  if (!config) return res.json({ paired: false });
  res.json({
    paired: true,
    cloud_url: config.cloudUrl,
    branch_id: config.branchId,
    branch_name: config.branchName,
  });
});

/**
 * POST /api/cloud/pair — save and verify the cloud address and key.
 *
 * Admin-only, the same as before: this is what starts sales syncing to the
 * cloud, and connecting the till to the wrong place (or with a leaked key)
 * is not something a manager should be able to do by themselves.
 */
router.post('/pair', requireAdmin, async (req, res) => {
  const cloudUrl = req.body && String(req.body.cloud_url || '').trim().replace(/\/+$/, '');
  const apiKey = req.body && String(req.body.api_key || '').trim();

  if (!cloudUrl) return res.status(400).json({ error: 'Enter the cloud address.' });
  if (!apiKey) return res.status(400).json({ error: 'Enter the API key.' });
  if (!/^https?:\/\//i.test(cloudUrl)) {
    return res.status(400).json({ error: 'The cloud address must start with http:// or https://' });
  }

  try {
    // Confirms three things before anything is written: the address is
    // reachable, the key is accepted, and which branch the cloud believes
    // this is — the same check the till's own /api/ping agent makes.
    const result = await postJson(cloudUrl, '/api/ping', {}, apiKey);

    const config = {
      enabled: true,
      cloud_url: cloudUrl,
      branch_id: result.branch_id,
      branch_name: result.branch_name,
      api_key: apiKey,
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

    /*
     * A second (or replacement) till pairing to a branch that already has
     * real history used to start its own order/shift/ingredient numbering
     * from zero right beside the first till's — which is exactly how two
     * different cloud rows for "Yogurt" ended up sharing a branch, one per
     * till's own local_id. See cloud/routes/ingest.js's own note on the
     * same problem from the other direction.
     *
     * If this till has never processed a single order, there is nothing of
     * its own to protect, so it pulls the branch's real history down first
     * — the same, already-proven logic as the PIN-gated manual restore
     * below, just without the PIN: that gate exists to stop this from
     * happening to a till with real data on it, and an order count of zero
     * is what proves this isn't one. A till that already has orders never
     * takes this path; it pairs exactly as it always did.
     */
    let autoRestored = null;
    let needsPinReset = [];
    const ordersSoFar = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    if (ordersSoFar === 0) {
      try {
        const cloudData = await getJson(cloudUrl, '/api/restore/full', apiKey);
        const hasRealHistory = ['staff', 'customers', 'ingredients', 'shifts', 'expenses', 'orders']
          .some((key) => Array.isArray(cloudData[key]) && cloudData[key].length > 0);
        if (hasRealHistory) {
          const restoreResult = await applyCloudRestore(cloudData);
          autoRestored = restoreResult.restored;
          needsPinReset = restoreResult.needs_pin_reset;
        }
      } catch (err) {
        // Pairing itself already succeeded and is worth keeping even if this
        // part fails — pushInitialBackfill below still runs either way, and
        // the owner can always run the manual restore afterward.
        console.error('[Cloud] Auto-restore on pairing failed:', err.message);
      }
    }

    // Everything this till now has — its own original data, or what the
    // pull above just gave it — pushed up so the cloud has it too. See
    // db/cloud-sync.js's pushInitialBackfill for why this can't just wait
    // for the next edit to each row.
    pushInitialBackfill();

    res.json({
      success: true,
      branch_name: result.branch_name,
      auto_restored: autoRestored,
      needs_pin_reset: needsPinReset,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Stops syncing without losing anything already recorded locally. */
router.post('/unpair', requireAdmin, (req, res) => {
  try {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/cloud/sync-now — push everything this till has, again.
 *
 * There was no way to ask for this before: every push in db/cloud-sync.js
 * is fire-and-forget with no retry queue, on purpose — an offline or slow
 * cloud must never delay or break a sale. The cost of that design, left
 * unaddressed, is real: a till offline for a stretch (or briefly pointed at
 * a wrong address — this exact thing happened once already) has no way to
 * find out afterward, and nothing here was ever going to catch it back up
 * on its own. pushInitialBackfill is already idempotent (every push is an
 * upsert) and already proven safe to run any time — it just never had a
 * button of its own outside of pairing.
 */
router.post('/sync-now', requireAdmin, (req, res) => {
  const config = readCloudConfig();
  if (!config) return res.status(400).json({ error: 'Connect to the cloud first, from the field above.' });
  pushInitialBackfill();
  res.json({ success: true });
});

/**
 * POST /api/cloud/restore-from-cloud — the opposite of pairing's usual
 * direction.
 *
 * Pairing pushes whatever already exists on THIS machine up (see
 * pushInitialBackfill). That is right when the till is the copy worth
 * keeping and the cloud is empty or wrong. This is for the other case: the
 * machine changed, the cloud is the real history, and this one needs to
 * start from what the cloud has rather than from nothing.
 *
 * Wipes the same tables a local "clear all data" would (see the till's own
 * Settings screen) and refills them from cloud/routes/restore.js's export,
 * keeping every original local id so orders, order_items, shifts and
 * expenses all still point at the right rows afterward. The menu is never
 * touched, on both sides, for the same reason a clear leaves it alone.
 *
 * PIN-gated on top of requireAdmin: this permanently overwrites whatever is
 * on this machine, and a session cookie proves someone is signed in, not
 * that they meant to press the one button here that cannot be undone.
 */
/**
 * Assigns each row a same-table-unique id, preferring its own original
 * `local_id` when nothing has claimed that number yet; a collision gets a
 * fresh one instead, counting up from the highest original id in the batch
 * so it can never step on a not-yet-processed "as-is" row either. Returns a
 * parallel array — `assigned[i]` is the id `rows[i]` was actually inserted
 * under.
 *
 * Exists because `local_id` stopped being enough on its own the moment a
 * branch could have more than one till: each till numbers shifts, orders,
 * customers, staff and expenses from its own SQLite AUTOINCREMENT, so two
 * tills' own "shift 3" are both real and both need a row here, not a
 * UNIQUE-constraint crash. See applyCloudRestore below for how a row's
 * *original* number is still recovered for anything that needs to point
 * back at it (an order's shift, an order_item's order) even after this
 * reassigns it — routes/restore.js sorts every table that can collide by
 * `received_at` first, so whichever till's row the cloud heard about first
 * is the one that keeps its original number.
 */
function assignNonCollidingIds(rows, idKey = 'local_id') {
  const used = new Set();
  let nextFree = rows.reduce((max, r) => Math.max(max, Number(r[idKey]) || 0), 0) + 1;
  return rows.map((r) => {
    const original = Number(r[idKey]);
    const assigned = used.has(original) ? nextFree++ : original;
    used.add(assigned);
    return assigned;
  });
}

/**
 * Applies a full cloud export onto this till's local database — the guts of
 * POST /restore-from-cloud below, pulled out so POST /pair can run the exact
 * same, already-proven logic automatically for a fresh till joining a shop
 * that already has real cloud history (see /pair's own comment on when and
 * why). Throws on failure; callers decide how to report that.
 */
async function applyCloudRestore(data) {
  // better-sqlite3 transactions run synchronously — bcrypt.hash is async,
  // so every placeholder has to be generated before the transaction below
  // even starts, not inside it.
  const placeholderPins = [];
  const placeholderHashes = new Map();
  for (const s of data.staff || []) {
    if (!s.pin_hash) {
      placeholderHashes.set(s.local_id, await bcrypt.hash(crypto.randomUUID(), 10));
      placeholderPins.push(s.name);
    }
  }

  const run = db.transaction(() => {
    const clearTables = ['order_items', 'orders', 'credit_payments', 'customers', 'shifts', 'expenses', 'staff'];
    for (const t of clearTables) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${clearTables.map(() => '?').join(',')})`)
      .run(...clearTables);

    // STAFF. No device_id here (routes/restore.js doesn't select one for
    // staff — the CLOUD_ID_BASE split already keeps a dashboard-created
    // account away from a till-created one; only two *different* tills'
    // own low-numbered accounts could still collide, rarer and unproven so
    // far, unlike shifts/orders below). A colliding id is still renumbered
    // rather than left to crash; staff_id/cashier_id/voided_by_id
    // references resolve through staffIdByOriginal, keyed by the original
    // number alone — the one imprecision this leaves is that if two
    // different staff really did share a number, a reference to it always
    // resolves to whichever of them claimed the number first.
    const staffIds = assignNonCollidingIds(data.staff || []);
    const staffIdByOriginal = new Map();
    const insertStaff = db.prepare(
      'INSERT INTO staff (id, name, role, pin, active, color) VALUES (?, ?, ?, ?, ?, ?)');
    (data.staff || []).forEach((s, i) => {
      const assignedId = staffIds[i];
      if (!staffIdByOriginal.has(s.local_id)) staffIdByOriginal.set(s.local_id, assignedId);
      // pin_hash is only ever present for a staff member the dashboard
      // itself created or edited — see cloud/routes/staff.js. One that
      // came from this same till originally never sent its hash up, so
      // there is nothing real to restore; the placeholder computed above
      // fills the NOT NULL column without granting anyone access, and
      // placeholderPins already has the name for the admin to see.
      const pinHash = s.pin_hash || placeholderHashes.get(s.local_id);
      insertStaff.run(assignedId, s.name, s.role, pinHash, s.active, s.color || '#DC2626');
    });
    const resolveStaffId = (originalId) => (originalId == null ? null : (staffIdByOriginal.get(originalId) ?? originalId));

    // CUSTOMERS. Renumbering here needs no downstream remap at all — an
    // order links to its customer by phone number (phoneToCustomerId
    // below), never by raw local_id, so a collision just gets a fresh id
    // like any other and nothing else has to know.
    const customerIds = assignNonCollidingIds(data.customers || []);
    const phoneToCustomerId = new Map();
    const insertCustomer = db.prepare(
      'INSERT INTO customers (id, name, phone, address, notes, active) VALUES (?, ?, ?, ?, ?, ?)');
    // The till derives a customer's balance live from their orders and
    // credit_payments rather than storing it (see db/customer-summary.js)
    // — but credit_payments itself was never something the cloud received,
    // only the resulting total_paid figure on each customer push (see
    // routes/customers.js). Orders restore in full below, which gets
    // total_credited right on its own; this one synthetic payment per
    // customer is what makes total_paid — and so the balance — come out
    // matching the cloud's last-known figure too, even though the
    // individual payments behind it cannot be recovered.
    const insertRestoredPayment = db.prepare(`
      INSERT INTO credit_payments (customer_id, amount, note, created_at)
      VALUES (?, ?, ?, datetime('now', 'localtime'))`);
    (data.customers || []).forEach((c, i) => {
      const assignedId = customerIds[i];
      insertCustomer.run(assignedId, c.name, c.phone, c.address, c.notes, c.active);
      if (c.phone) phoneToCustomerId.set(String(c.phone).trim(), assignedId);
      if (Number(c.total_paid) > 0) {
        insertRestoredPayment.run(
          assignedId, Number(c.total_paid),
          'Restored from cloud backup — individual payment history before this date is not available.',
        );
      }
    });

    // Upsert, not insert — ingredients is deliberately absent from
    // clearTables above (recipe_ingredients has a hard FK on ingredients.id,
    // and recipes/menu items are never touched by a restore either, so
    // deleting and re-inserting Milk/Yogurt under new rowids would orphan
    // every recipe that already points at their current ones). Milk and
    // Yogurt/Dahi already exist locally the moment the app has ever
    // started (see db/database.js's seed migrations), so this always
    // updates those two onto the cloud's figures rather than colliding
    // with them — which is exactly the bug this replaced: a plain INSERT
    // failed with "UNIQUE constraint failed: ingredients.id" every time,
    // because id 1 and 3 were never actually free to begin with.
    const upsertIngredientById = db.prepare(`
      INSERT INTO ingredients (id, name, unit, stock, low_stock_threshold, cost_per_unit)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, unit = excluded.unit, stock = excluded.stock,
        low_stock_threshold = excluded.low_stock_threshold, cost_per_unit = excluded.cost_per_unit
    `);
    // ingredients.name is UNIQUE locally, but the cloud has no such
    // constraint — a stale duplicate can end up there under a different
    // local_id (this happened once for real: two cloud rows both named
    // "Yogurt", the older one orphaned after being deleted at the till with
    // no delete-sync to remove it on the cloud's side too). Restoring that
    // second row by id alone would try to INSERT a second "Yogurt" and
    // crash the whole restore on the UNIQUE constraint. Checking by name
    // first means a second cloud row sharing a name updates the row that's
    // already here instead — whichever one the cloud lists last simply
    // wins, and every other ingredient restores exactly as before.
    const findIngredientByName = db.prepare('SELECT id FROM ingredients WHERE name = ?');
    const updateIngredientByName = db.prepare(`
      UPDATE ingredients SET unit = ?, stock = ?, low_stock_threshold = ?, cost_per_unit = ? WHERE name = ?
    `);
    for (const i of data.ingredients || []) {
      const existingByName = findIngredientByName.get(i.name);
      if (existingByName && existingByName.id !== i.local_id) {
        updateIngredientByName.run(i.unit, i.stock, i.low_stock_threshold, i.cost_per_unit, i.name);
      } else {
        upsertIngredientById.run(i.local_id, i.name, i.unit, i.stock, i.low_stock_threshold, i.cost_per_unit);
      }
    }

    // SHIFTS. This is the collision that actually crashed a real restore:
    // two different tills both had a "shift 3" once the ingest side (see
    // routes/ingest.js's own note) started correctly keeping two tills'
    // rows separate instead of one clobbering the other — restore then had
    // no way to fit both into this till's single shifts.id space and threw
    // a UNIQUE-constraint 500 instead. device_id is what tells the two
    // apart: keyed alongside the original local_id, it survives even when
    // that number was renumbered, so an order or expense from the very
    // same till can still find the right shift by asking for *its own*
    // device_id's version of that number.
    const shiftIds = assignNonCollidingIds(data.shifts || []);
    const shiftIdByKey = new Map();
    const insertShift = db.prepare(`
      INSERT INTO shifts (id, staff_id, staff_name, opening_cash, closing_cash, expected_cash,
                           variance, opened_at, closed_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    (data.shifts || []).forEach((s, i) => {
      const assignedId = shiftIds[i];
      shiftIdByKey.set(`${s.device_id || ''}|${s.local_id}`, assignedId);
      insertShift.run(assignedId, resolveStaffId(s.staff_id), s.staff_name, s.opening_cash, s.closing_cash,
        s.expected_cash, s.variance, s.opened_at, s.closed_at, s.status);
    });
    const resolveShiftId = (deviceId, originalShiftId) => {
      if (originalShiftId == null) return null;
      const key = `${deviceId || ''}|${originalShiftId}`;
      return shiftIdByKey.has(key) ? shiftIdByKey.get(key) : originalShiftId;
    };

    // ORDERS. Same reasoning and same device-scoped key as shifts.
    const orderIds = assignNonCollidingIds(data.orders || []);
    const orderIdByKey = new Map();
    const insertOrder = db.prepare(`
      INSERT INTO orders (id, total, discount, payment_method, status, cashier_name, cashier_id,
                           created_at, order_type, delivery_charge, shift_id, table_number,
                           tax_rate, tax_amount, is_employee, employee_discount, employee_discount_rate,
                           voided_by, voided_by_id, customer_name, customer_phone, customer_address,
                           customer_id, voided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    (data.orders || []).forEach((o, i) => {
      const assignedId = orderIds[i];
      orderIdByKey.set(`${o.device_id || ''}|${o.local_id}`, assignedId);
      const customerId = o.customer_phone
        ? phoneToCustomerId.get(String(o.customer_phone).trim()) || null
        : null;
      insertOrder.run(
        assignedId, o.total, o.discount, o.payment_method, o.status, o.cashier_name, resolveStaffId(o.cashier_id),
        o.created_at, o.order_type, o.delivery_charge, resolveShiftId(o.device_id, o.local_shift_id), o.table_number,
        o.tax_rate, o.tax_amount, o.is_employee, o.employee_discount, o.employee_discount_rate,
        o.voided_by, resolveStaffId(o.voided_by_id), o.customer_name, o.customer_phone, o.customer_address,
        customerId, o.voided_at,
      );
    });

    // ORDER_ITEMS. Nothing else ever points at one of these by local_id, so
    // a collision just needs a fresh id — but *finding* the right parent
    // order still needs the order's own device_id (routes/restore.js
    // selects it as order_device_id via the join), not the item's, since
    // that is what orderIdByKey was actually keyed on above.
    const itemIds = assignNonCollidingIds(data.order_items || []);
    const insertItem = db.prepare(`
      INSERT INTO order_items (id, order_id, menu_item_id, name, price, quantity, is_deal, variant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    (data.order_items || []).forEach((it, i) => {
      const assignedId = itemIds[i];
      const key = `${it.order_device_id || ''}|${it.order_local_id}`;
      const orderId = orderIdByKey.has(key) ? orderIdByKey.get(key) : it.order_local_id;
      insertItem.run(assignedId, orderId, it.menu_item_id, it.name, it.price,
        it.quantity, it.is_deal, it.variant_id);
    });

    // EXPENSES. Same shift/staff resolution as orders.
    const expenseIds = assignNonCollidingIds(data.expenses || []);
    const insertExpense = db.prepare(`
      INSERT INTO expenses (id, shift_id, staff_id, staff_name, category, description, amount,
                             from_drawer, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    (data.expenses || []).forEach((e, i) => {
      const assignedId = expenseIds[i];
      insertExpense.run(assignedId, resolveShiftId(e.device_id, e.local_shift_id), resolveStaffId(e.staff_id),
        e.staff_name, e.category, e.description, e.amount, e.from_drawer, e.created_at);
    });
  });

  run();

  return {
    restored: {
      staff: (data.staff || []).length,
      customers: (data.customers || []).length,
      orders: (data.orders || []).length,
      shifts: (data.shifts || []).length,
      expenses: (data.expenses || []).length,
      ingredients: (data.ingredients || []).length,
    },
    needs_pin_reset: placeholderPins,
  };
}

router.post('/restore-from-cloud', requireAdmin, async (req, res) => {
  const pin = req.body && req.body.pin;
  if (!pin) return res.status(400).json({ error: 'Enter your PIN to confirm.' });

  const admin = db.prepare('SELECT id, pin FROM staff WHERE id = ?').get(req.user.staffId);
  const pinOk = admin && await bcrypt.compare(String(pin), admin.pin);
  if (!pinOk) return res.status(401).json({ error: 'Incorrect PIN.' });

  const config = readCloudConfig();
  if (!config) return res.status(400).json({ error: 'Connect to the cloud first, from the field above.' });

  let data;
  try {
    data = await getJson(config.cloudUrl, '/api/restore/full', config.apiKey);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const result = await applyCloudRestore(data);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Restore from cloud failed:', err.message);
    res.status(500).json({ error: 'Could not restore from the cloud.' });
  }
});

module.exports = router;
// Exposed for direct testing (see how it's exercised against a real fresh
// database, not the live one) — applyCloudRestore has no route of its own
// to hit in isolation otherwise.
module.exports.applyCloudRestore = applyCloudRestore;
