const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { syncUpsert } = require('../db/cloud-sync');
const { moveStock, flushEntryPushes, round6 } = require('../db/inventory-entries');
const { clean, toNumber, checkEntryDay } = require('../db/validate');

/** Largest single stock figure accepted — far beyond any real shop, small enough to catch a typo. */
const MAX_AMOUNT = 10000000;

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

// GET all ingredients
router.get('/', (req, res) => {
  try {
    const ingredients = db.prepare('SELECT * FROM ingredients ORDER BY name ASC').all();
    res.json(ingredients);
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// POST new ingredient
router.post('/', (req, res) => {
  const { stock, low_stock_threshold, date } = req.body || {};
  const name = clean(req.body && req.body.name, 80);
  const unit = clean(req.body && req.body.unit, 20);
  if (!name || !unit) {
    return res.status(400).json({ error: 'Enter a name and a unit (for example Litre or grams) for this ingredient.' });
  }
  const startStock = stock === undefined || stock === null || stock === '' ? 0 : toNumber(stock);
  const startThreshold = low_stock_threshold === undefined || low_stock_threshold === null || low_stock_threshold === '' ? 0 : toNumber(low_stock_threshold);
  if (!(startStock >= 0) || startStock > MAX_AMOUNT) {
    return res.status(400).json({ error: 'The starting stock must be zero or more.' });
  }
  if (!(startThreshold >= 0) || startThreshold > MAX_AMOUNT) {
    return res.status(400).json({ error: 'The low-stock level must be zero or more.' });
  }
  const dayProblem = checkEntryDay(date);
  if (dayProblem) return res.status(400).json({ error: dayProblem });

  try {
    // Explicit id under 10000 — see backend/routes/staff.js's identical
    // comment for why: the cloud allocates its own ingredient ids from
    // 10000 up (see cloud/routes/inventory.js), and once this till has ever
    // pulled down a cloud-created ingredient, SQLite's own rowid allocation
    // would otherwise continue from that high-water mark instead of 1.
    const nextId = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM ingredients WHERE id < 10000').get().id;
    // Created at zero, then brought to its starting stock by a logged movement
    // in the same transaction — the number is never set without an entry.
    const create = db.transaction(() => {
      db.prepare('INSERT INTO ingredients (id, name, unit, stock, low_stock_threshold) VALUES (?, ?, ?, 0, ?)')
        .run(nextId, name, unit, startThreshold);
      if (startStock > 0) moveStock(nextId, 'stock', startStock, date || today());
    });
    create();
    flushEntryPushes();
    const result = { lastInsertRowid: nextId };
    const newIngredient = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(result.lastInsertRowid);
    syncUpsert('ingredients', newIngredient);
    res.status(201).json(newIngredient);
  } catch (error) {
    console.error('Error adding ingredient:', error);
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: `An ingredient called "${name}" already exists. Edit that one instead.` });
    }
    res.status(500).json({ error: 'Failed to add ingredient' });
  }
});

// PUT update stock (can be absolute or delta based on what client sends. We'll expect { stock: 50 })
// For a robust system we can allow { action: 'add', amount: 50 } or { stock: 50 }
router.put('/:id/stock', (req, res) => {
  const { id } = req.params;
  const { action, amount, stock, date } = req.body || {};

  try {
    const ingredient = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
    if (!ingredient) {
      return res.status(404).json({ error: 'That ingredient no longer exists. Refresh the page and try again.' });
    }
    const dayProblem = checkEntryDay(date);
    if (dayProblem) return res.status(400).json({ error: dayProblem });

    // Every path below moves the stock and logs the same amount, together.
    // Adding is a restock; removing is refused if it would go below zero; a
    // corrected count is logged as the difference, with the reason "Recount".
    let change;
    let reason = null;
    if (action === 'add' || action === 'subtract') {
      const delta = toNumber(amount);
      if (!(delta > 0) || delta > MAX_AMOUNT) {
        return res.status(400).json({ error: 'Enter an amount greater than zero.' });
      }
      if (action === 'subtract' && delta > ingredient.stock) {
        return res.status(400).json({
          error: `You can't remove ${delta} ${ingredient.unit} — only ${ingredient.stock} ${ingredient.unit} of ${ingredient.name} is in stock.`,
          code: 'INSUFFICIENT_STOCK',
        });
      }
      change = action === 'add' ? delta : -delta;
    } else if (stock !== undefined) {
      const counted = toNumber(stock);
      if (!(counted >= 0) || counted > MAX_AMOUNT) {
        return res.status(400).json({ error: 'Stock must be zero or more.' });
      }
      change = round6(counted - ingredient.stock);
      reason = 'Recount';
    } else {
      return res.status(400).json({ error: 'Choose whether to add stock, remove stock, or set the count.' });
    }

    if (round6(change) !== 0) {
      moveStock(ingredient.id, 'stock', change, date || today(), { reason });
      flushEntryPushes();
    }
    const newStock = db.prepare('SELECT stock FROM ingredients WHERE id = ?').get(ingredient.id).stock;

    syncUpsert('ingredients', { ...ingredient, stock: newStock });
    res.json({ ...ingredient, stock: newStock });
  } catch (error) {
    console.error('Error updating stock:', error);
    res.status(500).json({ error: 'Failed to update stock' });
  }
});

// PUT update threshold
router.put('/:id/threshold', (req, res) => {
  const { id } = req.params;
  const { threshold: rawThreshold } = req.body || {};
  const threshold = toNumber(rawThreshold);

  if (!(threshold >= 0) || threshold > MAX_AMOUNT) {
    return res.status(400).json({ error: 'The low-stock level must be zero or more.' });
  }

  try {
    const ingredient = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
    if (!ingredient) {
      return res.status(404).json({ error: 'Ingredient not found' });
    }

    const update = db.prepare('UPDATE ingredients SET low_stock_threshold = ? WHERE id = ?');
    update.run(parseFloat(threshold), id);

    syncUpsert('ingredients', { ...ingredient, low_stock_threshold: parseFloat(threshold) });
    res.json({ ...ingredient, low_stock_threshold: parseFloat(threshold) });
  } catch (error) {
    console.error('Error updating threshold:', error);
    res.status(500).json({ error: 'Failed to update threshold' });
  }
});

// GET stock history — restocks/adjustments, yogurt conversions, and waste,
// each tagged by 'type' so the Stock History screen can filter them into
// separate views instead of one combined feed. Optional filters: type,
// ingredient_id, from/to (entry_date, inclusive).
router.get('/history', (req, res) => {
  const { type, ingredient_id, from, to } = req.query;

  try {
    let query = `
      SELECT ie.id, ie.ingredient_id, ie.type, ie.amount, ie.entry_date, ie.created_at, ie.reason, ie.superseded_by,
             i.name AS ingredient_name, i.unit AS ingredient_unit
      FROM inventory_entries ie
      JOIN ingredients i ON i.id = ie.ingredient_id
      WHERE 1=1
    `;
    const params = [];

    if (type) { query += ' AND ie.type = ?'; params.push(type); }
    if (ingredient_id) { query += ' AND ie.ingredient_id = ?'; params.push(ingredient_id); }
    if (from) { query += ' AND ie.entry_date >= ?'; params.push(from); }
    if (to) { query += ' AND ie.entry_date <= ?'; params.push(to); }

    query += ' ORDER BY ie.entry_date DESC, ie.id DESC';

    const entries = db.prepare(query).all(...params);
    res.json(entries);
  } catch (error) {
    console.error('Error fetching inventory history:', error);
    res.status(500).json({ error: 'Failed to fetch inventory history' });
  }
});

// POST convert Milk stock into Yogurt stock — two entries recorded together
// (milk out, yogurt in) so the conversion shows as one event in history.
router.post('/convert-to-yogurt', (req, res) => {
  const { milk_amount, yogurt_amount, date } = req.body || {};
  const milkAmount = toNumber(milk_amount);
  const yogurtAmount = toNumber(yogurt_amount);

  if (!(milkAmount > 0) || !(yogurtAmount > 0) || milkAmount > MAX_AMOUNT || yogurtAmount > MAX_AMOUNT) {
    return res.status(400).json({ error: 'Enter how much milk is used and how much yogurt is being added.' });
  }
  const dayProblem = checkEntryDay(date);
  if (dayProblem) return res.status(400).json({ error: dayProblem });

  try {
    const milk = db.prepare("SELECT * FROM ingredients WHERE name = 'Milk'").get();
    const yogurt = db.prepare("SELECT * FROM ingredients WHERE name = 'Yogurt'").get();
    if (!milk || !yogurt) {
      return res.status(500).json({ error: 'Milk or Yogurt ingredient is missing from inventory.' });
    }
    if (milk.stock < milkAmount) {
      return res.status(400).json({ error: `Not enough milk in stock: ${milk.stock} ${milk.unit} available, ${milkAmount} needed.`, code: 'INSUFFICIENT_MILK' });
    }

    const entryDate = date || today();
    db.transaction(() => {
      moveStock(milk.id, 'yogurt_conversion', -milkAmount, entryDate);
      moveStock(yogurt.id, 'yogurt_conversion', yogurtAmount, entryDate);
    })();
    flushEntryPushes();

    const newMilkStock = db.prepare('SELECT stock FROM ingredients WHERE id = ?').get(milk.id).stock;
    const newYogurtStock = db.prepare('SELECT stock FROM ingredients WHERE id = ?').get(yogurt.id).stock;
    syncUpsert('ingredients', { ...milk, stock: newMilkStock });
    syncUpsert('ingredients', { ...yogurt, stock: newYogurtStock });

    res.json({
      milk: { ...milk, stock: newMilkStock },
      yogurt: { ...yogurt, stock: newYogurtStock },
    });
  } catch (error) {
    console.error('Error converting milk to yogurt:', error);
    res.status(500).json({ error: 'Failed to convert milk to yogurt' });
  }
});

// POST report waste — subtracts stock like a normal adjustment, but recorded
// with type 'waste' so it stays out of the restock/conversion history views.
router.post('/waste', (req, res) => {
  const { ingredient_id, amount, date } = req.body || {};
  const wasteAmount = toNumber(amount);

  if (!ingredient_id || !(wasteAmount > 0) || wasteAmount > MAX_AMOUNT) {
    return res.status(400).json({ error: 'Choose an ingredient and enter an amount.' });
  }
  const dayProblem = checkEntryDay(date);
  if (dayProblem) return res.status(400).json({ error: dayProblem });

  try {
    const ingredient = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(ingredient_id);
    if (!ingredient) {
      return res.status(404).json({ error: 'Ingredient not found' });
    }

    // Waste can't exceed what is in stock: recording more than exists would
    // put the balance below zero (or, clamped, hide the typo).
    if (wasteAmount > ingredient.stock) {
      return res.status(400).json({
        error: `You can't record ${wasteAmount} ${ingredient.unit} of waste — only ${ingredient.stock} ${ingredient.unit} of ${ingredient.name} is in stock.`,
        code: 'INSUFFICIENT_STOCK',
      });
    }
    moveStock(ingredient.id, 'waste', -wasteAmount, date || today());
    flushEntryPushes();
    const newStock = db.prepare('SELECT stock FROM ingredients WHERE id = ?').get(ingredient.id).stock;

    syncUpsert('ingredients', { ...ingredient, stock: newStock });
    res.json({ ...ingredient, stock: newStock });
  } catch (error) {
    console.error('Error reporting waste:', error);
    res.status(500).json({ error: 'Failed to report waste' });
  }
});

// GET low stock items count for POS banner
router.get('/low-stock', (req, res) => {
  try {
    const lowStockCount = db.prepare('SELECT COUNT(*) as count FROM ingredients WHERE stock <= low_stock_threshold').get();
    res.json({ count: lowStockCount.count });
  } catch (error) {
    console.error('Error fetching low stock count:', error);
    res.status(500).json({ error: 'Failed to fetch low stock count' });
  }
});

module.exports = router;
