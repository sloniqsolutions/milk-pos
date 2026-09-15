const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { syncUpsert, syncUpsertMany } = require('../db/cloud-sync');
const { getCustomerSummary } = require('../db/customer-summary');
const { buildOrderSyncPayload } = require('../db/order-sync-payload');

// Create a new completed order
router.post('/', (req, res) => {
  const {
    items, total, discount, payment_method, cashier_id, cashier_name,
    order_type, delivery_charge, table_number,
    customer_name, customer_phone, customer_address, customer_id,
  } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'Order must have at least one item' });
  }

  // FIX (Bug 6): discount and payment_method were always sent as 0/'Cash'
  // from the UI. Now that the client sends real values, validate them here
  // so a bad payload can't write a negative or nonsensical order.
  const VALID_PAYMENTS = ['Cash', 'Card', 'Online', 'Credit'];
  const paymentMethod = VALID_PAYMENTS.includes(payment_method) ? payment_method : 'Cash';

  if (paymentMethod === 'Credit' && !customer_id) {
    return res.status(400).json({ error: 'Select a customer for a credit sale' });
  }

  const safeDiscount = Math.max(0, Number(discount) || 0);
  const safeDelivery = Math.max(0, Number(delivery_charge) || 0);

  // Recompute the total server-side rather than trusting the client.
  const itemsSubtotal = items.reduce(
    (sum, i) => sum + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0
  );
  /**
   * Staff discount.
   *
   * Like tax, the rate is read from settings rather than taken from the
   * request — the client says only *whether* this is a staff purchase, never
   * how much comes off. It is taken off the subtotal, and any manual discount
   * then applies to what is left, so the two together can never exceed the
   * order value.
   */
  const isEmployee = req.body.is_employee === true || req.body.is_employee === 1;
  const empRateRow = db.prepare("SELECT value FROM settings WHERE key = 'employee_discount_rate'").get();
  const employeeRate = Math.max(0, Math.min(100, Number(empRateRow && empRateRow.value) || 0));
  const employeeDiscount = isEmployee
    ? Math.round(itemsSubtotal * employeeRate) / 100
    : 0;

  const manualDiscount = Math.min(safeDiscount, Math.max(0, itemsSubtotal - employeeDiscount));

  // `discount` stays the combined figure so every existing report, export and
  // reconciliation (subtotal - discount + tax + delivery = total) is unchanged.
  const cappedDiscount = Math.min(employeeDiscount + manualDiscount, itemsSubtotal);

  // Tax rate comes from settings, never from the request: the client must not
  // be able to choose what tax a sale is charged. It is applied to the
  // discounted subtotal, and the delivery fee is added afterwards so the rider's
  // charge is neither discounted nor taxed.
  const taxRateRow = db.prepare("SELECT value FROM settings WHERE key = 'tax_rate'").get();
  const taxRate = Math.max(0, Number(taxRateRow && taxRateRow.value) || 0);
  const taxable = Math.max(0, itemsSubtotal - cappedDiscount);
  const taxAmount = Math.round(taxable * taxRate) / 100;

  const computedTotal = Math.max(0, taxable + taxAmount + safeDelivery);

  // Trust the server figure; log when the client disagreed.
  if (Number(total) !== computedTotal) {
    console.warn(`Order total mismatch — client sent ${total}, server computed ${computedTotal}. Using server value.`);
  }

  // 1. Shift requirement check
  const openShift = db.prepare(
    "SELECT id FROM shifts WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1"
  ).get();

  if (!openShift) {
    return res.status(400).json({
      error: 'No shift is currently open. You must open a shift before creating sales.'
    });
  }

  // 2. Strict Inventory stock verification: ensure there is enough stock before charging
  const getRecipe = db.prepare(
    'SELECT id FROM recipes WHERE menu_item_id = ? AND (variant_id = ? OR variant_id IS NULL)'
  );
  const getRecipeIngredients = db.prepare(
    'SELECT ingredient_id, quantity_required FROM recipe_ingredients WHERE recipe_id = ?'
  );
  const getIngredientStock = db.prepare(
    'SELECT id, name, unit, stock FROM ingredients WHERE id = ?'
  );

  const requiredStockMap = {}; // ingredient_id -> { needed, name, unit, stock }
  for (const item of items) {
    if (item.is_deal) continue;
    const recipeRow = getRecipe.get(item.id, item.variant_id || null);
    if (recipeRow) {
      const ingredients = getRecipeIngredients.all(recipeRow.id);
      for (const ing of ingredients) {
        const needed = Number(ing.quantity_required) * Number(item.quantity);
        if (!requiredStockMap[ing.ingredient_id]) {
          const ingData = getIngredientStock.get(ing.ingredient_id);
          requiredStockMap[ing.ingredient_id] = {
            needed: 0,
            name: ingData ? ingData.name : 'Ingredient',
            unit: ingData ? ingData.unit : 'unit',
            stock: ingData ? Number(ingData.stock) : 0,
          };
        }
        requiredStockMap[ing.ingredient_id].needed += needed;
      }
    }
  }

  for (const reqData of Object.values(requiredStockMap)) {
    if (reqData.stock < reqData.needed) {
      return res.status(400).json({
        error: `Insufficient stock for "${reqData.name}". Available: ${reqData.stock} ${reqData.unit}, Required: ${reqData.needed} ${reqData.unit}`
      });
    }
  }

  // Insert order in a transaction so it is atomic
  const createOrder = db.transaction(() => {
    const orderResult = db.prepare(
      `INSERT INTO orders
         (total, discount, payment_method, status, cashier_id, cashier_name,
          order_type, delivery_charge, table_number, shift_id, created_at,
          tax_rate, tax_amount, is_employee, employee_discount, employee_discount_rate,
          customer_name, customer_phone, customer_address, customer_id)
       VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'), ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      computedTotal,
      cappedDiscount,
      paymentMethod,
      (req.user && req.user.staffId) || cashier_id || null,
      (req.user && req.user.name) || cashier_name || 'Unknown',
      order_type || 'Walk-in',
      safeDelivery,
      table_number || null,
      openShift.id,
      taxRate,
      taxAmount,
      isEmployee ? 1 : 0,
      employeeDiscount,
      isEmployee ? employeeRate : 0,
      (customer_name && String(customer_name).trim()) || null,
      (customer_phone && String(customer_phone).trim()) || null,
      (customer_address && String(customer_address).trim()) || null,
      customer_id || null
    );

    const orderId = orderResult.lastInsertRowid;

    const insertItem = db.prepare(
      'INSERT INTO order_items (order_id, menu_item_id, name, price, quantity, is_deal, variant_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    const deductStock = db.prepare(
      'UPDATE ingredients SET stock = MAX(0, stock - ?) WHERE id = ?'
    );

    items.forEach(item => {
      insertItem.run(orderId, item.id, item.name, item.price, item.quantity, item.is_deal ? 1 : 0, item.variant_id || null);

      if (item.is_deal) return;

      const recipeRow = getRecipe.get(item.id, item.variant_id || null);
      if (recipeRow) {
        const ingredients = getRecipeIngredients.all(recipeRow.id);
        ingredients.forEach(ing => {
          const totalQty = ing.quantity_required * item.quantity;
          deductStock.run(totalQty, ing.ingredient_id);
        });
      }
    });

    return orderId;
  });

  try {
    const orderId = createOrder();

    // Cloud sync: the order with its line items, whichever ingredients this
    // sale touched, and — for a credit sale — the customer's new balance.
    // Fire-and-forget — see db/cloud-sync.js.
    syncUpsert('orders', buildOrderSyncPayload(orderId));
    const touchedIngredientIds = Object.keys(requiredStockMap).map(Number);
    if (touchedIngredientIds.length > 0) {
      const placeholders = touchedIngredientIds.map(() => '?').join(',');
      syncUpsertMany(
        'ingredients',
        db.prepare(`SELECT * FROM ingredients WHERE id IN (${placeholders})`).all(...touchedIngredientIds)
      );
    }
    if (paymentMethod === 'Credit' && customer_id) {
      syncUpsert('customers', getCustomerSummary(customer_id));
    }

    res.status(201).json({
      success: true,
      id: orderId,
      total: computedTotal,
      discount: cappedDiscount,
      // Returned so the receipt prints the figures the server actually stored
      // rather than the client's own arithmetic.
      subtotal: itemsSubtotal,
      tax_rate: taxRate,
      tax_amount: taxAmount,
      delivery_charge: safeDelivery,
      is_employee: isEmployee ? 1 : 0,
      employee_discount: employeeDiscount,
      employee_discount_rate: employeeRate,
      manual_discount: manualDiscount,
      customer_name: (customer_name && String(customer_name).trim()) || null,
      customer_phone: (customer_phone && String(customer_phone).trim()) || null,
      customer_address: (customer_address && String(customer_address).trim()) || null,
    });
  } catch (err) {
    console.error('Error creating order:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all orders (for Orders screen)
router.get('/', (req, res) => {
  const { from, to, status, payment_method } = req.query;
  
  let conditions = [];
  let params = [];

  if (from && to) {
    conditions.push(`DATE(o.created_at) BETWEEN DATE(?) AND DATE(?)`);
    params.push(from, to);
  } else if (from) {
    conditions.push(`DATE(o.created_at) >= DATE(?)`);
    params.push(from);
  } else if (to) {
    conditions.push(`DATE(o.created_at) <= DATE(?)`);
    params.push(to);
  }

  if (status && status !== 'all' && status !== 'All') {
    conditions.push(`LOWER(o.status) = LOWER(?)`);
    params.push(status);
  }

  if (payment_method && payment_method !== 'all' && payment_method !== 'All') {
    conditions.push(`LOWER(o.payment_method) = LOWER(?)`);
    params.push(payment_method);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const orders = db.prepare(
      `SELECT o.* FROM orders o ${whereClause} ORDER BY o.created_at DESC` 
    ).all(...params);

    if (orders.length === 0) return res.json([]);

    const orderIds = orders.map(o => o.id);
    const placeholders = orderIds.map(() => '?').join(',');
    const allItems = db.prepare(
      `SELECT * FROM order_items WHERE order_id IN (${placeholders})` 
    ).all(...orderIds);

    const formatted = orders.map(o => ({
      ...o,
      items: allItems.filter(i => i.order_id === o.id)
    }));

    res.json(formatted);
  } catch (err) {
    console.error('Orders fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get single order with its items
router.get('/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id);
  res.json({ ...order, items });
});

/**
 * Void an order.
 *
 * This used to run `SET status = 'voided', total = 0, discount = 0`, which
 * destroyed the evidence: once voided, nothing recorded what the order had
 * been worth, so a void could never be audited and a manager could not see
 * how much was being written off or by whom. Every report already filters on
 * `status != 'voided'`, so zeroing the figures bought nothing.
 *
 * The amounts are now preserved and only the status changes. Stock consumed
 * by the sale is returned to inventory, which the previous version never did —
 * voiding a mis-rung order silently lost its ingredients.
 */
const voidOrder = (req, res) => {
  try {
    const order = db.prepare('SELECT id, status, payment_method, customer_id FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status === 'voided') {
      // Without this guard a second void would restock the ingredients again.
      return res.status(409).json({ error: 'Order is already voided' });
    }

    const doVoid = db.transaction(() => {
      const items = db.prepare(
        'SELECT menu_item_id, quantity, is_deal, variant_id FROM order_items WHERE order_id = ?'
      ).all(order.id);

      // Same lookup the sale used, so the restore mirrors the deduction
      // exactly — including variant-specific recipes.
      const getRecipe = db.prepare(
        'SELECT id FROM recipes WHERE menu_item_id = ? AND (variant_id = ? OR variant_id IS NULL)'
      );
      const getRecipeIngredients = db.prepare(
        'SELECT ingredient_id, quantity_required FROM recipe_ingredients WHERE recipe_id = ?'
      );
      const restoreStock = db.prepare(
        'UPDATE ingredients SET stock = stock + ? WHERE id = ?'
      );

      const touchedIngredientIds = new Set();
      items.forEach(item => {
        // Deals never deducted stock on the way in, so they must not add it back.
        if (item.is_deal) return;
        const recipeRow = getRecipe.get(item.menu_item_id, item.variant_id || null);
        if (!recipeRow) return;
        getRecipeIngredients.all(recipeRow.id).forEach(ing => {
          restoreStock.run(ing.quantity_required * item.quantity, ing.ingredient_id);
          touchedIngredientIds.add(ing.ingredient_id);
        });
      });

      // Record who voided it. The name comes from the session, not the
      // request body, so it cannot be spoofed by the caller.
      db.prepare(
        `UPDATE orders
            SET status = 'voided',
                voided_at = datetime('now', 'localtime'),
                voided_by = ?,
                voided_by_id = ?
          WHERE id = ?`
      ).run(
        (req.user && req.user.name) || 'Unknown',
        (req.user && req.user.staffId) || null,
        order.id
      );

      return touchedIngredientIds;
    });

    const touchedIngredientIds = doVoid();

    // Cloud sync: the order's status changed, whichever ingredients were
    // restocked did too, and — for a voided credit sale — the balance it had
    // added is now excluded from the customer's total.
    syncUpsert('orders', buildOrderSyncPayload(order.id));
    if (touchedIngredientIds.size > 0) {
      const ids = Array.from(touchedIngredientIds);
      const placeholders = ids.map(() => '?').join(',');
      syncUpsertMany(
        'ingredients',
        db.prepare(`SELECT * FROM ingredients WHERE id IN (${placeholders})`).all(...ids)
      );
    }
    if (order.payment_method === 'Credit' && order.customer_id) {
      syncUpsert('customers', getCustomerSummary(order.customer_id));
    }

    res.json({ success: true, id: order.id, status: 'voided' });
  } catch (err) {
    console.error('Error voiding order:', err);
    res.status(500).json({ error: err.message });
  }
};

router.put('/:id/void', voidOrder);
router.patch('/:id/void', voidOrder);

module.exports = router;
