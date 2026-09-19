/**
 * Where the till keeps its data, and how existing data gets there.
 *
 * A packaged install used to keep the database, the cloud pairing, the device
 * id and the activation record beside server.js — inside the install folder
 * (resources/backend). electron-builder's NSIS updater does not leave that
 * folder alone: to update, it moves every file in the install directory aside
 * and deletes the directory (see app-builder-lib/templates/nsis/uninstaller.nsh,
 * un.atomicRMDir + `RMDir /r $INSTDIR`). Every release would therefore have
 * erased the shop's database on every machine that updated.
 *
 * A packaged install now keeps all of it in Electron's per-user data folder
 * (%APPDATA%\pure-milk-pos), which no installer or updater touches. Development
 * still uses backend/ in the repo, as before.
 */

const fs = require('fs');
const path = require('path');

/** Everything the backend keeps beside its database — see backend/db/*-config.js. */
const DATA_FILES = [
  'pos_database.db', 'pos_database.db-wal', 'pos_database.db-shm',
  'cloud-sync.json', 'device-id.json', 'activation.json',
];

/** The folder the backend should treat as its data folder (POS_USER_DATA_PATH), or null for "beside server.js". */
function resolveDataDir({ isPackaged, userDataPath }) {
  return isPackaged && userDataPath ? path.join(userDataPath, 'data') : null;
}

/**
 * Brings data left in the old location (beside server.js) across to the new one,
 * once. Never overwrites: if the new location already has a database, that is
 * the real one and the old files are left where they are.
 *
 * This only helps where the old folder still exists — an install that has just
 * been *updated* by the old installer has already had it deleted, which is why
 * the cloud restore (backend/sync/bootstrap.js) exists too.
 *
 * @returns {string[]} the files copied
 */
function migrateLegacyData(legacyDir, dataDir, log = () => {}) {
  const copied = [];
  if (!legacyDir || !dataDir || path.resolve(legacyDir) === path.resolve(dataDir)) return copied;
  if (!fs.existsSync(path.join(legacyDir, 'pos_database.db'))) return copied;
  if (fs.existsSync(path.join(dataDir, 'pos_database.db'))) return copied;

  fs.mkdirSync(dataDir, { recursive: true });
  for (const name of DATA_FILES) {
    const from = path.join(legacyDir, name);
    const to = path.join(dataDir, name);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    try {
      fs.copyFileSync(from, to);
      copied.push(name);
    } catch (err) {
      log(`[Data] Could not copy ${name}: ${err.message}`);
    }
  }
  if (copied.length) log(`[Data] Moved existing data out of the install folder: ${copied.join(', ')}`);
  return copied;
}

module.exports = { resolveDataDir, migrateLegacyData, DATA_FILES };
