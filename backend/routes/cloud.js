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

    // Everything that already existed before this till was ever connected —
    // see db/cloud-sync.js's pushInitialBackfill for why this can't just
    // wait for the next edit to each row.
    pushInitialBackfill();

    res.json({ success: true, branch_name: result.branch_name });
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
    // A phone number is the only thread back to a credit customer's row: the
    // cloud never received the till's numeric customer_id, only the name,
    // phone and address printed on the order (see routes/restore.js's own
    // note on this). Matching on phone recovers the link for the common
    // case; an order with no phone on file, or a phone nobody's customer
    // record shares, keeps its customer_name/phone/address text and simply
    // has no linked ledger row, same as any other order it doesn't have.
    const phoneToCustomerId = new Map();
    (data.customers || []).forEach((c) => {
      if (c.phone) phoneToCustomerId.set(String(c.phone).trim(), c.local_id);
    });

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

      const insertStaff = db.prepare(
        'INSERT INTO staff (id, name, role, pin, active, color) VALUES (?, ?, ?, ?, ?, ?)');
      for (const s of data.staff || []) {
        // pin_hash is only ever present for a staff member the dashboard
        // itself created or edited — see cloud/routes/staff.js. One that
        // came from this same till originally never sent its hash up, so
        // there is nothing real to restore; the placeholder computed above
        // fills the NOT NULL column without granting anyone access, and
        // placeholderPins already has the name for the admin to see.
        const pinHash = s.pin_hash || placeholderHashes.get(s.local_id);
        insertStaff.run(s.local_id, s.name, s.role, pinHash, s.active, s.color || '#DC2626');
      }

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
      for (const c of data.customers || []) {
        insertCustomer.run(c.local_id, c.name, c.phone, c.address, c.notes, c.active);
        if (Number(c.total_paid) > 0) {
          insertRestoredPayment.run(
            c.local_id, Number(c.total_paid),
            'Restored from cloud backup — individual payment history before this date is not available.',
          );
        }
      }

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

      const insertShift = db.prepare(`
        INSERT INTO shifts (id, staff_id, staff_name, opening_cash, closing_cash, expected_cash,
                             variance, opened_at, closed_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const s of data.shifts || []) {
        insertShift.run(s.local_id, s.staff_id, s.staff_name, s.opening_cash, s.closing_cash,
          s.expected_cash, s.variance, s.opened_at, s.closed_at, s.status);
      }

      const insertOrder = db.prepare(`
        INSERT INTO orders (id, total, discount, payment_method, status, cashier_name, cashier_id,
                             created_at, order_type, delivery_charge, shift_id, table_number,
                             tax_rate, tax_amount, is_employee, employee_discount, employee_discount_rate,
                             voided_by, voided_by_id, customer_name, customer_phone, customer_address,
                             customer_id, voided_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const o of data.orders || []) {
        const customerId = o.customer_phone
          ? phoneToCustomerId.get(String(o.customer_phone).trim()) || null
          : null;
        insertOrder.run(
          o.local_id, o.total, o.discount, o.payment_method, o.status, o.cashier_name, o.cashier_id,
          o.created_at, o.order_type, o.delivery_charge, o.local_shift_id, o.table_number,
          o.tax_rate, o.tax_amount, o.is_employee, o.employee_discount, o.employee_discount_rate,
          o.voided_by, o.voided_by_id, o.customer_name, o.customer_phone, o.customer_address,
          customerId, o.voided_at,
        );
      }

      const insertItem = db.prepare(`
        INSERT INTO order_items (id, order_id, menu_item_id, name, price, quantity, is_deal, variant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const it of data.order_items || []) {
        insertItem.run(it.local_id, it.order_local_id, it.menu_item_id, it.name, it.price,
          it.quantity, it.is_deal, it.variant_id);
      }

      const insertExpense = db.prepare(`
        INSERT INTO expenses (id, shift_id, staff_id, staff_name, category, description, amount,
                               from_drawer, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const e of data.expenses || []) {
        insertExpense.run(e.local_id, e.local_shift_id, e.staff_id, e.staff_name, e.category,
          e.description, e.amount, e.from_drawer, e.created_at);
      }
    });

    run();

    res.json({
      success: true,
      restored: {
        staff: (data.staff || []).length,
        customers: (data.customers || []).length,
        orders: (data.orders || []).length,
        shifts: (data.shifts || []).length,
        expenses: (data.expenses || []).length,
        ingredients: (data.ingredients || []).length,
      },
      needs_pin_reset: placeholderPins,
    });
  } catch (err) {
    console.error('Restore from cloud failed:', err.message);
    res.status(500).json({ error: 'Could not restore from the cloud.' });
  }
});

module.exports = router;
