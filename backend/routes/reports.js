const express = require('express');
const router = express.Router();
const db = require('../db/database');

const { isAdminRole } = require('../middleware/auth');

/**
 * Restrict a manager to their own takings.
 *
 * An administrator sees the whole shop. A manager sees only the sales they
 * rang up themselves, so with a manager per branch neither can read the
 * other's figures — or the shop's combined total — from the reports screen.
 *
 * The filter is applied here, from the session, rather than taken from a query
 * parameter: the client cannot ask to see somebody else's numbers.
 *
 * `alias` is the table reference used by the calling query — most say
 * `FROM orders`, the joined ones alias it to `o`.
 */
function userScope(req, alias = 'orders') {
  if (!req.user || isAdminRole(req.user.role)) return { sql: '', params: [] };
  return { sql: ` AND ${alias}.cashier_id = ?`, params: [req.user.staffId] };
}

/**
 * Same idea as userScope but for credit_payments, which attributes to
 * received_by_id rather than cashier_id — a manager should only see the
 * credit payments they personally collected, not the whole shop's.
 */
function creditScope(req) {
  if (!req.user || isAdminRole(req.user.role)) return { sql: '', params: [] };
  return { sql: ' AND received_by_id = ?', params: [req.user.staffId] };
}

function getDateRange(req) {
  const today = new Date().toISOString().split('T')[0];
  const from = req.query.from || today;
  const to = req.query.to || today;
  return { from, to };
}

// KPI summary
router.get('/kpi', (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = userScope(req);
  const cScope = creditScope(req);
  try {
    const summary = db.prepare(`
      SELECT
        COUNT(*) as total_orders,
        COALESCE(SUM(total), 0) as total_revenue,
        COALESCE(AVG(total), 0) as avg_order_value,
        COALESCE(SUM(discount), 0) as total_discounts
      FROM orders
      WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)
      AND status != 'voided'${scope.sql}
    `).get(from, to, ...scope.params);

    // Credit money actually collected in this date range — separate from
    // total_revenue, which already books a credit sale as revenue the
    // moment it's rung up. This is "cash that came in from old debt today".
    const creditCollected = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as credit_collected
      FROM credit_payments
      WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)${cScope.sql}
    `).get(from, to, ...cScope.params);

    const prevFrom = new Date(from);
    prevFrom.setDate(prevFrom.getDate() - (new Date(to) - new Date(from)) / 86400000 - 1);
    const prevTo = new Date(from);
    prevTo.setDate(prevTo.getDate() - 1);

    const prev = db.prepare(`
      SELECT COALESCE(SUM(total), 0) as total_revenue, COUNT(*) as total_orders
      FROM orders
      WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)
      AND status != 'voided'${scope.sql}
    `).get(prevFrom.toISOString().split('T')[0], prevTo.toISOString().split('T')[0], ...scope.params);

    // How much of each ingredient this date range actually consumed, and
    // what's left right now. `used` reads off inventory_entries' own 'sale'
    // rows (see routes/orders.js) rather than re-deriving it from recipes —
    // same figure, but one that a manager can see without a per-cashier
    // ingredient scope existing to filter it (there isn't one; stock isn't a
    // per-cashier concept the way revenue is).
    const ingredientUsage = db.prepare(`
      SELECT i.id, i.name, i.unit, i.stock AS current_stock,
             COALESCE(-SUM(CASE WHEN ie.type = 'sale' THEN ie.amount ELSE 0 END), 0) AS used
        FROM ingredients i
        LEFT JOIN inventory_entries ie
          ON ie.ingredient_id = i.id AND DATE(ie.entry_date) BETWEEN DATE(?) AND DATE(?)
       GROUP BY i.id, i.name, i.unit, i.stock
       ORDER BY i.name
    `).all(from, to);

    const revenueTrend = prev.total_revenue > 0
      ? (((summary.total_revenue - prev.total_revenue) / prev.total_revenue) * 100).toFixed(1)
      : 0;
    const ordersTrend = prev.total_orders > 0
      ? (((summary.total_orders - prev.total_orders) / prev.total_orders) * 100).toFixed(1)
      : 0;

    res.json({
      ...summary,
      revenue_trend: revenueTrend,
      orders_trend: ordersTrend,
      credit_collected: creditCollected.credit_collected,
      ingredient_usage: ingredientUsage,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Revenue over time
router.get('/revenue-over-time', (req, res) => {
  const { from, to } = getDateRange(req);
  const groupBy = req.query.groupBy || 'day';
  const scope = userScope(req);
  try {
    let query;
    if (groupBy === 'hour') {
      query = `
        SELECT strftime('%H:00', created_at) as period,
               COALESCE(SUM(total), 0) as revenue,
               COUNT(*) as orders
        FROM orders
        WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)
        AND status != 'voided'${scope.sql}
        GROUP BY strftime('%H', created_at)
        ORDER BY strftime('%H', created_at)
      `;
    } else if (groupBy === 'month') {
      query = `
        SELECT strftime('%Y-%m', created_at) as period,
               COALESCE(SUM(total), 0) as revenue,
               COUNT(*) as orders
        FROM orders
        WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)
        AND status != 'voided'${scope.sql}
        GROUP BY strftime('%Y-%m', created_at)
        ORDER BY period
      `;
    } else {
      query = `
        SELECT DATE(created_at) as period,
               COALESCE(SUM(total), 0) as revenue,
               COUNT(*) as orders
        FROM orders
        WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)
        AND status != 'voided'${scope.sql}
        GROUP BY DATE(created_at)
        ORDER BY DATE(created_at)
      `;
    }
    const data = db.prepare(query).all(from, to, ...scope.params);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Top selling items
router.get('/top-items', (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = userScope(req, 'o');
  try {
    const items = db.prepare(`
      SELECT
        oi.name,
        SUM(oi.quantity) as total_qty,
        SUM(oi.price * oi.quantity) as total_revenue,
        COUNT(DISTINCT oi.order_id) as order_count
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE DATE(o.created_at) BETWEEN DATE(?) AND DATE(?)
      AND o.status != 'voided'${scope.sql}
      GROUP BY oi.name
      ORDER BY total_qty DESC
      LIMIT 10
    `).all(from, to, ...scope.params);

    const totalRevenue = items.reduce((s, i) => s + i.total_revenue, 0);
    const result = items.map(i => ({
      ...i,
      percentage: totalRevenue > 0 ? ((i.total_revenue / totalRevenue) * 100).toFixed(1) : 0
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sales by category
router.get('/by-category', (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = userScope(req, 'o');
  try {
    // A deal records the *deal's* id in order_items.menu_item_id, which shares
    // an id space with menu_items. A plain JOIN therefore matched a deal to an
    // unrelated menu item and filed its revenue under that item's category.
    // Deals are now grouped under their own bucket, and the join is a LEFT
    // JOIN so an item deleted from the menu after the sale still appears
    // rather than dropping out of the report entirely.
    const data = db.prepare(`
      SELECT
        CASE
          WHEN oi.is_deal = 1 THEN 'Deals'
          ELSE COALESCE(m.category, 'Uncategorized')
        END AS category,
        SUM(oi.quantity) as total_qty,
        SUM(oi.price * oi.quantity) as total_revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN menu_items m ON oi.menu_item_id = m.id AND oi.is_deal = 0
      WHERE DATE(o.created_at) BETWEEN DATE(?) AND DATE(?)
      AND o.status != 'voided'${scope.sql}
      GROUP BY category
      ORDER BY total_revenue DESC
    `).all(from, to, ...scope.params);

    const totalRevenue = data.reduce((s, i) => s + i.total_revenue, 0);
    const result = data.map(i => ({
      ...i,
      percentage: totalRevenue > 0 ? ((i.total_revenue / totalRevenue) * 100).toFixed(1) : 0
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Hourly heatmap — last 7 days by default
router.get('/hourly-heatmap', (req, res) => {
  const scope = userScope(req);
  try {
    const data = db.prepare(`
      SELECT
        CASE strftime('%w', created_at)
          WHEN '0' THEN 'Sun'
          WHEN '1' THEN 'Mon'
          WHEN '2' THEN 'Tue'
          WHEN '3' THEN 'Wed'
          WHEN '4' THEN 'Thu'
          WHEN '5' THEN 'Fri'
          WHEN '6' THEN 'Sat'
        END as day,
        strftime('%w', created_at) as day_num,
        CAST(strftime('%H', created_at) AS INTEGER) as hour,
        COUNT(*) as orders,
        COALESCE(SUM(total), 0) as revenue
      FROM orders
      WHERE DATE(created_at) >= DATE('now', '-30 days')
      AND status != 'voided'${scope.sql}
      GROUP BY day_num, hour
      ORDER BY day_num, hour
    `).all(...scope.params);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cashier performance
router.get('/cashier-performance', (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = userScope(req, 'o');
  try {
    const data = db.prepare(`
      SELECT
        o.cashier_id,
        o.cashier_name,
        COUNT(*) as total_orders,
        COALESCE(SUM(o.total), 0) as total_revenue,
        COALESCE(AVG(o.total), 0) as avg_order_value,
        COALESCE(SUM(o.discount), 0) as total_discounts
      FROM orders o
      WHERE DATE(o.created_at) BETWEEN DATE(?) AND DATE(?)
      AND o.status != 'voided'${scope.sql}
      GROUP BY o.cashier_id, o.cashier_name
      ORDER BY total_revenue DESC
    `).all(from, to, ...scope.params);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Detailed report — one row per order. Backs the Reports table and the
 * "Detailed" CSV export.
 *
 * Previously this returned `o.*` plus `items_summary`, but both the table and
 * the exporter read `row.subtotal` and `row.items`. Neither existed:
 * `subtotal` is not a column on `orders` (only total/discount/delivery_charge
 * are), and the concatenated item list was named `items_summary`. The result
 * was `undefined.toLocaleString()` — a hard render crash on the Detailed tab —
 * and `undefined.replace()` in the exporter, so the CSV never downloaded.
 *
 * `subtotal` is now derived from the order's own line items, which is the
 * authoritative figure: total = subtotal - discount + delivery_charge.
 *
 * Voided orders are excluded by default so these rows reconcile with the KPI
 * cards and every other report; pass include_voided=1 to audit them.
 */
router.get('/detailed', (req, res) => {
  const { from, to } = getDateRange(req);
  const includeVoided = req.query.include_voided === '1' || req.query.include_voided === 'true';
  const scope = userScope(req, 'o');

  try {
    const orders = db.prepare(`
      SELECT
        o.id,
        o.created_at,
        o.cashier_id,
        o.cashier_name,
        o.order_type,
        o.table_number,
        o.payment_method,
        o.status,
        o.discount,
        o.tax_rate,
        o.tax_amount,
        o.is_employee,
        o.employee_discount,
        o.employee_discount_rate,
        o.voided_by,
        o.customer_name,
        o.customer_phone,
        o.customer_address,
        o.delivery_charge,
        o.total,
        COALESCE(SUM(oi.price * oi.quantity), 0) AS subtotal,
        COALESCE(SUM(oi.quantity), 0)            AS total_qty,
        COUNT(oi.id)                             AS line_count,
        GROUP_CONCAT(oi.name || ' x' || oi.quantity, ', ') AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE DATE(o.created_at) BETWEEN DATE(?) AND DATE(?)
        ${includeVoided ? '' : "AND o.status != 'voided'"}${scope.sql}
      GROUP BY o.id
      ORDER BY o.created_at ASC
    `).all(from, to, ...scope.params);

    // GROUP_CONCAT returns NULL for an order with no line items.
    res.json(orders.map(o => ({ ...o, items: o.items || '' })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Line-item report — one row per item sold, rather than per order.
 *
 * This is what makes an item-level CSV possible: which dish sold, when, at
 * what unit price, on whose till. Category is resolved through menu_items and
 * falls back to 'Deal / Removed Item' when the id does not resolve, which is
 * the case for deals (they record the deal's id, not a menu item's) and for
 * items deleted from the menu after the sale.
 */
router.get('/line-items', (req, res) => {
  const { from, to } = getDateRange(req);
  const includeVoided = req.query.include_voided === '1' || req.query.include_voided === 'true';
  const scope = userScope(req, 'o');

  try {
    const rows = db.prepare(`
      SELECT
        o.id            AS order_id,
        o.created_at,
        o.cashier_name,
        o.order_type,
        o.table_number,
        o.payment_method,
        o.status,
        oi.name         AS item_name,
        CASE
          WHEN oi.is_deal = 1 THEN 'Deals'
          ELSE COALESCE(m.category, 'Removed Item')
        END AS category,
        oi.quantity,
        oi.price        AS unit_price,
        (oi.price * oi.quantity) AS line_total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN menu_items m ON oi.menu_item_id = m.id AND oi.is_deal = 0
      WHERE DATE(o.created_at) BETWEEN DATE(?) AND DATE(?)
        ${includeVoided ? '' : "AND o.status != 'voided'"}${scope.sql}
      ORDER BY o.created_at ASC, oi.id ASC
    `).all(from, to, ...scope.params);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Daily summary
router.get('/daily', (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = userScope(req);
  try {
    const data = db.prepare(`
      SELECT
        DATE(created_at) as date,
        COUNT(*) as total_orders,
        COALESCE(SUM(total), 0) as total_revenue,
        COALESCE(SUM(discount), 0) as total_discounts,
        COALESCE(AVG(total), 0) as avg_order_value
      FROM orders
      WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)
      AND status != 'voided'${scope.sql}
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `).all(from, to, ...scope.params);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Net revenue (revenue minus expenses)
router.get('/net', (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = userScope(req);
  try {
    const revRow = db.prepare(`
      SELECT COALESCE(SUM(total), 0) as revenue
      FROM orders
      WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)
      AND status != 'voided'${scope.sql}
    `).get(from, to, ...scope.params);

    const expRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as expenses
      FROM expenses
      WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)
    `).get(from, to);

    const revenue = revRow.revenue || 0;
    const expenses = expRow.expenses || 0;
    const net = revenue - expenses;

    res.json({ revenue, expenses, net });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
