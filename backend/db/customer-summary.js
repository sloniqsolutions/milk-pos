const db = require('./database');
const { getTotalLitres } = require('./order-litres');

/**
 * A credit customer's full standing — balance, lifetime litres and totals —
 * computed the same way GET /api/customers/:id computes it for the till's own
 * ledger screen.
 *
 * This exists separately from that route because the cloud has no
 * `credit_payments` table of its own (see cloud/db/schema.js — payments are
 * an implementation detail of how a balance moves, not something the
 * dashboard needs row-by-row). Instead, the till pushes this pre-computed
 * summary as a `customers` row every time a payment is recorded or a credit
 * sale is rung up, so the dashboard's balance figure is only ever as stale as
 * the next sync, never off by a whole payment history.
 */
function getCustomerSummary(customerId) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) return null;

  const creditOrders = db.prepare(
    `SELECT id, total, created_at, status FROM orders
     WHERE customer_id = ? AND payment_method = 'Credit'
     ORDER BY created_at DESC`
  ).all(customerId);

  const payments = db.prepare(
    'SELECT amount FROM credit_payments WHERE customer_id = ?'
  ).all(customerId);

  const completedOrders = creditOrders.filter(o => o.status === 'completed');
  const totalCredited = completedOrders.reduce((sum, o) => sum + o.total, 0);
  const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);

  const totalLitres = completedOrders.length > 0
    ? getTotalLitres(completedOrders.map(o => o.id))
    : 0;

  // creditOrders is newest-first, so after filtering the same order holds:
  // index 0 is the most recent completed order, the last index is the oldest.
  const lastOrder = completedOrders[0] || null;
  const firstOrder = completedOrders[completedOrders.length - 1] || null;

  return {
    ...customer,
    order_count: completedOrders.length,
    total_spent: totalCredited,
    first_order_at: firstOrder ? firstOrder.created_at : null,
    last_order_at: lastOrder ? lastOrder.created_at : null,
    total_credited: totalCredited,
    total_paid: totalPaid,
    balance: totalCredited - totalPaid,
    total_litres: totalLitres,
  };
}

module.exports = { getCustomerSummary };
