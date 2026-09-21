/**
 * Which stock entries are provably wrong — decided one entry at a time, against
 * the real order lines. Nothing is decided by date or by which batch an entry
 * came in. Pure: no database in here, so it runs on the till's SQLite and the
 * cloud's Postgres alike (scripts/cleanup-stock-entries.js loads the rows).
 *
 * An entry is DELETE (in the tool: marked corrected, never removed) only if it contradicts the records:
 *   (a) a sale entry whose amount is not what its order line used — Milk copied
 *       from a Dahi line, Yogurt copied from a Milk line — or that names an order
 *       line and disagrees with it
 *   (b) a second entry for an order line (and ingredient) that already has one
 *   (c) never on its own: two tills' entries filed under the same device and
 *       number are only flagged, because the other till's copy may be a real
 *       event. That is ASK ME.
 * An entry that matches a real order line (right ingredient, amount within 0.001)
 * is KEEP, whichever batch it was created in. Real restocks, waste and
 * conversions are KEEP. Anything else is ASK ME. Never a guess.
 */

const { buildStatement } = require('./stock-statement');

const TOLERANCE = 0.001;
const near = (a, b) => Math.abs(a - b) <= TOLERANCE;
const r = (n) => Math.round(n * 1e4) / 1e4;
const INGREDIENT_OF = { Milk: 'Milk', Dahi: 'Yogurt' };
const CREATED_BASE = 9000000; // ids for entries this cleanup creates: stable, so a re-run or a second copy is the same row

/**
 * @param {object} lines one order line: { device, order, item, day, created_at,
 *   status, group: 'Milk'|'Dahi'|'Other', name, quantity, amount } where `amount`
 *   is what the line took from its ingredient, in that ingredient's own unit
 * @param {object[]} entries { key, device, id, ingredient, type, amount, entry_date,
 *   created_at, order, item }
 */
function judge({ entries, lines, batchAt, suspectFrom, suspectTo, collisionKeys }) {
  const collisions = collisionKeys || new Set();

  // The stock each line should have taken: one sale event per line (and, if the
  // order was voided, a return). Voided lines need no entry, but may have them.
  const events = new Map(); // "device|day|ingredient" -> event[]
  const lineByItem = new Map(); // "device|item" -> line
  const daySources = new Map(); // "day|group" -> lines, for the copy test
  for (const l of lines) {
    if (!INGREDIENT_OF[l.group] || !(l.amount > 0)) continue;
    l.ingredient = INGREDIENT_OF[l.group];
    lineByItem.set(`${l.device}|${l.item}`, l);
    const k = `${l.device}|${l.day}|${l.ingredient}`;
    if (!events.has(k)) events.set(k, []);
    const voided = l.status === 'voided';
    events.get(k).push({ line: l, sign: -1, amount: l.amount, required: !voided, by: null });
    if (voided) events.get(k).push({ line: l, sign: 1, amount: l.amount, required: false, by: null });
    const g = `${l.day}|${l.group}`;
    if (!daySources.has(g)) daySources.set(g, []);
    daySources.get(g).push(l);
  }
  const eventsOnDay = (day, ingredient) => [...events].filter(([k]) => k.endsWith(`|${day}|${ingredient}`)).flatMap(([, v]) => v);
  const describe = (l) => `order #${l.order} line #${l.item} (${l.name} x ${l.quantity}) on ${l.day} [${l.device}]`;

  const verdicts = new Map();
  const say = (e, verdict, reason, line) => verdicts.set(e.key, { verdict, reason, line: line || null });

  const sorted = [...entries].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
  const isSale = (e) => e.type === 'sale';

  // ---- non-sale entries are real events; only "suspect" days need a person
  for (const e of sorted) {
    if (isSale(e)) continue;
    const suspect = suspectFrom && suspectTo && e.entry_date >= suspectFrom && e.entry_date <= suspectTo;
    if (collisions.has(e.key)) {
      say(e, 'ASK ME', `another till's entry also uses this device and number and the two disagree; the other copy may be a real event, so this is not deleted on its own`);
    } else if (suspect) {
      say(e, 'ASK ME', `dated ${e.entry_date}, created ${String(e.created_at).slice(0, 10)}: real or test data? Nothing in the orders can settle it`);
    } else {
      say(e, 'KEEP', `a real ${e.type === 'stock' ? (e.amount >= 0 ? 'restock' : 'removal') : e.type === 'waste' ? 'waste' : 'conversion'}; orders cannot contradict it`);
    }
  }

  // ---- sale entries, in two passes: those that name their line, then the rest
  const pending = [];
  for (const e of sorted.filter(isSale)) {
    if (e.item != null) {
      const line = lineByItem.get(`${e.device}|${e.item}`);
      if (!line) { say(e, 'ASK ME', `names order line #${e.item} which is not in the records`); continue; }
      const ev = (events.get(`${line.device}|${line.day}|${line.ingredient}`) || [])
        .find((x) => x.line === line && x.sign === Math.sign(e.amount));
      if (!ev || e.ingredient !== line.ingredient) {
        say(e, 'DELETE', `(a) names ${describe(line)}, which takes ${line.ingredient}, not ${e.ingredient}`, line);
      } else if (!near(Math.abs(e.amount), ev.amount)) {
        say(e, 'DELETE', `(a) says ${Math.abs(e.amount)} but ${describe(line)} used ${ev.amount}`, line);
      } else if (ev.by) {
        say(e, 'DELETE', `(b) second entry for ${describe(line)}; entry ${ev.by.id} already covers it`, line);
      } else {
        ev.by = e; say(e, 'KEEP', `matches ${describe(line)}`, line);
      }
    } else {
      pending.push(e);
    }
  }

  const take = (pool, e) => pool.find((x) => !x.by && x.sign === Math.sign(e.amount) && near(Math.abs(e.amount), x.amount));
  const rest = [];
  for (const e of pending) {
    if (!['Milk', 'Yogurt'].includes(e.ingredient)) { say(e, 'ASK ME', `a sale entry for ${e.ingredient}, which no order line can be checked against`); continue; }
    const own = (events.get(`${e.device}|${e.entry_date}|${e.ingredient}`) || []).filter((x) => x.required).concat(
      (events.get(`${e.device}|${e.entry_date}|${e.ingredient}`) || []).filter((x) => !x.required));
    const ev = take(own, e);
    if (ev) { ev.by = e; say(e, 'KEEP', `matches ${describe(ev.line)}`, ev.line); } else rest.push(e);
  }
  const leftovers = [];
  for (const e of rest) { // a line of another device, same day, same amount: the entry was filed under the wrong device
    const ev = take(eventsOnDay(e.entry_date, e.ingredient), e);
    if (ev) { ev.by = e; say(e, 'KEEP', `matches ${describe(ev.line)} (entry filed under device ${e.device})`, ev.line); } else leftovers.push(e);
  }

  // ---- what is left has no order line that accounts for it
  for (const e of leftovers) {
    const other = e.ingredient === 'Milk' ? 'Dahi' : 'Milk';
    const src = daySources.get(`${e.entry_date}|${other}`) || [];
    // Copies seen in the audit: an entry that carries the OTHER product's quantity
    // (as it is, doubled, or scaled between litres and millilitres/grams).
    const candidates = src.map((l) => [`quantity ${l.quantity}`, l.quantity, l]);
    const totalQty = src.reduce((sum, l) => sum + l.quantity, 0);
    candidates.push([`the day's ${other} quantities (${r(totalQty)})`, totalQty, null]);
    let copy = null;
    for (const [what, v, l] of candidates) {
      for (const f of [1, 2, 1000, 0.001]) {
        if (v > 0 && near(Math.abs(e.amount), v * f)) { copy = { what, f, line: l }; break; }
      }
      if (copy) break;
    }
    // Same ingredient, wrong amount: exactly half of a same-day line that has no other entry.
    const half = e.amount < 0 ? eventsOnDay(e.entry_date, e.ingredient)
      .find((x) => x.required && !x.by && !x.claimed && x.sign === -1 && near(x.amount, 2 * Math.abs(e.amount))) : null;
    const twin = eventsOnDay(e.entry_date, e.ingredient).find((x) => x.by && x.sign === Math.sign(e.amount) && near(Math.abs(e.amount), x.amount));
    if (copy) {
      say(e, 'DELETE', `(a) ${e.ingredient} entry equals ${copy.f === 1 ? '' : copy.f + ' x '}${copy.what} of a ${other} line; a ${other} sale never takes ${e.ingredient}`, copy.line);
    } else if (half) {
      half.claimed = true;
      say(e, 'DELETE', `(a) says ${Math.abs(e.amount)} but ${describe(half.line)} used ${half.amount} (exactly double) and has no other entry`, half.line);
    } else if (twin) {
      say(e, 'DELETE', `(b) duplicate: ${describe(twin.line)} already has its entry (${twin.by.id})`, twin.line);
    } else {
      say(e, 'ASK ME', `no order line on ${e.entry_date} accounts for ${e.amount} ${e.ingredient}`);
    }
  }
  for (const e of sorted) { // a collision never gets a quiet KEEP that hides it
    const v = verdicts.get(e.key);
    if (isSale(e) && collisions.has(e.key) && v.verdict === 'KEEP') v.reason += '; note: another till also filed a different entry under this number';
  }

  // ---- order lines left without a correct sale entry
  const missing = [];
  for (const list of events.values()) for (const ev of list) if (ev.required && !ev.by) missing.push(ev.line);
  missing.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.item - b.item);

  // The kept entry that now correctly records an order line, if there is one.
  const coverOf = (line) => {
    const ev = (events.get(`${line.device}|${line.day}|${line.ingredient}`) || []).find((x) => x.line === line && x.sign === -1);
    return ev && ev.by ? ev.by : null;
  };

  return { verdicts, missing, coverOf, isBatch: (e) => Boolean(batchAt) && String(e.created_at) === batchAt };
}

/** The entry that puts one missing order line's stock back in the books. */
function createdEntryFor(line) {
  return {
    device: line.device, id: CREATED_BASE + Number(line.item), ingredient: line.ingredient, type: 'sale',
    amount: -line.amount, entry_date: line.day, created_at: line.created_at, order: line.order, item: line.item,
    reason: null, key: `${line.device}#${CREATED_BASE + Number(line.item)}`,
  };
}

/** Per-day rows for buildStatement, from plain entries. */
function dayRowsOf(entries) {
  const byDay = new Map();
  for (const e of entries) {
    const k = `${e.entry_date}|${e.ingredient}`;
    if (!byDay.has(k)) byDay.set(k, { date: e.entry_date, ingredient_id: e.ingredient, name: e.ingredient, unit: '', sold: 0, restocked: 0, removed: 0, converted: 0, waste: 0, day_delta: 0 });
    const r = byDay.get(k);
    const a = Number(e.amount);
    if (e.type === 'sale') r.sold -= a;
    else if (e.type === 'stock') { if (a > 0) r.restocked += a; else r.removed -= a; }
    else if (e.type === 'yogurt_conversion') r.converted += a;
    else if (e.type === 'waste') r.waste -= a;
    r.day_delta += a;
  }
  return [...byDay.values()];
}

/** What the stock table will say after the cleanup, per ingredient: every day's Opening and Closing. */
function tableAfter(entries) {
  return buildStatement(dayRowsOf(entries), {}, 1);
}

module.exports = { judge, createdEntryFor, tableAfter, dayRowsOf, CREATED_BASE, TOLERANCE };
