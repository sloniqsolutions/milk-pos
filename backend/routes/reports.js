const express = require('express');
const router = express.Router();
const db = require('../db/database');

const { isAdminRole } = require('../middleware/auth');
const { isRealDay, localDay } = require('../db/validate');
const { unitAmount } = require('../db/item-quantities');
const { buildStatement, MOVEMENT_SUMS } = require('../db/stock-statement');
const { RESTORED_NOTE_LIKE } = require('../db/person-key');
const { createClassifier } = require('../db/line-classifier');

// One definition of Milk / Dahi / Other for every report — see db/line-classifier.js.
const { classifyLine, splitOrderLines } = createClassifier(unitAmount);

/**
 * Money, to the paisa. Without this, summing REAL columns leaves the kind of
 * dust (6433.6900000000005) that SQLite and Postgres round off at slightly
 * different points in the same SUM — so the same sales showed a different
 * total revenue on the till than on the dashboard for the exact same range.
 * Every money figure this file returns is rounded once, here, on the way out.
 */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Every report takes an optional from/to. An unreadable one (a typo, a
 * half-typed custom range, a hand-built URL) used to reach date arithmetic and
 * come back as a 500 reading "Invalid time value". It is answered here, once,
 * for every report below, in words the person at the till can act on.
 */
router.use((req, res, next) => {
  const { from, to } = req.query;
  for (const [label, value] of [['start', from], ['end', to]]) {
    if (value !== undefined && value !== '' && !isRealDay(String(value))) {
      return res.status(400).json({ error: `The ${label} date isn't a valid date. Choose it from the calendar (YYYY-MM-DD).` });
    }
  }
  if (from && to && String(from) > String(to)) {
    return res.status(400).json({ error: 'The start date is after the end date. Swap them and try again.' });
  }
  next();
});

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
  // The shop's own calendar day, not UTC's: between midnight and 5am local time
  // UTC is still "yesterday", and the default range opened on the wrong day.
  const today = localDay();
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
        -- Not the stand-in a restore writes to make a balance come out right:
        -- it stands for payments taken elsewhere on earlier days, and counting
        -- it here booked a customer's whole history as collected on install day.
        AND COALESCE(note, '') NOT LIKE '${RESTORED_NOTE_LIKE}'
    `).get(from, to, ...cScope.params);

    // What customers are known to have paid but with no date to put it on: the restore's stand-in for
    // history from before payments were kept one by one. It belongs to no day, so no date filter counts
    // it — this is shown beside the card so a customer's lifetime "paid" is not a mystery next to it.
    // Only for an administrator: a manager's card is scoped to what they took themselves.
    const creditUndated = cScope.sql ? 0 : db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS v FROM credit_payments WHERE COALESCE(note, '') LIKE '${RESTORED_NOTE_LIKE}'
    `).get().v;

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
          ON ie.ingredient_id = i.id AND ie.superseded_by IS NULL AND DATE(ie.entry_date) BETWEEN DATE(?) AND DATE(?)
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
      total_revenue: round2(summary.total_revenue),
      avg_order_value: round2(summary.avg_order_value),
      total_discounts: round2(summary.total_discounts),
      revenue_trend: revenueTrend,
      orders_trend: ordersTrend,
      credit_collected: round2(creditCollected.credit_collected),
      credit_undated: round2(creditUndated),
      ingredient_usage: ingredientUsage,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Stock movement, by day and ingredient — the Reports screen's "Summary" tab
 * table, read off the same inventory_entries rows as the kpi route's
 * ingredient_usage card. Built by db/stock-statement.js (kept identical to the
 * cloud's copy): Opening is the sum of every entry before the range, Closing
 * the sum through the day, so each row adds up by itself.
 */
router.get('/stock-movement', (req, res) => {
  const { from, to } = getDateRange(req);
  try {
    const dayRows = db.prepare(`
      SELECT ie.entry_date AS date, i.id AS ingredient_id, i.name, i.unit,
             ${MOVEMENT_SUMS}
        FROM inventory_entries ie
        JOIN ingredients i ON i.id = ie.ingredient_id
       WHERE ie.superseded_by IS NULL AND DATE(ie.entry_date) BETWEEN DATE(?) AND DATE(?)
       GROUP BY ie.entry_date, i.id, i.name, i.unit
    `).all(from, to);
    const openings = {};
    db.prepare(`
      SELECT ingredient_id, SUM(amount) AS opening
        FROM inventory_entries
       WHERE superseded_by IS NULL AND DATE(entry_date) < DATE(?)
       GROUP BY ingredient_id
    `).all(from).forEach((r) => { openings[r.ingredient_id] = Number(r.opening) || 0; });
    const daysInRange = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
    res.json(buildStatement(dayRows, openings, daysInRange));
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
    res.json(data.map((r) => ({ ...r, revenue: round2(r.revenue) })));
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
      total_revenue: round2(i.total_revenue),
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
      total_revenue: round2(i.total_revenue),
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
    res.json(data.map((r) => ({ ...r, revenue: round2(r.revenue) })));
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
    res.json(data.map((r) => ({ ...r, total_revenue: round2(r.total_revenue), avg_order_value: round2(r.avg_order_value), total_discounts: round2(r.total_discounts) })));
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
        ROUND(COALESCE(SUM(oi.quantity), 0), 4)  AS total_qty,
        COUNT(oi.id)                             AS line_count,
        -- printf('%.10g', ...) rather than plain concatenation: SQLite renders a
        -- REAL quantity of 1 as "1.0", where Postgres's STRING_AGG (cloud's own
        -- copy of this query) renders the same DOUBLE PRECISION value as "1" —
        -- so an order's item summary read differently on the till than on the
        -- dashboard for the exact same sale. %.10g is plenty of precision for
        -- any real litre/kg quantity and matches Postgres's own formatting.
        GROUP_CONCAT(oi.name || ' x' || printf('%.10g', oi.quantity), ', ') AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE DATE(o.created_at) BETWEEN DATE(?) AND DATE(?)
        ${includeVoided ? '' : "AND o.status != 'voided'"}${scope.sql}
      GROUP BY o.id
      ORDER BY o.created_at ASC
    `).all(from, to, ...scope.params);

    // Every order's lines split into Milk / Dahi / Other by the ONE classifier
    // (db/line-classifier.js) — the same one Item Sales uses, so the two views
    // cannot disagree. Real litres of Milk and kilograms of Dahi per order come
    // from the same place (see db/item-quantities.js).
    const lines = db.prepare(`
      SELECT oi.order_id AS key, m.category AS category, oi.is_deal AS is_deal,
             oi.name AS name, oi.quantity AS quantity, oi.price AS price
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        LEFT JOIN menu_items m ON m.id = oi.menu_item_id AND oi.is_deal = 0
       WHERE DATE(o.created_at) BETWEEN DATE(?) AND DATE(?)
         ${includeVoided ? '' : "AND o.status != 'voided'"}${scope.sql}
    `).all(from, to, ...scope.params);
    const split = splitOrderLines(lines);
    const none = {
      milk_value: 0, milk_lines: 0, milk_items: null, milk_qty: 0,
      dahi_value: 0, dahi_lines: 0, dahi_items: null, dahi_qty: 0,
      other_value: 0, other_lines: 0,
    };

    // GROUP_CONCAT returns NULL for an order with no line items.
    res.json(orders.map(o => ({
      ...o,
      subtotal: round2(o.subtotal),
      items: o.items || '',
      ...(split.get(o.id) || none),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Line-item report — one row per item sold, rather than per order.
 *
 * This is what makes an item-level CSV possible: which dish sold, when, at
 * what unit price, on whose till. `category` is the menu's own label: 'Deals' for a
 * deal, 'Removed Item' when the item was deleted from the menu after the sale. The
 * Milk / Dahi / Other split (`category_group`) is db/line-classifier.js's.
 */
router.get('/line-items', (req, res) => {
  const { from, to } = getDateRange(req);
  const includeVoided = req.query.include_voided === '1' || req.query.include_voided === 'true';
  const scope = userScope(req, 'o');

  try {
    const rows = db.prepare(`
      SELECT
        o.id            AS order_id,
        -- What identifies the order across tills: the same as order_id here, but
        -- not on the cloud, where two tills can each have an "order 7".
        o.id            AS order_key,
        o.created_at,
        o.cashier_name,
        o.order_type,
        o.table_number,
        o.payment_method,
        o.status,
        oi.name         AS item_name,
        oi.is_deal      AS is_deal,
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

    // The product each line is, and its real amount (litres / kg) — see
    // db/line-classifier.js. `category` above stays the menu's own label.
    const round4 = (n) => Math.round((n || 0) * 10000) / 10000;
    res.json(rows.map((r) => {
      const c = classifyLine({ category: r.category, is_deal: r.is_deal, name: r.item_name, quantity: r.quantity });
      return {
        ...r,
        is_deal: Number(r.is_deal) === 1 ? 1 : 0,
        category_group: c.group,
        amount: round4(c.amount),
        category_inferred: c.inferred,
        category_review: c.review,
        amount_assumed: c.amount_assumed,
      };
    }));
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
    res.json(data.map((r) => ({ ...r, total_revenue: round2(r.total_revenue), total_discounts: round2(r.total_discounts), avg_order_value: round2(r.avg_order_value) })));
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

    const revenue = round2(revRow.revenue || 0);
    const expenses = round2(expRow.expenses || 0);
    const net = round2(revenue - expenses);

    res.json({ revenue, expenses, net });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
