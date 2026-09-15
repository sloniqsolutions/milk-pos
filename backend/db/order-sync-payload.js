const db = require('./database');

/**
 * Builds the payload cloud/routes/ingest.js's orders handler expects: the
 * order row with its line items attached as `.items`, each carrying the
 * category the cloud can't resolve itself (menu item ids are per-till, so
 * the till has to do that join before the row ever leaves it).
 *
 * Shared between routes/orders.js (pushed on every sale and void) and
 * db/cloud-sync.js's pushInitialBackfill (pushed once, for every order that
 * already existed before this till was ever paired).
 */
function buildOrderSyncPayload(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  const items = db.prepare(`
    SELECT oi.*, m.category AS category
    FROM order_items oi
    LEFT JOIN menu_items m ON m.id = oi.menu_item_id AND oi.is_deal = 0
    WHERE oi.order_id = ?
  `).all(orderId);
  return { ...order, items };
}

module.exports = { buildOrderSyncPayload };
