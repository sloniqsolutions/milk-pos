/**
 * Product keys — the credential that makes an install licensed, not a branch
 * credential (see routes/activation.js). Same alphabet as pairing.js's short
 * codes, and the same reason: no O, I, 0 or 1, because this gets typed by
 * hand from a printed card or a WhatsApp message and those four are the ones
 * people misread.
 *
 * Twenty-five characters in five groups of five — VK7JG-NPHTM-C97JM-9MPGT-3V66T
 * — long enough that guessing is not a threat model even before the
 * activation endpoint's rate limit is considered.
 */

const crypto = require('crypto');

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const GROUPS = 5;
const GROUP_LENGTH = 5;

function generateProductKey() {
  const bytes = crypto.randomBytes(GROUPS * GROUP_LENGTH);
  const groups = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = '';
    for (let i = 0; i < GROUP_LENGTH; i++) {
      group += ALPHABET[bytes[g * GROUP_LENGTH + i] % ALPHABET.length];
    }
    groups.push(group);
  }
  return groups.join('-');
}

/** Hyphens, spaces and case are cosmetic — typed or pasted, any shape of the
 * same 25 characters is the same key. */
function normalise(raw) {
  return String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function hashProductKey(key) {
  return crypto.createHash('sha256').update(normalise(key)).digest('hex');
}

module.exports = { generateProductKey, normalise, hashProductKey };
