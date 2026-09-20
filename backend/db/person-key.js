/**
 * When are two customer rows the same person?
 *
 * The cloud identifies a customer by (branch, till, that till's own number), so
 * the same person pushed from two tills — or by an older build that sent no till
 * id — is two cloud rows. A restore or a pull that copied every row across made
 * two customers out of one. This is the one rule everything that adds a customer
 * (restore, downlink, the create route, scripts/merge-duplicate-customers.js)
 * uses to recognise a person already here:
 *
 *   - the same phone number, ignoring spaces, dashes and brackets; or
 *   - with no phone to go on, the same name (case and spacing ignored).
 *
 * Two different people who share only a name AND both have phones stay two.
 */

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');

function personKey(name, phone) {
  const digits = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (digits.length >= 7) return `tel:${digits}`;
  const n = norm(name);
  return n ? `name:${n}` : null;
}

/** The note on the stand-in payment a restore writes — see cloud-restore.js. */
const RESTORED_NOTE_LIKE = 'Restored from cloud backup%';

module.exports = { personKey, norm, RESTORED_NOTE_LIKE };
