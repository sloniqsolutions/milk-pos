const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { syncUpsert } = require('../db/cloud-sync');
const { getCustomerSummary } = require('../db/customer-summary');
const { getLitresByOrderIds } = require('../db/order-litres');

// Whitelisted so a bad ?sort= value can't be used to inject SQL — same
// reasoning as VALID_PAYMENTS in orders.js.
const CUSTOMER_SORTS = {
  name: 'c.name COLLATE NOCASE ASC',
  balance: 'balance DESC',
  // No geocoding in this app yet, so "closest location" degrades to an
  // alphabetical address sort for now — a real distance sort needs lat/lng
  // on the customer plus the shop's own coordinates.
  location: 'c.address COLLATE NOCASE ASC',
  recent: 'c.created_at DESC',
};

// GET /api/customers?search=ali&sort=balance
router.get('/', (req, res) => {
  const { search, sort } = req.query;
  const orderBy = CUSTOMER_SORTS[sort] || CUSTOMER_SORTS.name;

  let where = 'WHERE c.active = 1';
  const params = [];
  if (search && String(search).trim()) {
    where += ' AND (c.name LIKE ? OR c.phone LIKE ? OR c.address LIKE ?)';
    const term = `%${String(search).trim()}%`;
    params.push(term, term, term);
  }

  try {
    const rows = db.prepare(`
      SELECT
        c.id, c.name, c.phone, c.address, c.notes, c.created_at,
        COALESCE(credit_total.total, 0) - COALESCE(payment_total.total, 0) AS balance,
        COALESCE(litre_total.litres, 0) AS total_litres
      FROM customers c
      LEFT JOIN (
        SELECT customer_id, SUM(total) as total
        FROM orders
        WHERE payment_method = 'Credit' AND status = 'completed' AND customer_id IS NOT NULL
        GROUP BY customer_id
      ) credit_total ON credit_total.customer_id = c.id
      LEFT JOIN (
        SELECT customer_id, SUM(amount) as total
        FROM credit_payments
        GROUP BY customer_id
      ) payment_total ON payment_total.customer_id = c.id
      LEFT JOIN (
        -- Real milk litres, not order_items.quantity itself — see
        -- db/order-litres.js's docstring for why those differ once more than
        -- one milk pack size exists (a "2 Litre" pack is quantity 1).
        SELECT o.customer_id, SUM(oi.quantity * ri.quantity_required) as litres
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN recipes r ON r.menu_item_id = oi.menu_item_id
          AND (r.variant_id = oi.variant_id OR r.variant_id IS NULL)
        JOIN recipe_ingredients ri ON ri.recipe_id = r.id
        JOIN ingredients ing ON ing.id = ri.ingredient_id AND ing.name = 'Milk'
        WHERE o.payment_method = 'Credit' AND o.status = 'completed' AND o.customer_id IS NOT NULL
        GROUP BY o.customer_id
      ) litre_total ON litre_total.customer_id = c.id
      ${where}
      ORDER BY ${orderBy}
    `).all(...params);

    res.json(rows);
  } catch (err) {
    console.error('Customers fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customers — create
router.post('/', (req, res) => {
  const { name, phone, address, notes } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Customer name is required' });
  }

  try {
    // Explicit id under 10000 — see backend/routes/staff.js's identical
    // comment for why: the cloud allocates its own customer ids from 10000
    // up (see cloud/routes/customers.js).
    const nextId = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM customers WHERE id < 10000').get().id;
    const result = db.prepare(
      'INSERT INTO customers (id, name, phone, address, notes) VALUES (?, ?, ?, ?, ?)'
    ).run(
      nextId,
      String(name).trim(),
      (phone && String(phone).trim()) || null,
      (address && String(address).trim()) || null,
      (notes && String(notes).trim()) || null
    );
    syncUpsert('customers', getCustomerSummary(result.lastInsertRowid));
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) {
    console.error('Customer create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/customers/:id — profile + full credit ledger (orders + payments)
router.get('/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const creditOrders = db.prepare(
    `SELECT id, total, created_at, status, cashier_id, cashier_name FROM orders
     WHERE customer_id = ? AND payment_method = 'Credit'
     ORDER BY created_at DESC`
  ).all(req.params.id);

  const payments = db.prepare(
    `SELECT id, amount, note, received_by, created_at FROM credit_payments
     WHERE customer_id = ? ORDER BY created_at DESC`
  ).all(req.params.id);

  const completedOrders = creditOrders.filter(o => o.status === 'completed');
  const totalCredited = completedOrders.reduce((sum, o) => sum + o.total, 0);
  const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);

  // --- Litres + monthly breakdown ---
  // Real milk litres per order (see db/order-litres.js) — order_items.quantity
  // alone is not litres once packs of different sizes exist (a "2 Litre" pack
  // is quantity 1, not 2).
  let totalLitres = 0;
  const monthly = {}; // 'YYYY-MM' -> { litres, amount }

  if (completedOrders.length > 0) {
    const litresByOrder = getLitresByOrderIds(completedOrders.map(o => o.id));

    completedOrders.forEach(o => {
      const litres = litresByOrder[o.id] || 0;
      totalLitres += litres;
      const monthKey = String(o.created_at).slice(0, 7); // 'YYYY-MM'
      if (!monthly[monthKey]) monthly[monthKey] = { litres: 0, amount: 0 };
      monthly[monthKey].litres += litres;
      monthly[monthKey].amount += o.total;
    });
  }

  const monthlyBreakdown = Object.keys(monthly)
    .sort((a, b) => b.localeCompare(a))
    .map(month => ({ month, ...monthly[month] }));

  // Days since the oldest still-outstanding credit order — a simple ageing signal.
  const oldestUnpaid = completedOrders
    .slice()
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
  const daysOutstanding = oldestUnpaid && (totalCredited - totalPaid) > 0
    ? Math.floor((Date.now() - new Date(oldestUnpaid.created_at).getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  res.json({
    ...customer,
    balance: totalCredited - totalPaid,
    orders: creditOrders,
    payments,
    total_litres: totalLitres,
    total_credited: totalCredited,
    total_paid: totalPaid,
    days_outstanding: daysOutstanding,
    monthly_breakdown: monthlyBreakdown,
  });
});

// PUT /api/customers/:id — edit
router.put('/:id', (req, res) => {
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const { name, phone, address, notes } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Customer name is required' });
  }

  db.prepare(
    'UPDATE customers SET name = ?, phone = ?, address = ?, notes = ? WHERE id = ?'
  ).run(
    String(name).trim(),
    (phone && String(phone).trim()) || null,
    (address && String(address).trim()) || null,
    (notes && String(notes).trim()) || null,
    req.params.id
  );
  syncUpsert('customers', getCustomerSummary(req.params.id));
  res.json({ success: true });
});

// POST /api/customers/:id/payments — record money received against the balance
router.post('/:id/payments', (req, res) => {
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Payment amount must be greater than zero' });
  }

  // A payment can never exceed what the customer actually owes — otherwise
  // the derived balance (credit orders minus payments) goes negative, which
  // has no real meaning here and previously went unchecked.
  const creditTotal = db.prepare(
    `SELECT COALESCE(SUM(total), 0) as total FROM orders
     WHERE customer_id = ? AND payment_method = 'Credit' AND status = 'completed'`
  ).get(req.params.id).total;
  const paidTotal = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) as total FROM credit_payments WHERE customer_id = ?'
  ).get(req.params.id).total;
  const balance = creditTotal - paidTotal;

  if (amount > balance) {
    return res.status(400).json({
      error: balance > 0
        ? `Payment cannot exceed the outstanding balance of Rs. ${balance.toFixed(2)}`
        : 'This customer has no outstanding balance to pay off',
    });
  }

  // Same pattern as orders.js / expenses: attach to whichever shift is
  // currently open, so cash collected from a credit customer shows up in
  // that day's drawer total instead of vanishing into the ledger only.
  const openShift = db.prepare(
    "SELECT id FROM shifts WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1"
  ).get();

  const result = db.prepare(
    `INSERT INTO credit_payments (customer_id, amount, note, received_by, received_by_id, shift_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    req.params.id,
    amount,
    (req.body.note && String(req.body.note).trim()) || null,
    // Attribution from the session, same reasoning as void/order attribution
    // in orders.js — never trust the body for who did this.
    (req.user && req.user.name) || 'Unknown',
    (req.user && req.user.staffId) || null,
    openShift ? openShift.id : null
  );

  // The cloud has no credit_payments table of its own (see db/cloud-sync.js) —
  // a payment moves the customer's balance, so it's the customer's recomputed
  // standing that gets pushed, not the payment row itself.
  syncUpsert('customers', getCustomerSummary(req.params.id));
  res.status(201).json({ id: result.lastInsertRowid });
});

module.exports = router;
