const fs = require('fs');
const path = require('path');

/**
 * Reads `cloud-sync.json`, the pairing file `cloud/scripts/provision.js`
 * prints and the till is expected to save beside its own database:
 *
 *   { "enabled": true, "cloud_url": "...", "branch_id": 1,
 *     "branch_name": "...", "api_key": "..." }
 *
 * Same directory convention as the database itself (`POS_USER_DATA_PATH` in
 * development/packaged installs, the backend folder otherwise) — see
 * db/database.js. Missing file, malformed JSON or `enabled: false` all mean
 * the same thing to every caller: cloud sync is off, work locally only.
 */
const userDataDir = process.env.POS_USER_DATA_PATH || path.join(__dirname, '..');
const CONFIG_PATH = path.join(userDataDir, 'cloud-sync.json');

function readCloudConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!raw || raw.enabled !== true) return null;
    if (!raw.cloud_url || !raw.api_key || !raw.branch_id) return null;
    return {
      cloudUrl: String(raw.cloud_url).replace(/\/+$/, ''),
      branchId: Number(raw.branch_id),
      branchName: raw.branch_name || null,
      apiKey: String(raw.api_key),
    };
  } catch (e) {
    console.error('[Cloud] Could not read cloud-sync.json:', e.message);
    return null;
  }
}

module.exports = { readCloudConfig, CONFIG_PATH };
