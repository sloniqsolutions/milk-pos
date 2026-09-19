/**
 * Handing a replacement till everything the cloud knows, when the cloud is
 * the copy actually worth keeping — the other half of routes/admin.js's
 * clear-data backup, and the answer to the opposite question: not "the
 * cloud was only ever dummy data, start this machine clean," but "the old
 * machine is gone and the cloud is the real history."
 *
 * Branch-key authenticated, the same as every other till-facing route — a
 * replacement machine pairs first (see backend/routes/cloud.js), which is
 * what gets it a key, and only then can it ask for this.
 *
 * device_id and received_at travel with shifts, expenses and orders (not
 * customers/staff/ingredients, which don't collide the same way — see
 * ingest.js's own note on why ingredients merge by name instead) for
 * exactly one reason: two different tills can each have their own
 * "shift 3," and a branch with more than one till now genuinely can carry
 * both. backend/routes/cloud.js's applyCloudRestore needs both fields to
 * tell those apart and renumber the collision safely rather than crash on
 * a UNIQUE constraint trying to force two different shifts into one row.
 *
 * One real gap, worth stating rather than leaving to be discovered: orders
 * never carried a credit customer's numeric id up to the cloud, only their
 * name/phone/address as text (see db/schema.js's orders table) — so a
 * restored order shows who it was for but is not linked back to that
 * customer's ledger row the way the original was. And a staff account whose
 * PIN was only ever set at the till (never edited from this dashboard) has
 * no hash to give back — see the pin_hash note in routes/staff.js — so a
 * restored account with no known hash gets a placeholder nobody can sign in
 * with, and needs its PIN reset from the Staff tab once the till is back up.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/pg');
const { requireBranch } = require('../middleware/branch-auth');

router.get('/full', requireBranch, async (req, res) => {
  const branchId = req.branch.id;

  try {
    const [staff, customers, ingredients, shifts, expenses, orders, orderItems, inventoryEntries] = await Promise.all([
      db.q('SELECT local_id, device_id, name, role, color, active, pin_hash FROM staff WHERE branch_id = ? ORDER BY local_id', [branchId]),
      db.q(`SELECT local_id, device_id, name, phone, address, notes, active, order_count, total_spent,
                   first_order_at, last_order_at, total_credited, total_paid, balance, total_litres
              FROM customers WHERE branch_id = ? ORDER BY local_id`, [branchId]),
      db.q('SELECT local_id, name, unit, stock, low_stock_threshold, cost_per_unit FROM ingredients WHERE branch_id = ? ORDER BY local_id', [branchId]),
      db.q(`SELECT local_id, device_id, staff_id, staff_name, opening_cash, closing_cash, expected_cash,
                   variance, opened_at, closed_at, status, received_at
              FROM shifts WHERE branch_id = ? ORDER BY received_at ASC`, [branchId]),
      db.q(`SELECT local_id, device_id, local_shift_id, staff_id, staff_name, category, description,
                   amount, from_drawer, created_at, received_at
              FROM expenses WHERE branch_id = ? ORDER BY received_at ASC`, [branchId]),
      db.q(`SELECT local_id, device_id, total, discount, payment_method, status, cashier_name, cashier_id,
                   created_at, order_type, delivery_charge, local_shift_id, table_number, voided_at,
                   tax_rate, tax_amount, is_employee, employee_discount, employee_discount_rate,
                   voided_by, voided_by_id, customer_name, customer_phone, customer_address, received_at
              FROM orders WHERE branch_id = ? ORDER BY received_at ASC`, [branchId]),
      // order_items.order_id is the CLOUD's orders.id (remapped at ingest —
      // see routes/ingest.js); joining back to orders is what recovers the
      // till's own local order id (and which till's own id space it
      // belongs to), which is what a restored order_items row actually
      // needs to point at.
      db.q(`SELECT oi.local_id, o.local_id AS order_local_id, o.device_id AS order_device_id,
                   oi.menu_item_id, oi.name, oi.price, oi.quantity, oi.is_deal, oi.variant_id, oi.category
              FROM order_items oi
              JOIN orders o ON o.id = oi.order_id
             WHERE oi.branch_id = ?
             ORDER BY oi.local_id`, [branchId]),
      // Restocks, sales deductions, Convert-to-Yogurt and waste. The Reports
      // KPI cards' Milk/Yogurt "used" figures and the Stock Movement table
      // are read straight off these rows, not re-derived from orders — so a
      // restore that brings orders back without them leaves both empty.
      db.q(`SELECT local_id, device_id, ingredient_local_id, type, amount, entry_date, created_at, received_at
              FROM inventory_entries WHERE branch_id = ? ORDER BY received_at ASC`, [branchId]),
    ]);

    res.json({
      branch_id: branchId,
      generated_at: new Date().toISOString(),
      staff,
      customers,
      ingredients,
      shifts,
      expenses,
      orders,
      order_items: orderItems,
      inventory_entries: inventoryEntries,
    });
  } catch (err) {
    console.error('Restore export failed:', err.message);
    res.status(500).json({ error: 'Could not read branch data.' });
  }
});

module.exports = router;
