/**
 * Milk and Yogurt consumed by sales that never logged their stock movement.
 *
 * The Reports' "Used"/"Sold" figures normally add up the stock movements a till
 * logs as it rings a sale up (inventory_entries, type 'sale'). A till running an
 * older build of the app deducts stock but never logs that movement, and a sale
 * of an item with no recipe moves nothing at all. In both cases the sale is on
 * the cloud — revenue shows — yet Milk/Yogurt Used read 0 while stock fell.
 *
 * This fills exactly those gaps and nothing else: for each day, and each device
 * (till) that pushed sales that day, it derives what the sold order lines
 * consumed — but only if that device logged no 'sale' movement at all for that
 * ingredient on that day. Where it did log, the logged figure stands alone, so
 * nothing is ever counted twice.
 *
 * It mirrors what the till's recipes do (see backend/db/menu-pricing.js):
 *   Milk — a pack ("0.5 Litre", "2 Litre") consumes its size per unit sold; a
 *          custom line ("Milk (0.63 L)") is rung up against the 1-litre item, so
 *          its quantity already *is* litres.
 *   Dahi — Yogurt is counted in grams. "Dahi" is 1 kg per unit, "0.5 KG" / "250g"
 *          packs their own weight, and a custom line ("Dahi (192 g)") is rung up
 *          against the 1 kg item, so its quantity is kilograms.
 */

const INGREDIENT_FOR_CATEGORY = { Milk: 'Milk', Dahi: 'Yogurt' };

/** Units of the ingredient consumed by ONE unit of this order line. */
function unitAmount(category, name) {
  const label = String(name || '').trim();
  if (category === 'Milk') {
    if (/^milk\s*\(/i.test(label)) return 1;
    const pack = label.match(/([\d.]+)\s*Litre/i);
    return pack ? parseFloat(pack[1]) : 1;
  }
  if (category === 'Dahi') {
    if (/^dahi\s*\(/i.test(label) || /^dahi$/i.test(label)) return 1000;
    const kg = label.match(/([\d.]+)\s*kg\b/i);
    if (kg) return parseFloat(kg[1]) * 1000;
    const g = label.match(/([\d.]+)\s*g(rams?)?\b/i);
    if (g) return parseFloat(g[1]);
    return 1000;
  }
  return 0;
}

/**
 * @returns {Promise<Map<string, number>>} "YYYY-MM-DD|IngredientName" -> amount
 *   consumed by sales with no logged movement, for from..to inclusive.
 */
async function unloggedSold(db, branchId, from, to) {
  const [lines, logged] = await Promise.all([
    db.q(`
      SELECT o.created_at::date::text AS day, o.device_id AS device, oi.category AS category,
             oi.name AS name, SUM(oi.quantity)::float8 AS qty
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
       WHERE oi.branch_id = ? AND o.status != 'voided'
         AND o.created_at::date BETWEEN ?::date AND ?::date
         AND oi.category IN ('Milk', 'Dahi') AND COALESCE(oi.is_deal, 0) = 0
       GROUP BY 1, 2, 3, 4
    `, [branchId, from, to]),
    db.q(`
      SELECT e.entry_date AS day, e.device_id AS device, i.name AS name
        FROM inventory_entries e
        JOIN ingredients i ON i.branch_id = e.branch_id AND i.local_id = e.ingredient_local_id
       WHERE e.branch_id = ? AND e.type = 'sale'
         AND e.entry_date::date BETWEEN ?::date AND ?::date
       GROUP BY 1, 2, 3
    `, [branchId, from, to]),
  ]);

  const hasLogged = new Set(logged.map((l) => `${l.day}|${l.device}|${l.name}`));
  const out = new Map();
  for (const l of lines) {
    const ingredient = INGREDIENT_FOR_CATEGORY[l.category];
    if (!ingredient || hasLogged.has(`${l.day}|${l.device}|${ingredient}`)) continue;
    const amount = (Number(l.qty) || 0) * unitAmount(l.category, l.name);
    if (!(amount > 0)) continue;
    const key = `${l.day}|${ingredient}`;
    out.set(key, (out.get(key) || 0) + amount);
  }
  return out;
}

module.exports = { unloggedSold, unitAmount };
