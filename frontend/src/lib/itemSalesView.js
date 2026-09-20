/**
 * The Item Sales report's Milk / Dahi filter and its totals — pure functions, like
 * lib/detailedView.js, so the arithmetic can be tested on its own and the screen
 * only has to draw the result. They share CATEGORY_FILTERS and the same
 * conventions, so the two views always agree.
 *
 * Each row is one order line from /reports/line-items. The server classifies it
 * (db/line-classifier.js — the one definition both reports use) and sends:
 *   category_group  'Milk' | 'Dahi' | 'Other'
 *   amount          real litres (Milk) or kilograms (Dahi); 0 for Other
 *   category_inferred / category_review / amount_assumed   flags to badge
 *
 * Every line is in exactly one group, so  Milk + Dahi + Other = All  for both the
 * price and the line count.
 *
 * "Items" = order lines, the same convention as the Detailed footer. Quantity is
 * the real amount (Milk in litres, Dahi in kg), never the raw `quantity` column:
 * "2 Litre" sold 3 times is quantity 3 but 6 litres, and litres and kilograms
 * cannot be added to each other — so unfiltered, they are shown side by side.
 *
 * Every figure is over ALL the rows given, never just the ones drawn: the screen
 * caps what it draws for speed, a total must not depend on that.
 */

const UNIT = { Milk: 'L', Dahi: 'kg' };

const num = (v) => Number(v) || 0;
const cents = (n) => Math.round(n * 100) / 100;
const qty = (n) => Math.round(n * 10000) / 10000;

/** A line's price * quantity — `line_total` from the server, else worked out. */
export const lineValue = (r) => (r.line_total != null && r.line_total !== ''
  ? num(r.line_total)
  : num(r.unit_price) * num(r.quantity));

/** Which order a line belongs to. Two tills can each have an "order 7", so the cloud sends `order_key`. */
export const orderKeyOf = (r) => (r.order_key != null ? String(r.order_key) : `${r.branch_name || ''}|${r.order_id}`);

/** True when the server sent the classification (an older till or cloud does not; the filter is hidden then). */
export function hasLineCategoryData(rows) {
  return !Array.isArray(rows) || rows.length === 0 || 'category_group' in rows[0];
}

/** The rows a filter shows. 'all' returns them untouched. */
export function filterLineItems(rows, filter) {
  if (!Array.isArray(rows) || !UNIT[filter]) return rows || [];
  return rows.filter((r) => r.category_group === filter);
}

/**
 * Everything the totals footer shows.
 * @param {object[]} rows  every line in the range
 * @param {string} filter  'all' | 'Milk' | 'Dahi'
 */
export function summarizeLineItems(rows, filter) {
  const all = Array.isArray(rows) ? rows : [];
  const hasCategories = hasLineCategoryData(all);
  const cat = hasCategories && UNIT[filter] ? filter : null;
  const view = cat ? filterLineItems(all, cat) : all;

  const sumValue = (list) => list.reduce((s, r) => s + lineValue(r), 0);
  const group = (g) => all.filter((r) => r.category_group === g);
  const milk = group('Milk');
  const dahi = group('Dahi');
  const other = group('Other');

  return {
    filter: cat || 'all',
    hasCategories,
    lines: view.length,                                  // items: one per order line
    orders: new Set(view.map(orderKeyOf)).size,          // distinct orders holding them
    total: cents(sumValue(view)),                        // item total, before discounts / delivery / tax
    unit: cat ? UNIT[cat] : null,
    quantity: cat ? qty(view.reduce((s, r) => s + num(r.amount), 0)) : null,

    // Unfiltered: every group side by side, so the parts can be seen to add up.
    milkLitres: qty(milk.reduce((s, r) => s + num(r.amount), 0)),
    dahiKg: qty(dahi.reduce((s, r) => s + num(r.amount), 0)),
    milkValue: cents(sumValue(milk)),
    dahiValue: cents(sumValue(dahi)),
    otherValue: cents(sumValue(other)),
    milkLines: milk.length,
    dahiLines: dahi.length,
    otherLines: other.length,
    allValue: cents(sumValue(all)),
    allLines: all.length,

    // Lines a person may want to look at.
    inferredLines: view.filter((r) => r.category_inferred).length,
    reviewLines: view.filter((r) => r.category_review).length,
    assumedLines: view.filter((r) => r.amount_assumed).length,
  };
}
