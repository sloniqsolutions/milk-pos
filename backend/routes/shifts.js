const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { syncUpsert } = require('../db/cloud-sync');

/**
 * Shift management.
 *
 * FIX (Bug 5): the Settings > Shift screen previously rendered hardcoded
 * numbers — 23 orders, Rs. 12,400, and three invented history rows that
 * existed only in React state and vanished on refresh. Every figure below is
 * now derived from the orders actually rung up during the shift.
 */

/** Live totals for a shift, computed from its orders. */
const shiftTotalsStmt = db.prepare(`
  SELECT
    COUNT(*)                                                     AS total_orders,
    COALESCE(SUM(total), 0)                                      AS total_revenue,
    COALESCE(SUM(discount), 0)                                   AS total_discounts,
    COALESCE(SUM(CASE WHEN LOWER(payment_method) = 'cash' THEN total ELSE 0 END), 0) AS cash_revenue,
    COALESCE(SUM(CASE WHEN LOWER(payment_method) != 'cash' THEN total ELSE 0 END), 0) AS non_cash_revenue
  FROM orders
  WHERE shift_id = ? AND status != 'voided'
`);

/**
 * Cash paid out of the drawer during the shift.
 *
 * Rider fuel, staff lunch and the like leave the till but are not sales, so
 * without this the drawer is expected to hold money that was handed out hours
 * ago and every shift closes short by exactly what was spent.
 */
const shiftExpensesStmt = db.prepare(`
  SELECT
    COALESCE(SUM(amount), 0) AS drawer_expenses,
    COUNT(*)                 AS expense_count
  FROM expenses
  WHERE shift_id = ? AND from_drawer = 1
`);

/**
 * Cash collected from credit customers during the shift.
 *
 * A credit sale never touched the drawer when it was rung up (it's excluded
 * from cash_revenue above), so the money only shows up here, at the moment
 * it's actually paid back — exactly mirroring how a real till works.
 */
const shiftCreditCollectedStmt = db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS credit_collected
  FROM credit_payments
  WHERE shift_id = ?
`);

const getOpenShiftStmt = db.prepare(
  "SELECT * FROM shifts WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1"
);

function withTotals(shift) {
  if (!shift) return null;
  const totals = shiftTotalsStmt.get(shift.id);
  const spend = shiftExpensesStmt.get(shift.id);
  const credit = shiftCreditCollectedStmt.get(shift.id);

  // What the drawer should hold right now: the float, plus cash taken in,
  // plus credit payments collected in cash, minus cash paid back out.
  // Card and online sales never touch it.
  const expectedCash =
    Number(shift.opening_cash || 0) +
    Number(totals.cash_revenue || 0) +
    Number(credit.credit_collected || 0) -
    Number(spend.drawer_expenses || 0);

  return {
    ...shift,
    ...totals,
    ...spend,
    ...credit,
    // A closed shift keeps the figure recorded at the time; a live one is
    // computed so the screen updates as sales and payouts happen.
    expected_cash: shift.status === 'closed' && shift.expected_cash !== null
      ? shift.expected_cash
      : expectedCash,
  };
}

// GET the currently open shift (or null)
router.get('/current', (req, res) => {
  try {
    const shift = getOpenShiftStmt.get();
    res.json(shift ? withTotals(shift) : null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET recent closed shifts
router.get('/history', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  try {
    const shifts = db.prepare(
      "SELECT * FROM shifts WHERE status = 'closed' ORDER BY closed_at DESC LIMIT ?"
    ).all(limit);
    res.json(shifts.map(withTotals));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET a single shift's summary
router.get('/:id/summary', (req, res) => {
  try {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });

    const topItems = db.prepare(`
      SELECT oi.name, SUM(oi.quantity) AS total_qty, SUM(oi.price * oi.quantity) AS total_revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.shift_id = ? AND o.status != 'voided'
      GROUP BY oi.name
      ORDER BY total_qty DESC
      LIMIT 10
    `).all(shift.id);

    res.json({ ...withTotals(shift), top_items: topItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST open a shift
router.post('/open', (req, res) => {
  const { opening_cash, staff_id, staff_name } = req.body;

  try {
    const existing = getOpenShiftStmt.get();
    if (existing) {
      return res.status(409).json({ error: 'A shift is already open. Close it first.' });
    }

    // Local wall-clock, not CURRENT_TIMESTAMP's UTC — see db/database.js.
    const result = db.prepare(`
      INSERT INTO shifts (staff_id, staff_name, opening_cash, status, opened_at)
      VALUES (?, ?, ?, 'open', datetime('now', 'localtime'))
    `).run(staff_id || null, staff_name || 'Unknown', Number(opening_cash) || 0);

    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(result.lastInsertRowid);
    syncUpsert('shifts', shift);
    res.status(201).json(withTotals(shift));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST close the open shift
router.post('/close', (req, res) => {
  const { closing_cash } = req.body;

  try {
    const shift = getOpenShiftStmt.get();
    if (!shift) return res.status(404).json({ error: 'No open shift to close' });

    const totals = shiftTotalsStmt.get(shift.id);
    const spend = shiftExpensesStmt.get(shift.id);
    const credit = shiftCreditCollectedStmt.get(shift.id);

    // Expected drawer = float + cash taken in + credit collected - cash paid
    // out of the till. Card and online sales never touch the drawer, so they
    // are excluded, and petty cash handed out has to come off or the count
    // is short by that much.
    const expected =
      Number(shift.opening_cash || 0) +
      Number(totals.cash_revenue || 0) +
      Number(credit.credit_collected || 0) -
      Number(spend.drawer_expenses || 0);
    const actual = Number(closing_cash) || 0;

    db.prepare(`
      UPDATE shifts
      SET closing_cash = ?, expected_cash = ?, variance = ?,
          closed_at = datetime('now', 'localtime'), status = 'closed'
      WHERE id = ?
    `).run(actual, expected, actual - expected, shift.id);

    const closed = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id);
    syncUpsert('shifts', closed);
    res.json(withTotals(closed));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
