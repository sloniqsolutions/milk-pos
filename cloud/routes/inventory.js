/**
 * Ingredients — dashboard writes, till writes, both sides converge.
 *
 * Same pattern as routes/staff.js: a version counter the till polls, a
 * snapshot it downloads when that moves, an 'origin' column so one side's
 * edit doesn't get silently undone by the other's next push, and a
 * tombstone table so a dashboard delete sticks.
 *
 * The one thing this deliberately does NOT let the dashboard touch: stock.
 * A shop's real physical stock only changes through something that actually
 * happened at the till — a sale, a delivery entered on the Inventory screen,
 * a Convert-to-Yogurt, reported waste. The dashboard is not at the shop, so
 * it has no physical stock to report; editing the number from here would
 * just make it wrong. Stock stays till-derived and keeps flowing up through
 * the existing ingest push (routes/ingest.js) regardless of what this file
 * does to the rest of the row — see that file's ingredient handler for how
 * the two are kept from fighting each other.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/pg');
const { requireUser } = require('../middleware/session');
const { requireBranch } = require('../middleware/branch-auth');

const clean = (v) => {
  const t = String(v == null ? '' : v).trim();
  return t.length ? t : null;
};
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * Same reasoning as staff.js's CLOUD_ID_BASE: a till's own ids are a plain
 * AUTOINCREMENT starting at 1, so if the cloud also allocated from the low
 * numbers, an ingredient created here and one created at the till in the
 * same window could land on the same id — and the next sync in either
 * direction would merge two different ingredients into one row. Allocating
 * from a band the till's counter will not reach removes the collision
 * without the two allocators ever needing to coordinate.
 */
const CLOUD_ID_BASE = 10000;

async function bumpVersion(client) {
  const r = await client.query(
    'UPDATE ingredient_version SET version = version + 1, updated_at = NOW() WHERE id = 1 RETURNING version');
  return r.rows[0].version;
}

/* ------------------------------------------------------- the dashboard -- */

router.post('/', requireUser, async (req, res) => {
  const name = clean(req.body && req.body.name);
  const unit = clean(req.body && req.body.unit);
  const branchId = Number(req.body && req.body.branch_id) || null;
  if (!name || !unit) return res.status(400).json({ error: 'Name and unit are required.' });
  if (!branchId) return res.status(400).json({ error: 'Choose which branch this ingredient belongs to.' });

  try {
    const created = await db.tx(async (client) => {
      // Same reasoning as staff.js's CLOUD_ID_BASE allocation: numbers never
      // reused, counted over tombstones too, so a deleted ingredient's number
      // can't be handed to a new one and immediately re-deleted by a stale
      // tombstone on the till's next push.
      const next = await client.query(
        `SELECT GREATEST(
                  COALESCE((SELECT MAX(local_id) FROM ingredients WHERE branch_id = $1 AND local_id >= $2), $2 - 1),
                  COALESCE((SELECT MAX(local_id) FROM ingredient_deletions WHERE branch_id = $1 AND local_id >= $2), $2 - 1)
                ) + 1 AS id`, [branchId, CLOUD_ID_BASE]);
      const localId = Number(next.rows[0].id);

      await client.query(
        `INSERT INTO ingredients (branch_id, local_id, name, unit, stock, low_stock_threshold, cost_per_unit, origin, updated_ms, received_at)
         VALUES ($1, $2, $3, $4, 0, $5, $6, 'cloud', $7, $7)`,
        [branchId, localId, name, unit, num(req.body.low_stock_threshold) || 0, num(req.body.cost_per_unit) || 0, Date.now()]);

      await client.query('DELETE FROM ingredient_deletions WHERE branch_id = $1 AND local_id = $2', [branchId, localId]);

      const version = await bumpVersion(client);
      return { localId, version };
    });

    res.status(201).json({
      id: created.localId, name, unit, stock: 0,
      low_stock_threshold: num(req.body.low_stock_threshold) || 0,
      cost_per_unit: num(req.body.cost_per_unit) || 0,
      ingredient_version: created.version,
      note: `${name} will show up at the till once it has synced. Stock starts at 0 until it's counted there.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:branchId/:localId', requireUser, async (req, res) => {
  const branchId = Number(req.params.branchId);
  const localId = Number(req.params.localId);
  const body = req.body || {};
  if (!Number.isFinite(branchId) || !Number.isFinite(localId)) {
    return res.status(400).json({ error: 'Bad ingredient address.' });
  }
  if (body.stock !== undefined) {
    return res.status(400).json({ error: "Stock is recorded at the till, not here — it reflects what's physically on the shelf." });
  }

  try {
    const existing = await db.one('SELECT id FROM ingredients WHERE branch_id = $1 AND local_id = $2', [branchId, localId]);
    if (!existing) return res.status(404).json({ error: 'No such ingredient.' });

    const sets = [];
    const params = [];
    const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (body.name !== undefined) set('name', clean(body.name));
    if (body.unit !== undefined) set('unit', clean(body.unit));
    if (body.low_stock_threshold !== undefined) set('low_stock_threshold', num(body.low_stock_threshold) || 0);
    if (body.cost_per_unit !== undefined) set('cost_per_unit', num(body.cost_per_unit) || 0);
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });

    set('origin', 'cloud');
    set('updated_ms', Date.now());
    params.push(branchId, localId);

    const version = await db.tx(async (client) => {
      await client.query(
        `UPDATE ingredients SET ${sets.join(', ')} WHERE branch_id = $${params.length - 1} AND local_id = $${params.length}`,
        params);
      return bumpVersion(client);
    });

    res.json({ success: true, ingredient_version: version });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:branchId/:localId', requireUser, async (req, res) => {
  const branchId = Number(req.params.branchId);
  const localId = Number(req.params.localId);
  if (!Number.isFinite(branchId) || !Number.isFinite(localId)) {
    return res.status(400).json({ error: 'Bad ingredient address.' });
  }

  try {
    const version = await db.tx(async (client) => {
      const existing = await client.query('SELECT name FROM ingredients WHERE branch_id = $1 AND local_id = $2', [branchId, localId]);
      if (!existing.rows.length) return null;

      await client.query(`
        INSERT INTO ingredient_deletions (branch_id, local_id, name, deleted_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (branch_id, local_id) DO UPDATE SET
          deleted_at = NOW(), name = EXCLUDED.name, deleted_by = EXCLUDED.deleted_by
      `, [branchId, localId, existing.rows[0].name, (req.user && req.user.email) || null]);

      await client.query('DELETE FROM ingredients WHERE branch_id = $1 AND local_id = $2', [branchId, localId]);
      return bumpVersion(client);
    });

    if (version === null) return res.status(404).json({ error: 'No such ingredient.' });
    res.json({ success: true, ingredient_version: version });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------------------------------------------- tills -- */

router.get('/version', requireBranch, async (req, res) => {
  try {
    const row = await db.one('SELECT version FROM ingredient_version WHERE id = 1');
    res.json({ version: row ? Number(row.version) : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/snapshot', requireBranch, async (req, res) => {
  try {
    const [version, ingredients, deleted] = await Promise.all([
      db.one('SELECT version FROM ingredient_version WHERE id = 1'),
      db.q(
        `SELECT local_id, name, unit, low_stock_threshold, cost_per_unit, origin
           FROM ingredients WHERE branch_id = ? ORDER BY local_id`,
        [req.branch.id]),
      db.q('SELECT local_id FROM ingredient_deletions WHERE branch_id = ?', [req.branch.id]),
    ]);
    res.json({
      version: version ? Number(version.version) : 0,
      branch_id: req.branch.id,
      ingredients,
      deleted: deleted.map(d => Number(d.local_id)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
