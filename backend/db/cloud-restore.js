/**
 * Applying a full cloud export onto this till's database.
 *
 * Used by three callers — the PIN-gated manual "Restore from cloud" button and
 * the empty-till auto-restore on pairing (both in routes/cloud.js), and the
 * first-run bootstrap (sync/bootstrap.js) that lets a freshly installed till
 * pick up the branch's history without anyone pressing anything. Every one of
 * them needs the same guarantees, so they live here once:
 *
 *   - All or nothing. The whole restore is one transaction; if anything in it
 *     throws, this device is left exactly as it was.
 *   - Never a lock-out. Whatever the cloud sends, at least one active
 *     administrator this device can actually sign in as exists afterwards.
 *   - Never a crash on someone else's data. The cloud is fed by more than one
 *     till, and a row from any of them can be missing a field, point at a row
 *     that was deleted, or reuse a number another till already used. Rows are
 *     cleaned up on the way in and counted when they cannot be kept, instead
 *     of taking the whole restore down with a constraint error.
 *
 * `local_id` is each till's own AUTOINCREMENT, so two tills' "shift 3" are both
 * real and both need a row here. See assignNonCollidingIds.
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./database');
const { findUniversal } = require('./menu-pricing');
const identity = require('./cloud-identity');
const { personKey, norm } = require('./person-key');

const ADMIN_ROLES = ['Admin', 'Owner'];

/** A tidy local timestamp — what the till itself writes for `created_at`. */
function nowLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A finite number, or the fallback. Never NaN, never a string of digits. */
const num = (v, fallback = 0) => {
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? fallback : n;
};
const bit = (v, fallback = 1) => (v == null ? fallback : (Number(v) ? 1 : 0));
const text = (v) => (v == null ? null : String(v));

/**
 * Assigns each row a same-table-unique id, preferring its own original
 * `local_id` when nothing has claimed that number yet; a collision gets a
 * fresh one instead, counting up from the highest original id in the batch
 * so it can never step on a not-yet-processed "as-is" row either. Returns a
 * parallel array — `assigned[i]` is the id `rows[i]` was actually inserted
 * under.
 *
 * `local_id` stopped being enough on its own the moment a branch could have
 * more than one till: each till numbers shifts, orders, customers, staff and
 * expenses from its own SQLite AUTOINCREMENT. routes/restore.js on the cloud
 * sorts every table that can collide by `received_at` first, so whichever
 * till's row the cloud heard about first keeps its original number.
 */
function assignNonCollidingIds(rows, idKey = 'local_id') {
  const used = new Set();
  // Only a whole, positive, safely-representable number can be a row id; a
  // fractional, negative, textual or astronomically large one is renumbered
  // (and must not drag the counter it is renumbered from off the integers).
  const usable = (n) => Number.isSafeInteger(n) && n >= 1;
  let nextFree = rows.reduce((max, r) => {
    const n = Number(r[idKey]);
    return usable(n) ? Math.max(max, n) : max;
  }, 0) + 1;
  return rows.map((r) => {
    const original = Number(r[idKey]);
    const assigned = (!usable(original) || used.has(original)) ? nextFree++ : original;
    used.add(assigned);
    return assigned;
  });
}

/** Thrown when a caller asked for "only if this till is still empty" and it no longer is. */
class NotFreshError extends Error {
  constructor() {
    super('This device already has data of its own.');
    this.code = 'NOT_FRESH';
  }
}

/**
 * True while nothing has ever been recorded on this device: no sale, expense,
 * customer or stock movement, and at most the single default admin. That — and
 * only that — is the state in which replacing everything with the branch's
 * history can't cost anyone anything.
 *
 * A shift with no sale in it does not count. Signing in on a new install can
 * open one, and it used to make the till "not fresh" for good — so a restore
 * that had merely been slow (or waiting for the internet) was abandoned for
 * ever, and the shop had to press Restore by hand.
 */
function isFreshTill() {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return count('orders') === 0
    && count('expenses') === 0
    && count('customers') === 0
    && count('credit_payments') === 0
    && count('inventory_entries') === 0
    && count('staff') <= 1;
}

/**
 * @param {object} data The body of GET /api/restore/full.
 * @param {{ onlyIfFresh?: boolean }} [options]
 *   onlyIfFresh — re-checks emptiness inside the same transaction that writes,
 *   so an automatic caller can never overwrite something a person entered in
 *   the moment between deciding to restore and doing it.
 */
async function applyCloudRestore(data, options = {}) {
  data = data || {};
  const list = (key) => (Array.isArray(data[key]) ? data[key] : []);
  const staffRows = list('staff');
  const customerRows = list('customers');
  const ingredientRows = list('ingredients');
  const shiftRows = list('shifts');
  const expenseRows = list('expenses');
  const orderRows = list('orders');
  const itemRows = list('order_items');
  const entryRows = Array.isArray(data.inventory_entries) ? data.inventory_entries : null;
  const paymentRows = list('credit_payments');

  // better-sqlite3 transactions run synchronously — bcrypt.hash is async,
  // so every hash has to be generated before the transaction below starts.
  // A placeholder fills the NOT NULL pin column for an account whose PIN was
  // only ever set at a till (its hash never travels up) without granting
  // anyone access. Also prepared for a second account carrying an identical
  // hash, since pin is UNIQUE.
  const placeholderHashes = new Map(); // row index -> hash
  const seenHashes = new Set();
  for (let i = 0; i < staffRows.length; i++) {
    const hash = staffRows[i] && staffRows[i].pin_hash;
    if (!hash || seenHashes.has(hash)) {
      placeholderHashes.set(i, await bcrypt.hash(crypto.randomUUID(), 10));
    } else {
      seenHashes.add(hash);
    }
  }
  const fallbackAdminHash = await bcrypt.hash('1234', 10);

  const result = {
    skipped: { staff: 0, orders: 0, order_items: 0, expenses: 0, inventory_entries: 0, credit_payments: 0 },
    needs_pin_reset: [],
    kept_local_admin: null,
  };

  const run = db.transaction(() => {
    if (options.onlyIfFresh && !isFreshTill()) throw new NotFreshError();

    // Whoever could sign in here before — kept aside so a restore that brings
    // no usable administrator with it cannot lock the owner out of their own till.
    const previousAdmins = db.prepare(
      `SELECT name, role, pin, color FROM staff WHERE active = 1 AND role IN ('Admin', 'Owner')`).all();

    // Cleared children-first so no foreign key is ever violated. Ingredients
    // are deliberately absent: recipe_ingredients hangs off ingredients.id,
    // and recipes and menu items are never touched by a restore either.
    const clearTables = ['order_items', 'orders', 'credit_payments', 'customers', 'shifts', 'expenses', 'staff'];
    if (entryRows) clearTables.push('inventory_entries'); // only when the cloud actually sent them
    for (const t of clearTables) db.prepare(`DELETE FROM ${t}`).run();
    identity.clear();
    db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${clearTables.map(() => '?').join(',')})`)
      .run(...clearTables);

    // STAFF. A colliding id is renumbered rather than left to crash;
    // references resolve through staffIdByOriginal, keyed by the original
    // number alone — if two different staff really did share a number, a
    // reference to it resolves to whichever of them claimed it first.
    const staffIds = assignNonCollidingIds(staffRows);
    const staffIdByOriginal = new Map();
    const insertStaff = db.prepare(
      'INSERT INTO staff (id, name, role, pin, active, color) VALUES (?, ?, ?, ?, ?, ?)');
    const realAdminIds = [];
    staffRows.forEach((s, i) => {
      const assignedId = staffIds[i];
      if (!staffIdByOriginal.has(s.local_id)) staffIdByOriginal.set(s.local_id, assignedId);
      const placeholder = placeholderHashes.get(i);
      const name = text(s.name) || `Staff ${assignedId}`;
      identity.remember('staff', assignedId, s.device_id, s.local_id);
      const role = text(s.role) || 'Manager';
      const active = bit(s.active, 1);
      insertStaff.run(assignedId, name, role, placeholder || s.pin_hash, active, text(s.color) || '#DC2626');
      if (placeholder) result.needs_pin_reset.push(name);
      else if (active && ADMIN_ROLES.includes(role)) realAdminIds.push(assignedId);
    });
    const staffIdByName = new Map(); // a payment on the cloud carries only the receiver's NAME
    staffRows.forEach((s, i) => { const n = norm(s.name); if (n && !staffIdByName.has(n)) staffIdByName.set(n, staffIds[i]); });
    const resolveStaffId = (originalId) => (originalId == null ? null : (staffIdByOriginal.get(originalId) ?? null));

    // No administrator with a PIN anyone knows? Put back the ones this device
    // already had, so the owner is never locked out of their own till.
    if (realAdminIds.length === 0) {
      let nextStaffId = staffIds.reduce((m, id) => Math.max(m, id), 0) + 1;
      const usedPins = new Set(db.prepare('SELECT pin FROM staff').all().map((r) => r.pin));
      const carried = previousAdmins.filter((a) => a.pin && !usedPins.has(a.pin));
      if (carried.length > 0) {
        carried.forEach((a) => {
          insertStaff.run(nextStaffId++, a.name, a.role, a.pin, 1, a.color || '#DC2626');
          usedPins.add(a.pin);
        });
        result.kept_local_admin = carried.map((a) => a.name).join(', ');
      } else {
        insertStaff.run(nextStaffId++, 'Admin', 'Owner', fallbackAdminHash, 1, '#DC2626');
        result.kept_local_admin = 'Admin (PIN 1234 — change it in Settings)';
      }
    }

    // CUSTOMERS. An order links to its customer by phone digits or, with no phone,
    // by name (customerIdByPerson below), never by raw local_id, so a renumbered
    // customer needs no downstream remap at all.
    //
    // One customer per PERSON, not per cloud row: the cloud holds the same
    // person once for every till (or older build) that pushed them, and copying
    // each across is what listed "Suleman" twice. The first row of each group
    // is kept; the rest only lend their phone spellings (so orders still find
    // them) and their figures (see totalPaid below).
    const customerGroups = new Map(); // personKey -> rows
    const keptCustomerRows = [];
    customerRows.forEach((c) => {
      const key = personKey(c.name, c.phone) || `row:${c.device_id || ''}|${c.local_id}`;
      if (!customerGroups.has(key)) { customerGroups.set(key, []); keptCustomerRows.push(c); }
      customerGroups.get(key).push(c);
    });
    result.merged_customers = customerRows.length - keptCustomerRows.length;
    const customerIds = assignNonCollidingIds(keptCustomerRows);
    // How the rest of the restore finds the customer a row belongs to:
    //   customerIdByPerson  an order's customer, by phone or (no phone) name
    //   customerIdByKey     a payment's customer, by the till and number that pushed it
    //   customerIdByCloudNo a dashboard-numbered customer (10000+), the same on every till
    const customerIdByPerson = new Map();
    const customerIdByKey = new Map();
    const customerIdByCloudNo = new Map();
    const paidByCustomer = []; // { id, totalPaid } — reconciled once the payments are in
    const insertCustomer = db.prepare(
      'INSERT INTO customers (id, name, phone, address, notes, active) VALUES (?, ?, ?, ?, ?, ?)');
    // The till derives a customer's balance live from orders and credit_payments
    // rather than storing it (see db/customer-summary.js). The cloud now sends
    // each payment (below); a stand-in for whatever the cloud's running total
    // paid still exceeds them keeps the balance matching its last-known figure
    // — that is all a cloud from before per-payment history can offer.
    const insertRestoredPayment = db.prepare(`
      INSERT INTO credit_payments (customer_id, amount, note, created_at)
      VALUES (?, ?, ?, datetime('now', 'localtime'))`);
    keptCustomerRows.forEach((c, i) => {
      const assignedId = customerIds[i];
      const group = customerGroups.get(personKey(c.name, c.phone) || `row:${c.device_id || ''}|${c.local_id}`);
      identity.remember('customers', assignedId, c.device_id, c.local_id);
      insertCustomer.run(assignedId, text(c.name) || `Customer ${assignedId}`, text(c.phone), text(c.address),
        text(c.notes), group.some((g) => bit(g.active, 1)) ? 1 : 0);
      const key = personKey(c.name, c.phone);
      if (key) customerIdByPerson.set(key, assignedId);
      group.forEach((g) => {
        // Every spelling the group's rows use, so an order rung up with any of them still finds this customer.
        const gk = personKey(g.name, g.phone);
        if (gk && !customerIdByPerson.has(gk)) customerIdByPerson.set(gk, assignedId);
        customerIdByKey.set(`${g.device_id || ''}|${g.local_id}`, assignedId);
        if (Number(g.local_id) >= 10000) customerIdByCloudNo.set(Number(g.local_id), assignedId);
      });
      // The largest figure in the group, not the sum: a second row for the same
      // person is a re-push of the same ledger, and adding them would count what
      // they have paid twice.
      paidByCustomer.push({ id: assignedId, totalPaid: group.reduce((m, g) => Math.max(m, num(g.total_paid)), 0) });
    });

    // INGREDIENTS — upsert, never insert. Stock is NOT copied from the cloud's
    // number: it is recomputed from the restored entries below, so it can only
    // ever be the sum of what was logged. Milk and Yogurt already exist the
    // moment the app has started once, so a plain INSERT collided every time.
    // ingredients.name is UNIQUE locally but the cloud has no such
    // constraint (a stale duplicate under another local_id did once exist),
    // so a same-named row updates the existing one instead of inserting.
    const upsertIngredientById = db.prepare(`
      INSERT INTO ingredients (id, name, unit, stock, low_stock_threshold, cost_per_unit)
      VALUES (?, ?, ?, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, unit = excluded.unit,
        low_stock_threshold = excluded.low_stock_threshold, cost_per_unit = excluded.cost_per_unit
    `);
    const findIngredientByName = db.prepare('SELECT id FROM ingredients WHERE name = ?');
    const findIngredientById = db.prepare('SELECT id, name FROM ingredients WHERE id = ?');
    const updateIngredientByName = db.prepare(`
      UPDATE ingredients SET unit = ?, low_stock_threshold = ?, cost_per_unit = ? WHERE name = ?`);
    // Where each cloud ingredient actually ended up locally — inventory_entries
    // (below) has to follow it there.
    const ingredientIdByOriginal = new Map();
    for (const i of ingredientRows) {
      const name = text(i.name);
      if (!name) continue;
      const unit = text(i.unit) || 'unit';
      const threshold = num(i.low_stock_threshold);
      const cost = num(i.cost_per_unit);
      const byName = findIngredientByName.get(name);
      if (byName) {
        updateIngredientByName.run(unit, threshold, cost, name);
        ingredientIdByOriginal.set(i.local_id, byName.id);
      } else {
        // The number is free, or belongs to a *differently named* ingredient
        // here — in which case this one takes a fresh number rather than
        // renaming somebody else's.
        const idTaken = findIngredientById.get(i.local_id);
        if (idTaken || !Number.isInteger(Number(i.local_id))) {
          const newId = db.prepare(
            'INSERT INTO ingredients (name, unit, stock, low_stock_threshold, cost_per_unit) VALUES (?, ?, 0, ?, ?)')
            .run(name, unit, threshold, cost).lastInsertRowid;
          ingredientIdByOriginal.set(i.local_id, Number(newId));
        } else {
          upsertIngredientById.run(i.local_id, name, unit, threshold, cost);
          ingredientIdByOriginal.set(i.local_id, i.local_id);
        }
      }
    }

    // SHIFTS. device_id, keyed alongside the original local_id, tells two
    // tills' same-numbered shifts apart — and survives the renumbering, so an
    // order or expense from the very same till still finds the right shift.
    const shiftIds = assignNonCollidingIds(shiftRows);
    const shiftIdByKey = new Map();
    const insertShift = db.prepare(`
      INSERT INTO shifts (id, staff_id, staff_name, opening_cash, closing_cash, expected_cash,
                           variance, opened_at, closed_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const nullableNum = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    shiftRows.forEach((s, i) => {
      const assignedId = shiftIds[i];
      shiftIdByKey.set(`${s.device_id || ''}|${s.local_id}`, assignedId);
      identity.remember('shifts', assignedId, s.device_id, s.local_id);
      insertShift.run(assignedId, resolveStaffId(s.staff_id), text(s.staff_name), num(s.opening_cash),
        nullableNum(s.closing_cash), nullableNum(s.expected_cash), nullableNum(s.variance),
        text(s.opened_at) || nowLocal(), text(s.closed_at), text(s.status) || 'closed');
    });
    const resolveShiftId = (deviceId, originalShiftId) => {
      if (originalShiftId == null) return null;
      const key = `${deviceId || ''}|${originalShiftId}`;
      return shiftIdByKey.has(key) ? shiftIdByKey.get(key) : null;
    };

    // ORDERS. Same reasoning and same device-scoped key as shifts.
    const orderIds = assignNonCollidingIds(orderRows);
    const orderIdByKey = new Map();
    const insertOrder = db.prepare(`
      INSERT INTO orders (id, total, discount, payment_method, status, cashier_name, cashier_id,
                           created_at, order_type, delivery_charge, shift_id, table_number,
                           tax_rate, tax_amount, is_employee, employee_discount, employee_discount_rate,
                           voided_by, voided_by_id, customer_name, customer_phone, customer_address,
                           customer_id, voided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    orderRows.forEach((o, i) => {
      const assignedId = orderIds[i];
      orderIdByKey.set(`${o.device_id || ''}|${o.local_id}`, assignedId);
      identity.remember('orders', assignedId, o.device_id, o.local_id);
      // Only a credit sale belongs to a customer's ledger. Matched by phone digits
      // or, for a customer with no phone, by name: matching the raw phone text
      // alone left "0300-1234567" and "03001234567" as two different people, and
      // every order of a phone-less customer unlinked — so their litres, balance
      // and history came back short.
      const customerId = String(o.payment_method) === 'Credit'
        ? customerIdByPerson.get(personKey(o.customer_name, o.customer_phone)) || null
        : null;
      insertOrder.run(
        assignedId, num(o.total), num(o.discount), text(o.payment_method) || 'Cash', text(o.status) || 'completed',
        text(o.cashier_name) || 'Unknown', resolveStaffId(o.cashier_id),
        text(o.created_at) || nowLocal(), text(o.order_type), num(o.delivery_charge),
        resolveShiftId(o.device_id, o.local_shift_id), text(o.table_number),
        num(o.tax_rate), num(o.tax_amount), bit(o.is_employee, 0), num(o.employee_discount),
        num(o.employee_discount_rate),
        text(o.voided_by), resolveStaffId(o.voided_by_id), text(o.customer_name), text(o.customer_phone),
        text(o.customer_address), customerId, text(o.voided_at),
      );
    });

    // ORDER_ITEMS. Nothing else points at one of these by local_id, so a
    // collision just needs a fresh id — but *finding* the parent order needs
    // the order's own device_id (routes/restore.js selects it as
    // order_device_id via the join), which is what orderIdByKey is keyed on.
    // An item whose order is not in this export has no home; it is dropped
    // and counted rather than violating the foreign key.
    const itemIds = assignNonCollidingIds(itemRows);
    const insertItem = db.prepare(`
      INSERT INTO order_items (id, order_id, menu_item_id, name, price, quantity, is_deal, variant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    // A line's menu_item_id is the *selling till's* menu number, which is not
    // this device's: its 1 Litre may be 2 here, and it may have no such id at
    // all. Everything that joins order lines back to the menu — litres per
    // credit customer, sales by category, what a void gives back to stock —
    // goes through that number, so it is re-pointed by what the line actually
    // is: the same name and category, else (for a custom "Milk (0.63 L)" or
    // "Dahi (192 g)" line, which is rung up against the universal item) that
    // category's universal item. A line that matches nothing keeps its number.
    const menuByNameAndCategory = db.prepare(
      'SELECT id FROM menu_items WHERE name = ? AND category = ? ORDER BY active DESC, id LIMIT 1');
    const universalByCategory = new Map();
    const resolveMenuItemId = (it) => {
      const original = Math.trunc(num(it.menu_item_id));
      if (bit(it.is_deal, 0)) return original;
      // No category means the selling till could not find this item on its own menu (it was
      // deleted). Its number means nothing here — it can be a different item's — so it is
      // pointed at nothing (0) rather than at a stranger whose category it would then borrow.
      if (!it.category) return 0;
      const exact = menuByNameAndCategory.get(text(it.name), text(it.category));
      if (exact) return exact.id;
      if (!universalByCategory.has(it.category)) {
        const universal = ['Milk', 'Dahi'].includes(it.category) ? findUniversal(it.category) : null;
        universalByCategory.set(it.category, universal ? universal.id : null);
      }
      return universalByCategory.get(it.category) ?? original;
    };

    const itemIdByKey = new Map();
    itemRows.forEach((it, i) => {
      const orderId = orderIdByKey.get(`${it.order_device_id || ''}|${it.order_local_id}`);
      if (orderId == null) { result.skipped.order_items++; return; }
      identity.remember('order_items', itemIds[i], it.order_device_id, it.local_id);
      itemIdByKey.set(`${it.order_device_id || ''}|${it.local_id}`, itemIds[i]);
      insertItem.run(itemIds[i], orderId, resolveMenuItemId(it), text(it.name) || 'Item',
        num(it.price), num(it.quantity, 1), bit(it.is_deal, 0), it.variant_id == null ? null : Math.trunc(num(it.variant_id)));
    });

    // EXPENSES. Same shift/staff resolution as orders.
    const expenseIds = assignNonCollidingIds(expenseRows);
    const insertExpense = db.prepare(`
      INSERT INTO expenses (id, shift_id, staff_id, staff_name, category, description, amount,
                             from_drawer, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    expenseRows.forEach((e, i) => {
      identity.remember('expenses', expenseIds[i], e.device_id, e.local_id);
      insertExpense.run(expenseIds[i], resolveShiftId(e.device_id, e.local_shift_id), resolveStaffId(e.staff_id),
        text(e.staff_name), text(e.category) || 'Other', text(e.description), num(e.amount),
        bit(e.from_drawer, 1), text(e.created_at) || nowLocal());
    });

    // INVENTORY ENTRIES — the stock-movement history the Reports KPI cards
    // (Milk/Yogurt used) and the Stock Movement table are built from. Only
    // replaced when the cloud actually sent the field: an older cloud that
    // predates it must not cause this till's own history to be wiped.
    if (entryRows) {
      const entryIds = assignNonCollidingIds(entryRows);
      const insertEntry = db.prepare(`
        INSERT INTO inventory_entries (id, ingredient_id, type, amount, entry_date, created_at, order_id, order_item_id, reason)
        VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now', 'localtime')), ?, ?, ?)`);
      const entryIdByKey = new Map();
      const supersedes = [];
      entryRows.forEach((e, i) => {
        const ingredientId = ingredientIdByOriginal.get(e.ingredient_local_id);
        if (ingredientId == null || !e.type || !e.entry_date || e.amount == null || e.amount === '' || !Number.isFinite(Number(e.amount))) {
          result.skipped.inventory_entries++; // its ingredient is gone, or it is missing what makes it a movement
          return;
        }
        identity.remember('inventory_entries', entryIds[i], e.device_id, e.local_id);
        const orderId = e.order_local_id == null ? null : (orderIdByKey.get(`${e.device_id || ''}|${e.order_local_id}`) ?? null);
        const itemId = e.order_item_local_id == null ? null : (itemIdByKey.get(`${e.device_id || ''}|${e.order_item_local_id}`) ?? null);
        insertEntry.run(entryIds[i], ingredientId, String(e.type), Number(e.amount), String(e.entry_date), text(e.created_at),
          orderId, itemId, text(e.reason));
        entryIdByKey.set(`${e.device_id || ''}|${e.local_id}`, entryIds[i]);
        if (e.superseded_by != null) supersedes.push([entryIds[i], `${e.device_id || ''}|${e.superseded_by}`]);
      });
      // A corrected entry keeps pointing at the entry that corrects it, under its new number.
      supersedes.forEach(([id, key]) => {
        if (entryIdByKey.has(key)) db.prepare('UPDATE inventory_entries SET superseded_by = ? WHERE id = ?').run(entryIdByKey.get(key), id);
      });
      // Stock is what the restored entries add up to — never a number copied
      // across. Every ingredient, so one the export did not mention is 0, not stale.
      db.prepare(`
        UPDATE ingredients
           SET stock = COALESCE((SELECT SUM(amount) FROM inventory_entries WHERE ingredient_id = ingredients.id AND superseded_by IS NULL), 0)`).run();
    }

    // CREDIT PAYMENTS — each one on its own, with its own date, so "credit collected"
    // on the Reports screen has a day to put it on. Without them a restored till knew
    // only what each customer had paid IN TOTAL, and that card read 0 on every date
    // filter while the dashboard (which has the payments) showed the real figures.
    //
    // A payment names its customer by the number the pushing till gave them, and its
    // receiver only by name. The same payment can also reach the cloud twice (a till
    // re-pushed under a second device id), so an identical one — same customer, amount,
    // time and receiver — is kept once.
    const insertPayment = db.prepare(`
      INSERT INTO credit_payments (customer_id, amount, note, received_by, received_by_id, shift_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const seenPayments = new Set();
    const restoredPaid = new Map(); // customer id -> what those payments add up to
    paymentRows.forEach((p) => {
      const customerId = customerIdByKey.get(`${p.device_id || ''}|${p.customer_local_id}`)
        ?? (Number(p.customer_local_id) >= 10000 ? customerIdByCloudNo.get(Number(p.customer_local_id)) : undefined);
      const amount = num(p.amount);
      if (customerId == null || !(amount > 0)) { result.skipped.credit_payments++; return; }
      const dedupe = `${customerId}|${amount}|${text(p.created_at)}|${norm(p.received_by)}`;
      if (seenPayments.has(dedupe)) return;
      seenPayments.add(dedupe);
      const info = insertPayment.run(customerId, amount, text(p.note), text(p.received_by),
        staffIdByName.get(norm(p.received_by)) ?? null, resolveShiftId(p.device_id, p.local_shift_id),
        text(p.created_at) || nowLocal());
      identity.remember('credit_payments', Number(info.lastInsertRowid), p.device_id, p.local_id);
      restoredPaid.set(customerId, (restoredPaid.get(customerId) || 0) + amount);
    });

    // What the cloud's running total says a customer has paid, beyond the payments it
    // could itemise (history from before payments were sent one by one, or none at all
    // from an older cloud), becomes one stand-in so the balance still comes out right.
    // It is marked, and the Reports leave it out of "credit collected".
    paidByCustomer.forEach(({ id, totalPaid }) => {
      const missing = Math.round((totalPaid - (restoredPaid.get(id) || 0)) * 100) / 100;
      if (missing > 0) {
        insertRestoredPayment.run(id, missing,
          'Restored from cloud backup — individual payment history before this date is not available.');
      }
    });
  });

  run();

  result.restored = {
    staff: staffRows.length,
    customers: customerRows.length - (result.merged_customers || 0),
    orders: orderRows.length,
    shifts: shiftRows.length,
    expenses: expenseRows.length,
    ingredients: ingredientRows.length,
    inventory_entries: entryRows ? entryRows.length : 0,
    credit_payments: paymentRows.length - result.skipped.credit_payments,
  };
  return result;
}

module.exports = { applyCloudRestore, assignNonCollidingIds, isFreshTill, NotFreshError };
