/**
 * Postgres counterpart to backend/db/menu-pricing.js — same rule, same
 * parsed-value matching, kept in sync deliberately so a price edit behaves
 * identically whether it happens on a till or on the dashboard (the cloud is
 * the one they eventually converge on — see routes/menu.js's docstring).
 *
 * Whichever active Milk item parses to exactly 1 litre is the one true
 * per-litre price, and whichever active Dahi item parses to exactly 1
 * kilogram is the one true per-kilogram price; every other sized item is a
 * multiple of whichever it belongs to, derived from its own name rather
 * than typed independently.
 *
 * Identified by *parsed value*, not an exact name like "1 Litre" or "Dahi"
 * — the first version of this file matched on exact name, and renaming "1
 * Litre" to "1 Litre Milk" (a completely reasonable thing to type) silently
 * broke every check here: nothing recognized it as universal anymore, and
 * prices just quietly stopped cascading, with no error anywhere.
 * parseMilkLitres("1 Litre Milk") still reads 1, so matching on that instead
 * survives a rename that keeps the size in the name somewhere, which is the
 * case that actually happened.
 */

function parseMilkLitres(name) {
  const m = String(name || '').match(/([\d.]+)\s*Litre/i);
  return m ? parseFloat(m[1]) : null;
}

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
async function findUniversal(client, category) {
  const parse = category === 'Milk' ? parseMilkLitres : parseDahiFactor;
  const { rows } = await client.query('SELECT id, name, price FROM menu_items WHERE category = $1 AND active = 1', [category]);
  return rows.find(r => parse(r.name) === 1) || null;
}

/** Same 0.5x/2x pattern backend/db/database.js's seed migrations establish —
 * see that file's copy of this comment for why the cascade recreates these
 * instead of only updating rows that already exist. No recipe to restore
 * here: recipes/stock deduction are a till-only concept (see db/schema.js —
 * there is no recipes table on the cloud at all). */
const STANDARD_MILK_SIZES = [{ name: '0.5 Litre', factor: 0.5 }, { name: '2 Litre', factor: 2 }];
const STANDARD_DAHI_SIZES = [{ name: '0.5 KG', factor: 0.5 }, { name: '2 KG', factor: 2 }];

/**
 * Recomputes every other active Milk/Dahi item's price from the given
 * universal item's new price, and brings back any of the standard sizes
 * that were deleted (reactivating an existing row, or creating one fresh if
 * it doesn't exist at all). Must be called with the same transaction client
 * the save itself used (see routes/menu.js), and after that save has
 * committed within the transaction. No-op if the saved item isn't currently
 * a universal item (see isMilkUniversal/isDahiUniversal above).
 */
async function cascadeUniversalPricing(client, savedItem) {
  if (!savedItem) return;

  if (savedItem.category === 'Milk' && isMilkUniversal(savedItem.name)) {
    const perLitre = Number(savedItem.price);
    const { rows } = await client.query(
      "SELECT id, name FROM menu_items WHERE category = 'Milk' AND active = 1 AND id != $1",
      [savedItem.id]
    );
    for (const s of rows) {
      const litres = parseMilkLitres(s.name);
      if (litres != null) {
        await client.query('UPDATE menu_items SET price = $1 WHERE id = $2', [Math.round(perLitre * litres), s.id]);
      }
    }

    for (const { name, factor } of STANDARD_MILK_SIZES) {
      const price = Math.round(perLitre * factor);
      const existing = await client.query("SELECT id, active FROM menu_items WHERE category = 'Milk' AND name = $1", [name]);
      if (!existing.rows.length) {
        await client.query(
          "INSERT INTO menu_items (name, category, price, has_variants, active) VALUES ($1, 'Milk', $2, 0, 1)", [name, price]);
      } else if (!existing.rows[0].active) {
        await client.query('UPDATE menu_items SET active = 1, price = $1 WHERE id = $2', [price, existing.rows[0].id]);
      }
    }
  } else if (savedItem.category === 'Dahi' && isDahiUniversal(savedItem.name)) {
    const perKg = Number(savedItem.price);
    const { rows } = await client.query(
      "SELECT id, name FROM menu_items WHERE category = 'Dahi' AND active = 1 AND id != $1",
      [savedItem.id]
    );
    for (const s of rows) {
      const factor = parseDahiFactor(s.name);
      if (factor != null) {
        await client.query('UPDATE menu_items SET price = $1 WHERE id = $2', [Math.round(perKg * factor), s.id]);
      }
    }

    for (const { name, factor } of STANDARD_DAHI_SIZES) {
      const price = Math.round(perKg * factor);
      const existing = await client.query("SELECT id, active FROM menu_items WHERE category = 'Dahi' AND name = $1", [name]);
      if (!existing.rows.length) {
        await client.query(
          "INSERT INTO menu_items (name, category, price, has_variants, active) VALUES ($1, 'Dahi', $2, 0, 1)", [name, price]);
      } else if (!existing.rows[0].active) {
        await client.query('UPDATE menu_items SET active = 1, price = $1 WHERE id = $2', [price, existing.rows[0].id]);
      }
    }
  }
}

/**
 * What a new or renamed sibling item's price should be right now, given the
 * current universal price. Null if this item isn't a derivable Milk/Dahi
 * size (including the universal item itself, whose price is typed directly).
 */
async function derivedPriceFor(client, category, name) {
  if (category === 'Milk' && !isMilkUniversal(name)) {
    const litres = parseMilkLitres(name);
    if (litres == null) return null;
    const universal = await findUniversal(client, 'Milk');
    return universal ? Math.round(Number(universal.price) * litres) : null;
  }
  if (category === 'Dahi' && !isDahiUniversal(name)) {
    const factor = parseDahiFactor(name);
    if (factor == null) return null;
    const universal = await findUniversal(client, 'Dahi');
    return universal ? Math.round(Number(universal.price) * factor) : null;
  }
  return null;
}

module.exports = {
  cascadeUniversalPricing, derivedPriceFor,
  parseMilkLitres, parseDahiFactor, isMilkUniversal, isDahiUniversal, findUniversal,
};
