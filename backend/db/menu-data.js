/**
 * Pure Milk POS — menu data.
 * Single source of truth, read by database.js on first run.
 *
 * 3 standard items are always present:
 * 1. 0.5 Litre (Rs. 100)
 * 2. 1 Litre (Rs. 200)
 * 3. 2 Litre (Rs. 400)
 */

const MENU = [
  { c: 'Milk', n: '0.5 Litre', p: 100, d: 'Fresh pure milk (0.5 Litre)' },
  { c: 'Milk', n: '1 Litre',   p: 200, d: 'Fresh pure milk (1 Litre)' },
  { c: 'Milk', n: '2 Litre',   p: 400, d: 'Fresh pure milk (2 Litre)' },
];

// No combo/bundle deals for the milk system.
const DEALS = [];

module.exports = { MENU, DEALS };
