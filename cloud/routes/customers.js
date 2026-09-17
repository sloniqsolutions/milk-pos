/**
 * Credit customers — dashboard writes, till writes, both sides converge.
 *
 * Same pattern as routes/staff.js and routes/inventory.js: version counter,
 * snapshot, 'origin' column, tombstone table for deletes.
 *
 * What the dashboard can edit: name, phone, address, notes, active. What it
 * cannot: balance, total_litres, order_count, total_spent/credited/paid,
 * first/last_order_at — every one of those is computed on the till from
 * actual orders and payments (see backend/db/customer-summary.js) and simply
 * carried by the till's own push. There is nowhere else in this codebase a
 * balance is stored or edited directly; letting the dashboard set one here
 * would make it the one place a number could drift from the orders that are
 * supposed to add up to it.
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

/** Same reasoning as staff.js's CLOUD_ID_BASE — see routes/inventory.js's copy of this comment. */
const CLOUD_ID_BASE = 10000;

async function bumpVersion(client) {
  const r = await client.query(
    'UPDATE customer_version SET version = version + 1, updated_at = NOW() WHERE id = 1 RETURNING version');
  return r.rows[0].version;
}

const DERIVED_FIELDS = ['balance', 'total_litres', 'order_count', 'total_spent', 'total_credited', 'total_paid', 'first_order_at', 'last_order_at'];

/* ------------------------------------------------------- the dashboard -- */

router.post('/', requireUser, async (req, res) => {
  const name = clean(req.body && req.body.name);
  const branchId = Number(req.body && req.body.branch_id) || null;
  if (!name) return res.status(400).json({ error: 'A name is required.' });
  if (!branchId) return res.status(400).json({ error: 'Choose which branch this customer belongs to.' });

  try {
    const created = await db.tx(async (client) => {
      const next = await client.query(
        `SELECT GREATEST(
                  COALESCE((SELECT MAX(local_id) FROM customers WHERE branch_id = $1 AND local_id >= $2), $2 - 1),
                  COALESCE((SELECT MAX(local_id) FROM customer_deletions WHERE branch_id = $1 AND local_id >= $2), $2 - 1)
                ) + 1 AS id`, [branchId, CLOUD_ID_BASE]);
      const localId = Number(next.rows[0].id);

      await client.query(
        `INSERT INTO customers (branch_id, local_id, name, phone, address, notes, active,
                                 order_count, total_spent, total_credited, total_paid, balance, total_litres,
                                 origin, updated_ms, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 0, 0, 0, 0, 0, 0, 'cloud', $7, $7)`,
        [branchId, localId, name, clean(req.body.phone), clean(req.body.address), clean(req.body.notes), Date.now()]);

      await client.query('DELETE FROM customer_deletions WHERE branch_id = $1 AND local_id = $2', [branchId, localId]);

      const version = await bumpVersion(client);
      return { localId, version };
    });

    res.status(201).json({
      id: created.localId, name, phone: clean(req.body.phone), address: clean(req.body.address),
      notes: clean(req.body.notes), active: 1, balance: 0, total_litres: 0,
      customer_version: created.version,
      note: `${name} will show up at the till once it has synced.`,
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
    return res.status(400).json({ error: 'Bad customer address.' });
  }
  const attemptedDerived = DERIVED_FIELDS.find(f => body[f] !== undefined);
  if (attemptedDerived) {
    return res.status(400).json({ error: `${attemptedDerived.replace(/_/g, ' ')} is computed from orders and payments at the till, not editable here.` });
  }

  try {
    const existing = await db.one('SELECT id FROM customers WHERE branch_id = $1 AND local_id = $2', [branchId, localId]);
    if (!existing) return res.status(404).json({ error: 'No such customer.' });

    const sets = [];
    const params = [];
    const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (body.name !== undefined) {
      const name = clean(body.name);
      if (!name) return res.status(400).json({ error: 'A name is required.' });
      set('name', name);
    }
    if (body.phone !== undefined) set('phone', clean(body.phone));
    if (body.address !== undefined) set('address', clean(body.address));
    if (body.notes !== undefined) set('notes', clean(body.notes));
    if (body.active !== undefined) set('active', body.active ? 1 : 0);
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });

    set('origin', 'cloud');
    set('updated_ms', Date.now());
    params.push(branchId, localId);

    const version = await db.tx(async (client) => {
      await client.query(
        `UPDATE customers SET ${sets.join(', ')} WHERE branch_id = $${params.length - 1} AND local_id = $${params.length}`,
        params);
      return bumpVersion(client);
    });

    res.json({ success: true, customer_version: version });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:branchId/:localId', requireUser, async (req, res) => {
  const branchId = Number(req.params.branchId);
  const localId = Number(req.params.localId);
  if (!Number.isFinite(branchId) || !Number.isFinite(localId)) {
    return res.status(400).json({ error: 'Bad customer address.' });
  }

  try {
    const version = await db.tx(async (client) => {
      const existing = await client.query('SELECT name, balance FROM customers WHERE branch_id = $1 AND local_id = $2', [branchId, localId]);
      if (!existing.rows.length) return { missing: true };

      if (Number(existing.rows[0].balance) > 0) {
        return { balanceOwed: existing.rows[0].balance };
      }

      await client.query(`
        INSERT INTO customer_deletions (branch_id, local_id, name, deleted_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (branch_id, local_id) DO UPDATE SET
          deleted_at = NOW(), name = EXCLUDED.name, deleted_by = EXCLUDED.deleted_by
      `, [branchId, localId, existing.rows[0].name, (req.user && req.user.email) || null]);

      await client.query('DELETE FROM customers WHERE branch_id = $1 AND local_id = $2', [branchId, localId]);
      return { version: await bumpVersion(client) };
    });

    if (version.missing) return res.status(404).json({ error: 'No such customer.' });
    if (version.balanceOwed !== undefined) {
      return res.status(409).json({ error: `${version.balanceOwed > 0 ? 'This customer' : 'They'} still owes a balance — settle it before deleting.` });
    }
    res.json({ success: true, customer_version: version.version });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* -------------------------------------------------------------- tills -- */

router.get('/version', requireBranch, async (req, res) => {
  try {
    const row = await db.one('SELECT version FROM customer_version WHERE id = 1');
    res.json({ version: row ? Number(row.version) : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/snapshot', requireBranch, async (req, res) => {
  try {
    const [version, customers, deleted] = await Promise.all([
      db.one('SELECT version FROM customer_version WHERE id = 1'),
      db.q(
        `SELECT local_id, name, phone, address, notes, active, origin
           FROM customers WHERE branch_id = ? ORDER BY local_id`,
        [req.branch.id]),
      db.q('SELECT local_id FROM customer_deletions WHERE branch_id = ?', [req.branch.id]),
    ]);
    res.json({
      version: version ? Number(version.version) : 0,
      branch_id: req.branch.id,
      customers,
      deleted: deleted.map(d => Number(d.local_id)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
