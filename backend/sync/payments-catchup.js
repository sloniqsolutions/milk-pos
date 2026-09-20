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
 * additive and safe to repeat: a payment already here (same customer, amount, time
 * and receiver) is skipped, and this till's own payments are never re-added.
 *
 * The lump stand-in stood for history that was paid before the restore. Each payment
 * that turns out to be part of that history (dated no later than the stand-in) is
 * taken off it, so the balance stays exactly what it was — the same money, now with
 * its dates. A payment dated after the stand-in is new money and reduces nothing.
 */

const db = require('../db/database');
const { readCloudConfig } = require('../db/cloud-config');
const { getJson } = require('../db/cloud-http');
const { getDeviceId } = require('../db/activation-config');
const identity = require('../db/cloud-identity');
const { personKey, norm, RESTORED_NOTE_LIKE } = require('../db/person-key');

const CURSOR_KEY = 'cloud_credit_payment_cursor';
const round2 = (n) => Math.round(n * 100) / 100;

const getCursor = () => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CURSOR_KEY);
  return row ? Number(row.value) || 0 : 0;
};
const setCursor = (v) => db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(CURSOR_KEY, String(v));

/**
 * Adds the payments in one cloud response. Pure database work, so it can be tested without a cloud.
 * @returns {{ inserted: number, standInReduced: number }}
 */
function applyCreditPayments(payload, myDeviceId) {
  const payments = Array.isArray(payload.payments) ? payload.payments : [];
  const cloudCustomers = Array.isArray(payload.customers) ? payload.customers : [];
  if (payments.length === 0) return { inserted: 0, standInReduced: 0 };

  // The customer a payment names, found by person (phone / name) rather than by the pushing till's number.
  const localByPerson = new Map();
  for (const c of db.prepare('SELECT id, name, phone FROM customers ORDER BY active DESC, id').all()) {
    const key = personKey(c.name, c.phone);
    if (key && !localByPerson.has(key)) localByPerson.set(key, c.id);
  }
  const personOfCloudCustomer = new Map();
  for (const c of cloudCustomers) personOfCloudCustomer.set(`${c.device_id || ''}|${c.local_id}`, personKey(c.name, c.phone));
  const cloudNoToPerson = new Map(); // dashboard-numbered customers are the same number on every till
  for (const c of cloudCustomers) if (Number(c.local_id) >= 10000 && !cloudNoToPerson.has(Number(c.local_id))) cloudNoToPerson.set(Number(c.local_id), personKey(c.name, c.phone));

  const staffIdByName = new Map();
  for (const s of db.prepare('SELECT id, name FROM staff').all()) if (!staffIdByName.has(norm(s.name))) staffIdByName.set(norm(s.name), s.id);

  const exists = db.prepare(
    `SELECT 1 FROM credit_payments WHERE customer_id = ? AND amount = ? AND created_at = ? AND COALESCE(received_by, '') = ? LIMIT 1`);
  const insert = db.prepare(`
    INSERT INTO credit_payments (customer_id, amount, note, received_by, received_by_id, shift_id, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?)`);
  const standIn = db.prepare(
    `SELECT id, amount, created_at FROM credit_payments WHERE customer_id = ? AND note LIKE '${RESTORED_NOTE_LIKE}' ORDER BY id LIMIT 1`);
  const setStandIn = db.prepare('UPDATE credit_payments SET amount = ? WHERE id = ?');

  let inserted = 0;
  let standInReduced = 0;
  db.transaction(() => {
    for (const p of payments) {
      const amount = Number(p.amount);
      if (!(amount > 0) || p.device_id === myDeviceId) continue;   // this till's own payments are already here

      const person = personOfCloudCustomer.get(`${p.device_id || ''}|${p.customer_local_id}`)
        || (Number(p.customer_local_id) >= 10000 ? cloudNoToPerson.get(Number(p.customer_local_id)) : null);
      const customerId = person ? localByPerson.get(person) : null;
      if (customerId == null) continue;

      const when = String(p.created_at || '');
      if (!when || exists.get(customerId, amount, when, String(p.received_by || ''))) continue;

      const info = insert.run(customerId, amount, p.note || null, p.received_by || null,
        staffIdByName.get(norm(p.received_by)) ?? null, when);
      identity.remember('credit_payments', Number(info.lastInsertRowid), p.device_id, p.local_id);
      inserted++;

      // History that was already paid when the stand-in was written: it moves from the lump to its real day.
      const lump = standIn.get(customerId);
      if (lump && lump.amount > 0 && when <= String(lump.created_at)) {
        const reduced = Math.max(0, round2(lump.amount - amount));
        setStandIn.run(reduced, lump.id);
        standInReduced += round2(lump.amount - reduced);
      }
    }
  })();
  return { inserted, standInReduced: round2(standInReduced) };
}

let running = false;
let lastRun = 0;

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
    let total = { inserted: 0, standInReduced: 0 };
    for (let guard = 0; guard < 20; guard++) {   // 5000 at a time, until caught up
      const cursor = getCursor();
      const payload = await getJson(config.cloudUrl, `/api/restore/credit-payments?after=${cursor}`, config.apiKey, { timeoutMs: 60000 });
      const r = applyCreditPayments(payload, getDeviceId());
      total = { inserted: total.inserted + r.inserted, standInReduced: round2(total.standInReduced + r.standInReduced) };
      const next = Number(payload.next_after) || cursor;
      if (next > cursor) setCursor(next);
      if (!payload.payments || payload.payments.length < 5000) break;
    }
    if (total.inserted > 0) {
      console.log(`[Cloud] Credit payments caught up: ${total.inserted} added` +
        (total.standInReduced > 0 ? `, ${total.standInReduced} moved from the restore's lump sum to its real days.` : '.'));
    }
    return total;
  } finally {
    running = false;
  }
}

module.exports = { catchUpCreditPayments, applyCreditPayments };
