const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { cascadeUniversalPricing, derivedPriceFor } = require('../db/menu-pricing');
const { syncMenuUpsert } = require('../db/cloud-sync');

/**
 * The menu is editable from both sides once paired: here, and from the
 * dashboard (cloud/routes/menu.js). Every write below still applies locally
 * first — this till never waits on the cloud, same as every other screen —
 * and then pushes the saved row to `POST /api/menu/from-till`
 * (cloud/db/cloud-sync.js -> cloud/routes/menu.js), which upserts it there
 * by name and re-runs the same universal-price cascade the dashboard's own
 * edits trigger. This till's *next* downlink poll pulls that snapshot back
 * down — including any sibling sizes the cascade just repriced that this
 * till never touched directly — so both sides converge without this file
 * needing to know anything about cascades on the cloud's behalf.
 *
 * This used to be blocked outright after a real shop renamed "1 Litre" to
 * "1 Litre Milk" here and the price cascade silently stopped recognizing it,
 * with no error and nothing reaching the dashboard. That bug was in
 * db/menu-pricing.js's exact-name matching, not in allowing the write — it's
 * fixed there now (matching by parsed value instead), so editing here no
 * longer needs to be refused to stay safe.
 */

// Get all menu items. Retired items are hidden unless explicitly requested.
router.get('/', (req, res) => {
  const includeInactive = req.query.include_inactive === '1' || req.query.include_inactive === 'true';
  try {
    const items = db.prepare(
      `SELECT * FROM menu_items ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY category, name`
    ).all();
    const variants = db.prepare('SELECT * FROM item_variants ORDER BY sort_order').all();
    
    // Group variants by menu_item_id
    const variantsByItem = {};
    variants.forEach(v => {
      if (!variantsByItem[v.menu_item_id]) variantsByItem[v.menu_item_id] = [];
      variantsByItem[v.menu_item_id].push({ id: v.id, label: v.label, price: v.price, sort_order: v.sort_order });
    });

    const result = items.map(item => {
      return {
        ...item,
        variants: item.has_variants ? (variantsByItem[item.id] || []) : []
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new item
router.post('/', (req, res) => {
  const { name, category, price, image_url, variants, description } = req.body;
  
  if (!name || !category) {
    return res.status(400).json({ error: 'name and category are required' });
  }

  const hasVariants = Array.isArray(variants) && variants.length > 0;
  
  // Validation
  if (!hasVariants && price === undefined) {
    return res.status(400).json({ error: 'price is required for items without variants' });
  }

  if (hasVariants) {
    for (const v of variants) {
      if (!v.label || typeof v.label !== 'string' || v.label.trim() === '') {
        return res.status(400).json({ error: 'Variant label is required and must be non-empty string' });
      }
      if (v.price === undefined || v.price === null || isNaN(Number(v.price)) || Number(v.price) <= 0) {
        return res.status(400).json({ error: `Variant price must be a numeric value > 0 for label ${v.label}` });
      }
    }
  }

  try {
    const createItem = db.transaction(() => {
      // A sized Milk/Dahi item (e.g. "1.5 Litre", "250g") always prices off
      // the universal item ("1 Litre" / "Dahi") rather than whatever was
      // typed — see db/menu-pricing.js.
      const derived = hasVariants ? null : derivedPriceFor(category, name);
      const dbPrice = hasVariants ? 0 : (derived != null ? derived : Number(price));
      const dbHasVariants = hasVariants ? 1 : 0;

      const result = db.prepare(
        'INSERT INTO menu_items (name, category, price, image_url, has_variants, description) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(name, category, dbPrice, image_url || null, dbHasVariants, description || null);
      
      const itemId = result.lastInsertRowid;
      
      if (hasVariants) {
        const insertVariant = db.prepare('INSERT INTO item_variants (menu_item_id, label, price, sort_order) VALUES (?, ?, ?, ?)');
        variants.forEach((v, index) => {
          insertVariant.run(itemId, v.label.trim(), Number(v.price), v.sort_order || index);
        });
      }
      
      return itemId;
    });

    const newItemId = createItem();

    // Fetch newly created item
    const newItem = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(newItemId);
    if (newItem.has_variants) {
      newItem.variants = db.prepare('SELECT id, label, price, sort_order FROM item_variants WHERE menu_item_id = ? ORDER BY sort_order').all(newItemId);
    } else {
      newItem.variants = [];
    }

    syncMenuUpsert(newItem);
    res.status(201).json(newItem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update item
router.put('/:id', (req, res) => {
  const { name, category, price, image_url, variants, description } = req.body;
  const { id } = req.params;
  
  if (!name || !category) {
    return res.status(400).json({ error: 'name and category are required' });
  }

  const hasVariants = Array.isArray(variants) && variants.length > 0;
  
  if (!hasVariants && price === undefined) {
    return res.status(400).json({ error: 'price is required for items without variants' });
  }

  if (hasVariants) {
    for (const v of variants) {
      if (!v.label || typeof v.label !== 'string' || v.label.trim() === '') {
        return res.status(400).json({ error: 'Variant label is required and must be non-empty string' });
      }
      if (v.price === undefined || v.price === null || isNaN(Number(v.price)) || Number(v.price) <= 0) {
        return res.status(400).json({ error: `Variant price must be a numeric value > 0 for label ${v.label}` });
      }
    }
  }

  try {
    const updateItem = db.transaction(() => {
      const derived = hasVariants ? null : derivedPriceFor(category, name);
      const dbPrice = hasVariants ? 0 : (derived != null ? derived : Number(price));
      const dbHasVariants = hasVariants ? 1 : 0;

      db.prepare(
        'UPDATE menu_items SET name = ?, category = ?, price = ?, image_url = ?, has_variants = ?, description = ? WHERE id = ?'
      ).run(name, category, dbPrice, image_url || null, dbHasVariants, description || null, id);
      
      // Delete existing variants
      db.prepare('DELETE FROM item_variants WHERE menu_item_id = ?').run(id);
      
      if (hasVariants) {
        const insertVariant = db.prepare('INSERT INTO item_variants (menu_item_id, label, price, sort_order) VALUES (?, ?, ?, ?)');
        variants.forEach((v, index) => {
          insertVariant.run(id, v.label.trim(), Number(v.price), v.sort_order || index);
        });
      }
    });

    updateItem();

    const updatedItem = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
    // If this was the "1 Litre" or "Dahi" universal-price item, every other
    // sized item in that category is re-priced off it — see db/menu-pricing.js.
    cascadeUniversalPricing(updatedItem);
    if (updatedItem.has_variants) {
      updatedItem.variants = db.prepare('SELECT id, label, price, sort_order FROM item_variants WHERE menu_item_id = ? ORDER BY sort_order').all(id);
    } else {
      updatedItem.variants = [];
    }

    syncMenuUpsert(updatedItem);
    res.json(updatedItem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Retire a menu item.
 *
 * This was a hard DELETE, which had two failure modes:
 *
 *  1. If the item belonged to a deal, the foreign key on deal_items rejected
 *     it and the operator got a raw 500 "FOREIGN KEY constraint failed" with
 *     no indication of which deal was in the way.
 *  2. When it did succeed, every past order containing that item lost its
 *     category in sales-by-category, because the report joins order_items back
 *     to menu_items. Deleting one line from today's menu silently rewrote
 *     last month's reporting.
 *
 * The row is now marked inactive: it disappears from the menu and the sale
 * screen, deals that reference it keep working, and historical reporting is
 * unchanged.
 */
router.delete('/:id', (req, res) => {
  try {
    const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Menu item not found' });

    db.prepare('UPDATE menu_items SET active = 0 WHERE id = ?').run(item.id);

    syncMenuUpsert({ ...item, active: 0 });
    res.json({
      success: true,
      retired: true,
      name: item.name,
      used_in_deals: [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore a retired item.
router.put('/:id/restore', (req, res) => {
  try {
    const info = db.prepare('UPDATE menu_items SET active = 1 WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Menu item not found' });

    const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
    syncMenuUpsert(item);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
