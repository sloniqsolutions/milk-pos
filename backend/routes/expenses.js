const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { syncUpsert, syncDelete } = require('../db/cloud-sync');

/**
 * Petty cash paid out — rider fuel, staff lunch, a repair, and so on.
 *
 * The point of `from_drawer` is reconciliation. Money handed out of the till is
 * gone from the drawer but is not a sale, so without recording it every shift
 * closes short by exactly the amount that was spent and the manager gets
 * blamed for a shortfall that is really a fuel receipt. A drawer expense is
 * attached to whichever shift was open at the time, so it lands in the right
 * trading period even if it is entered a few minutes later.
 *
 * An expense paid from someone's own pocket or by card is still worth
 * recording, but must not move the drawer — hence the flag rather than always
 * subtracting.
 *
 * Both roles may add expenses: it is day-to-day till work, and a manager
 * handing a rider fuel money cannot wait for the owner.
 */

/** Common categories, offered in the UI. Free text is still accepted. */
const CATEGORIES = [
  'Transport',
  'Gas',
  'Staff Wages',
  'Supplies',
  'Miscellaneous',
];

router.get('/categories', (req, res) => res.json(CATEGORIES));

/**
 * List expenses for a date range, newest first.
 *
 * Deliberately not scoped per user, unlike the sales reports. The drawer
 * belongs to the shift rather than to a person: if one user records a payout
 * and another counts the till, hiding the first user's entry would make the
 * count impossible to reconcile.
 */
router.get('/', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const from = req.query.from || today;
  const to = req.query.to || today;
  const category = req.query.category && String(req.query.category).trim();

  const catClause = category ? ' AND category = ?' : '';
  const catParams = category ? [category] : [];

  try {
    const rows = db.prepare(`
      SELECT e.*, s.status AS shift_status
      FROM expenses e
      LEFT JOIN shifts s ON s.id = e.shift_id
      WHERE DATE(e.created_at) BETWEEN DATE(?) AND DATE(?)${category ? ' AND e.category = ?' : ''}
      ORDER BY e.created_at DESC, e.id DESC
    `).all(from, to, ...catParams);

    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(amount), 0) AS total,
        COALESCE(SUM(CASE WHEN from_drawer = 1 THEN amount ELSE 0 END), 0) AS from_drawer_total,
        COUNT(*) AS count
      FROM expenses
      WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)${catClause}
    `).get(from, to, ...catParams);

    res.json({ expenses: rows, totals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST a new expense
router.post('/', (req, res) => {
  const { category, description, amount, from_drawer } = req.body;

  const value = Number(amount);
  if (!category || !String(category).trim()) {
    return res.status(400).json({ error: 'Choose what the money was spent on' });
  }
  if (!Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ error: 'Enter an amount greater than zero' });
  }

  try {
    // Same restriction as a sale: an expense has to be attached to a real,
    // open shift or the drawer math it is meant to feed has nothing to land
    // in. Recording it "unattached" used to be allowed and silently produced
    // expenses nobody's shift ever accounted for.
    const openShift = db.prepare(
      "SELECT id FROM shifts WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1"
    ).get();

    if (!openShift) {
      return res.status(400).json({
        error: 'No shift is currently open. You must open a shift before recording an expense.'
      });
    }

    const fromDrawer = from_drawer === false || from_drawer === 0 ? 0 : 1;

    const info = db.prepare(`
      INSERT INTO expenses
        (shift_id, staff_id, staff_name, category, description, amount, from_drawer, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    `).run(
      openShift.id,
      // Attribution comes from the session, never the request body.
      (req.user && req.user.staffId) || null,
      (req.user && req.user.name) || 'Unknown',
      String(category).trim(),
      description ? String(description).trim() : null,
      Math.round(value * 100) / 100,
      fromDrawer
    );

    const created = db.prepare('SELECT * FROM expenses WHERE id = ?').get(info.lastInsertRowid);
    syncUpsert('expenses', created);
    res.status(201).json({
      ...created,
      // Tells the UI whether this actually moved a drawer, so it can say so
      // rather than implying a reconciliation that did not happen.
      affected_shift: Boolean(fromDrawer),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete an expense.
 *
 * A manager may remove their own mistake; only an administrator can remove
 * somebody else's, since deleting a drawer expense silently changes what the
 * till is expected to hold.
 */
router.delete('/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Expense not found' });

    const { isAdminRole } = require('../middleware/auth');
    const isAdmin = req.user && isAdminRole(req.user.role);
    const isOwnEntry = req.user && row.staff_id === req.user.staffId;

    if (!isAdmin && !isOwnEntry) {
      return res.status(403).json({
        error: 'You can only remove expenses you recorded yourself.',
      });
    }

    db.prepare('DELETE FROM expenses WHERE id = ?').run(row.id);
    syncDelete('expenses', row.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
