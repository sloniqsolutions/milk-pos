/**
 * Connecting this till to the cloud, from the Settings screen.
 *
 * There is one branch and one fixed key (TILL_API_KEY — see
 * cloud/middleware/branch-auth.js), generated once and never rotated. So
 * this is not a pairing exchange any more, just saving a cloud address and
 * that key into cloud-sync.json by hand — but verified against the cloud
 * before it is written, so a typo in either field is caught here rather than
 * showing up later as every sync silently failing.
 */

const express = require('express');
const router = express.Router();
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { readCloudConfig, CONFIG_PATH } = require('../db/cloud-config');
const { pushInitialBackfill } = require('../db/cloud-sync');
const { applyCloudRestore, isFreshTill } = require('../db/cloud-restore');
const { requireAdmin, sessions } = require('../middleware/auth');
const db = require('../db/database');

function request(method, baseUrl, path, apiKey, body) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(path, baseUrl);
    } catch (e) {
      reject(new Error('That does not look like a valid cloud address.'));
      return;
    }
    const payload = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const lib = url.protocol === 'https:' ? https : http;
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    // A full branch export can be large; the connect check and every other
    // call through here is small, so this only matters for /restore/full.
    const req = lib.request(url, { method, headers, timeout: 60000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch (e) { /* non-JSON error page */ }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(new Error(parsed.error || `The cloud answered with an error (HTTP ${res.statusCode}).`));
        }
      });
    });
    req.on('error', () => reject(new Error('Could not reach that address. Check the URL and your internet connection.')));
    req.on('timeout', () => req.destroy(new Error('The cloud did not respond in time.')));
    if (payload) req.write(payload);
    req.end();
  });
}

const postJson = (baseUrl, path, body, apiKey) => request('POST', baseUrl, path, apiKey, body);
const getJson = (baseUrl, path, apiKey) => request('GET', baseUrl, path, apiKey, null);

/**
 * What the Settings screen shows. Never the API key itself — same reasoning
 * as everywhere else a credential is handled here: showing it back is one
 * more place it could leak from, and the screen only ever needs to say
 * "paired as X" or "not paired."
 */
router.get('/status', (req, res) => {
  const config = readCloudConfig();
  if (!config) return res.json({ paired: false });
  res.json({
    paired: true,
    cloud_url: config.cloudUrl,
    branch_id: config.branchId,
    branch_name: config.branchName,
  });
});

/**
 * POST /api/cloud/pair — save and verify the cloud address and key.
 *
 * Admin-only, the same as before: this is what starts sales syncing to the
 * cloud, and connecting the till to the wrong place (or with a leaked key)
 * is not something a manager should be able to do by themselves.
 */
router.post('/pair', requireAdmin, async (req, res) => {
  // Text only: String({a:1}) is "[object Object]", which would be saved as the
  // key and then fail every sync with no hint why.
  const textOnly = (v) => (typeof v === 'string' ? v.trim() : '');
  const cloudUrl = textOnly(req.body && req.body.cloud_url).replace(/\/+$/, '');
  const apiKey = textOnly(req.body && req.body.api_key);

  if (!cloudUrl) return res.status(400).json({ error: 'Enter the cloud address.' });
  if (!apiKey) return res.status(400).json({ error: 'Enter the API key.' });
  if (!/^https?:\/\//i.test(cloudUrl)) {
    return res.status(400).json({ error: 'The cloud address must start with http:// or https://' });
  }

  try {
    // Confirms three things before anything is written: the address is
    // reachable, the key is accepted, and which branch the cloud believes
    // this is — the same check the till's own /api/ping agent makes.
    const result = await postJson(cloudUrl, '/api/ping', {}, apiKey);

    const config = {
      enabled: true,
      cloud_url: cloudUrl,
      branch_id: result.branch_id,
      branch_name: result.branch_name,
      api_key: apiKey,
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

    /*
     * A second (or replacement) till pairing to a branch that already has
     * real history used to start its own order/shift/ingredient numbering
     * from zero right beside the first till's — which is exactly how two
     * different cloud rows for "Yogurt" ended up sharing a branch, one per
     * till's own local_id. See cloud/routes/ingest.js's own note on the
     * same problem from the other direction.
     *
     * If this till has never processed a single order, there is nothing of
     * its own to protect, so it pulls the branch's real history down first
     * — the same, already-proven logic as the PIN-gated manual restore
     * below, just without the PIN: that gate exists to stop this from
     * happening to a till with real data on it, and an order count of zero
     * is what proves this isn't one. A till that already has orders never
     * takes this path; it pairs exactly as it always did.
     */
    let autoRestored = null;
    let needsPinReset = [];
    if (isFreshTill()) {
      try {
        const cloudData = await getJson(cloudUrl, '/api/restore/full', apiKey);
        const hasRealHistory = ['staff', 'customers', 'ingredients', 'shifts', 'expenses', 'orders']
          .some((key) => Array.isArray(cloudData[key]) && cloudData[key].length > 0);
        if (hasRealHistory) {
          // onlyIfFresh: re-checked inside the write itself, so nothing typed
          // in while the download was running can be overwritten.
          const restoreResult = await applyCloudRestore(cloudData, { onlyIfFresh: true });
          autoRestored = restoreResult.restored;
          needsPinReset = restoreResult.needs_pin_reset;
          sessions.clear();
        }
      } catch (err) {
        // Pairing itself already succeeded and is worth keeping even if this
        // part fails — pushInitialBackfill below still runs either way, and
        // the owner can always run the manual restore afterward.
        console.error('[Cloud] Auto-restore on pairing failed:', err.message);
      }
    }

    // Everything this till now has — its own original data, or what the
    // pull above just gave it — pushed up so the cloud has it too. See
    // db/cloud-sync.js's pushInitialBackfill for why this can't just wait
    // for the next edit to each row.
    pushInitialBackfill();

    res.json({
      success: true,
      branch_name: result.branch_name,
      auto_restored: autoRestored,
      needs_pin_reset: needsPinReset,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Stops syncing without losing anything already recorded locally. */
router.post('/unpair', requireAdmin, (req, res) => {
  try {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/cloud/sync-now — push everything this till has, again.
 *
 * There was no way to ask for this before: every push in db/cloud-sync.js
 * is fire-and-forget with no retry queue, on purpose — an offline or slow
 * cloud must never delay or break a sale. The cost of that design, left
 * unaddressed, is real: a till offline for a stretch (or briefly pointed at
 * a wrong address — this exact thing happened once already) has no way to
 * find out afterward, and nothing here was ever going to catch it back up
 * on its own. pushInitialBackfill is already idempotent (every push is an
 * upsert) and already proven safe to run any time — it just never had a
 * button of its own outside of pairing.
 */
router.post('/sync-now', requireAdmin, (req, res) => {
  const config = readCloudConfig();
  if (!config) return res.status(400).json({ error: 'Connect to the cloud first, from the field above.' });
  pushInitialBackfill();
  res.json({ success: true });
});

/**
 * POST /api/cloud/restore-from-cloud — the opposite of pairing's usual
 * direction.
 *
 * Pairing pushes whatever already exists on THIS machine up (see
 * pushInitialBackfill). That is right when the till is the copy worth
 * keeping and the cloud is empty or wrong. This is for the other case: the
 * machine changed, the cloud is the real history, and this one needs to
 * start from what the cloud has rather than from nothing. The row-by-row
 * work lives in db/cloud-restore.js, shared with the pairing auto-restore
 * and the first-run bootstrap.
 *
 * PIN-gated on top of requireAdmin: this permanently overwrites whatever is
 * on this machine, and a session cookie proves someone is signed in, not
 * that they meant to press the one button here that cannot be undone.
 */
let restoreInProgress = false;
let restoreFailures = 0;
let restoreLockedUntil = 0;

router.post('/restore-from-cloud', requireAdmin, async (req, res) => {
  const pin = req.body && req.body.pin;
  if (!pin || typeof pin !== 'string' && typeof pin !== 'number') {
    return res.status(400).json({ error: 'Enter your PIN to confirm.' });
  }

  // Too many wrong PINs and this is refused for a minute — the PIN is the only
  // thing standing between a signed-in admin session and replacing the database.
  const now = Date.now();
  if (now < restoreLockedUntil) {
    const seconds = Math.ceil((restoreLockedUntil - now) / 1000);
    return res.status(429).json({ error: `Too many incorrect PINs. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`, code: 'INVALID_PIN' });
  }

  // Any active administrator's PIN authorises this, not only the signed-in
  // account's own: whoever holds an admin PIN is entitled to do it, and a
  // signed-in admin should not be stuck because the account they happen to be
  // using is not the one whose PIN they remember.
  const admins = db.prepare(
    "SELECT pin FROM staff WHERE active = 1 AND role IN ('Admin', 'Owner')").all();
  let pinOk = false;
  for (const admin of admins) {
    try {
      if (await bcrypt.compare(String(pin), admin.pin)) { pinOk = true; break; }
    } catch (e) {
      // a stored value that is not a real bcrypt hash can never match
    }
  }
  if (pinOk) {
    restoreFailures = 0;
  } else if (++restoreFailures >= 5) {
    restoreFailures = 0;
    restoreLockedUntil = Date.now() + 60 * 1000;
  }
  // The code matters: the frontend signs the user out on any 401, so without
  // it a mistyped PIN here logs them out of a perfectly valid session.
  if (!pinOk) return res.status(401).json({ error: 'That PIN is not correct. Please try again.', code: 'INVALID_PIN' });

  const config = readCloudConfig();
  if (!config) return res.status(400).json({ error: 'This till is not connected to the cloud yet. Connect it first, from the section above.' });

  // Two presses (or two windows) at once would fetch the export twice and
  // apply it twice, back to back.
  if (restoreInProgress) {
    return res.status(409).json({ error: 'A restore is already running. Please wait for it to finish.', code: 'RESTORE_BUSY' });
  }
  restoreInProgress = true;
  try {
    let data;
    try {
      data = await getJson(config.cloudUrl, '/api/restore/full', config.apiKey);
    } catch (err) {
      return res.status(502).json({
        error: `We could not download your data from the cloud (${err.message}). Nothing was changed on this device.`,
        code: 'CLOUD_UNAVAILABLE',
      });
    }

    try {
      const result = await applyCloudRestore(data);
      // Every signed-in session belonged to the staff table that was just
      // replaced. Ending them here is what turns "a random 401 on whatever
      // you click next" into one clear sign-in prompt.
      sessions.clear();
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('Restore from cloud failed:', err.stack || err.message);
      res.status(500).json({
        error: 'We could not finish restoring your data. Nothing was changed on this device. Please try again, and contact support if it keeps happening.',
        code: 'RESTORE_FAILED',
        detail: err.message,
      });
    }
  } finally {
    restoreInProgress = false;
  }
});

module.exports = router;
// Kept on the router's exports so existing tests that reach it from here still work.
module.exports.applyCloudRestore = applyCloudRestore;
