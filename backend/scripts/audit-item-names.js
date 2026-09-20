/**
 * READ-ONLY audit of every order line's name / category / price, ahead of the
 * Item Sales Milk / Dahi filter. Changes nothing: the database is opened with
 * `readonly: true`, and db/database.js (which runs migrations) is NOT loaded.
 *
 *   node scripts/run-script.js scripts/audit-item-names.js
 *   node scripts/run-script.js scripts/audit-item-names.js --db "C:\path\to\pos_database.db"
 *   node scripts/run-script.js scripts/audit-item-names.js --json      (JSON only)
 *
 * On an installed till the database is %APPDATA%\pure-milk-pos\data\pos_database.db
 * (see frontend/electron/data-dir.js) — that is where this looks when --db and
 * POS_USER_DATA_PATH are not given. Stop the till first if you can; if it is
 * running this still works (a read-only reader does not block WAL writers).
 *
 * What it prints: for every distinct (name, category, is_deal, orphan, price) the
 * line count, summed quantity and summed price * quantity — non-voided and
 * voided kept apart — then one row per name saying how the reports classify it
 * TODAY and what unitAmount() makes of it, with the ambiguities flagged.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { unitAmount } = require('../db/item-quantities');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

function findDb() {
  const candidates = [
    option('--db'),
    process.env.POS_USER_DATA_PATH && path.join(process.env.POS_USER_DATA_PATH, 'pos_database.db'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'pure-milk-pos', 'data', 'pos_database.db'),
    path.join(__dirname, '..', 'pos_database.db'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const dbPath = findDb();
if (!dbPath) {
  console.error('Could not find pos_database.db. Pass --db "<full path>".');
  process.exit(1);
}
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

// ---------------------------------------------------------------------------
// 1. Raw grouping — exactly the join the reports use (menu_items via
//    menu_item_id, never for deals).
// ---------------------------------------------------------------------------
const rows = db.prepare(`
  SELECT
    CASE WHEN o.status = 'voided' THEN 1 ELSE 0 END AS voided,
    oi.name                                          AS name,
    m.category                                       AS menu_category,
    oi.is_deal                                       AS is_deal,
    CASE WHEN m.id IS NULL THEN 1 ELSE 0 END         AS orphan,
    oi.price                                         AS price,
    COUNT(*)                                         AS lines,
    ROUND(SUM(oi.quantity), 4)                       AS sum_quantity,
    ROUND(SUM(oi.price * oi.quantity), 2)            AS sum_value,
    SUM(CASE WHEN o.is_employee = 1 THEN 1 ELSE 0 END) AS staff_lines
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  LEFT JOIN menu_items m ON m.id = oi.menu_item_id AND oi.is_deal = 0
  GROUP BY voided, oi.name, m.category, oi.is_deal, orphan, oi.price
  ORDER BY voided, oi.name, oi.price
`).all();

// What each report labels the line. Till /line-items: 'Deals' for deals, else
// the menu category, else 'Removed Item'. The cloud stores whatever category the
// till sent, which is NULL for deals AND orphans, so it labels both 'Removed Item'.
const tillLabel = (r) => (r.is_deal ? 'Deals' : (r.menu_category || 'Removed Item'));
const cloudLabel = (r) => (r.menu_category || 'Removed Item');
// What /detailed's milk_value / dahi_value / other_value buckets do with it.
const detailedBucket = (r) => (r.menu_category === 'Milk' ? 'Milk' : r.menu_category === 'Dahi' ? 'Dahi' : 'Other');

// ---------------------------------------------------------------------------
// 2. What unitAmount() does with a name, and WHICH branch fired. The branches
//    below mirror db/item-quantities.js; the result is cross-checked against
//    the real function so a drift between the two is reported, not hidden.
// ---------------------------------------------------------------------------
function explainAmount(category, name) {
  const label = String(name || '').trim();
  let branch;
  let value;
  if (category === 'Milk') {
    if (/^milk\s*\(/i.test(label)) { branch = 'custom (quantity is litres)'; value = 1; }
    else {
      const pack = label.match(/([\d.]+)\s*Litre/i);
      if (pack) { branch = 'parsed'; value = parseFloat(pack[1]); }
      else { branch = 'DEFAULTED to 1 L (no "N Litre" in name)'; value = 1; }
    }
  } else if (category === 'Dahi') {
    if (/^dahi\s*\(/i.test(label) || /^dahi$/i.test(label)) { branch = 'custom (quantity is kg)'; value = 1000; }
    else {
      const kg = label.match(/([\d.]+)\s*kg\b/i);
      const g = label.match(/([\d.]+)\s*g(rams?)?\b/i);
      if (kg) { branch = 'parsed'; value = parseFloat(kg[1]) * 1000; }
      else if (g) { branch = 'parsed'; value = parseFloat(g[1]); }
      else { branch = 'DEFAULTED to 1000 g (no kg/g in name)'; value = 1000; }
    }
  } else {
    branch = 'n/a (not Milk/Dahi today)';
    value = 0;
  }
  const real = unitAmount(category, name);
  return { branch, value, matchesUnitAmount: real === value };
}

// Loose "looks like" patterns, used ONLY to flag — never to classify.
const LOOKS_MILK = /\bmilk\b|\bl(?:i)?tre?s?\b|\bltr\b|\bdoodh\b|\bdoodh\b/i;
const LOOKS_DAHI = /\bdahi\b|\byogh?urt\b|\bcurd\b|\braita\b|\blassi\b/i;

// One key per "same name": case, spacing, punctuation and unit spelling folded.
function foldName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9.()\s]/g, ' ')
    .replace(/\b(litres?|liters?|ltrs?|ltr|lt|l)\b/g, 'l')
    .replace(/\b(kgs?|kilograms?|kilos?)\b/g, 'kg')
    .replace(/\b(grams?|gms?|gm|g)\b/g, 'g')
    .replace(/\byogh?urt\b/g, 'dahi')
    .replace(/\bcurd\b/g, 'dahi')
    .replace(/\s+/g, ' ')
    .replace(/(\d)\s+(l|kg|g)\b/g, '$1$2')
    .trim();
}

// ---------------------------------------------------------------------------
// 3. One row per raw name.
// ---------------------------------------------------------------------------
const byName = new Map();
for (const r of rows) {
  if (!byName.has(r.name)) byName.set(r.name, []);
  byName.get(r.name).push(r);
}

const names = [];
for (const [name, group] of byName) {
  const live = group.filter((r) => !r.voided);
  const voidedOnly = live.length === 0;
  const use = voidedOnly ? group : live;

  const categories = [...new Set(use.map(tillLabel))];
  const menuCategories = [...new Set(use.map((r) => r.menu_category).filter(Boolean))];
  const prices = [...new Set(use.map((r) => r.price))].sort((a, b) => a - b);
  const sum = (key, list = use) => list.reduce((n, r) => n + (Number(r[key]) || 0), 0);

  // Amount parsing is category-driven, so report it for whichever of Milk/Dahi
  // the name is filed under today; a name filed elsewhere gets 'n/a'.
  const amountCategory = menuCategories.find((c) => c === 'Milk' || c === 'Dahi') || null;
  const explained = amountCategory ? explainAmount(amountCategory, name) : null;

  const flags = [];
  if (explained && /DEFAULTED/.test(explained.branch)) flags.push('AMOUNT-DEFAULTED');
  if (explained && !explained.matchesUnitAmount) flags.push('UNITAMOUNT-DRIFT');
  const orphanOrDeal = use.some((r) => r.orphan || r.is_deal);
  if (orphanOrDeal && LOOKS_MILK.test(name)) flags.push('LOOKS-MILK-BUT-UNCATEGORISED');
  if (orphanOrDeal && LOOKS_DAHI.test(name)) flags.push('LOOKS-DAHI-BUT-UNCATEGORISED');
  if (!amountCategory && !orphanOrDeal && LOOKS_MILK.test(name)) flags.push('LOOKS-MILK-BUT-FILED-ELSEWHERE');
  if (!amountCategory && !orphanOrDeal && LOOKS_DAHI.test(name)) flags.push('LOOKS-DAHI-BUT-FILED-ELSEWHERE');
  if (categories.length > 1) flags.push('MULTIPLE-CATEGORIES');
  if (prices.length > 1) flags.push('MULTIPLE-PRICES');
  if (use.some((r) => Number(r.price) === 0)) flags.push('PRICE-0');
  if (sum('staff_lines') > 0) flags.push('STAFF-LINES');
  if (name !== name.trim() || /\s{2}/.test(name)) flags.push('WHITESPACE');
  if (voidedOnly) flags.push('VOIDED-ONLY');
  if (use.some((r) => tillLabel(r) !== cloudLabel(r))) flags.push('TILL-VS-CLOUD-LABEL-DIFFER');

  names.push({
    name,
    fold: foldName(name),
    till_category: categories.join(' / '),
    cloud_category: [...new Set(use.map(cloudLabel))].join(' / '),
    detailed_bucket: [...new Set(use.map(detailedBucket))].join(' / '),
    lines: sum('lines'),
    sum_quantity: Math.round(sum('sum_quantity') * 10000) / 10000,
    sum_value: Math.round(sum('sum_value') * 100) / 100,
    prices,
    amount_per_unit: explained
      ? (amountCategory === 'Milk' ? `${explained.value} L` : `${explained.value} g`)
      : null,
    amount_rule: explained ? explained.branch : null,
    staff_lines: sum('staff_lines'),
    flags,
  });
}

// Variants: different raw names that fold to the same key.
const foldGroups = new Map();
for (const n of names) {
  if (!foldGroups.has(n.fold)) foldGroups.set(n.fold, []);
  foldGroups.get(n.fold).push(n.name);
}
const variants = [...foldGroups.values()].filter((g) => g.length > 1);
for (const n of names) {
  if ((foldGroups.get(n.fold) || []).length > 1) n.flags.push('NAME-VARIANT');
}

// Names under more than one menu category (the menu itself, not just the sales).
const menu = db.prepare(`
  SELECT name, category, active, price, has_variants FROM menu_items ORDER BY name, category
`).all();
const menuByFold = new Map();
for (const m of menu) {
  const k = foldName(m.name);
  if (!menuByFold.has(k)) menuByFold.set(k, []);
  menuByFold.get(k).push(m);
}
const menuNameInSeveralCategories = [...menuByFold.values()]
  .filter((g) => new Set(g.map((m) => m.category)).size > 1)
  .map((g) => g.map((m) => ({ name: m.name, category: m.category, active: m.active })));

const totals = db.prepare(`
  SELECT
    COUNT(*)                                                         AS lines,
    ROUND(SUM(CASE WHEN o.status != 'voided' THEN oi.price * oi.quantity ELSE 0 END), 2) AS live_value,
    SUM(CASE WHEN o.status != 'voided' THEN 1 ELSE 0 END)            AS live_lines,
    SUM(CASE WHEN o.status = 'voided' THEN 1 ELSE 0 END)             AS voided_lines,
    MIN(o.created_at) AS first_order, MAX(o.created_at) AS last_order
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
`).get();

const report = {
  database: dbPath,
  generated_at: new Date().toISOString(),
  totals,
  distinct_rows: rows,
  names,
  name_variants: variants,
  menu_names_in_several_categories: menuNameInSeveralCategories,
  menu_items: menu,
};

// ---------------------------------------------------------------------------
// 4. Output.
// ---------------------------------------------------------------------------
if (flag('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pad = (v, n) => String(v == null ? '' : v).padEnd(n).slice(0, n);
  console.log(`\nDatabase: ${dbPath}`);
  console.log(`Lines: ${totals.lines} (${totals.live_lines} live, ${totals.voided_lines} voided)   Live value: ${totals.live_value}   ${totals.first_order} -> ${totals.last_order}\n`);
  console.log([pad('NAME', 28), pad('TILL CAT', 14), pad('CLOUD CAT', 14), pad('LINES', 6), pad('PRICES', 16), pad('AMOUNT/UNIT', 12), 'FLAGS'].join(' '));
  for (const n of names) {
    console.log([
      pad(n.name, 28), pad(n.till_category, 14), pad(n.cloud_category, 14), pad(n.lines, 6),
      pad(n.prices.join(','), 16), pad(n.amount_per_unit, 12), n.flags.join(' '),
    ].join(' '));
  }
  console.log('\nName variants (same product spelled differently):', variants.length ? JSON.stringify(variants) : 'none');
  console.log('Menu names in more than one category:', menuNameInSeveralCategories.length ? JSON.stringify(menuNameInSeveralCategories) : 'none');
  console.log('\n----- JSON (paste everything below back) -----');
  console.log(JSON.stringify(report));
}

db.close();
