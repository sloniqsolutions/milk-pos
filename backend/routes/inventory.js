const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { syncUpsert } = require('../db/cloud-sync');

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
  const { name, unit, stock, low_stock_threshold } = req.body;
  if (!name || !unit) {
    return res.status(400).json({ error: 'Name and unit are required' });
  }

  try {
    const insert = db.prepare('INSERT INTO ingredients (name, unit, stock, low_stock_threshold) VALUES (?, ?, ?, ?)');
    const result = insert.run(name, unit, stock || 0, low_stock_threshold || 0);
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
  const { action, amount, stock } = req.body;

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
