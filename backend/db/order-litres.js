const db = require('./database');
const { unitAmount } = require('./item-quantities');

/**
 * Real milk litres consumed by a set of orders — quantity times the litres one
 * unit of that line stands for (db/item-quantities.js), for lines whose menu
 * item is in the Milk category.
 *
 * Quantity alone is not litres: a "2 Litre" pack bought as quantity 1 is 2
 * real litres, and a custom "Milk (0.63 L)" line is quantity 0.63 and IS litres.
 *
 * This used to go through the till's recipes (menu item -> Milk ingredient).
 * That gave 0 for any Milk item without a recipe — every item that arrives from
 * the dashboard has none (backend/sync/downlink.js) — so a customer's lifetime
 * litres silently under-counted. Reading the line and its category is the same
 * rule the Reports use (routes/reports.js, /detailed), so the customer screen
 * and the reports agree. Dahi (yogurt) contributes 0 here, as before.
 */
function litresOfLines(lines) {
  return lines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * unitAmount('Milk', l.name), 0);
}

const MILK_LINES = `
  FROM order_items oi
  JOIN menu_items m ON m.id = oi.menu_item_id AND oi.is_deal = 0
  WHERE m.category = 'Milk'`;

function getLitresByOrderIds(orderIds) {
  const litresByOrder = {};
  if (!orderIds || orderIds.length === 0) return litresByOrder;

  const placeholders = orderIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT oi.order_id AS order_id, oi.name AS name, oi.quantity AS quantity
    ${MILK_LINES} AND oi.order_id IN (${placeholders})
  `).all(...orderIds);

  rows.forEach((r) => { litresByOrder[r.order_id] = (litresByOrder[r.order_id] || 0) + litresOfLines([r]); });
  return litresByOrder;
}

/** Sum of getLitresByOrderIds across every order id given — a convenience
 * for callers that only need the one total, not a per-order breakdown. */
function getTotalLitres(orderIds) {
  const byOrder = getLitresByOrderIds(orderIds);
  return Object.values(byOrder).reduce((sum, l) => sum + l, 0);
}

/** customer id -> lifetime litres over their completed orders, for the customer list. */
function getLitresByCustomer() {
  const rows = db.prepare(`
    SELECT o.customer_id AS customer_id, oi.name AS name, oi.quantity AS quantity
    ${MILK_LINES.replace('WHERE', 'JOIN orders o ON o.id = oi.order_id WHERE')}
      AND o.status = 'completed' AND o.payment_method = 'Credit' AND o.customer_id IS NOT NULL
  `).all();
  const byCustomer = {};
  rows.forEach((r) => { byCustomer[r.customer_id] = (byCustomer[r.customer_id] || 0) + litresOfLines([r]); });
  return byCustomer;
}

module.exports = { getLitresByOrderIds, getTotalLitres, getLitresByCustomer };
