/**
 * Records a stock movement locally and pushes it to the cloud.
 *
 * Split out of routes/inventory.js so routes/orders.js can log the same kind
 * of row for a sale's own stock deduction (type 'sale') — needed so
 * "ingredient used in this period" can be computed identically on the till
 * and the cloud (see routes/reports.js's own note on why), the same way
 * restocks, conversions and waste already are. See cloud/routes/inventory.js's
 * /history route and db/schema.js's inventory_entries table.
 */

const db = require('./database');
const { syncUpsert } = require('./cloud-sync');

const insertEntry = db.prepare(
  'INSERT INTO inventory_entries (ingredient_id, type, amount, entry_date) VALUES (?, ?, ?, ?)'
);
const getEntry = db.prepare('SELECT * FROM inventory_entries WHERE id = ?');

function recordEntry(ingredientId, type, amount, entryDate) {
  const id = insertEntry.run(ingredientId, type, amount, entryDate).lastInsertRowid;
  syncUpsert('inventory_entries', getEntry.get(id));
}

module.exports = { recordEntry };
