/**
 * Clearing all trading data, for handing this install off to its next owner.
 *
 * The product ships as a fresh copy to a new shop with its own, empty local
 * database — but the cloud it was developed and tested against does not
 * start empty on its own. This is what makes it match: everything one shop
 * actually did (orders, customers, managers, stock, backups) is wiped, and
 * everything that belongs to the *software* rather than to a shop — the
 * menu, and the administrator account itself — is left exactly as it is. A
 * new owner still needs the same product catalog and a way to sign in and
 * set up their own staff; they do not need the previous owner's sales
 * history or their managers.
 *
 * Gated behind the dashboard password, re-entered here rather than trusted
 * from the session cookie alone. A signed-in session proves someone is at
 * this computer; it does not prove they meant to press the one button that
 * cannot be undone.
 *
 * Everything about to be deleted is read out and handed back in the same
 * response, before the delete runs — inside the same transaction, so the
 * copy is exactly what existed the instant before it was removed, not a
 * separately-timed read that could miss a row written in between. The
 * dashboard turns that straight into a downloaded file. This is also what
 * /api/restore/full (see routes/restore.js) hands a replacement till when
 * the cloud, not the dead machine, is the copy actually worth keeping.
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/pg');
const { requireUser } = require('../middleware/session');

/**
 * Every table that holds what one shop did, each with the select/delete pair
 * it actually needs. Most are scoped by their own `branch_id`; payslips is
 * the one exception — it hangs off `employee_id` with no branch_id of its
 * own — and runs first in the delete pass so it never fights employees'
 * foreign key on the way out. Explicit rather than templated, so this reads
 * as the complete list it is meant to be, not "orders, plus whatever
 * cascades happen to catch."
 */
const WIPE_TABLES = [
  {
    table: 'payslips',
    select: 'SELECT p.* FROM payslips p JOIN employees e ON e.id = p.employee_id WHERE e.branch_id = 1',
    del: 'DELETE FROM payslips WHERE employee_id IN (SELECT id FROM employees WHERE branch_id = 1)',
  },
  { table: 'employees', select: 'SELECT * FROM employees WHERE branch_id = 1', del: 'DELETE FROM employees WHERE branch_id = 1' },
  { table: 'order_items', select: 'SELECT * FROM order_items WHERE branch_id = 1', del: 'DELETE FROM order_items WHERE branch_id = 1' },
  { table: 'orders', select: 'SELECT * FROM orders WHERE branch_id = 1', del: 'DELETE FROM orders WHERE branch_id = 1' },
  { table: 'shifts', select: 'SELECT * FROM shifts WHERE branch_id = 1', del: 'DELETE FROM shifts WHERE branch_id = 1' },
  { table: 'expenses', select: 'SELECT * FROM expenses WHERE branch_id = 1', del: 'DELETE FROM expenses WHERE branch_id = 1' },
  { table: 'customers', select: 'SELECT * FROM customers WHERE branch_id = 1', del: 'DELETE FROM customers WHERE branch_id = 1' },
  // The administrator is permanent, the same rule as everywhere else staff
  // is touched (see the last-admin guard in routes/staff.js) — a clear that
  // took the only account able to sign in with it would leave nobody able to
  // set up the next owner's staff at all. Managers still go; only Admin/Owner
  // rows survive.
  {
    table: 'staff',
    select: "SELECT * FROM staff WHERE branch_id = 1 AND role NOT IN ('Admin', 'Owner')",
    del: "DELETE FROM staff WHERE branch_id = 1 AND role NOT IN ('Admin', 'Owner')",
  },
  { table: 'staff_deletions', select: 'SELECT * FROM staff_deletions WHERE branch_id = 1', del: 'DELETE FROM staff_deletions WHERE branch_id = 1' },
  { table: 'ingredients', select: 'SELECT * FROM ingredients WHERE branch_id = 1', del: 'DELETE FROM ingredients WHERE branch_id = 1' },
  { table: 'live_status', select: 'SELECT * FROM live_status WHERE branch_id = 1', del: 'DELETE FROM live_status WHERE branch_id = 1' },
  { table: 'sync_cursor', select: 'SELECT * FROM sync_cursor WHERE branch_id = 1', del: 'DELETE FROM sync_cursor WHERE branch_id = 1' },
  // The backup blobs themselves are large and are not what anyone restoring
  // this export needs — branch_backups holds gzipped SQLite files, not rows
  // this shape could represent. Its metadata (day, size, order count) is
  // still worth keeping a record of, so that much is exported; the blob
  // column is left out explicitly rather than shipped as base64 nobody asked
  // for in a JSON response meant to be readable.
  {
    table: 'branch_backups',
    select: 'SELECT id, branch_id, backup_day, taken_at, received_at, gz_bytes, raw_bytes, sha256, orders_count, last_order_at, reason FROM branch_backups WHERE branch_id = 1',
    del: 'DELETE FROM branch_backups WHERE branch_id = 1',
  },
];

router.post('/clear-data', requireUser, async (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only the owner account can clear all data.' });
  }

  const password = req.body && req.body.password;
  if (!password) return res.status(400).json({ error: 'Enter the dashboard password to confirm.' });

  try {
    const user = await db.one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const passwordOk = user && await bcrypt.compare(String(password), user.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    const { backup, cleared } = await db.tx(async (client) => {
      // Read first, every table, before anything is deleted — the backup is
      // a photograph of the instant before the wipe, taken inside the same
      // transaction so nothing written concurrently can fall in the gap
      // between "copy it" and "delete it".
      const backupData = {};
      for (const { table, select } of WIPE_TABLES) {
        backupData[table] = (await client.query(select)).rows;
      }

      const counts = {};
      for (const { table, del } of WIPE_TABLES) {
        counts[table] = (await client.query(del)).rowCount;
      }

      /*
       * Milk and Yogurt/Dahi come back at 0 rather than being left absent.
       *
       * Mirrors backend/db/database.js's own seed migrations on the till —
       * those two ingredients are load-bearing (Dahi's recipe and the
       * Convert-to-Yogurt feature both reference them by name), and a fresh
       * or newly-cleared install should look the same whichever side you
       * look at it from: not "no ingredients," but "Milk and Yogurt, empty."
       * `local_id` pinned to 1 and 3 to match the till's own ids for these
       * two — see that migration's comments — so the till's next push
       * lands on these same rows instead of creating duplicates.
       */
      await client.query(`
        INSERT INTO ingredients (branch_id, local_id, name, unit, stock, low_stock_threshold, cost_per_unit, received_at)
        VALUES
          (1, 1, 'Milk', 'Litre', 0, 0, 0, $1),
          (1, 3, 'Yogurt', 'grams', 0, 0, 0, $1)
        ON CONFLICT (branch_id, local_id) DO NOTHING
      `, [Date.now()]);

      return {
        cleared: counts,
        backup: {
          taken_at: new Date().toISOString(),
          branch_id: 1,
          tables: backupData,
        },
      };
    });

    console.log(`Data cleared by ${req.user.email}:`, JSON.stringify(cleared));
    res.json({ success: true, cleared, backup });
  } catch (err) {
    console.error('Clear data failed:', err.message);
    res.status(500).json({ error: 'Could not clear data.' });
  }
});

module.exports = router;
