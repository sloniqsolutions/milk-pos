/**
 * The Detailed report's Milk / Dahi filter and its totals — pure functions, so the
 * arithmetic can be tested on its own and the screen only has to draw the result.
 *
 * Why an order is split rather than shown whole: some orders hold BOTH (a litre of
 * milk and a kilo of dahi on one bill). If such an order appeared in both filters
 * at its full total, Milk + Dahi would add up to more than the day's takings. So a
 * filtered row shows only that category's items and amount, which makes the two
 * filters partition the unfiltered total exactly:  Milk + Dahi (+ Other) = All.
 *
 * "Dahi" and "yogurt" are the same product here (the stock ingredient is called
 * Yogurt; the menu category is Dahi).
 *
 * Quantities are real amounts, not the raw `quantity` column, which cannot be added
 * up (a 2 Litre pack sold 3 times is quantity 3 but 6 litres): Milk in litres, Dahi
 * in kilograms — computed by the backend, see the /reports/detailed routes.
 */

export const CATEGORY_FILTERS = [
  { key: 'all', label: 'All orders' },
  { key: 'Milk', label: 'Milk' },
  { key: 'Dahi', label: 'Dahi / Yogurt' },
];

const PREFIX = { Milk: 'milk', Dahi: 'dahi' };
const UNIT = { Milk: 'L', Dahi: 'kg' };

const num = (v) => Number(v) || 0;
const cents = (n) => Math.round(n * 100) / 100;
const qty = (n) => Math.round(n * 10000) / 10000;

/** True when the server sent the per-category fields (an older backend does not; the filter is hidden then). */
export function hasCategoryData(rows) {
  return !Array.isArray(rows) || rows.length === 0 || 'milk_lines' in rows[0];
}

/**
 * The rows the table shows for a filter. 'all' returns them untouched. A category
 * keeps only orders that contain it and rewrites each to just that part.
 */
export function buildView(rows, filter) {
  if (!Array.isArray(rows) || filter === 'all' || !PREFIX[filter]) return rows || [];
  const p = PREFIX[filter];
  const other = filter === 'Milk' ? 'Dahi' : 'Milk';
  return rows
    .filter((r) => num(r[`${p}_lines`]) > 0)
    .map((r) => ({
      ...r,
      items: r[`${p}_items`] || '',
      line_count: num(r[`${p}_lines`]),
      total_qty: num(r[`${p}_qty`]),        // litres or kg, not the raw column
      subtotal: num(r[`${p}_value`]),
      discount: 0,                          // order-level: cannot be split by category
      delivery_charge: 0,
      employee_discount: 0,
      total: num(r[`${p}_value`]),          // this category's part of the bill
      is_mixed: num(r[`${PREFIX[other]}_lines`]) > 0 || num(r.other_lines) > 0,
      order_total: num(r.total),
      other_category: other,
    }));
}

/**
 * Everything the totals bar shows, over ALL rows in the range (the screen only draws
 * the first few hundred, but a total must never depend on what was drawn).
 */
export function summarize(rows, filter) {
  const list = buildView(rows, filter);
  const sum = (k) => list.reduce((s, r) => s + num(r[k]), 0);
  const cat = PREFIX[filter] ? filter : null;

  const out = {
    filter,
    orders: list.length,
    items: sum('line_count'),                 // order lines: one per item entered
    total: cents(sum('total')),
    unit: cat ? UNIT[cat] : null,
    quantity: cat ? qty(sum('total_qty')) : null,
    mixedOrders: cat ? list.filter((r) => r.is_mixed).length : 0,
  };

  if (!cat) {
    // Unfiltered: every category side by side, so the parts can be seen to add up.
    const all = rows || [];
    const s = (k) => all.reduce((t, r) => t + num(r[k]), 0);
    out.milkLitres = qty(s('milk_qty'));
    out.dahiKg = qty(s('dahi_qty'));
    out.milkValue = cents(s('milk_value'));
    out.dahiValue = cents(s('dahi_value'));
    out.otherValue = cents(s('other_value'));
    out.otherItems = s('other_lines');
    // What sits between item prices and what the customer paid.
    out.discounts = cents(s('discount'));
    out.delivery = cents(s('delivery_charge'));
    out.tax = cents(s('tax_amount'));
    out.itemsValue = cents(s('subtotal'));
  }
  return out;
}

/** "191.8" for litres/kg: up to two decimals, no trailing zeros. */
export function fmtAmountQty(n) {
  const r = Math.round(num(n) * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
}
