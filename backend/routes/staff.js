const express = require('express');
const router = express.Router();
const db = require('../db/database');
const bcrypt = require('bcryptjs');
const { syncUpsert, syncStaffDelete } = require('../db/cloud-sync');
const saltRounds = 10;
const { clean } = require('../db/validate');

/** PINs are numeric — the sign-in screen is a number pad — and 4 to 8 digits long. */
const isValidPin = (pin) => /^\d{4,8}$/.test(String(pin));
const PIN_MESSAGE = 'The PIN must be 4 to 8 digits, numbers only.';
const {
  createSession, destroySession, requireAdmin, requireAuth, isAdminRole, getSession,
} = require('../middleware/auth');

/**
 * Roles this build recognises.
 *
 * Two, matching how the shop actually runs: an administrator with full access
 * and a manager who works the till. 'Owner' is the historical admin role name
 * and is still accepted so the shop's existing account keeps working.
 */
const ASSIGNABLE_ROLES = ['Admin', 'Manager'];

/**
 * Refuse to remove the last administrator.
 *
 * Nothing prevented deleting or demoting the only Owner, which would have left
 * the shop permanently unable to reach Settings, staff or backups — with no
 * way back in short of editing the database by hand.
 */
function countOtherActiveAdmins(excludeId) {
  return db.prepare(
    `SELECT COUNT(*) AS c FROM staff
     WHERE active = 1 AND id != ? AND role IN ('Admin', 'Owner')`
  ).get(excludeId).c;
}

/**
 * Public account directory for the PIN screen.
 *
 * The sign-in screen has to list the accounts before anyone is signed in, so
 * this cannot require a token. It returns only what that screen draws — the
 * name and colour of each active account — and never the PIN hash, the role or
 * anything else. GET /api/staff remains administration and stays admin-only.
 */
router.get('/directory', (req, res) => {
  try {
    // `role` is included because the sign-in screen labels each account with
    // it, and `active` because the screen filters on it. Both are already
    // visible on that screen by design; the PIN hash never leaves the table.
    const staff = db.prepare(
      "SELECT id, name, color, role, 1 AS active FROM staff WHERE active = 1 ORDER BY name ASC"
    ).all();
    res.json(staff);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all staff — administration, so admin only.
router.get('/', requireAdmin, (req, res) => {
  try {
    // SECURITY: `pin` used to be in this SELECT, so every caller of
    // GET /api/staff received the bcrypt hash of every staff PIN. Nothing in
    // the UI needs it — Settings only renders name/role/colour/active.
    // The staff cards show each person's takings for today. They read
    // `todayOrders` and `todayRevenue`, which this endpoint never returned —
    // so both tiles have always displayed 0. Computed here rather than with a
    // second round trip, and scoped to the local trading day.
    const staff = db.prepare(`
      SELECT
        s.id, s.name, s.role, s.color, s.active,
        (SELECT COUNT(*) FROM orders o
          WHERE o.cashier_id = s.id
            AND o.status != 'voided'
            AND DATE(o.created_at) = DATE('now', 'localtime')) AS todayOrders,
        (SELECT COALESCE(SUM(o.total), 0) FROM orders o
          WHERE o.cashier_id = s.id
            AND o.status != 'voided'
            AND DATE(o.created_at) = DATE('now', 'localtime')) AS todayRevenue
      FROM staff s
      ORDER BY s.role DESC, s.name ASC
    `).all();

    const normalized = staff.map(s => ({
      ...s,
      active: s.active === 1 || s.active === '1' || s.active === true ? 1 : 0
    }));
    res.json(normalized);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST new staff
router.post('/', requireAdmin, async (req, res) => {
  const { role, pin, color } = req.body || {};
  const name = clean(req.body && req.body.name, 60);
  if (!name || !pin) return res.status(400).json({ error: 'Enter a name and a PIN for the new staff member.' });
  if (!isValidPin(pin)) return res.status(400).json({ error: PIN_MESSAGE });
  if (role !== undefined && !ASSIGNABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` });
  }
  const sameName = db.prepare('SELECT id FROM staff WHERE LOWER(name) = LOWER(?)').get(name);
  if (sameName) {
    return res.status(409).json({ error: `There is already a staff member called "${name}". Use a different name so their sales are not confused.` });
  }

  try {
    const hashedPin = await bcrypt.hash(String(pin), saltRounds);

    /*
     * Explicit id, kept under 10000 on purpose.
     *
     * cloud/routes/staff.js allocates its own staff ids starting at 10000
     * specifically so a cloud-created account and a till-created one can
     * never collide — the two allocators don't have to talk to each other.
     * That only holds if this table's own "next id" actually stays below
     * 10000. It doesn't by default: SQLite's rowid auto-assignment continues
     * from the highest id *ever inserted*, and applyMenu/applyStaff's
     * downlink (sync/downlink.js) inserts cloud accounts with their real
     * 10000+ id explicitly. The first time this till pulls down a
     * cloud-created account, every following plain `INSERT` (omitting id)
     * jumps to 10001, 10002, ... — landing new till-created staff squarely in
     * the cloud's own band, one accidental double-booking away from merging
     * two different people into one row on the next sync. Computed fresh
     * every time rather than cached, since the safe ceiling only ever moves
     * up as more accounts are created.
     */
    const nextId = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM staff WHERE id < 10000').get().id;
    const insert = db.prepare('INSERT INTO staff (id, name, role, pin, color, active) VALUES (?, ?, ?, ?, ?, 1)');
    const info = insert.run(nextId, name, role || 'Manager', hashedPin, color || '#DC2626');
    syncUpsert('staff', db.prepare('SELECT * FROM staff WHERE id = ?').get(info.lastInsertRowid));
    res.json({ id: info.lastInsertRowid, name, role, color: color || '#DC2626', active: 1 });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(400).json({ error: 'PIN already in use by another staff member' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT update staff (toggle active, update role, etc)
router.put('/:id', requireAdmin, async (req, res) => {
  const { active, role, pin, color } = req.body || {};
  const name = req.body && req.body.name !== undefined ? clean(req.body.name, 60) : undefined;
  try {
    const target = db.prepare('SELECT id, role, active FROM staff WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'That staff member no longer exists. Refresh the page and try again.' });
    if (name !== undefined) {
      if (!name) return res.status(400).json({ error: 'The name cannot be empty.' });
      const clash = db.prepare('SELECT id FROM staff WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, target.id);
      if (clash) return res.status(409).json({ error: `There is already a staff member called "${name}".` });
    }
    if (pin && !isValidPin(pin)) return res.status(400).json({ error: PIN_MESSAGE });

    // Deactivating or demoting the last administrator would lock the shop out
    // of Settings, staff and backups with no way back in.
    const losingAdmin =
      (active !== undefined && !active && isAdminRole(target.role)) ||
      (role !== undefined && isAdminRole(target.role) && !isAdminRole(role));

    if (losingAdmin && target.active === 1 && countOtherActiveAdmins(target.id) === 0) {
      return res.status(409).json({
        error: 'This is the only administrator account. Promote another user to administrator first.',
      });
    }

    if (role !== undefined && !ASSIGNABLE_ROLES.includes(role) && !isAdminRole(role)) {
      return res.status(400).json({ error: `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` });
    }

    if (name !== undefined) {
      db.prepare('UPDATE staff SET name = ? WHERE id = ?').run(name, req.params.id);
    }
    if (active !== undefined) {
      db.prepare('UPDATE staff SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
    }
    if (role !== undefined) {
      db.prepare('UPDATE staff SET role = ? WHERE id = ?').run(role, req.params.id);
    }
    if (color !== undefined) {
      db.prepare('UPDATE staff SET color = ? WHERE id = ?').run(color, req.params.id);
    }
    if (pin) {
      const hashedPin = await bcrypt.hash(String(pin), saltRounds);
      db.prepare('UPDATE staff SET pin = ? WHERE id = ?').run(hashedPin, req.params.id);
    }
    syncUpsert('staff', db.prepare('SELECT * FROM staff WHERE id = ?').get(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE staff
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const target = db.prepare('SELECT id, role, active FROM staff WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'Staff member not found' });

    if (isAdminRole(target.role) && target.active === 1 && countOtherActiveAdmins(target.id) === 0) {
      return res.status(409).json({
        error: 'This is the only administrator account. Create another administrator before removing this one.',
      });
    }

    db.prepare('DELETE FROM staff WHERE id = ?').run(req.params.id);
    syncStaffDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * SECURITY: brute-force protection for PIN login.
 *
 * PINs are 4 digits — a 10,000-entry space — and this endpoint originally
 * accepted unlimited attempts with no delay or lockout, so the whole space
 * could be walked in minutes.
 *
 * The counter is per account. Sign-in now names the account being signed into,
 * so one person fat-fingering their PIN throttles only their own account
 * rather than locking the whole shop out of the till.
 *
 * State is in-memory on purpose: this is a single-till app, the backend is
 * restarted with the app, and a restart-to-reset still costs an attacker far
 * more than the unthrottled endpoint did.
 */
const MAX_ATTEMPTS = 5;          // failures before the first lockout
const LOCKOUT_MS = 60 * 1000;    // base lockout, doubles each further trip
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // failures older than this decay away

/** accountKey -> { failures: number[], lockedUntil, lockoutCount } */
const loginGuards = new Map();

function guardFor(accountKey) {
  const key = String(accountKey);
  if (!loginGuards.has(key)) {
    loginGuards.set(key, { failures: [], lockedUntil: 0, lockoutCount: 0 });
  }
  return loginGuards.get(key);
}

function guardStatus(guard, now = Date.now()) {
  if (now < guard.lockedUntil) {
    return { locked: true, retryAfterMs: guard.lockedUntil - now };
  }
  return { locked: false, retryAfterMs: 0 };
}

function recordFailure(guard, now = Date.now()) {
  guard.failures = guard.failures.filter(t => now - t < ATTEMPT_WINDOW_MS);
  guard.failures.push(now);

  if (guard.failures.length >= MAX_ATTEMPTS) {
    guard.lockoutCount += 1;
    // 1m, 2m, 4m, 8m … capped at 15m.
    const backoff = Math.min(LOCKOUT_MS * 2 ** (guard.lockoutCount - 1), 15 * 60 * 1000);
    guard.lockedUntil = now + backoff;
    guard.failures = [];
  }
}

function recordSuccess(guard) {
  guard.failures = [];
  guard.lockedUntil = 0;
  guard.lockoutCount = 0;
}

function lockedResponse(res, status) {
  const seconds = Math.ceil(status.retryAfterMs / 1000);
  return res.status(429).json({
    error: `Too many incorrect PINs. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
    retry_after_seconds: seconds,
  });
}


/**
 * Sign in.
 *
 * The PIN is checked against the *selected account only*.
 *
 * It used to be checked against every active account in turn and returned
 * whichever one matched, so the account picker on the sign-in screen was
 * decorative: choosing "Junaid (Manager)" and typing the administrator's PIN
 * signed you in as the administrator, with full access. Whoever's PIN you
 * typed is who you became.
 *
 * Requiring the account id makes the picked account authoritative — a PIN only
 * works for the person it belongs to. It also means two people may safely hold
 * the same PIN, which the schema never actually prevented: the UNIQUE
 * constraint is on `pin`, but `pin` stores a *bcrypt hash*, and bcrypt salts
 * every hash, so the same PIN hashed twice produces two different strings that
 * the constraint happily accepts.
 */
router.post('/login', async (req, res) => {
  const { pin, staff_id } = req.body || {};

  // A new install is still loading its branch's staff and history from the cloud.
  // Signing in now would race it (and the roster on screen is not the real one yet).
  if (require('../sync/bootstrap').holdsSignIn()) {
    return res.status(503).json({ error: 'Setting up — loading your data from the cloud. Try again in a moment.', code: 'SETUP_IN_PROGRESS' });
  }

  if (!pin || (typeof pin !== 'string' && typeof pin !== 'number')) {
    return res.status(400).json({ error: 'Enter your PIN.' });
  }
  if (staff_id === undefined || staff_id === null || staff_id === ''
      || !Number.isInteger(Number(staff_id))) {
    return res.status(400).json({ error: 'Select an account to sign in.' });
  }

  // Throttle per account, so one person's mistyping cannot lock out the other.
  const guard = guardFor(staff_id);
  const status = guardStatus(guard);
  if (status.locked) return lockedResponse(res, status);

  const member = db.prepare(
    'SELECT id, name, role, color, pin FROM staff WHERE id = ? AND active = 1'
  ).get(staff_id);

  // A missing or inactive account and a wrong PIN return the same failure, so
  // the response cannot be used to enumerate which accounts exist.
  const pinIsHashed = member && /^\$2[aby]\$/.test(member.pin || '');
  const ok = pinIsHashed && await bcrypt.compare(String(pin), member.pin);

  if (ok) {
    recordSuccess(guard);
    const { pin: _, ...staffData } = member;
    // The token authorises every later request. The role travels inside it,
    // read from the database — the client never gets to assert its own role.
    const token = createSession(member);
    return res.json({ ...staffData, token, is_admin: isAdminRole(member.role) });
  }

  recordFailure(guard);
  const after = guardStatus(guard);
  if (after.locked) return lockedResponse(res, after);

  return res.status(401).json({ error: 'Incorrect PIN for this account.' });
});


/**
 * Performance per cashier for a date range. Backs the Performance tab.
 *
 * Admin only — it is every staff member's takings side by side. A manager sees
 * their own figures on the reports screen, which is scoped to them.
 */
router.get('/performance', requireAdmin, (req, res) => {
  const today = new Date().toLocaleDateString('en-CA');
  const from = req.query.from || today;
  const to = req.query.to || today;

  try {
    const allStaff = db.prepare('SELECT id, name, role, color, active FROM staff').all();

    const performance = allStaff.map(s => {
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total_orders,
          COALESCE(SUM(total), 0) as total_revenue,
          COALESCE(AVG(total), 0) as avg_order_value,
          COALESCE(SUM(discount), 0) as total_discounts
        FROM orders
        WHERE cashier_id = ?
        AND DATE(created_at) BETWEEN DATE(?) AND DATE(?)
        AND status != 'voided'
      `).get(s.id, from, to);

      const busiestHour = db.prepare(`
        SELECT
          CAST(strftime('%H', created_at) AS INTEGER) as hour,
          COUNT(*) as count
        FROM orders
        WHERE cashier_id = ?
        AND DATE(created_at) BETWEEN DATE(?) AND DATE(?)
        AND status != 'voided'
        GROUP BY hour
        ORDER BY count DESC
        LIMIT 1
      `).get(s.id, from, to);

      const hourLabel = busiestHour
        ? `${busiestHour.hour % 12 || 12}${busiestHour.hour < 12 ? 'AM' : 'PM'}`
        : 'N/A';

      return { ...s, ...stats, busiest_hour: hourLabel };
    });

    res.json(performance);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Sign out — drops the session so the token stops working immediately. */
router.post('/logout', (req, res) => {
  const session = getSession(req);
  if (session) destroySession(session.token);
  res.json({ success: true });
});

/**
 * Who am I? Lets the app verify a restored session against the server rather
 * than trusting what it saved in localStorage.
 */
router.get('/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.staffId,
    name: req.user.name,
    role: req.user.role,
    is_admin: isAdminRole(req.user.role),
  });
});

module.exports = router;

