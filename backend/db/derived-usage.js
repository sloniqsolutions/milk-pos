const db = require('./database');
require('./cloud-identity'); // makes sure the cloud_identity table exists

/**
 * Stock consumed by sales that never logged their stock movement.
 *
 * "Used" and "Sold" in Reports add up the movements the till logs when it rings
 * a sale up (inventory_entries, type 'sale'). History restored from the cloud
 * can include sales rung up by an older build of the app that deducted stock but
 * never logged the movement — revenue shows, yet Milk/Yogurt Used read 0.
 *
 * This fills exactly that gap: for each day, and each origin device (the till
 * that made the row — restored rows keep theirs in cloud_identity; rows made
 * here have none), it works out what the sold order lines consumed from their
 * recipes — but only if that device logged no 'sale' movement for that
 * ingredient on that day. Where it did log, the logged figure stands alone, so
 * nothing is ever counted twice. (Same rule as cloud/db/derived-usage.js.)
 *
 * @returns {Map<string, number>} "YYYY-MM-DD|ingredientId" -> amount
 */
function unloggedSold(from, to) {
  const derived = db.prepare(`
    SELECT DATE(o.created_at) AS day, COALESCE(ci.device_id, 'local') AS device,
           ri.ingredient_id AS ingredient_id, SUM(oi.quantity * ri.quantity_required) AS amount
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN cloud_identity ci ON ci.tbl = 'orders' AND ci.local_id = o.id
      JOIN recipes r ON r.menu_item_id = oi.menu_item_id
        AND (r.variant_id = oi.variant_id OR r.variant_id IS NULL)
      JOIN recipe_ingredients ri ON ri.recipe_id = r.id
     WHERE o.status != 'voided' AND COALESCE(oi.is_deal, 0) = 0
       AND DATE(o.created_at) BETWEEN DATE(?) AND DATE(?)
     GROUP BY 1, 2, 3
  `).all(from, to);

  const logged = db.prepare(`
    SELECT ie.entry_date AS day, COALESCE(ci.device_id, 'local') AS device, ie.ingredient_id AS ingredient_id
      FROM inventory_entries ie
      LEFT JOIN cloud_identity ci ON ci.tbl = 'inventory_entries' AND ci.local_id = ie.id
     WHERE ie.type = 'sale' AND DATE(ie.entry_date) BETWEEN DATE(?) AND DATE(?)
     GROUP BY 1, 2, 3
  `).all(from, to);
  const hasLogged = new Set(logged.map((l) => `${l.day}|${l.device}|${l.ingredient_id}`));

  const out = new Map();
  for (const d of derived) {
    if (hasLogged.has(`${d.day}|${d.device}|${d.ingredient_id}`)) continue;
    const amount = Number(d.amount) || 0;
    if (!(amount > 0)) continue;
    const key = `${d.day}|${d.ingredient_id}`;
    out.set(key, (out.get(key) || 0) + amount);
  }
  return out;
}

module.exports = { unloggedSold };
