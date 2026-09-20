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
const identity = require('../db/cloud-identity');
const { personKey } = require('../db/person-key');

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
  const { ensureRecipeForItem } = require('../db/menu-pricing');
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
      // Without a recipe a sale of this item deducts nothing and logs no stock
      // movement, so it would never appear in the stock reports.
      ensureRecipeForItem({ id: itemId, name: item.n, category: item.c });
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

/* ------------------------------------------------------------ identity -- */

/**
 * Where cloud-created rows' numbers start — see cloud/routes/staff.js's own
 * CLOUD_ID_BASE. A number at or above this was handed out by the cloud, so it
 * means the same row on every till.
 *
 * A number *below* it was handed out by some till's own SQLite AUTOINCREMENT,
 * and means a different row on every till: this till's "staff 1" is the
 * default admin, another till's "staff 1" is somebody else entirely. The
 * downlink used to write by raw id regardless, which is how a freshly
 * installed till's own Admin got rewritten into a manager from another till
 * within seconds of the first sign-in — and how a delete on one till could
 * remove an unrelated person from another.
 *
 * So for a till-numbered row, the id alone proves nothing. It is applied only
 * when it demonstrably is this till's own row: the cloud says this till
 * pushed it (device_id), or the name is the same. Anything else belongs to
 * another till and reaches this one through Restore, which renumbers safely.
 */
const CLOUD_ID_BASE = 10000;

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

function myDeviceId() {
  try { return require('../db/activation-config').getDeviceId(); } catch (e) { return null; }
}

/** True when a till-numbered cloud row is this till's own row rather than another till's. */
function isMyRow(cloudRow, localRow, cloudName, localName, myDevice) {
  if (!localRow) return false;
  if (cloudRow.device_id && myDevice && cloudRow.device_id === myDevice) return true;
  return norm(cloudName) !== '' && norm(cloudName) === norm(localName);
}

/**
 * Tombstones carry what the deleted row was called and which till it came
 * from (`deleted_rows`, newer clouds); an older cloud sends bare numbers,
 * which are only trusted where a number is globally unique.
 */
function tombstones(snapshot) {
  if (Array.isArray(snapshot.deleted_rows)) return snapshot.deleted_rows;
  return (snapshot.deleted || []).map((id) => ({ local_id: Number(id) }));
}

/** Runs one row's write; a single bad row is logged and skipped, never allowed to abort the rest. */
function attempt(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[Cloud] Skipped one ${label} row it could not apply: ${err.message}`);
  }
}

/* --------------------------------------------------------------- staff -- */

const isAdminRole = (role) => role === 'Admin' || role === 'Owner';

/**
 * Applies a staff snapshot. Cloud-created accounts are allocated from 10000
 * upward specifically so they never collide with this till's own
 * AUTOINCREMENT sequence (see cloud/routes/staff.js), so writing them with an
 * explicit id is safe. A till-numbered row is applied only if it is this
 * till's own (see the identity note above).
 *
 * A row with no `pin_hash` originated at a till — the downlink updates
 * everything except the credential and leaves the PIN the till already has.
 *
 * Whatever the cloud says, the last active administrator here can never be
 * demoted, deactivated or deleted by this — that is a lock-out.
 */
function applyStaff(snapshot) {
  const myDevice = myDeviceId();
  const findLocal = db.prepare('SELECT id, name, role, active FROM staff WHERE id = ?');
  const findPinOwner = db.prepare('SELECT id FROM staff WHERE pin = ? AND id != ?');
  const otherAdmins = db.prepare(
    `SELECT COUNT(*) AS c FROM staff WHERE active = 1 AND role IN ('Admin', 'Owner') AND id != ?`);
  const upsertWithPin = db.prepare(`
    INSERT INTO staff (id, name, role, color, active, pin)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, role = excluded.role, color = excluded.color,
      active = excluded.active, pin = excluded.pin
  `);
  const updateNoPin = db.prepare(
    'UPDATE staff SET name = ?, role = ?, color = ?, active = ? WHERE id = ?');
  const deleteStaff = db.prepare('DELETE FROM staff WHERE id = ?');

  const apply = db.transaction((staff, deleted) => {
    staff.forEach((s) => {
      attempt('staff', () => {
        const id = Number(s.local_id);
        if (!Number.isInteger(id) || !s.name) return;
        const local = findLocal.get(id);
        if (id < CLOUD_ID_BASE && !isMyRow(s, local, s.name, local && local.name, myDevice)) return;

        let role = s.role || 'Manager';
        let active = s.active ? 1 : 0;
        if (local && isAdminRole(local.role) && local.active && (!isAdminRole(role) || !active)
            && otherAdmins.get(id).c === 0) {
          role = local.role; // keep the only administrator an administrator
          active = 1;
        }

        if (s.pin_hash && !findPinOwner.get(s.pin_hash, id)) {
          upsertWithPin.run(id, s.name, role, s.color || '#DC2626', active, s.pin_hash);
        } else if (local) {
          updateNoPin.run(s.name, role, s.color || '#DC2626', active, id);
        }
        // else: a brand-new row can only come from the cloud, and a cloud-created
        // row always carries a usable hash — so with none, there is nothing safe to do.
      });
    });

    tombstones({ deleted_rows: deleted.deleted_rows, deleted: deleted.deleted }).forEach((d) => {
      attempt('staff delete', () => {
        const id = Number(d.local_id);
        const local = findLocal.get(id);
        if (!local) return;
        const mine = id >= CLOUD_ID_BASE
          || (d.device_id && myDevice && d.device_id === myDevice)
          || (norm(d.name) !== '' && norm(d.name) === norm(local.name));
        if (!mine) return;
        if (isAdminRole(local.role) && local.active && otherAdmins.get(id).c === 0) return; // never the last admin
        deleteStaff.run(id);
        identity.forget('staff', id);
      });
    });
  });

  apply(snapshot.staff || [], { deleted: snapshot.deleted || [], deleted_rows: snapshot.deleted_rows });
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
 * Applies an ingredient snapshot. An ingredient's identity is its NAME — that
 * is what the shop means by it, what `ingredients.name UNIQUE` enforces here,
 * and what the cloud merges pushed rows by (see cloud/routes/ingest.js's
 * ingestIngredients). Its number is per-till and means nothing across tills:
 * the cloud's "Yogurt" is 3 while this till's is 2, and matching by number made
 * every pull die on "UNIQUE constraint failed: ingredients.name" — so
 * ingredient changes from the dashboard never arrived at all.
 *
 * Stock is deliberately never touched here, even for an ingredient this
 * till has never seen before — see cloud/routes/inventory.js's own
 * docstring: physical stock only means something once it's actually been
 * counted at this till. A brand new cloud-created ingredient arrives at 0.
 *
 * A rename made on the dashboard (origin 'cloud') arrives under the same
 * number as the row it renames; that is the one case a number is trusted.
 */
function applyIngredients(snapshot) {
  const findByName = db.prepare('SELECT id FROM ingredients WHERE name = ?');
  const findById = db.prepare('SELECT id, name FROM ingredients WHERE id = ?');
  const insertWithId = db.prepare(
    'INSERT INTO ingredients (id, name, unit, stock, low_stock_threshold, cost_per_unit) VALUES (?, ?, ?, 0, ?, ?)');
  const insertNew = db.prepare(
    'INSERT INTO ingredients (name, unit, stock, low_stock_threshold, cost_per_unit) VALUES (?, ?, 0, ?, ?)');
  const updateExisting = db.prepare(
    'UPDATE ingredients SET unit = ?, low_stock_threshold = ?, cost_per_unit = ? WHERE id = ?');
  const rename = db.prepare('UPDATE ingredients SET name = ? WHERE id = ?');
  const inUseByRecipe = db.prepare('SELECT 1 FROM recipe_ingredients WHERE ingredient_id = ? LIMIT 1');
  const deleteIngredient = db.prepare('DELETE FROM ingredients WHERE id = ?');

  const apply = db.transaction((ingredients, deleted) => {
    ingredients.forEach((i) => {
      attempt('ingredient', () => {
        if (!i.name) return;
        const unit = i.unit || 'unit';
        const threshold = Number(i.low_stock_threshold) || 0;
        const cost = Number(i.cost_per_unit) || 0;
        const sameName = findByName.get(i.name);
        if (sameName) {
          updateExisting.run(unit, threshold, cost, sameName.id);
          return;
        }
        const sameNumber = findById.get(i.local_id);
        if (sameNumber && i.origin === 'cloud') {
          rename.run(i.name, sameNumber.id);
          updateExisting.run(unit, threshold, cost, sameNumber.id);
        } else if (!sameNumber && Number.isInteger(Number(i.local_id))) {
          insertWithId.run(i.local_id, i.name, unit, threshold, cost);
        } else {
          insertNew.run(i.name, unit, threshold, cost);
        }
      });
    });

    tombstones(deleted).forEach((d) => {
      attempt('ingredient delete', () => {
        const local = findById.get(Number(d.local_id));
        if (!local || norm(d.name) === '' || norm(d.name) !== norm(local.name)) return;
        // Deleting an ingredient cascades into its recipes, which would quietly
        // stop every sale of the items built on it from deducting stock.
        if (inUseByRecipe.get(local.id)) return;
        deleteIngredient.run(local.id);
      });
    });
  });

  apply(snapshot.ingredients || [], { deleted: snapshot.deleted || [], deleted_rows: snapshot.deleted_rows });
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
 * wrong to overwrite from a cloud-sent number.
 *
 * A till-numbered row is applied only if it is provably this till's own
 * customer — same phone number or same name (see the identity note above) —
 * so another till's "customer 1" can no longer overwrite this till's.
 */
function applyCustomers(snapshot) {
  const findLocal = db.prepare('SELECT id, name, phone FROM customers WHERE id = ?');
  const insertNew = db.prepare(
    'INSERT INTO customers (id, name, phone, address, notes, active) VALUES (?, ?, ?, ?, ?, ?)');
  const updateExisting = db.prepare(
    'UPDATE customers SET name = ?, phone = ?, address = ?, notes = ?, active = ? WHERE id = ?');
  const hasHistory = db.prepare(
    `SELECT 1 FROM orders WHERE customer_id = ? UNION ALL SELECT 1 FROM credit_payments WHERE customer_id = ? LIMIT 1`);
  const deleteCustomer = db.prepare('DELETE FROM customers WHERE id = ?');
  const allLocal = db.prepare('SELECT id, name, phone FROM customers WHERE active = 1');

  const samePerson = (cloud, local) => local && (
    (norm(cloud.phone) !== '' && norm(cloud.phone) === norm(local.phone))
    || (norm(cloud.name) !== '' && norm(cloud.name) === norm(local.name)));

  const apply = db.transaction((customers, deleted) => {
    customers.forEach((c) => {
      attempt('customer', () => {
        const id = Number(c.local_id);
        if (!Number.isInteger(id) || !c.name) return;
        const active = c.active ? 1 : 0;
        const local = findLocal.get(id);
        if (id >= CLOUD_ID_BASE) {
          if (local) updateExisting.run(c.name, c.phone, c.address, c.notes, active, id);
          else {
            // A dashboard-created customer this till already has under its own
            // number (same phone, or same name with no phone) is the same
            // person — adding them again is what listed customers twice.
            const key = personKey(c.name, c.phone);
            const twin = key && allLocal.all().find((l) => personKey(l.name, l.phone) === key);
            if (!twin) insertNew.run(id, c.name, c.phone, c.address, c.notes, active);
          }
        } else if (samePerson(c, local)) {
          updateExisting.run(c.name, c.phone, c.address, c.notes, active, id);
        }
      });
    });

    tombstones(deleted).forEach((d) => {
      attempt('customer delete', () => {
        const id = Number(d.local_id);
        const local = findLocal.get(id);
        if (!local) return;
        if (!(id >= CLOUD_ID_BASE || (norm(d.name) !== '' && norm(d.name) === norm(local.name)))) return;
        // A customer with orders or payments behind them is history, not clutter:
        // the foreign keys would refuse anyway, and it would abort this pull.
        if (hasHistory.get(id, id)) return;
        deleteCustomer.run(id);
        identity.forget('customers', id);
      });
    });
  });

  apply(snapshot.customers || [], { deleted: snapshot.deleted || [], deleted_rows: snapshot.deleted_rows });
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
 * this till recorded itself. Their numbers come from the cloud's own band, so
 * writing them with an explicit id cannot collide with this till's.
 */
function applyExpenses(snapshot) {
  const findLocal = db.prepare('SELECT id, description FROM expenses WHERE id = ?');
  const insertNew = db.prepare(
    'INSERT INTO expenses (id, category, description, amount, staff_name, from_drawer, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)');
  const deleteExpense = db.prepare('DELETE FROM expenses WHERE id = ?');
  const myDevice = myDeviceId();

  const apply = db.transaction((expenses, deleted) => {
    expenses.forEach((e) => {
      attempt('expense', () => {
        const id = Number(e.local_id);
        if (!Number.isInteger(id) || id < CLOUD_ID_BASE) return;
        // No edit route exists for expenses (see cloud/routes/expenses.js) —
        // a dashboard-created row is only ever inserted once, never updated.
        if (!findLocal.get(id)) {
          insertNew.run(id, e.category || 'Other', e.description, Number(e.amount) || 0, e.staff_name, e.created_at);
        }
      });
    });

    tombstones(deleted).forEach((d) => {
      attempt('expense delete', () => {
        const id = Number(d.local_id);
        const local = findLocal.get(id);
        if (!local) return;
        const mine = id >= CLOUD_ID_BASE
          || (d.device_id && myDevice && d.device_id === myDevice
              && norm(d.description) !== '' && norm(d.description) === norm(local.description));
        if (mine) { deleteExpense.run(id); identity.forget('expenses', id); }
      });
    });
  });

  apply(snapshot.expenses || [], { deleted: snapshot.deleted || [], deleted_rows: snapshot.deleted_rows });
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
  // A brand-new install is still waiting to catch up with its branch (see
  // sync/bootstrap.js). Merging the roster in piecemeal first is exactly what
  // that replaces, so this tick simply waits its turn.
  if (require('./bootstrap').isPending()) return;

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
    // Credit payments taken elsewhere, or that a restore could only stand in for — so
    // "credit collected" has the real days. See sync/payments-catchup.js.
    await require('./payments-catchup').catchUpCreditPayments();
  } catch (err) {
    logPollError('Credit payments', err);
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
