/**
 * Product-key activation.
 *
 * Whether an install is licensed at all, checked independently of which
 * branch it eventually belongs to — a till can be activated before it has
 * ever been paired, the same way a fresh Windows install asks for a key
 * before you have signed into anything. See db/product-key.js for the key
 * format and db/schema.js's product_keys table for the reasoning.
 *
 * The device is bound on first activation and never rebound by presenting
 * the key again: a product key that let any machine claim it whenever
 * offered would not be limiting anything. Moving a license to new hardware
 * is a deliberate admin action — see scripts/issue-key.js's `reset` command.
 *
 * Unauthenticated, necessarily: an unlicensed till has nothing to
 * authenticate with. That is what the rate limit protects.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/pg');
const { hashProductKey } = require('../db/product-key');

/*
 * Same shape as the pairing claim limiter (routes/pairing.js) and the
 * dashboard login limiter (routes/auth.js): in memory, keyed on IP, reset by
 * a restart. A 25-character key from a 32-letter alphabet is not a threat
 * model any of these limiters were really written for, but there is no
 * reason for this one endpoint to be the exception to a pattern used
 * everywhere else an unauthenticated write exists.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map();

function tooMany(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(key); return false; }
  return rec.count >= MAX_ATTEMPTS;
}

function recordAttempt(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

/**
 * POST /api/activation/activate
 * body: { key, device_id, device_name }
 */
router.post('/activate', async (req, res) => {
  const ip = req.ip || 'unknown';

  if (tooMany(ip)) {
    return res.status(429).json({
      error: 'Too many attempts. Try again in a few minutes.',
      code: 'RATE_LIMITED',
    });
  }

  const key = req.body && req.body.key;
  const deviceId = req.body && String(req.body.device_id || '').trim();
  const deviceName = (req.body && String(req.body.device_name || '').trim()) || null;

  if (!key) return res.status(400).json({ error: 'Enter the product key.' });
  if (!deviceId) return res.status(400).json({ error: 'Missing device identity.' });

  recordAttempt(ip);

  try {
    const row = await db.one(
      'SELECT id, device_id, label FROM product_keys WHERE key_hash = ? AND revoked_at IS NULL',
      [hashProductKey(key)]
    );

    if (!row) {
      return res.status(400).json({ error: 'That product key is not valid.', code: 'BAD_KEY' });
    }

    if (row.device_id && row.device_id !== deviceId) {
      return res.status(409).json({
        error: 'This product key is already activated on another device.',
        code: 'ALREADY_ACTIVATED',
      });
    }

    // Bound here, once. A device presenting the same key again (a reinstall
    // on the same machine, or a false start before this reply arrived) finds
    // its own device_id already in place and this is simply skipped.
    if (!row.device_id) {
      await db.run(
        'UPDATE product_keys SET device_id = ?, device_name = ?, activated_at = NOW() WHERE id = ?',
        [deviceId, deviceName, row.id]
      );
    }

    // Spent, so a wrong key typed earlier does not count against the
    // machine's very next, correct, attempt.
    attempts.delete(ip);

    res.json({ activated: true, label: row.label || null });
  } catch (err) {
    console.error('Activation failed:', err.message);
    res.status(500).json({ error: 'Could not activate' });
  }
});

module.exports = router;
