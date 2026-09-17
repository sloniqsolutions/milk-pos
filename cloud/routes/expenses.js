/**
 * Expenses — dashboard writes, till writes, both sides converge.
 *
 * Same pattern as routes/staff.js/inventory.js/customers.js: version
 * counter, snapshot, 'origin' column, tombstone table for deletes.
 *
 * No edit route, unlike the other three — an expense is a record of a
 * single payment that happened; fixing a mistake by deleting the wrong
 * entry and adding the right one leaves an honest trail, where "edited"
 * would not say what it used to be. Create and delete only.
 *
 * A dashboard-created expense has no shift — the owner is not standing at a
 * till mid-shift when they log something paid outside the shop — so
 * from_drawer is always 0 and shift_id stays null; till-created expenses
 * are unaffected.
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

/** Same reasoning as staff.js's CLOUD_ID_BASE — see routes/inventory.js's copy of this comment. */
const CLOUD_ID_BASE = 10000;

async function bumpVersion(client) {
  const r = await client.query(
    'UPDATE expense_version SET version = version + 1, updated_at = NOW() WHERE id = 1 RETURNING version');
  return r.rows[0].version;
}

/* ------------------------------------------------------- the dashboard -- */

router.post('/', requireUser, async (req, res) => {
  const category = clean(req.body && req.body.category);
  const amount = num(req.body && req.body.amount);
  const branchId = Number(req.body && req.body.branch_id) || null;
  if (!category) return res.status(400).json({ error: 'A category is required.' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero.' });
  if (!branchId) return res.status(400).json({ error: 'Choose which branch this expense belongs to.' });

  try {
    const created = await db.tx(async (client) => {
      const next = await client.query(
        `SELECT GREATEST(
                  COALESCE((SELECT MAX(local_id) FROM expenses WHERE branch_id = $1 AND local_id >= $2), $2 - 1),
                  COALESCE((SELECT MAX(local_id) FROM expense_deletions WHERE branch_id = $1 AND local_id >= $2), $2 - 1)
                ) + 1 AS id`, [branchId, CLOUD_ID_BASE]);
      const localId = Number(next.rows[0].id);

      await client.query(
        `INSERT INTO expenses (branch_id, local_id, staff_name, category, description, amount,
                                from_drawer, created_at, origin, updated_ms, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0, NOW(), 'cloud', $7, $7)`,
        [branchId, localId, (req.user && req.user.email) || 'Dashboard', category,
          clean(req.body.description), amount, Date.now()]);

      await client.query('DELETE FROM expense_deletions WHERE branch_id = $1 AND local_id = $2', [branchId, localId]);

      const version = await bumpVersion(client);
      return { localId, version };
    });

    res.status(201).json({
      id: created.localId, category, description: clean(req.body.description), amount,
      expense_version: created.version,
      note: 'This will show up at the till once it has synced.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/expenses/local/:localId — a till telling the cloud it just
 * deleted one of its own expenses (see backend/routes/expenses.js's DELETE
 * route, the only place that calls this). Same reasoning and same route-
 * ordering note as cloud/routes/staff.js's identical /local/:localId route:
 * registered before /:branchId/:localId below because both are two-segment
 * paths and Express matches on registration order — "local" would otherwise
 * be read as a branchId and this would 404/sign-in-fail instead of deleting.
 */
router.delete('/local/:localId', requireBranch, async (req, res) => {
  const localId = Number(req.params.localId);
  if (!Number.isFinite(localId)) return res.status(400).json({ error: 'Bad expense id.' });

  try {
    const version = await db.tx(async (client) => {
      const existing = await client.query('SELECT description FROM expenses WHERE branch_id = $1 AND local_id = $2', [req.branch.id, localId]);

      await client.query(`
        INSERT INTO expense_deletions (branch_id, local_id, description, deleted_by)
        VALUES ($1, $2, $3, 'till')
        ON CONFLICT (branch_id, local_id) DO UPDATE SET
          deleted_at = NOW(), description = EXCLUDED.description, deleted_by = EXCLUDED.deleted_by
      `, [req.branch.id, localId, existing.rows[0] ? existing.rows[0].description : null]);

      await client.query('DELETE FROM expenses WHERE branch_id = $1 AND local_id = $2', [req.branch.id, localId]);
      return bumpVersion(client);
    });

    res.json({ success: true, expense_version: version });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:branchId/:localId', requireUser, async (req, res) => {
  const branchId = Number(req.params.branchId);
  const localId = Number(req.params.localId);
  if (!Number.isFinite(branchId) || !Number.isFinite(localId)) {
    return res.status(400).json({ error: 'Bad expense address.' });
  }

  try {
    const version = await db.tx(async (client) => {
      const existing = await client.query('SELECT description FROM expenses WHERE branch_id = $1 AND local_id = $2', [branchId, localId]);
      if (!existing.rows.length) return null;

      await client.query(`
        INSERT INTO expense_deletions (branch_id, local_id, description, deleted_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (branch_id, local_id) DO UPDATE SET
          deleted_at = NOW(), description = EXCLUDED.description, deleted_by = EXCLUDED.deleted_by
      `, [branchId, localId, existing.rows[0].description, (req.user && req.user.email) || null]);

      await client.query('DELETE FROM expenses WHERE branch_id = $1 AND local_id = $2', [branchId, localId]);
      return bumpVersion(client);
    });

    if (version === null) return res.status(404).json({ error: 'No such expense.' });
    res.json({ success: true, expense_version: version });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------------------------------------------- tills -- */

router.get('/version', requireBranch, async (req, res) => {
  try {
    const row = await db.one('SELECT version FROM expense_version WHERE id = 1');
    res.json({ version: row ? Number(row.version) : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/snapshot', requireBranch, async (req, res) => {
  try {
    const [version, expenses, deleted] = await Promise.all([
      db.one('SELECT version FROM expense_version WHERE id = 1'),
      db.q(
        `SELECT local_id, category, description, amount, staff_name, created_at, origin
           FROM expenses WHERE branch_id = ? AND origin = 'cloud' ORDER BY local_id`,
        [req.branch.id]),
      db.q('SELECT local_id FROM expense_deletions WHERE branch_id = ?', [req.branch.id]),
    ]);
    res.json({
      version: version ? Number(version.version) : 0,
      branch_id: req.branch.id,
      expenses,
      deleted: deleted.map(d => Number(d.local_id)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
