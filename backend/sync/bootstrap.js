/**
 * First-run bootstrap: a freshly installed till catches up with its branch
 * before anyone uses it.
 *
 * The installer ships already paired (frontend/electron/main.js writes
 * cloud-sync.json on first launch), so a new machine never goes through the
 * pairing screen — which is where the "empty till picks up the branch's
 * history" step used to live. Without this, the first sign-in on a new
 * install started the ordinary downlink against an empty database, and that
 * is a merge, not a restore: it brought the menu across, but never the
 * history, and — worse — it applied cloud rows by raw id onto the installer's
 * own default admin.
 *
 * This runs at boot, before any sign-in, and only ever while the device is
 * provably empty (see isFreshTill), re-checked inside the same transaction that
 * writes. Once it succeeds it never runs again on this install. A device with
 * any data of its own is left strictly alone.
 *
 * It keeps trying quietly if the cloud is unreachable (a new shop may open the
 * till before the internet is up), and the ordinary downlink waits its turn
 * until this has either finished or been ruled out — see pollOnce().
 */

const db = require('../db/database');
const { readCloudConfig } = require('../db/cloud-config');
const { getJson } = require('../db/cloud-http');
const { applyCloudRestore, isFreshTill, NotFreshError } = require('../db/cloud-restore');
const { sessions } = require('../middleware/auth');

const FLAG = 'cloud_bootstrap_done';

/**
 * How long the cloud may take to send a whole branch's history. It says nothing
 * until it has gathered all of it, and the shared client's 20s allowance is for
 * small polls: that is what made a real shop's first-run restore time out every
 * time, quietly, while the manual Restore button (which waits longer) worked.
 */
const RESTORE_TIMEOUT_MS = 5 * 60 * 1000;

/** How long sign-in is held back while the first restore is in flight, at most. */
const HOLD_SIGN_IN_MS = 150 * 1000;

const getFlag = () => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(FLAG);
  return Boolean(row && row.value === '1');
};
const setFlag = () => db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'`).run(FLAG);

const hasHistory = (data) => ['staff', 'customers', 'ingredients', 'shifts', 'expenses', 'orders']
  .some((k) => Array.isArray(data[k]) && data[k].length > 0);

let running = false;
let runningSince = 0;
let lastOutcome = null; // { status, error? } of the most recent attempt

/**
 * True while the downlink should hold off: paired, still empty, and not yet
 * bootstrapped. Cheap — a handful of COUNTs — so pollOnce can ask every tick.
 */
function isPending() {
  try {
    return Boolean(readCloudConfig()) && !getFlag() && isFreshTill();
  } catch (e) {
    return false;
  }
}

/**
 * Where the first-run catch-up stands, for the sign-in screen and /api/health:
 *   'off'      not paired (nothing to catch up with)
 *   'done'     finished, or ruled out for good
 *   'running'  the restore is in flight — sign-in waits (see holdsSignIn)
 *   'pending'  paired, empty, and about to try
 *   'offline'  the last attempt failed (no internet, cloud down); it retries every 30s
 */
function status() {
  try {
    if (!readCloudConfig()) return { state: 'off' };
    if (getFlag()) return { state: 'done' };
    if (running) return { state: 'running', seconds: Math.round((Date.now() - runningSince) / 1000) };
    if (lastOutcome && lastOutcome.status === 'cloud-empty') return { state: 'done' };
    if (lastOutcome && lastOutcome.status === 'error') return { state: 'offline', error: lastOutcome.error };
    return isFreshTill() ? { state: 'pending' } : { state: 'done' };
  } catch (e) {
    return { state: 'done' };
  }
}

/**
 * True while signing in would race the restore: the first person in could open
 * a shift or ring a sale, and the restore only ever replaces an EMPTY till.
 * Bounded, so a slow cloud can never lock a shop out of its own till.
 */
function holdsSignIn() {
  const s = status();
  if (s.state === 'running') return Date.now() - runningSince < HOLD_SIGN_IN_MS;
  if (s.state === 'pending') return process.uptime() * 1000 < 15000; // the first attempt fires at boot
  return false;
}

async function bootstrapOnce() {
  if (running) return { status: 'busy' };
  const config = readCloudConfig();
  if (!config) return { status: 'unpaired' };
  if (getFlag()) return { status: 'done' };

  if (!isFreshTill()) {
    // This device already holds its own data: there is nothing to bootstrap,
    // and there never will be. Remembered so this stops being asked.
    setFlag();
    return { status: 'not-fresh' };
  }

  running = true;
  runningSince = Date.now();
  try {
    const data = await getJson(config.cloudUrl, '/api/restore/full', config.apiKey, { timeoutMs: RESTORE_TIMEOUT_MS });
    if (!hasHistory(data)) { lastOutcome = { status: 'cloud-empty' }; return lastOutcome; } // a brand new shop: nothing to pull yet
    const result = await applyCloudRestore(data, { onlyIfFresh: true });
    sessions.clear();
    setFlag();
    console.log(`[Cloud] First-run restore complete: ${result.restored.orders} orders, `
      + `${result.restored.staff} staff, ${result.restored.customers} customers.`);
    lastOutcome = { status: 'restored', result };
    return lastOutcome;
  } catch (err) {
    if (err instanceof NotFreshError) { setFlag(); lastOutcome = { status: 'not-fresh' }; return lastOutcome; }
    console.error('[Cloud] First-run restore will retry:', err.message);
    lastOutcome = { status: 'error', error: err.message };
    return lastOutcome;
  } finally {
    running = false;
  }
}

/** Fires at boot, then keeps trying every 30s until it is settled one way or the other. */
function startBootstrap(intervalMs = 30000) {
  let timer = null;
  const tick = async () => {
    const outcome = await bootstrapOnce();
    if (['restored', 'not-fresh', 'done'].includes(outcome.status) && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  tick();
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => { if (timer) clearInterval(timer); };
}

module.exports = { startBootstrap, bootstrapOnce, isPending, status, holdsSignIn };
