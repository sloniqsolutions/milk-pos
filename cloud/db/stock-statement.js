/**
 * What makes a /reports/stock-movement row read like a bank statement:
 *
 *   Opening + Restocked ± Converted − Sold − Waste ± Other = Closing
 *
 * `closing_balance` has always been "today's stock minus every movement dated
 * after that day". The four columns beside it only show SOME of what moved —
 * Restocked is positive 'stock' entries only, so a manual removal or a
 * set-the-count correction (a negative 'stock' entry) changed the balance
 * without appearing anywhere, and a sale that never logged its movement
 * (db/derived-usage.js) is shown as Sold although it never touched the logged
 * balance. Those are what `adjustment` ("Other") holds, so the row adds up.
 *
 * Kept identical to cloud/db/stock-statement.js on purpose, like unitAmount,
 * so the till's Reports and the dashboard's can never disagree.
 */

const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

/**
 * @param {number} stock  the ingredient's stock right now
 * @param {{date: string, delta: number}[]} deltas  one entry per day this
 *   ingredient moved, from the report's `from` onward, NEWEST first
 * @returns {(date: string) => number} the (unclamped) stock at the END of any
 *   date on or after `from`: today's stock minus everything dated after it.
 *   A day with no entries of its own gets the same answer as the last day
 *   before it that had some — it used to get today's stock instead.
 */
function closingLookup(stock, deltas) {
  const byDate = new Map();
  let after = 0; // sum of every day strictly after the one about to be recorded
  for (const d of deltas) { // already newest-first
    byDate.set(d.date, Number(stock) - after);
    after += d.delta;
  }
  return (date) => {
    if (byDate.has(date)) return byDate.get(date);
    // No entries that day: sum only what is dated after it. Only reached for a
    // day that has no movement of its own, so this scan stays rare.
    let later = 0;
    for (const d of deltas) {
      if (d.date <= date) break;
      later += d.delta;
    }
    return Number(stock) - later;
  };
}

/**
 * Adds `opening_balance` and `adjustment` to a row, leaving `closing_balance`
 * exactly as it was.
 *
 * @param {object} row  sold / restocked / converted / waste already final
 * @param {number|null} rawClosing  closingLookup's answer for this day
 * @param {number} dayDelta  the SUM of every logged entry that day, all types
 *
 * Closing is clamped at zero, as it always was (see the note in the routes).
 * Opening is clamped the same way, so one day's Closing is the next day's
 * Opening, and whatever the clamp or an unlogged sale does to the arithmetic
 * lands in `adjustment` rather than making the row wrong.
 */
function withStatement(row, rawClosing, dayDelta) {
  if (rawClosing == null) return { ...row, opening_balance: null, adjustment: 0 };
  const closing = Math.max(0, rawClosing);
  const opening = Math.max(0, rawClosing - dayDelta);
  const adjustment = closing - opening - row.restocked - row.converted + row.sold + row.waste;
  return { ...row, opening_balance: round4(opening), adjustment: round4(adjustment) };
}

module.exports = { closingLookup, withStatement, round4 };
