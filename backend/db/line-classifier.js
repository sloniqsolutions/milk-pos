/**
 * Which product an order line is — Milk, Dahi or Other — and how much of it.
 *
 * ONE definition, used by /reports/line-items (Item Sales) and /reports/detailed
 * (Detailed) on both the till and the cloud, so "Milk" means the same thing in
 * every view and on both surfaces, and Milk + Dahi + Other always equals All.
 * Kept identical to cloud/db/line-classifier.js on purpose, like unitAmount.
 *
 * PRIMARY RULE: the menu item's category ('Milk' or 'Dahi'). Any other real
 * category is Other.
 *
 * FALLBACK, for a line with no menu category to go on — a deleted menu item, a
 * NULL category, or a deal — the NAME is read, but ONLY for the exact names this
 * app itself writes:
 *
 *   Milk  "0.5 Litre" / "1 Litre" / "2 Litre"  (the seeded packs, db/menu-data.js)
 *         "Milk (0.6300 L)"                    (a custom line, AddMilkDahiModal.jsx)
 *   Dahi  "Dahi"                               (the universal item)
 *         "0.5 KG" / "2 KG"                    (the seeded sizes, db/database.js)
 *         "Dahi (192 g)"                       (a custom line, AddMilkDahiModal.jsx)
 *
 * Case and spacing are ignored ("milk (0.63 L)", double spaces). Anything else —
 * "1 Liter", "2 Ltr", "Yogurt", "Curd" — is NOT guessed at: it is counted under
 * Other and flagged `category_review`, so a person can look at it. A line is
 * never dropped and never silently reassigned. A deal is always Other: its name
 * is the deal's, not a product's.
 *
 * Inferred lines carry `category_inferred: true` so the screen can badge them.
 *
 * `amount` is the real quantity — litres for Milk, kilograms for Dahi, 0 for
 * Other — from the caller's `unitAmount` (the stock reports' own rule, which is
 * deliberately not changed here). `amount_assumed` is true when the name gave no
 * size and unitAmount fell back to its default (1 L / 1 kg).
 */

const collapse = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');

const MILK_PACK = /^\d+(?:\.\d+)? ?litre$/i;
const MILK_CUSTOM = /^milk \( ?\d+(?:\.\d+)? ?l ?\)$/i;
const DAHI_UNIVERSAL = /^dahi$/i;
const DAHI_PACK = /^\d+(?:\.\d+)? ?kg$/i;
const DAHI_CUSTOM = /^dahi \( ?\d+(?:\.\d+)? ?g ?\)$/i;

// Loose "looks like" patterns, used ONLY to raise a review flag — never to classify.
const LOOKS_MILK = /\bmilk\b|\b(?:litres?|liters?|ltrs?|lt)\b|\bdoodh\b/i;
const LOOKS_DAHI = /\bdahi\b|\byogh?urt\b|\bcurd\b|\braita\b|\blassi\b/i;

/** The product an unlabelled line's NAME confirms, or null. */
function inferFromName(name) {
  const label = collapse(name);
  if (MILK_PACK.test(label) || MILK_CUSTOM.test(label)) return 'Milk';
  if (DAHI_UNIVERSAL.test(label) || DAHI_PACK.test(label) || DAHI_CUSTOM.test(label)) return 'Dahi';
  return null;
}

/** True when unitAmount had no size to read and used its default. */
function amountIsAssumed(group, name) {
  const label = String(name || '').trim();
  if (group === 'Milk') {
    return !(/^milk\s*\(/i.test(label) || /([\d.]+)\s*Litre/i.test(label));
  }
  if (group === 'Dahi') {
    return !(/^dahi\s*\(/i.test(label) || /^dahi$/i.test(label)
      || /([\d.]+)\s*kg\b/i.test(label) || /([\d.]+)\s*g(rams?)?\b/i.test(label));
  }
  return false;
}

function createClassifier(unitAmount) {
  /**
   * @param {{ category?: string|null, is_deal?: number|boolean|null, name?: string, quantity?: number }} line
   * @returns {{ group: 'Milk'|'Dahi'|'Other', amount: number, inferred: boolean, review: boolean, amount_assumed: boolean }}
   */
  function classifyLine(line) {
    const isDeal = Number(line.is_deal) === 1 || line.is_deal === true;
    const category = line.category == null ? '' : String(line.category);
    const hasMenuCategory = !isDeal && category !== '' && category !== 'Removed Item' && category !== 'Deals';

    let group = 'Other';
    let inferred = false;
    if (hasMenuCategory) {
      if (category === 'Milk' || category === 'Dahi') group = category;
    } else if (!isDeal) {
      const found = inferFromName(line.name);
      if (found) { group = found; inferred = true; }
    }

    const review = !hasMenuCategory && !isDeal && group === 'Other'
      && (LOOKS_MILK.test(String(line.name || '')) || LOOKS_DAHI.test(String(line.name || '')));

    let amount = 0;
    let assumed = false;
    if (group === 'Milk') {
      amount = (Number(line.quantity) || 0) * unitAmount('Milk', line.name);
      assumed = amountIsAssumed('Milk', line.name);
    } else if (group === 'Dahi') {
      amount = (Number(line.quantity) || 0) * unitAmount('Dahi', line.name) / 1000;
      assumed = amountIsAssumed('Dahi', line.name);
    }
    return { group, amount, inferred, review, amount_assumed: assumed };
  }

  /**
   * Splits every order's lines by product, for /reports/detailed.
   *
   * @param {{ key: any, category?: string|null, is_deal?: any, name: string, quantity: number, price: number }[]} lines
   *   `key` is whatever identifies the order to the caller (the till's order id,
   *   the cloud's row id).
   * @returns {Map<any, object>} key -> the per-product fields Detailed carries:
   *   milk_/dahi_ value, lines, items, qty, plus other_value / other_lines.
   */
  function splitOrderLines(lines) {
    const round4 = (n) => Math.round((n || 0) * 10000) / 10000;
    const byOrder = new Map();
    for (const l of lines) {
      const c = classifyLine(l);
      if (!byOrder.has(l.key)) {
        byOrder.set(l.key, {
          milk_value: 0, milk_lines: 0, milk_items: [], milk_qty: 0,
          dahi_value: 0, dahi_lines: 0, dahi_items: [], dahi_qty: 0,
          other_value: 0, other_lines: 0,
        });
      }
      const o = byOrder.get(l.key);
      const value = (Number(l.price) || 0) * (Number(l.quantity) || 0);
      const item = `${l.name} x${l.quantity}`;
      if (c.group === 'Milk') { o.milk_value += value; o.milk_lines += 1; o.milk_items.push(item); o.milk_qty += c.amount; }
      else if (c.group === 'Dahi') { o.dahi_value += value; o.dahi_lines += 1; o.dahi_items.push(item); o.dahi_qty += c.amount; }
      else { o.other_value += value; o.other_lines += 1; }
    }
    for (const o of byOrder.values()) {
      o.milk_items = o.milk_items.length ? o.milk_items.join(', ') : null;
      o.dahi_items = o.dahi_items.length ? o.dahi_items.join(', ') : null;
      o.milk_qty = round4(o.milk_qty);
      o.dahi_qty = round4(o.dahi_qty);
    }
    return byOrder;
  }

  return { classifyLine, splitOrderLines };
}

module.exports = { createClassifier, inferFromName };
