/**
 * Sales ingest.
 *
 * The opposite contract to the heartbeat next door: this channel must never
 * lose a row. A missed heartbeat is superseded a moment later; a missed sale is
 * money the owner never sees.
 *
 * The design that makes that survivable on a bad link is **idempotency**, not
 * careful delivery. On a fluctuating connection the till frequently cannot tell
 * whether a batch arrived — the request may have been answered after it gave
 * up, or the reply lost on the way back. Rather than trying to resolve that
 * ambiguity, re-sending is made harmless: every row is keyed on
 * `(branch_id, local_id)`, so the same batch applied three times leaves exactly
 * one copy of each sale.
 *
 * The branch always comes from the API key, never from the body.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/pg');
const { requireBranch } = require('../middleware/branch-auth');

/** Caps a single request. The till batches to match; a bad payload is refused before it is worked on. */
const MAX_ROWS = 200;

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v) => (v == null ? null : String(v));

/**
 * Build one multi-row upsert for a whole batch.
 *
 * The first version issued a statement per row, which was correct and far too
 * slow: a hundred orders with three hundred line items meant four hundred
 * sequential round trips to a database in another country. At a couple of
 * hundred milliseconds each that is well over a minute, and the till's push
 * timed out before it finished — so a shop with a real backlog could never
 * catch up at all.
 *
 * One statement per table per batch turns that into three round trips.
 *
 * Postgres caps a statement at 65535 parameters. The widest table here is
 * orders at 25 columns, so the till's batch of 100 uses 2,500 — comfortably
 * inside it, but the cap is why BATCH_SIZE and MAX_ROWS exist rather than
 * sending everything at once.
 *
 * `RETURNING` is what makes the order_items remap possible in the same trip:
 * it hands back each row's cloud id alongside the till's local_id.
 */
/**
 * @param {string|object} [opts] Either a bare `conflictWhere` SQL condition
 *   string (blocks the WHOLE row's update when false — what staff uses: an
 *   owner-edited row is never touched by that till's next push again), or
 *   `{ alwaysCols, gateCondition }` for a table where some columns must
 *   always take the till's value regardless of who else has touched the
 *   row — ingredient stock and a customer's derived balance/litres/order
 *   figures are both like this: real numbers computed at the till that must
 *   never freeze just because a dashboard edit touched the row's name once.
 *   `alwaysCols` lists which columns that applies to; every other column in
 *   `columns` is gated by `gateCondition` instead of the whole row.
 */
/**
 * @param {string} deviceId Which till pushed this batch — see the migration
 *   block in db/schema.js for why (branch_id, local_id) alone stopped being
 *   a safe conflict key once a branch can have more than one till. Every
 *   table here carries it except ingredients, which passes `withDevice:
 *   false` — see routes/ingest.js's ingestIngredients for why that one
 *   table needs the opposite treatment (merged by name, not disambiguated
 *   by device).
 */
function buildUpsert(table, columns, rows, valuesFor, receivedAt, branchId, deviceId, opts) {
  const options = typeof opts === 'string' ? { conflictWhere: opts } : (opts || {});
  const { conflictWhere, alwaysCols = [], gateCondition, withDevice = true } = options;

  const keyCols = withDevice ? ['branch_id', 'device_id', 'local_id'] : ['branch_id', 'local_id'];
  const cols = [...keyCols, ...columns, 'received_at'];
  const params = [];
  const tuples = [];

  rows.forEach((row) => {
    const keyValues = withDevice ? [branchId, deviceId, num(row.id)] : [branchId, num(row.id)];
    const values = [...keyValues, ...valuesFor(row), receivedAt];
    const placeholders = values.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    tuples.push(`(${placeholders.join(', ')})`);
  });

  // received_at is refreshed too, so "when did the cloud last hear about this
  // row" stays honest after an update.
  const updates = [
    ...columns.map((c) => {
      if (gateCondition && !alwaysCols.includes(c)) {
        return `${c} = CASE WHEN ${gateCondition} THEN EXCLUDED.${c} ELSE ${table}.${c} END`;
      }
      return `${c} = EXCLUDED.${c}`;
    }),
    'received_at = EXCLUDED.received_at',
  ].join(', ');

  const conflictTarget = withDevice ? '(branch_id, device_id, local_id)' : '(branch_id, local_id)';

  return {
    sql: `
      INSERT INTO ${table} (${cols.join(', ')})
      VALUES ${tuples.join(', ')}
      ON CONFLICT ${conflictTarget} DO UPDATE SET ${updates}
      ${conflictWhere ? `WHERE ${conflictWhere}` : ''}
      RETURNING id, local_id
    `,
    params,
  };
}

/*
 * The columns each table carries, beyond the (branch_id, local_id) key and
 * received_at. Order matters: it has to match the values function beneath it.
 *
 * Orders are mutable — one already sent can later be voided — so every column
 * is refreshed on conflict rather than only the void fields, and a correction
 * of any kind lands.
 */
const ORDER_COLS = [
  'total', 'discount', 'payment_method', 'status', 'cashier_name', 'cashier_id',
  'created_at', 'order_type', 'delivery_charge', 'local_shift_id', 'table_number',
  'voided_at', 'tax_rate', 'tax_amount', 'is_employee', 'employee_discount',
  'employee_discount_rate', 'voided_by', 'voided_by_id',
  'customer_name', 'customer_phone', 'customer_address',
];
// A shift is sent while open and again once counted, so it must update too.
const SHIFT_COLS = [
  'staff_id', 'staff_name', 'opening_cash', 'closing_cash', 'expected_cash',
  'variance', 'opened_at', 'closed_at', 'status',
];
const EXPENSE_COLS = [
  'local_shift_id', 'staff_id', 'staff_name', 'category', 'description',
  'amount', 'from_drawer', 'created_at',
];
// Note what is absent: the PIN, hashed or otherwise. It is of no use to the
// dashboard, and every copy of a credential is another place it can leak from.
const STAFF_COLS = ['name', 'role', 'color', 'active'];
const INGREDIENT_COLS = ['name', 'unit', 'stock', 'low_stock_threshold', 'cost_per_unit'];
const CUSTOMER_COLS = [
  'name', 'phone', 'address', 'notes', 'active', 'order_count', 'total_spent',
  'first_order_at', 'last_order_at', 'total_credited', 'total_paid', 'balance',
  'total_litres',
];
const CREDIT_PAYMENT_COLS = ['customer_local_id', 'local_shift_id', 'amount', 'note', 'received_by', 'created_at'];
const INVENTORY_ENTRY_COLS = ['ingredient_local_id', 'type', 'amount', 'entry_date', 'created_at'];

const ORDER_VALUES = (r) => [
  num(r.total), num(r.discount), str(r.payment_method), str(r.status),
  str(r.cashier_name), num(r.cashier_id), str(r.created_at),
  str(r.order_type), num(r.delivery_charge), num(r.shift_id),
  str(r.table_number), str(r.voided_at), num(r.tax_rate), num(r.tax_amount),
  num(r.is_employee), num(r.employee_discount), num(r.employee_discount_rate),
  str(r.voided_by), num(r.voided_by_id),
  str(r.customer_name), str(r.customer_phone), str(r.customer_address),
];

async function ingestOrders(client, branchId, rows, receivedAt, deviceId) {
  const orderUpsert = buildUpsert('orders', ORDER_COLS, rows, ORDER_VALUES, receivedAt, branchId, deviceId);
  const result = await client.query(orderUpsert.sql, orderUpsert.params);

  /*
   * Remap the line items onto the CLOUD's order id.
   *
   * The till sends its own order id, which is only unique within that branch
   * *and that till* (see the device_id note on buildUpsert above) — a batch
   * only ever comes from one till at a time, so local_id alone is still
   * enough to map these RETURNING rows back onto the rows just pushed.
   * Storing the till's own id unchanged would make E-18's items join onto
   * CBR Town's order of the same number — quietly attributing one shop's
   * food to the other's sale.
   */
  const cloudIdFor = new Map(result.rows.map(r => [Number(r.local_id), r.id]));

  const items = [];
  for (const row of rows) {
    const orderId = cloudIdFor.get(num(row.id));
    for (const item of row.items || []) {
      items.push({ item, orderId });
    }
  }
  if (!items.length) return;

  const params = [];
  const tuples = items.map(({ item, orderId }) => {
    const values = [
      branchId, deviceId, num(item.id), orderId, num(item.menu_item_id), str(item.name),
      num(item.price), num(item.quantity), num(item.is_deal), num(item.variant_id),
      // Resolved by the till, because menu item ids are per-machine and cannot
      // be resolved here.
      str(item.category),
    ];
    return `(${values.map(v => { params.push(v); return `$${params.length}`; }).join(', ')})`;
  });

  await client.query(`
    INSERT INTO order_items (
      branch_id, device_id, local_id, order_id, menu_item_id, name, price, quantity,
      is_deal, variant_id, category
    ) VALUES ${tuples.join(', ')}
    ON CONFLICT (branch_id, device_id, local_id) DO UPDATE SET
      order_id = EXCLUDED.order_id, name = EXCLUDED.name, price = EXCLUDED.price,
      quantity = EXCLUDED.quantity, is_deal = EXCLUDED.is_deal,
      variant_id = EXCLUDED.variant_id, category = EXCLUDED.category
  `, params);
}

/** The simple tables: one multi-row upsert, no children to remap. */
function simpleIngest(table, columns, valuesFor, opts, after) {
  return async (client, branchId, rows, receivedAt, deviceId) => {
    const { sql, params } = buildUpsert(
      table, columns, rows, valuesFor, receivedAt, branchId, deviceId, opts);
    await client.query(sql, params);
    if (after) await after(client, branchId);
  };
}

/**
 * Undo anything this push resurrected.
 *
 * A till pushes its whole staff list every five minutes and knows nothing about
 * deletions until its next pull. Without this, deleting somebody on the
 * dashboard would work and then silently undo itself within the next five
 * minutes — which looks exactly like the delete button not working.
 *
 * Done after the upsert rather than by filtering rows beforehand: the upsert is
 * one multi-row statement, and one extra DELETE is both cheaper and much harder
 * to get subtly wrong than per-row filtering inside it.
 */
async function dropDeletedStaff(client, branchId) {
  // device_id-matched — see db/schema.js's migration note on staff_deletions.
  // A NULL device_id (a dashboard-created row — see routes/staff.js's own
  // POST) is coalesced to 'legacy' on both sides so it still compares
  // equal, not against a NULL that matches nothing.
  await client.query(db.toPg(`
    DELETE FROM staff s
     USING staff_deletions d
     WHERE s.branch_id = ? AND d.branch_id = s.branch_id AND d.local_id = s.local_id
       AND COALESCE(d.device_id, 'legacy') = COALESCE(s.device_id, 'legacy')
  `), [branchId]);
}

/** Same reasoning as dropDeletedStaff, for the two other tables the
 * dashboard can now delete from — see routes/inventory.js/customers.js. */
async function dropDeletedIngredients(client, branchId) {
  await client.query(db.toPg(`
    DELETE FROM ingredients i
     USING ingredient_deletions d
     WHERE i.branch_id = ? AND d.branch_id = i.branch_id AND d.local_id = i.local_id
  `), [branchId]);
}
async function dropDeletedCustomers(client, branchId) {
  await client.query(db.toPg(`
    DELETE FROM customers c
     USING customer_deletions d
     WHERE c.branch_id = ? AND d.branch_id = c.branch_id AND d.local_id = c.local_id
  `), [branchId]);
}

/**
 * Ingredients get their own handler rather than simpleIngest, because
 * `(branch_id, local_id)` alone isn't a safe key for this one table: a
 * branch can have more than one till (this shop does), and each till's
 * local_id is its own SQLite AUTOINCREMENT — unrelated to any other till's.
 * Two tills that both have a "Yogurt" row, one as local_id 2 and the other
 * as local_id 3, would otherwise land as two different cloud rows for what
 * is physically one ingredient, or — worse — two *different* ingredients
 * that happen to share a local_id would silently overwrite each other's
 * stock under one row. (Every other table pushed here carries its own
 * per-till identity in its data — an order's own line items, a shift's own
 * cashier — so a same-numbered row from two tills is still two genuinely
 * different rows, just both real. An ingredient has no such distinguishing
 * data beyond its name, which is exactly what a shop already treats as the
 * identity — SQLite's own `name TEXT NOT NULL UNIQUE` on the till agrees.)
 *
 * Before the upsert, every pushed row is remapped onto whichever local_id
 * this branch already has on file for that name, if one exists — so a
 * second till's own numbering just updates the first till's row instead of
 * colliding with or duplicating it. See routes/cloud.js's
 * restore-from-cloud for the same guard on the way back down, and where
 * this exact problem first turned up.
 */
async function ingestIngredients(client, branchId, rows, receivedAt /* , deviceId — unused: merged by name instead, see above */) {
  const existing = await client.query(
    'SELECT local_id, name FROM ingredients WHERE branch_id = $1', [branchId]);
  const canonicalIdByName = new Map(existing.rows.map(r => [r.name, Number(r.local_id)]));

  const remapped = new Map(); // canonical local_id -> row (last one in the batch wins)
  for (const row of rows) {
    const name = str(row.name);
    const canonicalId = (name && canonicalIdByName.has(name)) ? canonicalIdByName.get(name) : num(row.id);
    remapped.set(canonicalId, { ...row, id: canonicalId });
  }

  const { sql, params } = buildUpsert(
    'ingredients', INGREDIENT_COLS, Array.from(remapped.values()),
    r => [str(r.name), str(r.unit), num(r.stock), num(r.low_stock_threshold), num(r.cost_per_unit)],
    receivedAt, branchId, null,
    { alwaysCols: ['stock'], gateCondition: "ingredients.origin <> 'cloud'", withDevice: false });
  await client.query(sql, params);
  await dropDeletedIngredients(client, branchId);
}

/**
 * Stock movements. A movement names its ingredient by the pushing till's own
 * row number, which is not the number the cloud files that ingredient under —
 * ingredients are merged by name (see ingestIngredients above), so the cloud's
 * "Yogurt" can be 3 while a till's own is 2. Filing the movement under the
 * till's number left it pointing at no ingredient here, and every report that
 * joins the two silently dropped it: milk or yogurt sold, and not in the
 * table. The till now sends `ingredient_name` along with each movement (see
 * backend/db/cloud-sync.js); it is resolved to this branch's own number here.
 * A till too old to send the name falls back to the number it always sent.
 */
async function ingestInventoryEntries(client, branchId, rows, receivedAt, deviceId) {
  const existing = await client.query(
    'SELECT local_id, name FROM ingredients WHERE branch_id = $1', [branchId]);
  const idByName = new Map(existing.rows.map(r => [String(r.name), Number(r.local_id)]));
  const resolved = rows.map((r) => {
    const canonical = r.ingredient_name != null ? idByName.get(String(r.ingredient_name)) : undefined;
    return canonical != null ? { ...r, ingredient_id: canonical } : r;
  });
  const { sql, params } = buildUpsert(
    'inventory_entries', INVENTORY_ENTRY_COLS, resolved,
    r => [num(r.ingredient_id), str(r.type), num(r.amount), str(r.entry_date), str(r.created_at)],
    receivedAt, branchId, deviceId);
  await client.query(sql, params);
}

/** Where cloud-created rows' numbers start — see routes/customers.js's copy of this constant. */
const CLOUD_ID_BASE = 10000;

const ingestCustomersFromTill = simpleIngest('customers', CUSTOMER_COLS, r => [
  str(r.name), str(r.phone), str(r.address), str(r.notes), num(r.active),
  num(r.order_count), num(r.total_spent),
  str(r.first_order_at), str(r.last_order_at),
  num(r.total_credited), num(r.total_paid), num(r.balance), num(r.total_litres),
], {
  alwaysCols: ['order_count', 'total_spent', 'first_order_at', 'last_order_at', 'total_credited', 'total_paid', 'balance', 'total_litres'],
  gateCondition: "customers.origin <> 'cloud'",
}, dropDeletedCustomers);

/**
 * Customers. A customer created on the dashboard is numbered from
 * CLOUD_ID_BASE and stored with no till id (routes/customers.js's POST), and
 * every till pulls it down under that same number. When that till later pushed
 * the customer's balance back — a credit sale, a payment, the pairing backfill —
 * the row was keyed (branch, THIS TILL, number), matched nothing, and was filed
 * as a second copy of the same person. A fresh install then restored both, which
 * is how "Staff Milk" and "Suleman" came up twice.
 *
 * A number at or above CLOUD_ID_BASE means the same customer whichever till
 * pushes it, so those rows update the dashboard's own row in place. Only when no
 * such row exists (the dashboard row was deleted, or the number is a till's own)
 * does the ordinary upsert run.
 */
async function ingestCustomers(client, branchId, rows, receivedAt, deviceId) {
  const unmatched = [];
  for (const r of rows) {
    if (!(num(r.id) >= CLOUD_ID_BASE)) { unmatched.push(r); continue; }
    const updated = await client.query(
      `UPDATE customers SET order_count = $3, total_spent = $4, first_order_at = $5, last_order_at = $6,
              total_credited = $7, total_paid = $8, balance = $9, total_litres = $10, received_at = $11
        WHERE branch_id = $1 AND local_id = $2 AND origin = 'cloud'`,
      [branchId, num(r.id), num(r.order_count), num(r.total_spent), str(r.first_order_at), str(r.last_order_at),
       num(r.total_credited), num(r.total_paid), num(r.balance), num(r.total_litres), receivedAt]);
    if (!updated.rowCount) unmatched.push(r);
  }
  if (unmatched.length) await ingestCustomersFromTill(client, branchId, unmatched, receivedAt, deviceId);
  else await dropDeletedCustomers(client, branchId);
}

const HANDLERS = {
  orders: ingestOrders,

  shifts: simpleIngest('shifts', SHIFT_COLS, r => [
    num(r.staff_id), str(r.staff_name), num(r.opening_cash), num(r.closing_cash),
    num(r.expected_cash), num(r.variance), str(r.opened_at), str(r.closed_at), str(r.status),
  ]),

  expenses: simpleIngest('expenses', EXPENSE_COLS, r => [
    num(r.shift_id), num(r.staff_id), str(r.staff_name), str(r.category),
    str(r.description), num(r.amount), num(r.from_drawer), str(r.created_at),
  ]),

  /*
   * Staff and stock are pushed so the owner can see them on the dashboard.
   *
   * STAFF_COLS still carries no PIN. The till has no reason to send one up: the
   * hash travels the other way now, from routes/staff.js down to the till, and
   * a push that carried it back would achieve nothing but a second copy in
   * flight.
   *
   * The WHERE clause is what makes the two directions coexist. A row the owner
   * has touched is marked origin = 'cloud', and this push must not overwrite
   * it — otherwise deactivating somebody on the dashboard would be undone by
   * that same till's next push thirty seconds later, which looks exactly like
   * the button not working.
   */
  staff: simpleIngest('staff', STAFF_COLS, r => [
    str(r.name), str(r.role), str(r.color), num(r.active),
  ], "staff.origin <> 'cloud'", dropDeletedStaff),

  // Stock always takes the till's value — it's the one figure here that's a
  // real physical count, not something the dashboard can edit (see
  // routes/inventory.js). Name/unit/threshold/cost only update when the
  // dashboard hasn't claimed the row, same rule staff uses.
  ingredients: ingestIngredients,

  // The credit customer book. Balance/litres/order figures are computed on
  // the till (backend/db/customer-summary.js) and always carried through —
  // there is nowhere else they could come from. Name/phone/address/notes
  // only update when the dashboard hasn't claimed the row (see
  // routes/customers.js).
  customers: ingestCustomers,

  // The individual events behind a customer's balance — see db/schema.js's
  // credit_payments table for why this exists (branch-data.js's shift
  // totals need "collected during THIS shift", which a lifetime total_paid
  // figure can't answer). Immutable once recorded — no edit/delete route
  // anywhere touches a payment after the fact — so a plain upsert with no
  // origin gating is enough; nothing on the dashboard ever writes here to
  // conflict with.
  credit_payments: simpleIngest('credit_payments', CREDIT_PAYMENT_COLS, r => [
    num(r.customer_id), num(r.shift_id), num(r.amount), str(r.note), str(r.received_by), str(r.created_at),
  ]),

  // Restocks, Convert-to-Yogurt, waste — see db/schema.js's inventory_entries
  // table. Immutable once recorded (no edit/delete route touches one after
  // the fact), so a plain upsert is enough.
  inventory_entries: ingestInventoryEntries,
};

/**
 * POST /api/ingest/batch — one table's worth of pending rows.
 *
 * All-or-nothing: the whole batch commits or none of it does. A partial batch
 * would leave the till marking rows synced that the cloud never stored.
 */
router.post('/batch', requireBranch, async (req, res) => {
  const { table, rows } = req.body || {};
  // A push from a till that hasn't picked up the code sending this yet is
  // read as 'legacy' rather than left blank — see db/schema.js's migration
  // note on why every row needs a real, non-NULL value here.
  const deviceId = str(req.body && req.body.device_id) || 'legacy';
  const handler = typeof table === 'string' && Object.prototype.hasOwnProperty.call(HANDLERS, table) ? HANDLERS[table] : null;

  if (!handler) {
    return res.status(400).json({ error: `Unknown table "${table}"` });
  }
  if (!Array.isArray(rows)) {
    return res.status(400).json({ error: 'rows must be an array' });
  }
  if (rows.length > MAX_ROWS) {
    return res.status(413).json({ error: `Batch too large (max ${MAX_ROWS} rows)` });
  }
  if (rows.length === 0) {
    return res.json({ ok: true, accepted: 0 });
  }
  // A row with no usable identifier would be stored under NULL and could never
  // be updated again; refuse the batch with a reason instead of a database error.
  if (rows.some(r => !r || typeof r !== 'object' || num(r.id) == null)) {
    return res.status(400).json({ error: 'Every row in a batch needs its own id. Nothing in this batch was stored.' });
  }

  try {
    const receivedAt = Date.now();

    await db.tx(async (client) => {
      await handler(client, req.branch.id, rows, receivedAt, deviceId);
      await client.query(`
        INSERT INTO sync_cursor (branch_id, table_name, rows_received, last_synced_ms)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (branch_id, table_name) DO UPDATE SET
          rows_received = sync_cursor.rows_received + EXCLUDED.rows_received,
          last_synced_ms = EXCLUDED.last_synced_ms
      `, [req.branch.id, table, rows.length, receivedAt]);
    });

    // The till marks rows synced only on this reply, so it is the till's proof
    // that the data is durable here.
    res.json({ ok: true, accepted: rows.length });
  } catch (err) {
    console.error(`Ingest of ${table} failed:`, err.message);
    res.status(500).json({ error: 'Could not store batch' });
  }
});

module.exports = router;
module.exports.ingestCustomers = ingestCustomers;
