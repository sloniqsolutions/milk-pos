/**
 * The till's half of the Live tab (see cloud/routes/live.js).
 *
 * Lossy by design, same as the cloud side documents: a heartbeat that fails
 * to send is never queued or retried, because by the time it could be
 * redelivered a fresher one already exists. This is the one sync channel in
 * the till where "just try again next time" is the entire error-handling
 * strategy, on purpose.
 */

const db = require('../db/database');
const { readCloudConfig } = require('../db/cloud-config');
const { postJson } = require('../db/cloud-http');

const AGENT_STARTED_MS = Date.now();

function getLocalVersion(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? Number(row.value) || 0 : 0;
}

/** The open shift's live figures, in the shape cloud/routes/live.js expects. */
function currentShiftSnapshot() {
  const shift = db.prepare(
    "SELECT * FROM shifts WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1"
  ).get();
  if (!shift) return null;

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(total), 0) AS total_revenue,
      COALESCE(SUM(CASE WHEN LOWER(payment_method) = 'cash' THEN total ELSE 0 END), 0) AS cash_revenue,
      COALESCE(SUM(CASE WHEN LOWER(payment_method) != 'cash' THEN total ELSE 0 END), 0) AS non_cash_revenue
    FROM orders WHERE shift_id = ? AND status != 'voided'
  `).get(shift.id);

  const spend = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS drawer_expenses, COUNT(*) AS expense_count FROM expenses WHERE shift_id = ? AND from_drawer = 1'
  ).get(shift.id);

  const credit = db.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS credit_collected FROM credit_payments WHERE shift_id = ?'
  ).get(shift.id);

  const expectedCash =
    Number(shift.opening_cash || 0) +
    Number(totals.cash_revenue || 0) +
    Number(credit.credit_collected || 0) -
    Number(spend.drawer_expenses || 0);

  return {
    local_id: shift.id,
    staff_name: shift.staff_name,
    opened_at: shift.opened_at,
    opening_cash: shift.opening_cash,
    total_orders: totals.total_orders,
    total_revenue: totals.total_revenue,
    cash_revenue: totals.cash_revenue,
    non_cash_revenue: totals.non_cash_revenue,
    drawer_expenses: spend.drawer_expenses,
    expense_count: spend.expense_count,
    expected_cash: expectedCash,
  };
}

function todaysExpenses() {
  return db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
    FROM expenses WHERE DATE(created_at) = DATE('now', 'localtime')
  `).get();
}

async function sendHeartbeat() {
  const config = readCloudConfig();
  if (!config) return;

  const shift = currentShiftSnapshot();
  const payload = {
    state: shift ? 'open' : 'closed',
    shift,
    expenses_today: todaysExpenses(),
    menu_version: getLocalVersion('cloud_menu_version'),
    sent_at_ms: Date.now(),
    agent_started_ms: AGENT_STARTED_MS,
  };

  try {
    await postJson(config.cloudUrl, '/api/live/heartbeat', config.apiKey, payload);
  } catch (err) {
    console.error('[Cloud] Heartbeat failed:', err.message);
  }
}

/** Started once at boot. Fires immediately, then every 30s, matching the cloud's LIVE_MS band. */
function startHeartbeat(intervalMs = 30000) {
  sendHeartbeat();
  const timer = setInterval(sendHeartbeat, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { startHeartbeat, sendHeartbeat };
