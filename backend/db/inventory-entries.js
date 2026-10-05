/**
 * The one way stock moves.
 *
 * A stock number and its log entry are changed together, by the same amount,
 * in one transaction — so the number on the shelf is always the sum of the
 * entries, and the Summary table can add up by itself. Nothing else in the
 * till may UPDATE ingredients.stock (backend/test/stock-ledger.test.js greps
 * for it).
 *
 * If a movement would take stock below zero it is refused (code
 * INSUFFICIENT_STOCK) and nothing changes: no clamp, so what is logged is
 * always exactly what moved.
 *
 * The cloud push happens after the surrounding transaction has committed
 * (flushEntryPushes), never from inside it — a sale that rolls back must not
 * leave a movement on the cloud.
 *
 * Each entry tracks whether it reached the cloud (cloud_synced). A periodic
 * retry loop re-pushes any that failed, so a single dropped request no longer
 * means the cloud is permanently out of sync.
 */

const db = require('./database');
const { syncUpsertTracked } = require('./cloud-sync');

const bump = db.prepare('UPDATE ingredients SET stock = ROUND(stock + ?, 6) WHERE id = ?');
const readStock = db.prepare('SELECT name, unit, stock FROM ingredients WHERE id = ?');
const insertEntry = db.prepare(`
  INSERT INTO inventory_entries (ingredient_id, type, amount, entry_date, created_at, order_id, order_item_id, reason)
  VALUES (?, ?, ?, ?, COALESCE(?, datetime('now', 'localtime')), ?, ?, ?)`);
const getEntry = db.prepare('SELECT * FROM inventory_entries WHERE id = ?');
const markSynced = db.prepare('UPDATE inventory_entries SET cloud_synced = 1 WHERE id = ?');
const getUnsynced = db.prepare(
  'SELECT * FROM inventory_entries WHERE cloud_synced = 0 ORDER BY id LIMIT 50');

/** Six decimals: far finer than any real quantity, coarse enough to drop float dust. */
const round6 = (n) => Math.round(Number(n) * 1e6) / 1e6;

class InsufficientStockError extends Error {
  constructor(name, unit, have, need) {
    super(`Not enough ${name} in stock: ${have} ${unit} available, ${need} needed.`);
    this.code = 'INSUFFICIENT_STOCK';
    this.status = 400;
  }
}

const pendingPush = new Set();

/**
 * @param {number} ingredientId
 * @param {'stock'|'sale'|'waste'|'yogurt_conversion'} type
 * @param {number} amount signed: positive adds stock, negative removes it
 * @param {string} entryDate YYYY-MM-DD
 * @param {{orderId?: number, orderItemId?: number, reason?: string, createdAt?: string}} [opts]
 *   sale and return entries name the order line they belong to and are dated
 *   by the order's own time (createdAt)
 * @returns {number} the new entry's id
 */
function moveStock(ingredientId, type, amount, entryDate, opts = {}) {
  const amt = round6(amount);
  if (!Number.isFinite(amt) || amt === 0) throw new Error('A stock movement needs a non-zero amount.');

  const id = db.transaction(() => {
    const ing = readStock.get(ingredientId);
    if (!ing) throw new Error('That ingredient no longer exists.');
    if (amt < 0 && Number(ing.stock) + amt < -1e-9) {
      throw new InsufficientStockError(ing.name, ing.unit, round6(ing.stock), round6(-amt));
    }
    const entryId = insertEntry.run(
      ingredientId, type, amt, entryDate, opts.createdAt || null,
      opts.orderId || null, opts.orderItemId || null, opts.reason || null).lastInsertRowid;
    bump.run(amt, ingredientId);
    return Number(entryId);
  })();

  if (db.inTransaction) pendingPush.add(id);
  else pushAndTrack(id);
  return id;
}

function pushAndTrack(id) {
  const row = getEntry.get(id);
  if (!row) return;
  syncUpsertTracked('inventory_entries', row).then((ok) => {
    if (ok) markSynced.run(id);
  });
}

/** Send the movements made inside a transaction that has now committed. A rolled-back one no longer exists and is skipped. */
function flushEntryPushes() {
  for (const id of pendingPush) {
    pushAndTrack(id);
  }
  pendingPush.clear();
}

let retryTimer = null;

/** Re-push any inventory entries that never reached the cloud. */
function retrySyncEntries() {
  const rows = getUnsynced.all();
  if (rows.length === 0) return;
  console.log(`[Cloud] retrying ${rows.length} unsynced inventory entries…`);
  for (const row of rows) {
    syncUpsertTracked('inventory_entries', row).then((ok) => {
      if (ok) markSynced.run(row.id);
    });
  }
}

function startRetryLoop() {
  if (retryTimer) return;
  retryTimer = setInterval(retrySyncEntries, 60_000);
  retryTimer.unref();
}

startRetryLoop();

module.exports = { moveStock, flushEntryPushes, InsufficientStockError, round6 };
