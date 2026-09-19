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

const getFlag = () => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(FLAG);
  return Boolean(row && row.value === '1');
};
const setFlag = () => db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'`).run(FLAG);

const hasHistory = (data) => ['staff', 'customers', 'ingredients', 'shifts', 'expenses', 'orders']
  .some((k) => Array.isArray(data[k]) && data[k].length > 0);

let running = false;

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
  try {
    const data = await getJson(config.cloudUrl, '/api/restore/full', config.apiKey);
    if (!hasHistory(data)) return { status: 'cloud-empty' }; // a brand new shop: nothing to pull yet
    const result = await applyCloudRestore(data, { onlyIfFresh: true });
    sessions.clear();
    setFlag();
    console.log(`[Cloud] First-run restore complete: ${result.restored.orders} orders, `
      + `${result.restored.staff} staff, ${result.restored.customers} customers.`);
    return { status: 'restored', result };
  } catch (err) {
    if (err instanceof NotFreshError) { setFlag(); return { status: 'not-fresh' }; }
    console.error('[Cloud] First-run restore will retry:', err.message);
    return { status: 'error', error: err.message };
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

module.exports = { startBootstrap, bootstrapOnce, isPending };
