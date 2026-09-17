/**
 * Postgres counterpart to backend/db/menu-pricing.js — same rule, same
 * name-driven parsing, kept in sync deliberately so a price edit behaves
 * identically whether it happens on a till or on the dashboard (the cloud is
 * the one they eventually converge on — see routes/menu.js's docstring).
 *
 * "1 Litre" is the one true per-litre Milk price and "Dahi" is the one true
 * per-kilogram Dahi price; every other sized item is a multiple of whichever
 * it belongs to, derived from its own name rather than typed independently.
 */

const MILK_UNIVERSAL_NAME = '1 Litre';
const DAHI_UNIVERSAL_NAME = 'Dahi';

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

/**
 * Recomputes every other active Milk/Dahi item's price from the given
 * universal item's new price. Must be called with the same transaction
 * client the save itself used (see routes/menu.js), and after that save has
 * committed within the transaction. No-op if the saved item isn't one of the
 * two universal items.
 */
async function cascadeUniversalPricing(client, savedItem) {
  if (!savedItem) return;

  if (savedItem.category === 'Milk' && savedItem.name === MILK_UNIVERSAL_NAME) {
    const perLitre = Number(savedItem.price);
    const { rows } = await client.query(
      "SELECT id, name FROM menu_items WHERE category = 'Milk' AND active = 1 AND name != $1",
      [MILK_UNIVERSAL_NAME]
    );
    for (const s of rows) {
      const litres = parseMilkLitres(s.name);
      if (litres != null) {
        await client.query('UPDATE menu_items SET price = $1 WHERE id = $2', [Math.round(perLitre * litres), s.id]);
      }
    }
  } else if (savedItem.category === 'Dahi' && savedItem.name === DAHI_UNIVERSAL_NAME) {
    const perKg = Number(savedItem.price);
    const { rows } = await client.query(
      "SELECT id, name FROM menu_items WHERE category = 'Dahi' AND active = 1 AND name != $1",
      [DAHI_UNIVERSAL_NAME]
    );
    for (const s of rows) {
      const factor = parseDahiFactor(s.name);
      if (factor != null) {
        await client.query('UPDATE menu_items SET price = $1 WHERE id = $2', [Math.round(perKg * factor), s.id]);
      }
    }
  }
}

/**
 * What a new or renamed sibling item's price should be right now, given the
 * current universal price. Null if this item isn't a derivable Milk/Dahi
 * size (including the universal items themselves, whose price is typed
 * directly).
 */
async function derivedPriceFor(client, category, name) {
  if (category === 'Milk' && name !== MILK_UNIVERSAL_NAME) {
    const litres = parseMilkLitres(name);
    if (litres == null) return null;
    const { rows } = await client.query(
      "SELECT price FROM menu_items WHERE category = 'Milk' AND name = $1 AND active = 1", [MILK_UNIVERSAL_NAME]
    );
    return rows[0] ? Math.round(Number(rows[0].price) * litres) : null;
  }
  if (category === 'Dahi' && name !== DAHI_UNIVERSAL_NAME) {
    const factor = parseDahiFactor(name);
    if (factor == null) return null;
    const { rows } = await client.query(
      "SELECT price FROM menu_items WHERE category = 'Dahi' AND name = $1 AND active = 1", [DAHI_UNIVERSAL_NAME]
    );
    return rows[0] ? Math.round(Number(rows[0].price) * factor) : null;
  }
  return null;
}

module.exports = {
  cascadeUniversalPricing, derivedPriceFor,
  parseMilkLitres, parseDahiFactor, MILK_UNIVERSAL_NAME, DAHI_UNIVERSAL_NAME,
};
