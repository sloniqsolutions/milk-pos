const db = require('./database');

/**
 * Universal-price cascade for Milk and Dahi.
 *
 * Whichever active Milk item parses to exactly 1 litre is the one true
 * per-litre price, and whichever active Dahi item parses to exactly 1
 * kilogram is the one true per-kilogram price — every other sized item
 * (0.5 Litre, 2 Litre, a future 1.5 Litre, a future 250g Dahi, ...) is
 * defined as a multiple of whichever it belongs to, not an independently
 * typed number. Editing the universal item must therefore re-price every
 * sibling in the same pass — that's what this module does, called from
 * routes/menu.js right after a menu_items UPDATE commits.
 *
 * Identified by *parsed value*, not by an exact name like "1 Litre" or
 * "Dahi" — the first version of this file matched on exact name, and a shop
 * renaming their own "1 Litre" to "1 Litre Milk" (a completely reasonable
 * thing to type) silently broke every check in this file: the cascade
 * stopped recognizing it as universal, derivedPriceFor stopped pricing
 * siblings off it, and there was no error anywhere — prices just quietly
 * stopped updating. parseMilkLitres("1 Litre Milk") still reads 1, so
 * matching on that instead survives a rename that keeps the size in the
 * name somewhere, which is the case that actually happened.
 */

/** "0.5 Litre" -> 0.5, "2 Litre" -> 2, "1 Litre Milk" -> 1. Null if unparseable. */
function parseMilkLitres(name) {
  const m = String(name || '').match(/([\d.]+)\s*Litre/i);
  return m ? parseFloat(m[1]) : null;
}

/** "250g" / "250 grams" -> 0.25, "1.5kg" / "1.5 KG" -> 1.5, bare "Dahi" -> 1.
 * Null if unparseable. */
function parseDahiFactor(name) {
  const trimmed = String(name || '').trim();
  if (/^dahi$/i.test(trimmed)) return 1;
  const kg = trimmed.match(/([\d.]+)\s*kg\b/i);
  if (kg) return parseFloat(kg[1]);
  const g = trimmed.match(/([\d.]+)\s*g(rams?)?\b/i);
  if (g) return parseFloat(g[1]) / 1000;
  return null;
}

const isMilkUniversal = (name) => parseMilkLitres(name) === 1;
const isDahiUniversal = (name) => parseDahiFactor(name) === 1;

/** The current universal item for a category, however it's currently named
 * — the first active row whose name parses to exactly 1x. Null if none. */
function findUniversal(category) {
  const parse = category === 'Milk' ? parseMilkLitres : parseDahiFactor;
  const rows = db.prepare('SELECT id, name, price FROM menu_items WHERE category = ? AND active = 1').all(category);
  return rows.find(r => parse(r.name) === 1) || null;
}

/**
 * The sizes every shop is assumed to want, beyond the universal item itself
 * — the same 0.5x/2x pattern db/database.js's seed migrations establish for
 * both Milk and Dahi. cascadeUniversalPricing uses this to bring a deleted
 * size back rather than leaving a gap: deleting "0.5 Litre" and then editing
 * the universal item's price used to do nothing for it (the cascade only
 * updated rows that already existed), which read as "changing the universal
 * price is supposed to regenerate the others" simply not working.
 */
const STANDARD_MILK_SIZES = [{ name: '0.5 Litre', factor: 0.5 }, { name: '2 Litre', factor: 2 }];
const STANDARD_DAHI_SIZES = [{ name: '0.5 KG', factor: 0.5, grams: 500 }, { name: '2 KG', factor: 2, grams: 2000 }];

/** Ensures a recipe exists for `itemId` consuming `quantity` of
 * `ingredientId`, replacing whatever recipe_ingredients rows it had (same
 * idempotent pattern db/database.js's own seed migrations use). */
function ensureRecipe(itemId, ingredientId, quantity) {
  const existing = db.prepare('SELECT id FROM recipes WHERE menu_item_id = ?').get(itemId);
  const recipeId = existing
    ? existing.id
    : db.prepare('INSERT INTO recipes (menu_item_id, variant_id) VALUES (?, NULL)').run(itemId).lastInsertRowid;
  db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(recipeId);
  db.prepare('INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity_required) VALUES (?, ?, ?)').run(recipeId, ingredientId, quantity);
}

/**
 * Recomputes every other active Milk/Dahi item's price from the given
 * universal item's new price, and brings back any of the standard sizes that
 * were deleted (reactivating an existing row, or creating one fresh with its
 * recipe if it somehow doesn't exist at all). Call with the item that was
 * just saved; a no-op if it isn't currently a universal item (see
 * isMilkUniversal/isDahiUniversal above for what that means).
 */
function cascadeUniversalPricing(savedItem) {
  if (!savedItem) return;

  if (savedItem.category === 'Milk' && isMilkUniversal(savedItem.name)) {
    const perLitre = Number(savedItem.price);
    const siblings = db.prepare(
      'SELECT id, name FROM menu_items WHERE category = \'Milk\' AND active = 1 AND id != ?'
    ).all(savedItem.id);
    const update = db.prepare('UPDATE menu_items SET price = ? WHERE id = ?');
    siblings.forEach(s => {
      const litres = parseMilkLitres(s.name);
      if (litres != null) update.run(Math.round(perLitre * litres), s.id);
    });

    const milkIng = db.prepare("SELECT id FROM ingredients WHERE name = 'Milk'").get();
    STANDARD_MILK_SIZES.forEach(({ name, factor }) => {
      const price = Math.round(perLitre * factor);
      const existing = db.prepare("SELECT id, active FROM menu_items WHERE category = 'Milk' AND name = ?").get(name);
      if (!existing) {
        const itemId = db.prepare(
          "INSERT INTO menu_items (name, category, price, has_variants, active) VALUES (?, 'Milk', ?, 0, 1)"
        ).run(name, price).lastInsertRowid;
        if (milkIng) ensureRecipe(itemId, milkIng.id, factor);
      } else if (!existing.active) {
        db.prepare('UPDATE menu_items SET active = 1, price = ? WHERE id = ?').run(price, existing.id);
        if (milkIng) ensureRecipe(existing.id, milkIng.id, factor);
      }
    });
  } else if (savedItem.category === 'Dahi' && isDahiUniversal(savedItem.name)) {
    const perKg = Number(savedItem.price);
    const siblings = db.prepare(
      'SELECT id, name FROM menu_items WHERE category = \'Dahi\' AND active = 1 AND id != ?'
    ).all(savedItem.id);
    const update = db.prepare('UPDATE menu_items SET price = ? WHERE id = ?');
    siblings.forEach(s => {
      const factor = parseDahiFactor(s.name);
      if (factor != null) update.run(Math.round(perKg * factor), s.id);
    });

    const yogurtIng = db.prepare("SELECT id FROM ingredients WHERE name = 'Yogurt'").get();
    STANDARD_DAHI_SIZES.forEach(({ name, factor, grams }) => {
      const price = Math.round(perKg * factor);
      const existing = db.prepare("SELECT id, active FROM menu_items WHERE category = 'Dahi' AND name = ?").get(name);
      if (!existing) {
        const itemId = db.prepare(
          "INSERT INTO menu_items (name, category, price, has_variants, active) VALUES (?, 'Dahi', ?, 0, 1)"
        ).run(name, price).lastInsertRowid;
        if (yogurtIng) ensureRecipe(itemId, yogurtIng.id, grams);
      } else if (!existing.active) {
        db.prepare('UPDATE menu_items SET active = 1, price = ? WHERE id = ?').run(price, existing.id);
        if (yogurtIng) ensureRecipe(existing.id, yogurtIng.id, grams);
      }
    });
  }
}

/**
 * For a brand-new (or renamed) sibling item, what its price should be right
 * now given the current universal price — so creating "1.5 Litre" prices it
 * off the universal item immediately rather than waiting for the next time
 * that item's price is edited. Returns null if this item isn't a derivable
 * Milk/Dahi size (including the universal item itself, whose price is typed
 * directly).
 */
function derivedPriceFor(category, name) {
  if (category === 'Milk' && !isMilkUniversal(name)) {
    const litres = parseMilkLitres(name);
    if (litres == null) return null;
    const universal = findUniversal('Milk');
    return universal ? Math.round(Number(universal.price) * litres) : null;
  }
  if (category === 'Dahi' && !isDahiUniversal(name)) {
    const factor = parseDahiFactor(name);
    if (factor == null) return null;
    const universal = findUniversal('Dahi');
    return universal ? Math.round(Number(universal.price) * factor) : null;
  }
  return null;
}

module.exports = {
  cascadeUniversalPricing, derivedPriceFor,
  parseMilkLitres, parseDahiFactor, isMilkUniversal, isDahiUniversal, findUniversal,
};
