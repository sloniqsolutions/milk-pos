const db = require('./database');

/**
 * Universal-price cascade for Milk and Dahi.
 *
 * "1 Litre" is the one true per-litre Milk price and "Dahi" is the one true
 * per-kilogram Dahi price — every other sized item (0.5 Litre, 2 Litre, a
 * future 1.5 Litre, a future 250g Dahi, ...) is defined as a multiple of
 * whichever of those two it belongs to, not an independently-typed number.
 * Editing "1 Litre" or "Dahi" must therefore re-price every sibling in the
 * same pass — that's what this module does, called from routes/menu.js right
 * after a menu_items UPDATE commits.
 *
 * Kept name-driven (parsing "0.5 Litre" / "250g") rather than a schema
 * column, because the two universal items ("1 Litre", "Dahi") are already
 * identified by name throughout this codebase (see AddMilkDahiModal.jsx,
 * db/database.js's seed migrations) — a size factor column would just be a
 * second way of saying what the name already says, and could drift from it.
 */

const MILK_UNIVERSAL_NAME = '1 Litre';
const DAHI_UNIVERSAL_NAME = 'Dahi';

/** "0.5 Litre" -> 0.5, "2 Litre" -> 2, "1 Litre" -> 1. Null if unparseable. */
function parseMilkLitres(name) {
  const m = String(name || '').match(/([\d.]+)\s*Litre/i);
  return m ? parseFloat(m[1]) : null;
}

/** "250g" / "250 grams" -> 0.25, "1.5kg" / "1.5 KG" -> 1.5. Null if unparseable
 * and not the universal item itself (which is exactly 1x). */
function parseDahiFactor(name) {
  const trimmed = String(name || '').trim();
  if (/^dahi$/i.test(trimmed)) return 1;
  const kg = trimmed.match(/([\d.]+)\s*kg\b/i);
  if (kg) return parseFloat(kg[1]);
  const g = trimmed.match(/([\d.]+)\s*g(rams?)?\b/i);
  if (g) return parseFloat(g[1]) / 1000;
  return null;
}

/**
 * Recomputes every other active Milk/Dahi item's price from the given
 * universal item's new price. Call with the item that was just saved; a no-op
 * if it isn't one of the two universal items.
 */
function cascadeUniversalPricing(savedItem) {
  if (!savedItem) return;

  if (savedItem.category === 'Milk' && savedItem.name === MILK_UNIVERSAL_NAME) {
    const perLitre = Number(savedItem.price);
    const siblings = db.prepare(
      "SELECT id, name FROM menu_items WHERE category = 'Milk' AND active = 1 AND name != ?"
    ).all(MILK_UNIVERSAL_NAME);
    const update = db.prepare('UPDATE menu_items SET price = ? WHERE id = ?');
    siblings.forEach(s => {
      const litres = parseMilkLitres(s.name);
      if (litres != null) update.run(Math.round(perLitre * litres), s.id);
    });
  } else if (savedItem.category === 'Dahi' && savedItem.name === DAHI_UNIVERSAL_NAME) {
    const perKg = Number(savedItem.price);
    const siblings = db.prepare(
      "SELECT id, name FROM menu_items WHERE category = 'Dahi' AND active = 1 AND name != ?"
    ).all(DAHI_UNIVERSAL_NAME);
    const update = db.prepare('UPDATE menu_items SET price = ? WHERE id = ?');
    siblings.forEach(s => {
      const factor = parseDahiFactor(s.name);
      if (factor != null) update.run(Math.round(perKg * factor), s.id);
    });
  }
}

/**
 * For a brand-new (or renamed) sibling item, what its price should be right
 * now given the current universal price — so creating "1.5 Litre" prices it
 * off "1 Litre" immediately rather than waiting for the next time "1 Litre"
 * itself is edited. Returns null if this item isn't a derivable Milk/Dahi
 * size (including the universal items themselves, whose price is typed directly).
 */
function derivedPriceFor(category, name) {
  if (category === 'Milk' && name !== MILK_UNIVERSAL_NAME) {
    const litres = parseMilkLitres(name);
    if (litres == null) return null;
    const universal = db.prepare("SELECT price FROM menu_items WHERE category = 'Milk' AND name = ? AND active = 1").get(MILK_UNIVERSAL_NAME);
    return universal ? Math.round(Number(universal.price) * litres) : null;
  }
  if (category === 'Dahi' && name !== DAHI_UNIVERSAL_NAME) {
    const factor = parseDahiFactor(name);
    if (factor == null) return null;
    const universal = db.prepare("SELECT price FROM menu_items WHERE category = 'Dahi' AND name = ? AND active = 1").get(DAHI_UNIVERSAL_NAME);
    return universal ? Math.round(Number(universal.price) * factor) : null;
  }
  return null;
}

module.exports = {
  cascadeUniversalPricing, derivedPriceFor,
  parseMilkLitres, parseDahiFactor, MILK_UNIVERSAL_NAME, DAHI_UNIVERSAL_NAME,
};
