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
const identity = require('./cloud-identity');

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

const ingredientName = db.prepare('SELECT name FROM ingredients WHERE id = ?');

/**
 * A stock movement points at its ingredient by this till's own row number,
 * which means nothing to the cloud: it merges ingredients by name (see
 * cloud/routes/ingest.js's ingestIngredients), so the cloud's "Yogurt" can be
 * number 3 while this till's is 2. Every movement pushed with only the number
 * then pointed at an ingredient the cloud does not have under that number, and
 * dropped out of every report that joins the two. Sending the name along is
 * what lets the cloud file each movement under the right ingredient.
 */
function withIngredientName(cloudTable, rows) {
  if (cloudTable !== 'inventory_entries') return rows;
  return rows.map((r) => {
    const found = r && ingredientName.get(r.ingredient_id);
    return found ? { ...r, ingredient_name: found.name } : r;
  });
}

/**
 * Files each row under the (device, number) the cloud knows it by.
 *
 * A row this device made itself is filed under this device and its own number,
 * as it always was. A row that was *restored* from the cloud (see
 * db/cloud-identity.js) is filed under the till it originally came from and
 * that till's number for it — so pushing it again updates the cloud's existing
 * row instead of adding a second copy beside it — and the numbers it refers to
 * (its shift, its line items, its customer) are translated the same way.
 *
 * Returns Map<deviceId, rows[]>.
 */
function groupByCloudIdentity(cloudTable, rows) {
  const myDevice = getDeviceId();
  const groups = new Map();
  for (const row of rows) {
    if (!row) continue;
    const own = identity.lookup(cloudTable, row.id);
    const device = own ? own.device_id : myDevice;
    let out = own ? { ...row, id: own.orig_id } : row;

    if (own && ['orders', 'expenses'].includes(cloudTable) && out.shift_id != null) {
      const shift = identity.lookup('shifts', out.shift_id);
      if (shift && shift.device_id === device) out = { ...out, shift_id: shift.orig_id };
    }
    if (own && cloudTable === 'orders' && Array.isArray(out.items)) {
      out = { ...out, items: out.items.map((it) => {
        const item = identity.lookup('order_items', it.id);
        return item ? { ...it, id: item.orig_id } : it;
      }) };
    }
    // A stock entry restored from another till names that till's order line by
    // the number the cloud knows it by, not this device's renumbered one.
    if (own && cloudTable === 'inventory_entries') {
      const order = out.order_id != null ? identity.lookup('orders', out.order_id) : null;
      const item = out.order_item_id != null ? identity.lookup('order_items', out.order_item_id) : null;
      out = {
        ...out,
        order_id: order && order.device_id === device ? order.orig_id : null,
        order_item_id: item && item.device_id === device ? item.orig_id : null,
      };
      if (out.superseded_by != null) {
        const by = identity.lookup('inventory_entries', out.superseded_by);
        out = { ...out, superseded_by: by && by.device_id === device ? by.orig_id : null };
      }
    }
    // A payment recorded here for a customer restored from elsewhere refers to
    // that customer by the number the cloud knows them by.
    if (cloudTable === 'credit_payments' && out.customer_id != null) {
      const customer = identity.lookup('customers', out.customer_id);
      if (customer) out = { ...out, customer_id: customer.orig_id };
    }

    if (!groups.has(device)) groups.set(device, []);
    groups.get(device).push(out);
  }
  return groups;
}

/**
 * Posts rows to the cloud in batches under ingest.js's MAX_ROWS (200), one
 * device's rows at a time. Resolves to the outcome of every request, so a
 * caller that needs to know whether it all landed can check; one that does not
 * (every push below) just logs failures and moves on.
 */
function postGrouped(config, cloudTable, rows) {
  const CHUNK = 200;
  const requests = [];
  let groups;
  try {
    groups = groupByCloudIdentity(cloudTable, withIngredientName(cloudTable, rows));
  } catch (err) {
    // Preparing a push must never throw into the sale, payment or shift that caused it.
    return Promise.resolve([{ status: 'rejected', reason: err }]);
  }
  for (const [deviceId, deviceRows] of groups) {
    for (let i = 0; i < deviceRows.length; i += CHUNK) {
      requests.push(postJson(config.cloudUrl, '/api/ingest/batch', config.apiKey, {
        table: cloudTable,
        rows: deviceRows.slice(i, i + CHUNK),
        // Which till this is — see cloud/db/schema.js's migration note and
        // cloud/routes/ingest.js's buildUpsert for why (branch_id, local_id)
        // alone stopped being a safe key once a branch can have more than one
        // till. For rows this device made, that is the same stable per-install
        // id activation already relies on (db/activation-config.js).
        device_id: deviceId,
      }));
    }
  }
  return Promise.allSettled(requests);
}

function pushBatches(config, cloudTable, rows, label) {
  postGrouped(config, cloudTable, rows).then((outcomes) => {
    outcomes.filter((o) => o.status === 'rejected').forEach((o) => {
      console.error(`[Cloud] sync ${label} failed:`, o.reason && o.reason.message);
    });
  });
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
  // Looked up and forgotten first, even when unpaired: staff numbers are handed out
  // as MAX+1, so a deleted row's number can be reused and must not inherit its identity.
  const own = identity.lookup('staff', localId);
  identity.forget('staff', localId);
  const config = readCloudConfig();
  if (!config) return;
  // device_id as a query param, not a body — DELETE requests carry no body
  // here (see db/cloud-http.js's deleteJson). Without it, this delete would
  // match *any* till's staff row of this same local_id once a branch can
  // have more than one — see cloud/routes/staff.js's own note on why that
  // used to be safe and now genuinely is not.
  deleteJson(config.cloudUrl, `/api/staff/local/${own ? own.orig_id : localId}?device_id=${encodeURIComponent(own ? own.device_id : getDeviceId())}`, config.apiKey).catch((err) => {
    console.error('[Cloud] sync staff delete failed:', err.message);
  });

}

/** Same as syncStaffDelete, for an expense — see cloud/routes/expenses.js's
 * DELETE /local/:localId, the only thing this calls. */
function syncExpenseDelete(localId) {
  const own = identity.lookup('expenses', localId);
  identity.forget('expenses', localId);
  const config = readCloudConfig();
  if (!config) return;
  deleteJson(config.cloudUrl, `/api/expenses/local/${own ? own.orig_id : localId}?device_id=${encodeURIComponent(own ? own.device_id : getDeviceId())}`, config.apiKey).catch((err) => {
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

  // Not the placeholder payment a restore writes to make a balance come out
  // right (routes/cloud.js): it stands for payments the cloud already has.
  const creditPayments = db.prepare(
    "SELECT * FROM credit_payments WHERE COALESCE(note, '') NOT LIKE 'Restored from cloud backup%' ORDER BY id").all();
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

/**
 * Re-sends every stock movement with its ingredient's name attached, and
 * reports whether the cloud accepted all of it. Movements recorded before the
 * name travelled with them are filed on the cloud under this till's own
 * ingredient numbers, which is what made milk or yogurt sales go missing from
 * the Summary table — re-pushing them lets the cloud file each one under the
 * right ingredient (every push is an upsert, so this is safe to repeat).
 * Awaited, unlike the fire-and-forget pushes above, because the caller only
 * wants to remember it is done once it actually is.
 */
async function pushInventoryEntriesResync() {
  const config = readCloudConfig();
  if (!config) return false;
  const outcomes = await postGrouped(config, 'inventory_entries', db.prepare('SELECT * FROM inventory_entries ORDER BY id').all());
  const failed = outcomes.find((o) => o.status === 'rejected');
  if (failed) throw failed.reason;
  return true;
}

module.exports = { pushInventoryEntriesResync, syncUpsert, syncUpsertMany, syncDelete, syncStaffDelete, syncExpenseDelete, syncMenuUpsert, pushInitialBackfill };
