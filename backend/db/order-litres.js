const db = require('./database');

/**
 * Real milk litres consumed by a set of orders — computed from the recipe
 * tied to each line's menu item/variant, not order_items.quantity itself.
 *
 * Quantity alone is not litres: a "2 Litre" pack bought as quantity 1 is 2
 * real litres, and a custom "Milk (0.63 L)" line is quantity 0.63 — both are
 * only correct once multiplied by that item's Milk recipe_ingredients
 * quantity_required. Treating quantity as litres directly (the assumption
 * this file replaces) is why a credit sale of a 0.5L or 2L pack used to show
 * up as exactly 1L everywhere a customer's litres were totalled.
 *
 * Scoped to the Milk ingredient specifically — a Dahi (yogurt) line has its
 * own recipe against the Yogurt ingredient and contributes 0 here, same as
 * any other non-milk item.
 */
function getLitresByOrderIds(orderIds) {
  const litresByOrder = {};
  if (!orderIds || orderIds.length === 0) return litresByOrder;

  const placeholders = orderIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT oi.order_id, SUM(oi.quantity * ri.quantity_required) as litres
    FROM order_items oi
    JOIN recipes r ON r.menu_item_id = oi.menu_item_id
      AND (r.variant_id = oi.variant_id OR r.variant_id IS NULL)
    JOIN recipe_ingredients ri ON ri.recipe_id = r.id
    JOIN ingredients ing ON ing.id = ri.ingredient_id AND ing.name = 'Milk'
    WHERE oi.order_id IN (${placeholders})
    GROUP BY oi.order_id
  `).all(...orderIds);

  rows.forEach(r => { litresByOrder[r.order_id] = r.litres || 0; });
  return litresByOrder;
}

/** Sum of getLitresByOrderIds across every order id given — a convenience
 * for callers that only need the one total, not a per-order breakdown. */
function getTotalLitres(orderIds) {
  const byOrder = getLitresByOrderIds(orderIds);
  return Object.values(byOrder).reduce((sum, l) => sum + l, 0);
}

module.exports = { getLitresByOrderIds, getTotalLitres };
