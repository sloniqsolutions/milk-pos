/**
 * The stock table, built once. Each row is one ingredient on one day:
 *
 *   Opening + Restocked +/- Converted - Sold - Waste - Removed = Closing
 *
 * Nothing here estimates, clamps or plugs. Opening is the sum of every stock
 * entry before the day, Closing is the sum through the day, and each column is
 * a plain sum of one kind of entry:
 *
 *   Restocked  entries of type 'stock' that are positive (stock brought in)
 *   Removed    entries of type 'stock' that are negative (taken out by hand,
 *              or a count corrected down), shown as a positive figure
 *   Converted  'yogurt_conversion' entries, signed (negative for milk)
 *   Sold       'sale' entries, negated. A void's return entry is a positive
 *              'sale' entry, so it reduces Sold.
 *   Waste      'waste' entries, negated
 *
 * If a row ever fails to add up, some entry has a type this table does not
 * know, or a stock number was changed without an entry. That is a bug in the
 * source, and backend/test/stock-table.test.js is what catches it.
 *
 * Kept identical to cloud/db/stock-statement.js on purpose, so the till's
 * Reports and the dashboard's can never disagree.
 */

const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

/**
 * The per-day sums, as SQL. `ie` must be inventory_entries. Runs unchanged on
 * SQLite (the till) and Postgres (the cloud).
 */
const MOVEMENT_SUMS = `
  COALESCE(-SUM(CASE WHEN ie.type = 'sale' THEN ie.amount ELSE 0 END), 0) AS sold,
  COALESCE(SUM(CASE WHEN ie.type = 'stock' AND ie.amount > 0 THEN ie.amount ELSE 0 END), 0) AS restocked,
  COALESCE(-SUM(CASE WHEN ie.type = 'stock' AND ie.amount < 0 THEN ie.amount ELSE 0 END), 0) AS removed,
  COALESCE(SUM(CASE WHEN ie.type = 'yogurt_conversion' THEN ie.amount ELSE 0 END), 0) AS converted,
  COALESCE(-SUM(CASE WHEN ie.type = 'waste' THEN ie.amount ELSE 0 END), 0) AS waste,
  COALESCE(SUM(ie.amount), 0) AS day_delta`;

/**
 * @param {object[]} dayRows one per (date, ingredient) that moved in the range:
 *   { date, ingredient_id, name, unit, sold, restocked, removed, converted, waste, day_delta }
 * @param {Object<string, number>} openings ingredient_id -> the sum of every
 *   entry dated before the range starts
 * @param {number} daysInRange length of the range in days, for "stock lasts"
 * @returns {object[]} the same rows, oldest first, with opening_balance and
 *   closing_balance added
 */
function buildStatement(dayRows, openings, daysInRange) {
  const byIngredient = new Map();
  for (const r of dayRows) {
    if (!byIngredient.has(r.ingredient_id)) byIngredient.set(r.ingredient_id, []);
    byIngredient.get(r.ingredient_id).push(r);
  }

  const out = [];
  for (const [ingredientId, rows] of byIngredient) {
    rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const totalSold = rows.reduce((s, r) => s + Number(r.sold), 0);
    const avgDailySold = totalSold / Math.max(1, daysInRange || 1);
    let running = Number(openings && openings[ingredientId]) || 0;
    for (const r of rows) {
      const opening = running;
      const closing = opening + Number(r.day_delta);
      running = closing;
      const sold = Number(r.sold);
      const waste = Number(r.waste);
      out.push({
        date: r.date, ingredient_id: r.ingredient_id, name: r.name, unit: r.unit,
        opening_balance: round4(opening),
        restocked: round4(r.restocked),
        converted: round4(r.converted),
        sold: round4(sold),
        waste: round4(waste),
        removed: round4(r.removed),
        closing_balance: round4(closing),
        waste_pct: (sold + waste) > 0 ? (waste / (sold + waste)) * 100 : 0,
        days_remaining: avgDailySold > 0 && closing > 0 ? closing / avgDailySold : null,
      });
    }
  }
  out.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.name).localeCompare(String(b.name)));
  return out;
}

module.exports = { buildStatement, MOVEMENT_SUMS, round4 };
