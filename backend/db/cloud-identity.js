/**
 * Which cloud row each restored local row really is.
 *
 * The cloud identifies a row by (branch, device, number): the till that made it
 * and that till's own AUTOINCREMENT number for it. That is what keeps two tills'
 * "order 7" apart. A device that *restores* history from the cloud (a
 * replacement PC, or a second till set up in the same shop) receives rows
 * other tills made, and may have to renumber some to fit its own number space.
 * If it later pushes one of them — a void, a customer edit, "Sync now" — under
 * its own device and its own number, the cloud files a second copy next to the
 * original: revenue counted twice, a customer listed twice.
 *
 * So at restore time every row that arrives with a known origin is written down
 * here — this device's number, and the (device, number) the cloud knows it by —
 * and everything that pushes a row consults this first (see db/cloud-sync.js).
 * A row this device created itself has no entry and pushes as it always did.
 *
 * Kept in the same database file as the rows it describes, so a backup or a
 * file-level restore carries the two together.
 */

const db = require('./database');

db.exec(`
  CREATE TABLE IF NOT EXISTS cloud_identity (
    tbl       TEXT    NOT NULL,
    local_id  INTEGER NOT NULL,
    device_id TEXT    NOT NULL,
    orig_id   INTEGER NOT NULL,
    PRIMARY KEY (tbl, local_id)
  );
`);

const getStmt = db.prepare('SELECT device_id, orig_id FROM cloud_identity WHERE tbl = ? AND local_id = ?');
const putStmt = db.prepare('INSERT OR REPLACE INTO cloud_identity (tbl, local_id, device_id, orig_id) VALUES (?, ?, ?, ?)');
const forgetStmt = db.prepare('DELETE FROM cloud_identity WHERE tbl = ? AND local_id = ?');
const clearStmt = db.prepare('DELETE FROM cloud_identity');

/** { device_id, orig_id } for a restored row, or null for one this device made itself. */
function lookup(table, localId) {
  const id = Number(localId);
  if (!Number.isInteger(id)) return null;
  return getStmt.get(table, id) || null;
}

function remember(table, localId, deviceId, origId) {
  if (!deviceId || !Number.isInteger(Number(localId)) || !Number.isInteger(Number(origId))) return;
  putStmt.run(table, Number(localId), String(deviceId), Number(origId));
}

/**
 * Called when a local row is deleted. Staff, customer and expense numbers are
 * handed out as MAX+1 (see their create routes), so a number can be reused
 * after a delete — and a reused number must not inherit the deleted row's identity.
 */
function forget(table, localId) {
  forgetStmt.run(table, Number(localId));
}

function clear() {
  clearStmt.run();
}

module.exports = { lookup, remember, forget, clear };
