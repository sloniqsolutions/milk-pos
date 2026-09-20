const db = require('./database');
const { unitAmount } = require('./item-quantities');
const { createClassifier } = require('./line-classifier');

// One definition of Milk / Dahi for every screen — see db/line-classifier.js.
const { classifyLine } = createClassifier(unitAmount);

/**
 * Real milk litres and Dahi kilograms consumed by orders — from each line's
 * quantity and what one unit of it stands for (db/item-quantities.js), for the
 * lines db/line-classifier.js calls Milk or Dahi.
 *
 * Quantity alone is not litres: a "2 Litre" pack bought as quantity 1 is 2
 * real litres, and a custom "Milk (0.63 L)" line is quantity 0.63 and IS litres.
 *
 * This used to go through the till's recipes (menu item -> Milk ingredient), which
 * gave 0 for any Milk item without a recipe — every item that arrives from the
 * dashboard has none — and, on a restored till, for a line whose menu item no longer
 * exists. Using the classifier is the rule the Reports use, so a customer's litres
 * and the reports agree, including for a line recognised by its name.
 */
const LINES = `
  SELECT oi.order_id AS order_id, m.category AS category, oi.is_deal AS is_deal,
         oi.name AS name, oi.quantity AS quantity
    FROM order_items oi
    LEFT JOIN menu_items m ON m.id = oi.menu_item_id AND oi.is_deal = 0`;

/** { [orderId]: { litres, kg } } for the orders given. */
function consumptionByOrder(orderIds) {
  const byOrder = {};
  if (!orderIds || orderIds.length === 0) return byOrder;
  const placeholders = orderIds.map(() => '?').join(',');
  for (const l of db.prepare(`${LINES} WHERE oi.order_id IN (${placeholders})`).all(...orderIds)) {
    const c = classifyLine(l);
    if (c.group === 'Other') continue;
    const o = byOrder[l.order_id] || (byOrder[l.order_id] = { litres: 0, kg: 0 });
    if (c.group === 'Milk') o.litres += c.amount; else o.kg += c.amount;
  }
  return byOrder;
}

function getLitresByOrderIds(orderIds) {
  const out = {};
  for (const [id, c] of Object.entries(consumptionByOrder(orderIds))) out[id] = c.litres;
  return out;
}

function getDahiKgByOrderIds(orderIds) {
  const out = {};
  for (const [id, c] of Object.entries(consumptionByOrder(orderIds))) out[id] = c.kg;
  return out;
}

/** Sum of getLitresByOrderIds across every order id given — a convenience
 * for callers that only need the one total, not a per-order breakdown. */
function getTotalLitres(orderIds) {
  return Object.values(getLitresByOrderIds(orderIds)).reduce((sum, l) => sum + l, 0);
}

/** customer id -> { litres, kg } over their completed credit orders, for the customer list. */
function consumptionByCustomer() {
  const rows = db.prepare(`
    SELECT o.customer_id AS customer_id, l.category AS category, l.is_deal AS is_deal, l.name AS name, l.quantity AS quantity
      FROM orders o
      JOIN (${LINES}) l ON l.order_id = o.id
     WHERE o.status = 'completed' AND o.payment_method = 'Credit' AND o.customer_id IS NOT NULL
  `).all();
  const byCustomer = {};
  for (const r of rows) {
    const c = classifyLine(r);
    if (c.group === 'Other') continue;
    const o = byCustomer[r.customer_id] || (byCustomer[r.customer_id] = { litres: 0, kg: 0 });
    if (c.group === 'Milk') o.litres += c.amount; else o.kg += c.amount;
  }
  return byCustomer;
}

function getLitresByCustomer() {
  const out = {};
  for (const [id, c] of Object.entries(consumptionByCustomer())) out[id] = c.litres;
  return out;
}

function getDahiKgByCustomer() {
  const out = {};
  for (const [id, c] of Object.entries(consumptionByCustomer())) out[id] = c.kg;
  return out;
}

module.exports = { getLitresByOrderIds, getTotalLitres, getLitresByCustomer, getDahiKgByOrderIds, getDahiKgByCustomer };
