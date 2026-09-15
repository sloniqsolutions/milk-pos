/**
 * Authenticate the till.
 *
 * `Authorization: Bearer <TILL_API_KEY>`. Milk POS is one shop with one till,
 * and only ever will be — there is no pairing flow, no per-branch key, and
 * nothing that rotates. Set TILL_API_KEY once, the same value in this
 * process's environment and in the till's cloud-sync.json, and it never has
 * to change again.
 *
 * This replaces the earlier pairing-code system (cloud/routes/pairing.js,
 * now removed): a code exchanged for a freshly generated key, rotated on
 * every claim. That made sense when a key was scoped to *a* branch among
 * several — a compromised key for one shop should not be able to write
 * another's figures. With exactly one branch that no longer buys anything;
 * it only bought two config files (the till's cloud-sync.json and whichever
 * local dev database happened to pair most recently) a standing chance of
 * silently disagreeing about which key was current, which is exactly what
 * happened in practice.
 */

const crypto = require('crypto');
const db = require('../db/pg');

const TILL_API_KEY = process.env.TILL_API_KEY || '';

function readBearer(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Same length check + timingSafeEqual as the old hash comparison — a
 * length mismatch means the input isn't the key at all and can be rejected
 * outright without the (slightly) more expensive constant-time compare. */
function keysMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

async function requireBranch(req, res, next) {
  if (!TILL_API_KEY) {
    console.error('TILL_API_KEY is not set — every till request will be refused until it is.');
    return res.status(503).json({ error: 'Cloud not configured' });
  }

  const key = readBearer(req);
  if (!key || !keysMatch(key, TILL_API_KEY)) {
    // Deliberately vague, and deliberately never echoes the key back — every
    // line this process logs ends up in a file on disk.
    return res.status(401).json({ error: 'Unrecognised key', code: 'BAD_BRANCH_KEY' });
  }

  try {
    // Metadata only — branch identity itself no longer depends on this row
    // existing or being correct; the key check above is what authenticates.
    const branch = await db.one('SELECT id, name FROM branches WHERE id = 1');
    req.branch = branch || { id: 1, name: 'Pure Milk' };
    next();
  } catch (err) {
    console.error('Branch lookup failed:', err.message);
    res.status(503).json({ error: 'Database unavailable' });
  }
}

module.exports = { requireBranch };
