/**
 * Pushes local writes to the cloud (see ../../cloud/routes/ingest.js).
 *
 * Replaces the earlier direct-to-Supabase sync (db/supabase.js, db/sync.js) —
 * the cloud service is now what owns "the same data ends up in Postgres too."
 * This module is only the till's half of that: it batches rows into the
 * shape cloud/routes/ingest.js expects and POSTs them to
 * `${cloud_url}/api/ingest/batch`, authenticated with the branch API key from
 * `cloud-sync.json` (see db/cloud-config.js).
 *
 * Every function here is fire-and-forget: it never throws back into the
 * route that called it and never delays the HTTP response. Local SQLite is
 * the source of truth the till itself reads and writes — an unpaired,
 * offline or slow cloud must only ever make this fall behind, never break a
 * sale, a payment or a shift change.
 */

const { readCloudConfig } = require('./cloud-config');
const { postJson, deleteJson } = require('./cloud-http');
const db = require('./database');
const { getCustomerSummary } = require('./customer-summary');
const { buildOrderSyncPayload } = require('./order-sync-payload');
const { getDeviceId } = require('./activation-config');

/**
 * Cloud ingest table per local table. Not every local table has a cloud
 * counterpart:
 *   - `menu_items`/`item_variants` are cloud-owned (the dashboard edits the
 *     menu; the till only ever pulls it) — see cloud/routes/menu.js.
 *   - `settings` is likewise edited on the dashboard for the shop-wide keys
 *     it covers — see cloud/routes/settings.js.
 *   - `credit_payments` has no table of its own on the cloud; instead, every
 *     payment (and every credit sale) pushes the *customer's* recomputed
 *     balance as a `customers` row — see db/customer-summary.js and its
 *     call sites in routes/customers.js and routes/orders.js.
 * Calling syncUpsert for any of those is simply a no-op.
 */
const INGEST_TABLE = {
  orders: 'orders',
  shifts: 'shifts',
  expenses: 'expenses',
  ingredients: 'ingredients',
  staff: 'staff',
  customers: 'customers',
  credit_payments: 'credit_payments',
  inventory_entries: 'inventory_entries',
};

/** Splits a push into batches under ingest.js's MAX_ROWS (200). */
function pushBatches(config, cloudTable, rows, label) {
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    postJson(config.cloudUrl, '/api/ingest/batch', config.apiKey, {
      table: cloudTable,
      rows: chunk,
      // Which till this is — see cloud/db/schema.js's migration note and
      // cloud/routes/ingest.js's buildUpsert for why (branch_id, local_id)
      // alone stopped being a safe key once a branch can have more than one
      // till. Reuses the same stable per-install id activation already
      // relies on (db/activation-config.js) rather than minting a second one.
      device_id: getDeviceId(),
    }).catch((err) => {
      console.error(`[Cloud] sync ${label} failed:`, err.message);
    });
  }
}

/** Push one row. See module doc — a no-op if `localTable` has no cloud table, or the till isn't paired. */
function syncUpsert(localTable, row) {
  const cloudTable = INGEST_TABLE[localTable];
  if (!cloudTable || !row) return;
  const config = readCloudConfig();
  if (!config) return;
  pushBatches(config, cloudTable, [row], localTable);
}

/** Push several rows of the same table in as few requests as the 200-row cap allows. */
function syncUpsertMany(localTable, rows) {
  const cloudTable = INGEST_TABLE[localTable];
  if (!cloudTable || !rows || rows.length === 0) return;
  const config = readCloudConfig();
  if (!config) return;
  pushBatches(config, cloudTable, rows, localTable);
}

/**
 * Deletion has no ingest counterpart for whatever table this is still called
 * for. Staff and expenses used to be in that bucket and now have their own
 * real delete-sync functions below (syncStaffDelete, syncExpenseDelete) —
 * this stays only for a table nobody has built one for yet, as a documented,
 * one-time-per-table warning rather than a silent gap, so the row's
 * continued presence on the dashboard is explained rather than mysterious.
 */
const warnedDeletes = new Set();
function syncDelete(localTable) {
  if (warnedDeletes.has(localTable)) return;
  warnedDeletes.add(localTable);
  console.warn(
    `[Cloud] A local delete on "${localTable}" was not pushed — the cloud has no delete ` +
    'endpoint for this table, so the row may still appear there until removed on the dashboard directly.'
  );
}

/**
 * Tells the cloud a staff member was just permanently deleted at this till —
 * see cloud/routes/staff.js's DELETE /local/:localId, the only thing this
 * calls. Staff is the one table where a till-side hard delete is common
 * (routes/staff.js's own DELETE route) and silently leaving a ghost record
 * on the dashboard is a real problem (it stays selectable/active there
 * indefinitely) — unlike the other tables syncDelete() covers, which are
 * rare enough that a documented gap is an acceptable trade for not building
 * a whole tombstone mechanism for them too.
 */
function syncStaffDelete(localId) {
  const config = readCloudConfig();
  if (!config) return;
  // device_id as a query param, not a body — DELETE requests carry no body
  // here (see db/cloud-http.js's deleteJson). Without it, this delete would
  // match *any* till's staff row of this same local_id once a branch can
  // have more than one — see cloud/routes/staff.js's own note on why that
  // used to be safe and now genuinely is not.
  deleteJson(config.cloudUrl, `/api/staff/local/${localId}?device_id=${encodeURIComponent(getDeviceId())}`, config.apiKey).catch((err) => {
    console.error('[Cloud] sync staff delete failed:', err.message);
  });
}

/** Same as syncStaffDelete, for an expense — see cloud/routes/expenses.js's
 * DELETE /local/:localId, the only thing this calls. */
function syncExpenseDelete(localId) {
  const config = readCloudConfig();
  if (!config) return;
  deleteJson(config.cloudUrl, `/api/expenses/local/${localId}?device_id=${encodeURIComponent(getDeviceId())}`, config.apiKey).catch((err) => {
    console.error('[Cloud] sync expense delete failed:', err.message);
  });
}

/**
 * Pushes a till-side menu create/update/retire/restore up to
 * cloud/routes/menu.js's POST /from-till, which upserts it by name (menu
 * items have no shared id space between till and cloud — see
 * backend/sync/downlink.js's own name-matched applyMenu()) and re-runs the
 * universal-price cascade there. This till's next downlink poll pulls the
 * result back down, including any sibling sizes the cascade repriced that
 * this push never mentioned — see backend/routes/menu.js's own note on why
 * that round trip is enough instead of duplicating the cascade here.
 */
function syncMenuUpsert(item) {
  const config = readCloudConfig();
  if (!config || !item) return;
  postJson(config.cloudUrl, '/api/menu/from-till', config.apiKey, {
    name: item.name,
    category: item.category,
    price: item.price,
    description: item.description,
    has_variants: item.has_variants,
    active: item.active,
    variants: item.variants,
  }).catch((err) => {
    console.error('[Cloud] sync menu item failed:', err.message);
  });
}

/**
 * Pushes everything that already exists locally, right after pairing.
 *
 * Every other push in this module fires on a create or an edit — which is
 * exactly the gap this closes. A row created *before* a till was ever paired
 * has no create/edit event left to trigger on, so without this the cloud's
 * view of it is permanently empty until someone happens to touch it again.
 * Discovered twice, the same way: pairing a till with a real existing roster
 * and finding the cloud believed it had none, then pairing one with real
 * trading history and finding Reports empty despite sync "working."
 *
 * Orders are pushed oldest-first and chunked at 200 (ingest.js's own cap),
 * so a till with a long history sends several batches rather than one that
 * would be refused. Each batch is its own request; a failure partway through
 * is logged per-batch by pushBatches and does not stop the rest, on the same
 * fire-and-forget reasoning as every other push here — pairing must not hang
 * or fail because of how much history there is to send.
 */
function pushInitialBackfill() {
  const config = readCloudConfig();
  if (!config) return;

  const staff = db.prepare('SELECT * FROM staff').all();
  pushBatches(config, 'staff', staff, 'staff (initial backfill)');

  const ingredients = db.prepare('SELECT * FROM ingredients').all();
  pushBatches(config, 'ingredients', ingredients, 'ingredients (initial backfill)');

  const customerIds = db.prepare('SELECT id FROM customers').all().map(r => r.id);
  const customers = customerIds.map(getCustomerSummary).filter(Boolean);
  pushBatches(config, 'customers', customers, 'customers (initial backfill)');

  const creditPayments = db.prepare('SELECT * FROM credit_payments ORDER BY id').all();
  pushBatches(config, 'credit_payments', creditPayments, 'credit payments (initial backfill)');

  const inventoryEntries = db.prepare('SELECT * FROM inventory_entries ORDER BY id').all();
  pushBatches(config, 'inventory_entries', inventoryEntries, 'inventory entries (initial backfill)');

  const shifts = db.prepare('SELECT * FROM shifts ORDER BY id').all();
  pushBatches(config, 'shifts', shifts, 'shifts (initial backfill)');

  const expenses = db.prepare('SELECT * FROM expenses ORDER BY id').all();
  pushBatches(config, 'expenses', expenses, 'expenses (initial backfill)');

  const orderIds = db.prepare('SELECT id FROM orders ORDER BY id').all().map(r => r.id);
  const orders = orderIds.map(buildOrderSyncPayload).filter(Boolean);
  pushBatches(config, 'orders', orders, 'orders (initial backfill)');
}

module.exports = { syncUpsert, syncUpsertMany, syncDelete, syncStaffDelete, syncExpenseDelete, syncMenuUpsert, pushInitialBackfill };
