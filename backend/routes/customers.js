const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { syncUpsert } = require('../db/cloud-sync');
const { getCustomerSummary } = require('../db/customer-summary');
const { getLitresByOrderIds } = require('../db/order-litres');
const { clean, toNumber } = require('../db/validate');

/**
 * Checks and normalises the fields a customer is created or edited with.
 * Returns { error } or { value }. A phone number, when given, has to look like
 * one (digits with optional + - spaces and brackets) and must not already
 * belong to another customer: a restore re-links every credit order to its
 * customer *by phone number*, so two customers sharing one would have their
 * ledgers merged into whichever came first.
 */
function checkCustomer(body, ignoreId) {
  const name = clean(body && body.name, 100);
  if (!name) return { error: 'Enter the customer\'s name.' };
  const phone = clean(body && body.phone, 25);
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (!/^[+()\-\s\d]+$/.test(phone) || digits.length < 7 || digits.length > 15) {
      return { error: 'That phone number does not look right. Use digits only, for example 0300 1234567.' };
    }
    const twin = db.prepare('SELECT id, name FROM customers WHERE phone = ? AND active = 1 AND id != ?').get(phone, ignoreId || 0);
    if (twin) return { error: `${twin.name} already has this phone number. Open that customer instead of adding a second one.` };
  }
  return {
    value: {
      name,
      phone: phone || null,
      address: clean(body && body.address, 200) || null,
      notes: clean(body && body.notes, 500) || null,
    },
  };
}

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
  const checked = checkCustomer(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const { name, phone, address, notes } = checked.value;

  try {
    // Explicit id under 10000 — see backend/routes/staff.js's identical
    // comment for why: the cloud allocates its own customer ids from 10000
    // up (see cloud/routes/customers.js).
    const nextId = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM customers WHERE id < 10000').get().id;
    const result = db.prepare(
      'INSERT INTO customers (id, name, phone, address, notes) VALUES (?, ?, ?, ?, ?)'
    ).run(nextId, name, phone, address, notes);
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

  const checked = checkCustomer(req.body, customer.id);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const { name, phone, address, notes } = checked.value;

  db.prepare(
    'UPDATE customers SET name = ?, phone = ?, address = ?, notes = ? WHERE id = ?'
  ).run(name, phone, address, notes, customer.id);
  syncUpsert('customers', getCustomerSummary(req.params.id));
  res.json({ success: true });
});

// POST /api/customers/:id/payments — record money received against the balance
router.post('/:id/payments', (req, res) => {
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const rawAmount = toNumber(req.body && req.body.amount);
  if (!(rawAmount > 0) || rawAmount > 1000000000) {
    return res.status(400).json({ error: 'Enter a payment amount greater than zero.' });
  }
  const amount = Math.round(rawAmount * 100) / 100;
  if (!(amount > 0)) {
    return res.status(400).json({ error: 'Enter a payment amount of at least one paisa (0.01).' });
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
  const balance = Math.round((creditTotal - paidTotal) * 100) / 100;

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
    clean(req.body && req.body.note, 300) || null,
    // Attribution from the session, same reasoning as void/order attribution
    // in orders.js — never trust the body for who did this.
    (req.user && req.user.name) || 'Unknown',
    (req.user && req.user.staffId) || null,
    openShift ? openShift.id : null
  );

  // Two pushes: the customer's recomputed standing (balance, litres, ...),
  // and the payment event itself — the cloud needs the individual row too,
  // not just the resulting total, so a shift's "collected from credit
  // customers" figure can be computed for that shift specifically rather
  // than only known as a lifetime total (see cloud/db/schema.js's
  // credit_payments table).
  syncUpsert('customers', getCustomerSummary(req.params.id));
  syncUpsert('credit_payments', db.prepare('SELECT * FROM credit_payments WHERE id = ?').get(result.lastInsertRowid));
  res.status(201).json({ id: result.lastInsertRowid });
});

module.exports = router;
