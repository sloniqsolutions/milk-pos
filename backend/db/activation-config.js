const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Software activation — a separate concern from cloud sync pairing.
 *
 * Pairing (`cloud-config.js`) says which branch this till's sales belong to,
 * and is entered by the owner once cloud sync is being set up. Activation
 * says whether this is a legitimately licensed install at all, and has to
 * work before any of that — before a shop has even been chosen — so it does
 * not read cloud-sync.json and does not depend on a cloud address the owner
 * has not typed in yet. It always talks to Virtiqo's own activation server,
 * never to whatever cloud a branch happens to be paired to.
 *
 * Same directory convention as the database and cloud-sync.json (see
 * db/cloud-config.js) — `POS_USER_DATA_PATH` in development/packaged
 * installs, the backend folder otherwise. That directory survives an app
 * update or reinstall on the same machine, which activation.json and
 * device-id.json both depend on: reinstalling the app must not look like a
 * second, different machine to the activation server.
 */
const userDataDir = process.env.POS_USER_DATA_PATH || path.join(__dirname, '..');
const ACTIVATION_PATH = path.join(userDataDir, 'activation.json');
const DEVICE_ID_PATH = path.join(userDataDir, 'device-id.json');

/*
 * Overridable for local development and testing against a local cloud
 * instance. A production build must set MILKPOS_ACTIVATION_URL to the real,
 * deployed activation server — this fallback is a dev convenience, not a
 * production default.
 */
const ACTIVATION_URL = (process.env.MILKPOS_ACTIVATION_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');

/**
 * A stable identity for this install, minted once and kept in the same
 * durable per-machine folder as the database. Not a hardware fingerprint —
 * just a random id that outlives an app update or reinstall on the same
 * machine, which is all "is this the same device" needs to mean here.
 */
function getDeviceId() {
  try {
    if (fs.existsSync(DEVICE_ID_PATH)) {
      const raw = JSON.parse(fs.readFileSync(DEVICE_ID_PATH, 'utf8'));
      if (raw && raw.device_id) return raw.device_id;
    }
  } catch (e) {
    // Malformed file — fall through and mint a fresh one rather than fail.
  }

  const deviceId = crypto.randomUUID();
  try {
    fs.writeFileSync(DEVICE_ID_PATH, JSON.stringify({ device_id: deviceId }, null, 2));
  } catch (e) {
    console.error('[Activation] Could not persist device id:', e.message);
  }
  return deviceId;
}

function readActivation() {
  try {
    if (!fs.existsSync(ACTIVATION_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(ACTIVATION_PATH, 'utf8'));
    if (!raw || raw.activated !== true) return null;
    return raw;
  } catch (e) {
    return null;
  }
}

function writeActivation(data) {
  fs.writeFileSync(ACTIVATION_PATH, JSON.stringify({ activated: true, ...data }, null, 2));
}

module.exports = {
  getDeviceId, readActivation, writeActivation, ACTIVATION_URL, ACTIVATION_PATH,
};
