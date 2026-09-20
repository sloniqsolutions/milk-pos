/**
 * Reporting — the cloud's copy.
 *
 * Ported from `backend/routes/reports.js`. It is kept as textually close to the
 * till's copy as the dialect allows, because when the till's reporting changes
 * this has to change with it, and a readable diff is what makes that possible.
 *
 * **This is a Postgres translation, not a copy.** The earlier SQLite cloud let
 * the file across untouched; Supabase does not. Every difference below is a
 * place where a mistake would produce a query that still runs and quietly
 * returns a different number — which is why the port is guarded by a test that
 * compares all ten endpoints against the till's output field by field, rather
 * than by reading.
 *
 * What had to change, beyond `?` placeholders (handled mechanically by `toPg`
 * in db/pg.js):
 *
 *   - `DATE(x)` -> `x::date`. Timestamps are stored as the till's own local
 *     wall-clock text, so casting compares exactly what the shop recorded.
 *   - `strftime(...)` -> `to_char(...)` / `EXTRACT(...)`. No equivalent exists.
 *   - `GROUP_CONCAT` -> `STRING_AGG`.
 *   - **Every aggregate is cast.** `pg` returns `bigint` and `numeric` as
 *     strings to avoid precision loss, so an uncast `COUNT(*)` arrives as "32"
 *     and reaches the dashboard as a string.
 *   - **Dates are formatted, not cast, in SELECT lists.** `x::date` returns a
 *     JS Date that JSON-encodes as a full ISO timestamp, so an evening sale on
 *     the 7th would come back as the 6th.
 *   - Postgres requires SELECT and GROUP BY to agree; SQLite did not.
 *
 * And three differences from the till that are about role rather than dialect,
 * each marked CLOUD: below — scoping, the stored `order_items.category`, and
 * reporting the till's own `local_id` as the order number.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/pg');

const { localToday } = require('../db/local-date');
const { unloggedSold, unitAmount } = require('../db/derived-usage');
const { requireUser } = require('../middleware/session');

/**
 * CLOUD: narrow a report to one branch.
 *
 * The till's copy also scopes a manager to their own sales. Here the reader is
 * the owner, who sees the whole shop and may narrow with `?branch=<id>`.
 *
 * A dashboard account carrying a `branch_id` — none today, but the column
 * exists so per-branch logins are a row rather than a migration — is pinned to
 * that branch and cannot widen the view by passing a different one.
 */
function scopeOrders(req, alias = 'orders') {
  const pinned = req.user && req.user.branchId;
  const branch = pinned || Number(req.query.branch) || null;
  if (!branch) return { sql: '', params: [] };
  return { sql: ` AND ${alias}.branch_id = ?`, params: [branch] };
}

/** CLOUD: the same, for expenses. */
function scopeExpenses(req, alias = 'expenses') {
  const pinned = req.user && req.user.branchId;
  const branch = pinned || Number(req.query.branch) || null;
  if (!branch) return { sql: '', params: [] };
  return { sql: ` AND ${alias}.branch_id = ?`, params: [branch] };
}

/** CLOUD: the same, for credit_payments. No till-side per-cashier
 * equivalent here (that's userScope/creditScope, till-only) — a dashboard
 * account sees the whole branch's credit collections, same as it sees the
 * whole branch's orders and expenses. */
function scopeCreditPayments(req, alias = 'credit_payments') {
  const pinned = req.user && req.user.branchId;
  const branch = pinned || Number(req.query.branch) || null;
  if (!branch) return { sql: '', params: [] };
  return { sql: ` AND ${alias}.branch_id = ?`, params: [branch] };
}

function getDateRange(req) {
  // Local wall-clock, not toISOString's UTC — at UTC+5 that named yesterday
  // for the first five hours of every trading day.
  const today = localToday();
  const from = req.query.from || today;
  const to = req.query.to || today;
  return { from, to };
}

// KPI summary
router.get('/kpi', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = scopeOrders(req);
  const expScope = scopeExpenses(req);
  try {
    const summary = await db.one(`
      SELECT
        COUNT(*)::int as total_orders,
        COALESCE(SUM(total)::float8, 0) as total_revenue,
        COALESCE(AVG(total)::float8, 0) as avg_order_value,
        COALESCE(SUM(discount)::float8, 0) as total_discounts
      FROM orders
      WHERE created_at::date BETWEEN ?::date AND ?::date
      AND status != 'voided'${scope.sql}
    `, [from, to, ...scope.params]);

    const prevFrom = new Date(from);
    prevFrom.setDate(prevFrom.getDate() - (new Date(to) - new Date(from)) / 86400000 - 1);
    const prevTo = new Date(from);
    prevTo.setDate(prevTo.getDate() - 1);

    const prev = await db.one(`
      SELECT COALESCE(SUM(total)::float8, 0) as total_revenue, COUNT(*)::int as total_orders
      FROM orders
      WHERE created_at::date BETWEEN ?::date AND ?::date
      AND status != 'voided'${scope.sql}
    `, [prevFrom.toISOString().split('T')[0], prevTo.toISOString().split('T')[0], ...scope.params]);

    /*
     * Expenses belong on the headline, not in a corner.
     *
     * Takings alone flatter the day: a shop can ring up 40,000 and still be
     * down if 9,000 went out on fuel and supplies. `net_revenue` is what the
     * owner actually keeps, and it is the figure the KPI row leads with.
     *
     * Every expense counts here, not only the ones paid out of the drawer —
     * the drawer flag is about reconciling the till, whereas this is about
     * what the day cost. That distinction is preserved in the split below so
     * the two questions never get confused.
     */
    const expenses = await db.one(`
      SELECT
        COALESCE(SUM(amount)::float8, 0) AS total_expenses,
        COALESCE(SUM(CASE WHEN from_drawer = 1 THEN amount ELSE 0 END)::float8, 0) AS drawer_expenses,
        COUNT(*)::int AS expense_count
      FROM expenses
      WHERE created_at::date BETWEEN ?::date AND ?::date${expScope.sql}
    `, [from, to, ...expScope.params]);

    /*
     * Wages, counted separately from expenses.
     *
     * Kept out of `total_expenses` on purpose. That figure means petty cash out
     * of the shop — fuel, supplies, a staff meal — and it is what the drawer is
     * reconciled against. Wages are a different kind of cost, paid monthly and
     * never through the till, and folding them in would both distort the daily
     * expense figures and make the drawer look short by a month's salaries.
     *
     * Dated on when the money was handed over, not on the month the payslip is
     * labelled with: August's wages paid in September are what September cost.
     *
     * The till has no payroll, so its own /kpi never returns this and the
     * Reports screen simply does not draw the card. See routes/payroll.js.
     */
    // Scoped through the employees table, which is where a wage's branch
    // lives — scopeExpenses defaults to the expenses table's own alias.
    const wageScope = scopeExpenses(req, 'e');
    const wages = await db.one(`
      SELECT COALESCE(SUM(p.paid_amount)::float8, 0) AS wages_paid
        FROM payslips p
        JOIN employees e ON e.id = p.employee_id
       WHERE p.paid_on BETWEEN ?::date AND ?::date${wageScope.sql}
    `, [from, to, ...wageScope.params]);

    // Credit money actually collected in this date range — same reasoning as
    // backend/routes/reports.js's own copy: separate from total_revenue,
    // which already booked the credit sale as revenue the moment it was rung
    // up. This is "cash that came in from old debt today". Missing here
    // entirely until now, which is why the dashboard's Reports screen always
    // showed 0 regardless of what the till had actually collected.
    const creditScope = scopeCreditPayments(req);
    const creditCollected = await db.one(`
      SELECT COALESCE(SUM(amount)::float8, 0) AS credit_collected
        FROM credit_payments
       WHERE created_at::date BETWEEN ?::date AND ?::date${creditScope.sql}
    `, [from, to, ...creditScope.params]);

    // How much of each ingredient this date range actually consumed, and
    // what's left right now — same reasoning and same 'sale'-typed
    // inventory_entries rows as backend/routes/reports.js's own copy. The
    // cloud has no recipes/recipe_ingredients table at all (recipes are a
    // till-only concept — see cloud/db/schema.js), so re-deriving this from
    // what was sold isn't possible here the way it is on the till; reading
    // it off inventory_entries instead is what makes it possible on both.
    const ingredientBranch = (req.user && req.user.branchId) || Number(req.query.branch) || 1;
    const ingredientUsage = await db.q(`
      SELECT i.local_id AS id, i.name, i.unit, i.stock AS current_stock,
             COALESCE(-SUM(CASE WHEN ie.type = 'sale' THEN ie.amount ELSE 0 END)::float8, 0) AS used
        FROM ingredients i
        LEFT JOIN inventory_entries ie
          ON ie.branch_id = i.branch_id AND ie.ingredient_local_id = i.local_id
         AND ie.entry_date::date BETWEEN ?::date AND ?::date
       WHERE i.branch_id = ?
       GROUP BY i.local_id, i.name, i.unit, i.stock
       ORDER BY i.name
    `, [from, to, ingredientBranch]);

    // Sales from a till that never logged their stock movement (an older build,
    // or an item with no recipe) — see db/derived-usage.js. Supplements, never
    // doubles: only days/devices with no logged 'sale' movement are added.
    try {
      const unlogged = await unloggedSold(db, ingredientBranch, from, to);
      for (const row of ingredientUsage) {
        let extra = 0;
        for (const [key, amount] of unlogged) if (key.endsWith('|' + row.name)) extra += amount;
        if (extra > 0) row.used = Number(row.used) + extra;
      }
    } catch (err) {
      console.error('Unlogged-usage fallback failed (figures show logged movements only):', err.message);
    }

    const revenueTrend = prev.total_revenue > 0
      ? (((summary.total_revenue - prev.total_revenue) / prev.total_revenue) * 100).toFixed(1)
      : 0;
    const ordersTrend = prev.total_orders > 0
      ? (((summary.total_orders - prev.total_orders) / prev.total_orders) * 100).toFixed(1)
      : 0;

    res.json({
      ...summary,
      ...expenses,
      wages_paid: Number(wages.wages_paid) || 0,
      // Net is what the owner actually keeps, so it has to carry the wage bill
      // too. Without it a month with a full payroll behind it reads as pure
      // profit, which is the single most misleading number this API could
      // return.
      net_revenue: summary.total_revenue - expenses.total_expenses - (Number(wages.wages_paid) || 0),
      revenue_trend: revenueTrend,
      orders_trend: ordersTrend,
      credit_collected: Number(creditCollected.credit_collected) || 0,
      ingredient_usage: ingredientUsage,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Stock movement, by day and ingredient — CLOUD port of
 * backend/routes/reports.js's own /stock-movement, same reasoning and same
 * clamp-at-zero note on closing_balance. Kept as close to the till's copy as
 * the Postgres dialect allows, same as every other route in this file.
 */
router.get('/stock-movement', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const branchId = (req.user && req.user.branchId) || Number(req.query.branch) || 1;
  try {
    const ingredients = await db.q(
      'SELECT local_id AS id, name, unit, stock FROM ingredients WHERE branch_id = ? ORDER BY name', [branchId]);
    const ingredientById = {};
    ingredients.forEach((i) => { ingredientById[i.id] = i; });

    // Nothing before `from` is fetched — see backend/routes/reports.js's own
    // note on why, and on the O(rows × history) nested scan this replaced:
    // that version blocked Node's one event loop for as long as it ran, on
    // *every* branch's request, since the cloud is one shared process —
    // which is what actually caused a batch of live browser requests
    // (including totally unrelated ones like GET /settings) to time out.
    const allDeltas = await db.q(`
      SELECT ingredient_local_id AS ingredient_id, entry_date, SUM(amount)::float8 AS delta
        FROM inventory_entries
       WHERE branch_id = ? AND entry_date >= ?
       GROUP BY ingredient_local_id, entry_date
       ORDER BY entry_date DESC
    `, [branchId, from]);
    const balanceByIngredientAndDate = {};
    const deltasByIngredient = {};
    allDeltas.forEach((r) => {
      if (!deltasByIngredient[r.ingredient_id]) deltasByIngredient[r.ingredient_id] = [];
      deltasByIngredient[r.ingredient_id].push({ date: r.entry_date, delta: Number(r.delta) || 0 });
    });
    Object.keys(deltasByIngredient).forEach((ingredientId) => {
      const ingredient = ingredientById[ingredientId];
      if (!ingredient) return;
      let cumulativeAfter = 0;
      const map = {};
      for (const d of deltasByIngredient[ingredientId]) {
        map[d.date] = Number(ingredient.stock) - cumulativeAfter;
        cumulativeAfter += d.delta;
      }
      balanceByIngredientAndDate[ingredientId] = map;
    });
    function closingBalance(ingredientId, currentStock, date) {
      const map = balanceByIngredientAndDate[ingredientId];
      return map && date in map ? map[date] : currentStock;
    }

    const movement = await db.q(`
      SELECT ie.entry_date AS date, i.local_id AS ingredient_id, i.name, i.unit,
             COALESCE(-SUM(CASE WHEN ie.type = 'sale' THEN ie.amount ELSE 0 END)::float8, 0) AS sold,
             COALESCE(SUM(CASE WHEN ie.type = 'stock' AND ie.amount > 0 THEN ie.amount ELSE 0 END)::float8, 0) AS restocked,
             COALESCE(SUM(CASE WHEN ie.type = 'yogurt_conversion' THEN ie.amount ELSE 0 END)::float8, 0) AS converted,
             COALESCE(-SUM(CASE WHEN ie.type = 'waste' THEN ie.amount ELSE 0 END)::float8, 0) AS waste
        FROM inventory_entries ie
        JOIN ingredients i ON i.branch_id = ie.branch_id AND i.local_id = ie.ingredient_local_id
       WHERE ie.branch_id = ? AND ie.entry_date::date BETWEEN ?::date AND ?::date
       GROUP BY ie.entry_date, i.local_id, i.name, i.unit
       ORDER BY ie.entry_date ASC, i.name
    `, [branchId, from, to]);

    const daysInRange = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
    const totalSoldByIngredient = {};
    movement.forEach((r) => {
      totalSoldByIngredient[r.ingredient_id] = (totalSoldByIngredient[r.ingredient_id] || 0) + Number(r.sold);
    });

    const rows = movement.map((r) => {
      const ingredient = ingredientById[r.ingredient_id];
      const rawBalance = ingredient ? closingBalance(r.ingredient_id, Number(ingredient.stock), r.date) : null;
      const balance = rawBalance != null ? Math.max(0, rawBalance) : null;
      const sold = Number(r.sold);
      const waste = Number(r.waste);
      const wastePct = (sold + waste) > 0 ? (waste / (sold + waste)) * 100 : 0;
      const avgDailySold = (totalSoldByIngredient[r.ingredient_id] || 0) / daysInRange;
      const daysRemaining = avgDailySold > 0 && balance != null && balance > 0 ? balance / avgDailySold : null;
      return {
        date: r.date, ingredient_id: r.ingredient_id, name: r.name, unit: r.unit,
        sold, restocked: Number(r.restocked), converted: Number(r.converted), waste,
        waste_pct: wastePct, closing_balance: balance, days_remaining: daysRemaining,
      };
    });

    // Days whose sales logged no movement (see db/derived-usage.js): fill their
    // Sold figure in, creating the day's row if nothing else moved that day.
    try {
      const unlogged = await unloggedSold(db, branchId, from, to);
      for (const [key, amount] of unlogged) {
        const [date, name] = key.split('|');
        const existing = rows.find((r) => r.date === date && r.name === name);
        if (existing) {
          existing.sold += amount;
        } else {
          const ingredient = ingredients.find((i) => i.name === name);
          if (!ingredient) continue;
          const raw = closingBalance(ingredient.id, Number(ingredient.stock), date);
          rows.push({
            date, ingredient_id: ingredient.id, name, unit: ingredient.unit,
            sold: amount, restocked: 0, converted: 0, waste: 0, waste_pct: 0,
            closing_balance: Math.max(0, raw), days_remaining: null,
          });
        }
      }
      rows.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
    } catch (err) {
      console.error('Unlogged-usage fallback failed (figures show logged movements only):', err.message);
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Revenue over time
router.get('/revenue-over-time', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const groupBy = req.query.groupBy || 'day';
  const scope = scopeOrders(req);
  try {
    let query;
    if (groupBy === 'hour') {
      query = `
        SELECT to_char(created_at::timestamp, 'HH24:00') as period,
               COALESCE(SUM(total)::float8, 0) as revenue,
               COUNT(*)::int as orders
        FROM orders
        WHERE created_at::date BETWEEN ?::date AND ?::date
        AND status != 'voided'${scope.sql}
        GROUP BY to_char(created_at::timestamp, 'HH24:00')
        ORDER BY to_char(created_at::timestamp, 'HH24:00')
      `;
    } else if (groupBy === 'month') {
      query = `
        SELECT to_char(created_at::timestamp, 'YYYY-MM') as period,
               COALESCE(SUM(total)::float8, 0) as revenue,
               COUNT(*)::int as orders
        FROM orders
        WHERE created_at::date BETWEEN ?::date AND ?::date
        AND status != 'voided'${scope.sql}
        GROUP BY to_char(created_at::timestamp, 'YYYY-MM')
        ORDER BY period
      `;
    } else {
      query = `
        SELECT to_char(created_at::timestamp, 'YYYY-MM-DD') as period,
               COALESCE(SUM(total)::float8, 0) as revenue,
               COUNT(*)::int as orders
        FROM orders
        WHERE created_at::date BETWEEN ?::date AND ?::date
        AND status != 'voided'${scope.sql}
        GROUP BY to_char(created_at::timestamp, 'YYYY-MM-DD')
        ORDER BY to_char(created_at::timestamp, 'YYYY-MM-DD')
      `;
    }
    const data = await db.q(query, [from, to, ...scope.params]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Top selling items
router.get('/top-items', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = scopeOrders(req, 'o');
  try {
    const items = await db.q(`
      SELECT
        oi.name,
        SUM(oi.quantity)::int as total_qty,
        SUM(oi.price * oi.quantity)::float8 as total_revenue,
        COUNT(DISTINCT oi.order_id)::int as order_count
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at::date BETWEEN ?::date AND ?::date
      AND o.status != 'voided'${scope.sql}
      GROUP BY oi.name
      -- Tie-broken deliberately. Ordering by total_qty alone means items that sold
      -- the same number of units come back in whatever order the engine
      -- happens to produce, so the tenth row — and therefore every
      -- percentage, which is computed against the ten — could change between
      -- runs for no reason at all.
      ORDER BY total_qty DESC, total_revenue DESC, oi.name ASC
      LIMIT 10
    `, [from, to, ...scope.params]);

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
router.get('/by-category', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = scopeOrders(req, 'o');
  try {
    // CLOUD: the till resolves the category at push time and sends it, because
    // menu item ids are per-machine and the join is not resolvable here. The
    // till's own version of this query carries the reasoning behind the CASE it
    // uses — deals share an id space with menu items, so they get their own
    // bucket rather than being filed under an unrelated item's category.
    const data = await db.q(`
      SELECT
        COALESCE(oi.category, 'Uncategorized') AS category,
        SUM(oi.quantity)::int as total_qty,
        SUM(oi.price * oi.quantity)::float8 as total_revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN branches br ON br.id = o.branch_id
      WHERE o.created_at::date BETWEEN ?::date AND ?::date
      AND o.status != 'voided'${scope.sql}
      GROUP BY category
      ORDER BY total_revenue DESC
    `, [from, to, ...scope.params]);

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
router.get('/hourly-heatmap', requireUser, async (req, res) => {
  const scope = scopeOrders(req);
  try {
    const data = await db.q(`
      SELECT
        CASE EXTRACT(DOW FROM created_at::timestamp)::int
          WHEN '0' THEN 'Sun'
          WHEN '1' THEN 'Mon'
          WHEN '2' THEN 'Tue'
          WHEN '3' THEN 'Wed'
          WHEN '4' THEN 'Thu'
          WHEN '5' THEN 'Fri'
          WHEN '6' THEN 'Sat'
        END as day,
        -- ::text because SQLite's strftime('%w') returns text, and the
        -- dashboard reuses the till's own screens — a number where they
        -- expect a string would compare unequal and quietly render nothing.
        EXTRACT(DOW FROM created_at::timestamp)::int::text as day_num,
        EXTRACT(HOUR FROM created_at::timestamp)::int as hour,
        COUNT(*)::int as orders,
        COALESCE(SUM(total)::float8, 0) as revenue
      FROM orders
      WHERE created_at::date >= (CURRENT_DATE - INTERVAL '30 days')
      AND status != 'voided'${scope.sql}
      -- Grouped by the raw expressions rather than the output aliases.
      -- Postgres matches a selected expression against the grouping ones
      -- textually, so once day_num gained its ::text cast the CASE above no
      -- longer looked like the thing being grouped. Naming the underlying
      -- EXTRACTs keeps every derived column valid.
      GROUP BY EXTRACT(DOW FROM created_at::timestamp),
               EXTRACT(HOUR FROM created_at::timestamp)
      ORDER BY EXTRACT(DOW FROM created_at::timestamp),
               EXTRACT(HOUR FROM created_at::timestamp)
    `, [...scope.params]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cashier performance
router.get('/cashier-performance', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = scopeOrders(req, 'o');
  try {
    const data = await db.q(`
      SELECT
        o.cashier_id,
        o.cashier_name,
        COUNT(*)::int as total_orders,
        COALESCE(SUM(o.total)::float8, 0) as total_revenue,
        COALESCE(AVG(o.total)::float8, 0) as avg_order_value,
        COALESCE(SUM(o.discount)::float8, 0) as total_discounts
      FROM orders o
      WHERE o.created_at::date BETWEEN ?::date AND ?::date
      AND o.status != 'voided'${scope.sql}
      GROUP BY o.cashier_id, o.cashier_name
      ORDER BY total_revenue DESC
    `, [from, to, ...scope.params]);
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
router.get('/detailed', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const includeVoided = req.query.include_voided === '1' || req.query.include_voided === 'true';
  const scope = scopeOrders(req, 'o');

  try {
    const orders = await db.q(`
      SELECT
        -- CLOUD: the till's own number, not the cloud's row id. This is the
        -- number printed on the customer's receipt and written in the shop's
        -- own records, so it is the only one the owner can cross-reference.
        -- The cloud's own id exists purely to join rows together.
        o.local_id AS id,
        -- The cloud's own row id: unique across every branch and till, unlike
        -- the till's number above (two tills can each have an "order 7"). Only
        -- used to join the quantities computed below back onto their order.
        o.id AS row_key,
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
        br.name AS branch_name,
        -- The label the shop actually uses for this sale. Built here rather
        -- than in the browser so the dashboard, the till's Orders screen and
        -- the printed receipt cannot drift apart: one format, one place.
        -- Falls back to the bare number for a branch with no code set.
        CASE WHEN COALESCE(br.code, '') = '' THEN o.local_id::text
             ELSE br.code || '-' || LPAD(o.local_id::text, 3, '0') END AS order_no,
        COALESCE(SUM(oi.price * oi.quantity)::float8, 0) AS subtotal,
        -- Rounded, not cast: this used to be ::int, which turned a 0.3636-litre
        -- sale into 0 and a 5.909-litre one into 6, so every total built from it was wrong.
        ROUND(COALESCE(SUM(oi.quantity), 0)::numeric, 4)::float8 AS total_qty,
        COUNT(oi.id)::int                             AS line_count,
        STRING_AGG(oi.name || ' x' || oi.quantity, ', ') AS items,
        -- The same order split by what was sold, so the report can be filtered
        -- to Milk or Dahi (yogurt) and every figure still adds back up: an order
        -- holding both appears under each, showing only that part.
        COALESCE(SUM(oi.price * oi.quantity) FILTER (WHERE oi.category = 'Milk')::float8, 0) AS milk_value,
        (COUNT(oi.id) FILTER (WHERE oi.category = 'Milk'))::int                              AS milk_lines,
        STRING_AGG(oi.name || ' x' || oi.quantity, ', ') FILTER (WHERE oi.category = 'Milk') AS milk_items,
        COALESCE(SUM(oi.price * oi.quantity) FILTER (WHERE oi.category = 'Dahi')::float8, 0) AS dahi_value,
        (COUNT(oi.id) FILTER (WHERE oi.category = 'Dahi'))::int                              AS dahi_lines,
        STRING_AGG(oi.name || ' x' || oi.quantity, ', ') FILTER (WHERE oi.category = 'Dahi') AS dahi_items,
        COALESCE(SUM(oi.price * oi.quantity) FILTER (WHERE COALESCE(oi.category, '') NOT IN ('Milk', 'Dahi'))::float8, 0) AS other_value,
        (COUNT(oi.id) FILTER (WHERE COALESCE(oi.category, '') NOT IN ('Milk', 'Dahi')))::int AS other_lines
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN branches br ON br.id = o.branch_id
      WHERE o.created_at::date BETWEEN ?::date AND ?::date
        ${includeVoided ? '' : "AND o.status != 'voided'"}${scope.sql}
      -- Postgres, unlike SQLite, requires every selected column to be grouped
      -- or aggregated. Grouping by orders' primary key covers o.*, but br.name
      -- comes from a joined table and has to be named explicitly.
      GROUP BY o.id, br.name, br.code
      ORDER BY o.created_at ASC
    `, [from, to, ...scope.params]);

    /*
     * How much Milk (litres) and Dahi (kilograms) each order holds.
     *
     * "Quantity" alone cannot be added up: a 2 Litre pack sold three times is
     * quantity 3 but 6 litres; a custom line "Milk (0.63 L)" is quantity 0.63 and
     * IS litres; "Dahi (192 g)" is quantity 0.1923 and is kilograms. So each line
     * is turned into a real amount by db/derived-usage.js's unitAmount — the same
     * rules the stock reports use — and summed per order here. Grouped by the
     * cloud's own row id, never the till's order number, which repeats across tills.
     */
    const lines = await db.q(`
      SELECT oi.order_id AS row_key, oi.category, oi.name, oi.quantity::float8 AS quantity
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
       WHERE o.created_at::date BETWEEN ?::date AND ?::date
         ${includeVoided ? '' : "AND o.status != 'voided'"}${scope.sql}
         AND oi.category IN ('Milk', 'Dahi')
    `, [from, to, ...scope.params]);
    const litres = new Map();
    const kilos = new Map();
    for (const l of lines) {
      const amount = (Number(l.quantity) || 0) * unitAmount(l.category, l.name);
      if (l.category === 'Milk') litres.set(l.row_key, (litres.get(l.row_key) || 0) + amount);
      else kilos.set(l.row_key, (kilos.get(l.row_key) || 0) + amount / 1000);
    }
    const round4 = (n) => Math.round((n || 0) * 10000) / 10000;

    // GROUP_CONCAT returns NULL for an order with no line items.
    res.json(orders.map(o => ({
      ...o,
      items: o.items || '',
      milk_qty: round4(litres.get(o.row_key)),
      dahi_qty: round4(kilos.get(o.row_key)),
    })));
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
router.get('/line-items', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const includeVoided = req.query.include_voided === '1' || req.query.include_voided === 'true';
  const scope = scopeOrders(req, 'o');

  try {
    const rows = await db.q(`
      SELECT
        -- CLOUD: the till's own order number — see /detailed above.
        o.local_id      AS order_id,
        o.created_at,
        o.cashier_name,
        o.order_type,
        o.table_number,
        o.payment_method,
        o.status,
        br.name         AS branch_name,
        oi.name         AS item_name,
        -- CLOUD: resolved by the till at push time.
        COALESCE(oi.category, 'Removed Item') AS category,
        oi.quantity,
        oi.price        AS unit_price,
        (oi.price * oi.quantity) AS line_total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN branches br ON br.id = o.branch_id
      WHERE o.created_at::date BETWEEN ?::date AND ?::date
        ${includeVoided ? '' : "AND o.status != 'voided'"}${scope.sql}
      ORDER BY o.created_at ASC, oi.id ASC
    `, [from, to, ...scope.params]);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Daily summary
router.get('/daily', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = scopeOrders(req);
  const expScope = scopeExpenses(req);
  try {
    /*
     * The day-by-day summary, with what was spent set against what was taken.
     *
     * The list of days is a UNION of both tables rather than just the sales
     * table. A day the shop was shut but still paid a supplier has expenses
     * and no orders; driving the report off orders alone would drop that day
     * entirely and quietly overstate the period's net.
     */
    const data = await db.q(`
      WITH days AS (
        SELECT DISTINCT to_char(created_at::timestamp, 'YYYY-MM-DD') AS date FROM orders
         WHERE created_at::date BETWEEN ?::date AND ?::date
           AND status != 'voided'${scope.sql}
        UNION
        SELECT DISTINCT to_char(created_at::timestamp, 'YYYY-MM-DD') AS date FROM expenses
         WHERE created_at::date BETWEEN ?::date AND ?::date${expScope.sql}
      )
      SELECT
        d.date,
        COALESCE(o.total_orders, 0)     AS total_orders,
        COALESCE(o.total_revenue, 0)    AS total_revenue,
        COALESCE(o.total_discounts, 0)  AS total_discounts,
        COALESCE(o.avg_order_value, 0)  AS avg_order_value,
        COALESCE(x.total_expenses, 0)   AS total_expenses,
        COALESCE(x.drawer_expenses, 0)  AS drawer_expenses,
        COALESCE(o.total_revenue, 0) - COALESCE(x.total_expenses, 0) AS net_revenue
      FROM days d
      LEFT JOIN (
        SELECT to_char(created_at::timestamp, 'YYYY-MM-DD') AS date,
               COUNT(*)::int AS total_orders,
               SUM(total)::float8 AS total_revenue,
               SUM(discount)::float8 AS total_discounts,
               AVG(total)::float8 AS avg_order_value
          FROM orders
         WHERE status != 'voided'${scope.sql}
         GROUP BY to_char(created_at::timestamp, 'YYYY-MM-DD')
      ) o ON o.date = d.date
      LEFT JOIN (
        SELECT to_char(created_at::timestamp, 'YYYY-MM-DD') AS date,
               SUM(amount)::float8 AS total_expenses,
               SUM(CASE WHEN from_drawer = 1 THEN amount ELSE 0 END)::float8 AS drawer_expenses
          FROM expenses
         WHERE 1 = 1${expScope.sql}
         GROUP BY to_char(created_at::timestamp, 'YYYY-MM-DD')
      ) x ON x.date = d.date
      ORDER BY d.date DESC
    `, [from, to, ...scope.params,
      from, to, ...expScope.params,
      ...scope.params,
      ...expScope.params]);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Expenses grouped by what the money went on.
 *
 * The mirror image of Sales by Category: that answers where the money came
 * from, this answers where it went. Together they are the whole day.
 */
router.get('/expenses-by-category', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = scopeExpenses(req);
  try {
    res.json(await db.q(`
      SELECT
        category,
        COUNT(*)::int AS entries,
        COALESCE(SUM(amount)::float8, 0) AS total,
        COALESCE(SUM(CASE WHEN from_drawer = 1 THEN amount ELSE 0 END)::float8, 0) AS from_drawer_total
      FROM expenses
      WHERE created_at::date BETWEEN ?::date AND ?::date${scope.sql}
      GROUP BY category
      ORDER BY total DESC
    `, [from, to, ...scope.params]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Every expense in the period, line by line.
 *
 * Feeds both the on-screen table and the CSV/Excel export, so the owner can
 * account for each payout individually — who recorded it, what for, whether it
 * came out of the till, and which branch it belongs to.
 */
router.get('/expenses-detail', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = scopeExpenses(req, 'e');
  try {
    res.json(await db.q(`
      SELECT
        -- CLOUD: the till's own number — see /detailed above.
        e.local_id AS id,
        e.created_at,
        e.category,
        e.description,
        e.amount,
        e.from_drawer,
        e.staff_name,
        -- CLOUD: the till's own shift number, which is only unique within its
        -- branch — hence the column name.
        e.local_shift_id AS shift_id,
        b.name AS branch_name
      FROM expenses e
      LEFT JOIN branches b ON b.id = e.branch_id
      WHERE e.created_at::date BETWEEN ?::date AND ?::date${scope.sql}
      ORDER BY e.created_at DESC, e.id DESC
    `, [from, to, ...scope.params]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Net revenue (revenue minus expenses).
 *
 * Ported from the till's own `/reports/net` — the dashboard's Reports tab is
 * the till's own Reports screen, reused unmodified (see dashboard/src/Shell.jsx),
 * and it calls this as part of a `Promise.all` alongside every other report
 * below. Without it, one missing endpoint fails that whole batch and the tab
 * shows nothing at all — not just a blank net-revenue card.
 */
router.get('/net', requireUser, async (req, res) => {
  const { from, to } = getDateRange(req);
  const scope = scopeOrders(req);
  const expScope = scopeExpenses(req);
  try {
    const revRow = await db.one(`
      SELECT COALESCE(SUM(total)::float8, 0) as revenue
      FROM orders
      WHERE created_at::date BETWEEN ?::date AND ?::date
      AND status != 'voided'${scope.sql}
    `, [from, to, ...scope.params]);

    const expRow = await db.one(`
      SELECT COALESCE(SUM(amount)::float8, 0) as expenses
      FROM expenses
      WHERE created_at::date BETWEEN ?::date AND ?::date${expScope.sql}
    `, [from, to, ...expScope.params]);

    const revenue = revRow.revenue || 0;
    const expenses = expRow.expenses || 0;

    res.json({ revenue, expenses, net: revenue - expenses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
