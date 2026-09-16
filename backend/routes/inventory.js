const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { syncUpsert } = require('../db/cloud-sync');

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

const recordEntry = db.prepare(
  'INSERT INTO inventory_entries (ingredient_id, type, amount, entry_date) VALUES (?, ?, ?, ?)'
);

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
  const { name, unit, stock, low_stock_threshold, date } = req.body;
  if (!name || !unit) {
    return res.status(400).json({ error: 'Name and unit are required' });
  }

  try {
    const insert = db.prepare('INSERT INTO ingredients (name, unit, stock, low_stock_threshold) VALUES (?, ?, ?, ?)');
    const startingStock = stock || 0;
    const result = insert.run(name, unit, startingStock, low_stock_threshold || 0);
    if (startingStock > 0) {
      recordEntry.run(result.lastInsertRowid, 'stock', startingStock, date || today());
    }
    const newIngredient = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(result.lastInsertRowid);
    syncUpsert('ingredients', newIngredient);
    res.status(201).json(newIngredient);
  } catch (error) {
    console.error('Error adding ingredient:', error);
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: 'Ingredient with this name already exists' });
    }
    res.status(500).json({ error: 'Failed to add ingredient' });
  }
});

// PUT update stock (can be absolute or delta based on what client sends. We'll expect { stock: 50 })
// For a robust system we can allow { action: 'add', amount: 50 } or { stock: 50 }
router.put('/:id/stock', (req, res) => {
  const { id } = req.params;
  const { action, amount, stock, date } = req.body;

  try {
    const ingredient = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
    if (!ingredient) {
      return res.status(404).json({ error: 'Ingredient not found' });
    }

    let newStock = ingredient.stock;
    if (action === 'add') {
      newStock += parseFloat(amount);
    } else if (action === 'subtract') {
      // Clamp at 0 — stock cannot go negative from a manual adjustment either.
      newStock = Math.max(0, newStock - parseFloat(amount));
    } else if (stock !== undefined) {
      newStock = parseFloat(stock);
    } else {
      return res.status(400).json({ error: 'Invalid stock update request' });
    }

    const update = db.prepare('UPDATE ingredients SET stock = ? WHERE id = ?');
    update.run(newStock, id);

    // Logged as the actual change applied, not the requested amount — a
    // subtract that got clamped at 0 should show up in history as exactly
    // what left the stock, not the bigger number that was typed in.
    const delta = newStock - ingredient.stock;
    if (delta !== 0) {
      recordEntry.run(id, 'stock', delta, date || today());
    }

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
  const { threshold } = req.body;

  if (threshold === undefined) {
    return res.status(400).json({ error: 'Threshold is required' });
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
      SELECT ie.id, ie.ingredient_id, ie.type, ie.amount, ie.entry_date, ie.created_at,
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
  const { milk_amount, yogurt_amount, date } = req.body;
  const milkAmount = parseFloat(milk_amount);
  const yogurtAmount = parseFloat(yogurt_amount);

  if (!(milkAmount > 0) || !(yogurtAmount > 0)) {
    return res.status(400).json({ error: 'Enter how much milk is used and how much yogurt is being added.' });
  }

  try {
    const milk = db.prepare("SELECT * FROM ingredients WHERE name = 'Milk'").get();
    const yogurt = db.prepare("SELECT * FROM ingredients WHERE name = 'Yogurt'").get();
    if (!milk || !yogurt) {
      return res.status(500).json({ error: 'Milk or Yogurt ingredient is missing from inventory.' });
    }
    if (milk.stock < milkAmount) {
      return res.status(400).json({ error: 'Not enough milk in stock.', code: 'INSUFFICIENT_MILK' });
    }

    const entryDate = date || today();
    const newMilkStock = milk.stock - milkAmount;
    const newYogurtStock = yogurt.stock + yogurtAmount;

    const convert = db.transaction(() => {
      db.prepare('UPDATE ingredients SET stock = ? WHERE id = ?').run(newMilkStock, milk.id);
      db.prepare('UPDATE ingredients SET stock = ? WHERE id = ?').run(newYogurtStock, yogurt.id);
      recordEntry.run(milk.id, 'yogurt_conversion', -milkAmount, entryDate);
      recordEntry.run(yogurt.id, 'yogurt_conversion', yogurtAmount, entryDate);
    });
    convert();

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
  const { ingredient_id, amount, date } = req.body;
  const wasteAmount = parseFloat(amount);

  if (!ingredient_id || !(wasteAmount > 0)) {
    return res.status(400).json({ error: 'Choose an ingredient and enter an amount.' });
  }

  try {
    const ingredient = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(ingredient_id);
    if (!ingredient) {
      return res.status(404).json({ error: 'Ingredient not found' });
    }

    // Clamp at 0, same as a manual "subtract" adjustment — recorded amount
    // reflects what actually left the stock.
    const newStock = Math.max(0, ingredient.stock - wasteAmount);
    const actualWaste = ingredient.stock - newStock;
    const entryDate = date || today();

    const reportWaste = db.transaction(() => {
      db.prepare('UPDATE ingredients SET stock = ? WHERE id = ?').run(newStock, ingredient.id);
      recordEntry.run(ingredient.id, 'waste', -actualWaste, entryDate);
    });
    reportWaste();

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
