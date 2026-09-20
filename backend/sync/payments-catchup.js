/**
 * Keeps this till's credit payments in step with the cloud's.
 *
 * Why it exists: "credit collected" on the Reports screen is the money that came in
 * on each day, so it needs every payment with its own date. A till restored from the
 * cloud used to receive only each customer's running TOTAL paid, and stood in for it
 * with one lump payment — which the Reports (rightly) do not call "collected", so the
 * card read 0 on every date filter while the dashboard, which holds the real
 * payments, showed the real figures. Payments taken at ANOTHER till never reached
 * this one at all.
 *
 * This fetches the payments the cloud has and this till lacks, and adds them. It is
 * additive and safe to repeat.
 *
 * Which payments are "lacking" is decided by what a payment IS — the same customer and
 * amount, on the same day — never by who pushed it. Skipping this till's own pushes
 * (as the first version did) was wrong: an earlier restore wipes the local payments
 * and this till's own history, which the cloud still holds under its device id, would
 * then never come back. A payment already here is matched to at most one cloud payment,
 * so two genuine payments of the same amount on one day are both kept, and one payment
 * is never counted twice.
 *
 * A payment whose customer is not here yet is not lost: the cursor stops in front of it,
 * so it is asked for again, and a full pass over everything runs at start and every half
 * hour as a backstop.
 *
 * The lump stand-in stood for history that was paid before the restore. Each payment
 * that turns out to be part of that history (dated no later than the stand-in) is
 * taken off it, so the balance stays exactly what it was — the same money, now with
 * its dates. A payment dated after the stand-in is new money and reduces nothing.
 */

const db = require('../db/database');
const { readCloudConfig } = require('../db/cloud-config');
const { getJson } = require('../db/cloud-http');
const identity = require('../db/cloud-identity');
const { personKey, norm, RESTORED_NOTE_LIKE } = require('../db/person-key');

const CURSOR_KEY = 'cloud_credit_payment_cursor';
const FULL_PASS_EVERY_MS = 30 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;

const getCursor = () => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CURSOR_KEY);
  return row ? Number(row.value) || 0 : 0;
};
const setCursor = (v) => db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(CURSOR_KEY, String(v));

/**
 * Adds the payments in one cloud response. Pure database work, so it can be tested without a cloud.
 *
 * @param {object} payload  the cloud's { payments, customers }
 * @param {{ dryRun?: boolean }} [opts]  dryRun changes nothing and only reports
 * @returns {{ inserted: number, matched: number, standInReduced: number,
 *             unresolved: object[], wouldInsert: object[], earliestUnresolved: number|null }}
 */
function applyCreditPayments(payload, opts = {}) {
  const payments = Array.isArray(payload.payments) ? payload.payments : [];
  const cloudCustomers = Array.isArray(payload.customers) ? payload.customers : [];
  const out = { inserted: 0, matched: 0, standInReduced: 0, unresolved: [], wouldInsert: [], earliestUnresolved: null };
  if (payments.length === 0) return out;

  // The customer a payment names, found by person (phone / name) rather than by the pushing till's number.
  const localByPerson = new Map();
  for (const c of db.prepare('SELECT id, name, phone FROM customers ORDER BY active DESC, id').all()) {
    const key = personKey(c.name, c.phone);
    if (key && !localByPerson.has(key)) localByPerson.set(key, c.id);
  }
  const cloudCustomerOf = new Map();
  for (const c of cloudCustomers) cloudCustomerOf.set(`${c.device_id || ''}|${c.local_id}`, c);
  const dashboardNumbered = new Map(); // a customer numbered from 10000 is the same number on every till
  for (const c of cloudCustomers) if (Number(c.local_id) >= 10000 && !dashboardNumbered.has(Number(c.local_id))) dashboardNumbered.set(Number(c.local_id), c);
  const localIds = new Set(db.prepare('SELECT id FROM customers').all().map((r) => r.id));

  const resolveCustomer = (p) => {
    const cc = cloudCustomerOf.get(`${p.device_id || ''}|${p.customer_local_id}`)
      || (Number(p.customer_local_id) >= 10000 ? dashboardNumbered.get(Number(p.customer_local_id)) : null);
    const byPerson = cc ? localByPerson.get(personKey(cc.name, cc.phone)) : null;
    if (byPerson != null) return byPerson;
    // Restored customers remember which cloud row they came from.
    const viaIdentity = identity.findLocal('customers', p.device_id, p.customer_local_id);
    return viaIdentity != null && localIds.has(viaIdentity) ? viaIdentity : null;
  };

  const staffIdByName = new Map();
  for (const s of db.prepare('SELECT id, name FROM staff').all()) if (!staffIdByName.has(norm(s.name))) staffIdByName.set(norm(s.name), s.id);

  const candidates = db.prepare(
    `SELECT id, created_at FROM credit_payments WHERE customer_id = ? AND amount = ? AND COALESCE(note, '') NOT LIKE '${RESTORED_NOTE_LIKE}'`);
  const insert = db.prepare(`
    INSERT INTO credit_payments (customer_id, amount, note, received_by, received_by_id, shift_id, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?)`);
  const standIn = db.prepare(
    `SELECT id, amount, created_at FROM credit_payments WHERE customer_id = ? AND note LIKE '${RESTORED_NOTE_LIKE}' ORDER BY id LIMIT 1`);
  const setStandIn = db.prepare('UPDATE credit_payments SET amount = ? WHERE id = ?');

  const claimed = new Set(); // local payments already accounted for by a cloud payment
  const cloudSeen = new Set(); // cloud payments already dealt with in this pass
  const run = () => {
    for (const p of payments) {
      const amount = Number(p.amount);
      if (!(amount > 0)) continue;

      const customerId = resolveCustomer(p);
      if (customerId == null) {
        out.unresolved.push(p);
        const at = Number(p.received_at) || 0;
        if (out.earliestUnresolved == null || at < out.earliestUnresolved) out.earliestUnresolved = at;
        continue;
      }

      const when = String(p.created_at || '');
      if (!when) continue;
      // The cloud can hold ONE payment twice (an older build pushed it under a second device id). Two
      // genuine payments never share the same customer, amount, second and receiver, so those are one.
      const cloudKey = `${customerId}|${amount}|${when}|${norm(p.received_by)}`;
      if (cloudSeen.has(cloudKey)) continue;
      cloudSeen.add(cloudKey);
      // Already here? The exact time first, then the same day (the two sides' clocks may differ by hours).
      const mine = candidates.all(customerId, amount).filter((r) => !claimed.has(r.id));
      const same = mine.find((r) => r.created_at === when) || mine.find((r) => String(r.created_at).slice(0, 10) === when.slice(0, 10));
      if (same) { claimed.add(same.id); out.matched++; continue; }

      if (opts.dryRun) { out.wouldInsert.push({ customerId, amount, created_at: when, by: p.received_by, device: p.device_id }); continue; }
      const info = insert.run(customerId, amount, p.note || null, p.received_by || null,
        staffIdByName.get(norm(p.received_by)) ?? null, when);
      claimed.add(Number(info.lastInsertRowid));
      identity.remember('credit_payments', Number(info.lastInsertRowid), p.device_id, p.local_id);
      out.inserted++;

      // History that was already paid when the stand-in was written: it moves from the lump to its real day.
      const lump = standIn.get(customerId);
      if (lump && lump.amount > 0 && when <= String(lump.created_at)) {
        const reduced = Math.max(0, round2(lump.amount - amount));
        setStandIn.run(reduced, lump.id);
        out.standInReduced += round2(lump.amount - reduced);
      }
    }
  };
  if (opts.dryRun) run(); else db.transaction(run)();
  out.standInReduced = round2(out.standInReduced);
  return out;
}

let running = false;
let lastRun = 0;
let lastFullPass = 0;

/**
 * One catch-up pass. Cheap when there is nothing new (the cloud answers with an empty
 * list), so the downlink can call it on its ordinary poll; it throttles itself to once a minute.
 */
async function catchUpCreditPayments({ force = false } = {}) {
  const config = readCloudConfig();
  if (!config || running) return { inserted: 0 };
  if (!force && Date.now() - lastRun < 60000) return { inserted: 0 };
  running = true;
  lastRun = Date.now();
  try {
    // Never before the first-run restore has had its say: it replaces an empty till wholesale.
    if (require('./bootstrap').isPending()) return { inserted: 0 };

    // A full pass at start and every half hour: anything an earlier pass could not place is found again.
    const full = force || Date.now() - lastFullPass > FULL_PASS_EVERY_MS;
    let cursor = full ? 0 : getCursor();
    let total = { inserted: 0, standInReduced: 0, unresolved: 0 };
    for (let guard = 0; guard < 20; guard++) {   // 5000 at a time, until caught up
      const payload = await getJson(config.cloudUrl, `/api/restore/credit-payments?after=${cursor}`, config.apiKey, { timeoutMs: 60000 });
      const r = applyCreditPayments(payload);
      total = { inserted: total.inserted + r.inserted, standInReduced: round2(total.standInReduced + r.standInReduced), unresolved: total.unresolved + r.unresolved.length };

      let next = Number(payload.next_after) || cursor;
      if (r.earliestUnresolved != null) next = Math.min(next, r.earliestUnresolved - 1);   // stop in front of what could not be placed
      if (next <= cursor) break;
      cursor = next;
      if (!full || r.earliestUnresolved == null) setCursor(cursor);
      if (!payload.payments || payload.payments.length < 5000) break;
    }
    if (full) lastFullPass = Date.now();
    if (total.inserted > 0) {
      console.log(`[Cloud] Credit payments caught up: ${total.inserted} added` +
        (total.standInReduced > 0 ? `, ${total.standInReduced} moved from the restore's lump sum to its real days.` : '.'));
    }
    if (total.unresolved > 0) {
      console.log(`[Cloud] ${total.unresolved} credit payment(s) on the cloud are for a customer this till does not have yet; they will be added when it does.`);
    }
    return total;
  } finally {
    running = false;
  }
}

module.exports = { catchUpCreditPayments, applyCreditPayments };
