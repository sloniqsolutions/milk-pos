/**
 * How much of an ingredient ONE unit of a sold order line represents, so a
 * column of quantities can actually be added up.
 *
 * "Quantity" on its own cannot be summed: a 2 Litre pack sold three times is
 * quantity 3 but 6 litres; a custom line "Milk (0.63 L)" is quantity 0.63 and IS
 * litres; "Dahi (192 g)" is quantity 0.1923 and is kilograms. These are the same
 * rules as cloud/db/item-quantities.js (kept identical on purpose, so the till's
 * Reports and the dashboard's can never show different totals for one sale), and
 * they mirror what the till's recipes do — see db/menu-pricing.js.
 *
 *   Milk — returns litres per unit.
 *   Dahi — returns GRAMS per unit (the Yogurt ingredient is counted in grams).
 */
function unitAmount(category, name) {
  const label = String(name || '').trim();
  if (category === 'Milk') {
    if (/^milk\s*\(/i.test(label)) return 1; // custom amount: quantity is litres
    const pack = label.match(/([\d.]+)\s*Litre/i);
    return pack ? parseFloat(pack[1]) : 1;
  }
  if (category === 'Dahi') {
    if (/^dahi\s*\(/i.test(label) || /^dahi$/i.test(label)) return 1000; // custom: quantity is kilograms
    const kg = label.match(/([\d.]+)\s*kg\b/i);
    if (kg) return parseFloat(kg[1]) * 1000;
    const g = label.match(/([\d.]+)\s*g(rams?)?\b/i);
    if (g) return parseFloat(g[1]);
    return 1000;
  }
  return 0;
}

module.exports = { unitAmount };
