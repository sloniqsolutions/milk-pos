/**
 * Pulls the things the cloud owns back down to this till: the menu, the
 * staff roster, and the shop-wide settings. See cloud/routes/menu.js,
 * cloud/routes/staff.js and cloud/routes/settings.js for the other half of
 * each of these — this file exists because nothing on the till side ever
 * consumed those endpoints before, so a dashboard edit had nowhere to land.
 *
 * Same shape for all three: a cheap version-number poll, and a full snapshot
 * fetched only when that number has moved. The last version actually applied
 * is remembered in the local `settings` table (`cloud_menu_version`,
 * `cloud_staff_version`, `cloud_settings_version`) so a restart does not
 * re-apply a snapshot it already has.
 *
 * Every poll is independent and swallows its own error — a cloud that is
 * unreachable, unpaired, or slow must never stop the till from selling, and a
 * failure pulling staff must not stop the menu from updating.
 */

const db = require('../db/database');
const { readCloudConfig } = require('../db/cloud-config');
const { getJson } = require('../db/cloud-http');

function getLocalVersion(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? Number(row.value) || 0 : 0;
}

const setSetting = db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

/* ---------------------------------------------------------------- menu -- */

/**
 * Applies a menu snapshot on top of the local menu, matched by name — item
 * ids are per-machine, so name is the only key both sides agree on (see
 * cloud/routes/menu.js's own comment about linking deal lines the same way).
 *
 * Deliberately additive/updating only, never retiring a local item absent
 * from the snapshot: on a till that already had a working menu before ever
 * pairing, the first pull otherwise risks silently retiring everything that
 * has not yet been added on the dashboard. A local item created before
 * pairing simply keeps working until someone also adds it to the cloud (or
 * removes it locally).
 *
 * A new item from the cloud gets no local recipe — recipes are a local-only
 * concept tied to ingredients, and there is no way to invent one. It sells,
 * it just does not deduct stock until someone sets up its recipe at the
 * till's own Inventory screen.
 */
function applyMenu(snapshot) {
  const findItem = db.prepare('SELECT id FROM menu_items WHERE name = ?');
  const insertItem = db.prepare(
    'INSERT INTO menu_items (name, category, price, description, has_variants, active) VALUES (?, ?, ?, ?, ?, 1)'
  );
  const updateItem = db.prepare(
    'UPDATE menu_items SET category = ?, price = ?, description = ?, has_variants = ?, active = 1 WHERE id = ?'
  );
  const deleteVariants = db.prepare('DELETE FROM item_variants WHERE menu_item_id = ?');
  const insertVariant = db.prepare(
    'INSERT INTO item_variants (menu_item_id, label, price, sort_order) VALUES (?, ?, ?, ?)'
  );

  const apply = db.transaction((items) => {
    items.forEach((item) => {
      const hasVariants = Array.isArray(item.v) && item.v.length > 0;
      const price = hasVariants ? 0 : (Number(item.p) || 0);
      const existing = findItem.get(item.n);
      let itemId;
      if (existing) {
        itemId = existing.id;
        updateItem.run(item.c || null, price, item.d || null, hasVariants ? 1 : 0, itemId);
      } else {
        itemId = insertItem.run(item.n, item.c || null, price, item.d || null, hasVariants ? 1 : 0).lastInsertRowid;
      }
      if (hasVariants) {
        deleteVariants.run(itemId);
        item.v.forEach(([label, variantPrice], i) => insertVariant.run(itemId, label, Number(variantPrice) || 0, i));
      }
    });
  });

  apply(snapshot.MENU || []);
}

async function pollMenu(config) {
  const local = getLocalVersion('cloud_menu_version');
  const { version } = await getJson(config.cloudUrl, '/api/menu/version', config.apiKey);
  if (Number(version) === local) return;

  const snapshot = await getJson(config.cloudUrl, '/api/menu/snapshot', config.apiKey);
  applyMenu(snapshot);
  setSetting.run('cloud_menu_version', String(snapshot.version));
  console.log(`[Cloud] Menu updated to version ${snapshot.version}`);
}

/* --------------------------------------------------------------- staff -- */

/**
 * Applies a staff snapshot. `local_id` is the cloud's stand-in for this
 * till's own `staff.id` — cloud-created accounts are allocated from 10000
 * upward specifically so they never collide with this till's own
 * AUTOINCREMENT sequence (see cloud/routes/staff.js), so writing them with an
 * explicit id is safe.
 *
 * A row with no `pin_hash` originated at this till — the downlink updates
 * everything except the credential and leaves the PIN the till already has
 * alone, exactly as the cloud's own comments describe.
 */
function applyStaff(snapshot) {
  const findLocal = db.prepare('SELECT id FROM staff WHERE id = ?');
  const upsertWithPin = db.prepare(`
    INSERT INTO staff (id, name, role, color, active, pin)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, role = excluded.role, color = excluded.color,
      active = excluded.active, pin = excluded.pin
  `);
  const updateNoPin = db.prepare(
    'UPDATE staff SET name = ?, role = ?, color = ?, active = ? WHERE id = ?'
  );
  const deleteStaff = db.prepare('DELETE FROM staff WHERE id = ?');

  const apply = db.transaction((staff, deleted) => {
    staff.forEach((s) => {
      if (s.pin_hash) {
        upsertWithPin.run(s.local_id, s.name, s.role, s.color, s.active ? 1 : 0, s.pin_hash);
      } else if (findLocal.get(s.local_id)) {
        // No hash means this row originated at the till. A brand-new row can
        // only come from the cloud, and a cloud-created row always carries
        // one — so if it is not already here, there is nothing safe to do.
        updateNoPin.run(s.name, s.role, s.color, s.active ? 1 : 0, s.local_id);
      }
    });
    deleted.forEach((id) => deleteStaff.run(id));
  });

  apply(snapshot.staff || [], snapshot.deleted || []);
}

async function pollStaff(config) {
  const local = getLocalVersion('cloud_staff_version');
  const { version } = await getJson(config.cloudUrl, '/api/staff/version', config.apiKey);
  if (Number(version) === local) return;

  const snapshot = await getJson(config.cloudUrl, '/api/staff/snapshot', config.apiKey);
  applyStaff(snapshot);
  setSetting.run('cloud_staff_version', String(snapshot.version));
  console.log(`[Cloud] Staff roster updated to version ${snapshot.version}`);
}

/* ------------------------------------------------------------ inventory -- */

/**
 * Applies an ingredient snapshot. Matched by id directly (not name, unlike
 * the menu) — a cloud-created ingredient's local_id already comes from the
 * 10000+ band (see cloud/routes/inventory.js), so there's no risk of
 * colliding with this till's own low-numbered ids, and matching by id means
 * a rename doesn't orphan the row the way name-matching would.
 *
 * Stock is deliberately never touched here, even for an ingredient this
 * till has never seen before — see cloud/routes/inventory.js's own
 * docstring: physical stock only means something once it's actually been
 * counted at this till. A brand new cloud-created ingredient arrives at 0,
 * same as if someone had just added it locally.
 */
function applyIngredients(snapshot) {
  const findLocal = db.prepare('SELECT id FROM ingredients WHERE id = ?');
  const insertNew = db.prepare(
    'INSERT INTO ingredients (id, name, unit, stock, low_stock_threshold, cost_per_unit) VALUES (?, ?, ?, 0, ?, ?)'
  );
  const updateExisting = db.prepare(
    'UPDATE ingredients SET name = ?, unit = ?, low_stock_threshold = ?, cost_per_unit = ? WHERE id = ?'
  );
  const deleteIngredient = db.prepare('DELETE FROM ingredients WHERE id = ?');

  const apply = db.transaction((ingredients, deleted) => {
    ingredients.forEach((i) => {
      if (findLocal.get(i.local_id)) {
        updateExisting.run(i.name, i.unit, i.low_stock_threshold, i.cost_per_unit, i.local_id);
      } else {
        insertNew.run(i.local_id, i.name, i.unit, i.low_stock_threshold, i.cost_per_unit);
      }
    });
    deleted.forEach((id) => deleteIngredient.run(id));
  });

  apply(snapshot.ingredients || [], snapshot.deleted || []);
}

async function pollInventory(config) {
  const local = getLocalVersion('cloud_ingredient_version');
  const { version } = await getJson(config.cloudUrl, '/api/inventory/version', config.apiKey);
  if (Number(version) === local) return;

  const snapshot = await getJson(config.cloudUrl, '/api/inventory/snapshot', config.apiKey);
  applyIngredients(snapshot);
  setSetting.run('cloud_ingredient_version', String(snapshot.version));
  console.log(`[Cloud] Ingredients updated to version ${snapshot.version}`);
}

/* -------------------------------------------------------------- customers --*/

/**
 * Applies a customer snapshot. Only name/phone/address/notes/active travel
 * down — balance and every other figure are computed at the till from real
 * orders and payments (see db/customer-summary.js) and would be actively
 * wrong to overwrite from a cloud-sent number, even one the cloud itself
 * only ever got from this same till in the first place.
 */
function applyCustomers(snapshot) {
  const findLocal = db.prepare('SELECT id FROM customers WHERE id = ?');
  const insertNew = db.prepare(
    'INSERT INTO customers (id, name, phone, address, notes, active) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const updateExisting = db.prepare(
    'UPDATE customers SET name = ?, phone = ?, address = ?, notes = ?, active = ? WHERE id = ?'
  );
  const deleteCustomer = db.prepare('DELETE FROM customers WHERE id = ?');

  const apply = db.transaction((customers, deleted) => {
    customers.forEach((c) => {
      const active = c.active ? 1 : 0;
      if (findLocal.get(c.local_id)) {
        updateExisting.run(c.name, c.phone, c.address, c.notes, active, c.local_id);
      } else {
        insertNew.run(c.local_id, c.name, c.phone, c.address, c.notes, active);
      }
    });
    // A customer with a credit balance was already refused deletion on the
    // dashboard (see cloud/routes/customers.js), so this never has to choose
    // between honouring a delete and losing an unpaid balance's history.
    deleted.forEach((id) => deleteCustomer.run(id));
  });

  apply(snapshot.customers || [], snapshot.deleted || []);
}

async function pollCustomers(config) {
  const local = getLocalVersion('cloud_customer_version');
  const { version } = await getJson(config.cloudUrl, '/api/customers/version', config.apiKey);
  if (Number(version) === local) return;

  const snapshot = await getJson(config.cloudUrl, '/api/customers/snapshot', config.apiKey);
  applyCustomers(snapshot);
  setSetting.run('cloud_customer_version', String(snapshot.version));
  console.log(`[Cloud] Customers updated to version ${snapshot.version}`);
}

/* --------------------------------------------------------------- expenses --*/

/**
 * Applies an expense snapshot — dashboard-created expenses only (see
 * cloud/routes/expenses.js's snapshot query), so this never touches a row
 * this till recorded itself.
 */
function applyExpenses(snapshot) {
  const findLocal = db.prepare('SELECT id FROM expenses WHERE id = ?');
  const insertNew = db.prepare(
    'INSERT INTO expenses (id, category, description, amount, staff_name, from_drawer, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
  );
  const deleteExpense = db.prepare('DELETE FROM expenses WHERE id = ?');

  const apply = db.transaction((expenses, deleted) => {
    expenses.forEach((e) => {
      // No edit route exists for expenses (see cloud/routes/expenses.js) —
      // a dashboard-created row is only ever inserted once, never updated.
      if (!findLocal.get(e.local_id)) {
        insertNew.run(e.local_id, e.category, e.description, e.amount, e.staff_name, e.created_at);
      }
    });
    deleted.forEach((id) => deleteExpense.run(id));
  });

  apply(snapshot.expenses || [], snapshot.deleted || []);
}

async function pollExpenses(config) {
  const local = getLocalVersion('cloud_expense_version');
  const { version } = await getJson(config.cloudUrl, '/api/expenses/version', config.apiKey);
  if (Number(version) === local) return;

  const snapshot = await getJson(config.cloudUrl, '/api/expenses/snapshot', config.apiKey);
  applyExpenses(snapshot);
  setSetting.run('cloud_expense_version', String(snapshot.version));
  console.log(`[Cloud] Expenses updated to version ${snapshot.version}`);
}

/* ------------------------------------------------------------ settings -- */

/** Only ever the allow-listed, shop-wide keys — see cloud/routes/settings.js's CLOUD_OWNED. */
function applySettings(settings) {
  const apply = db.transaction((entries) => {
    entries.forEach(([key, value]) => setSetting.run(key, String(value)));
  });
  apply(Object.entries(settings || {}));
}

async function pollSettings(config) {
  const local = getLocalVersion('cloud_settings_version');
  // Settings has no separate /version route — the snapshot itself is cheap
  // (six keys), so there is nothing to save by asking first.
  const snapshot = await getJson(config.cloudUrl, '/api/settings/snapshot', config.apiKey);
  if (Number(snapshot.version) === local) return;

  applySettings(snapshot.settings);
  setSetting.run('cloud_settings_version', String(snapshot.version));
  console.log(`[Cloud] Settings updated to version ${snapshot.version}`);
}

/* ------------------------------------------------------------------ run -- */

let polling = false;

/**
 * Every 20s, forever, until the cloud actually has the route this is asking
 * for — which for a newly-added endpoint (inventory/customers/expenses, the
 * first time they're deployed somewhere) can be a while. Logging the exact
 * same failure on every single tick drowned out everything else in this
 * process's console, menu/staff included. Only the *first* occurrence of a
 * given failure message is printed; a change (the cloud comes back, or a
 * different error starts happening) prints again.
 */
const lastLoggedError = new Map();
function logPollError(label, err) {
  if (lastLoggedError.get(label) === err.message) return;
  lastLoggedError.set(label, err.message);
  console.error(`[Cloud] ${label} poll failed:`, err.message);
}

async function pollOnce() {
  if (polling) return;
  const config = readCloudConfig();
  if (!config) return;

  polling = true;
  try {
    await pollMenu(config);
  } catch (err) {
    logPollError('Menu', err);
  }
  try {
    await pollStaff(config);
  } catch (err) {
    logPollError('Staff', err);
  }
  try {
    await pollInventory(config);
  } catch (err) {
    logPollError('Inventory', err);
  }
  try {
    await pollCustomers(config);
  } catch (err) {
    logPollError('Customers', err);
  }
  try {
    await pollExpenses(config);
  } catch (err) {
    logPollError('Expenses', err);
  }
  try {
    await pollSettings(config);
  } catch (err) {
    logPollError('Settings', err);
  }
  polling = false;
}

/** Started once at boot. Fires immediately, then on a fixed interval. */
function startDownlinkPolling(intervalMs = 20000) {
  pollOnce();
  const timer = setInterval(pollOnce, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  startDownlinkPolling, pollOnce,
  applyMenu, applyStaff, applySettings, applyIngredients, applyCustomers, applyExpenses,
};
