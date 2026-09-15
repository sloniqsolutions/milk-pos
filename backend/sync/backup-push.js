/**
 * Pushes the till's own daily backup up to the cloud (see
 * cloud/routes/backup.js). Nothing on the till side did this before — the
 * local backup (db/database.js's doAutoBackup) protects against a deleted
 * record, but sits on the same disk as the database itself, which is no
 * protection at all if that disk is what fails.
 *
 * Reuses the file doAutoBackup already wrote today rather than copying the
 * live database again: that copy already exists, made once, at the same
 * cadence this needs, so there is no reason to read the live file a second
 * time (better-sqlite3's WAL mode makes a plain file copy of a database
 * that is actively being written to a real, if rare, risk — not worth
 * taking twice for the same day).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const db = require('../db/database');
const { readCloudConfig } = require('../db/cloud-config');
const { postRaw } = require('../db/cloud-http');

const userDataDir = process.env.POS_USER_DATA_PATH || path.join(__dirname, '..');
const backupDir = path.join(userDataDir, 'backups');

/** UTC date, matching db/database.js's doAutoBackup filename exactly. */
function todaysBackupPath() {
  const date = new Date().toISOString().split('T')[0];
  return path.join(backupDir, `pos_backup_${date}.db`);
}

function getLastPushedSha() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'cloud_last_backup_sha256'").get();
  return row ? row.value : null;
}

const setSetting = db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

function orderStats() {
  const row = db.prepare(
    "SELECT COUNT(*) AS n, MAX(created_at) AS last FROM orders WHERE status != 'voided'"
  ).get();
  return { count: row.n || 0, lastOrderAt: row.last || null };
}

/**
 * Reads today's local backup file, and — if it hasn't already been sent —
 * gzips and uploads it. Skipping an unchanged file is what makes it safe to
 * call this often: the file only changes once a day (when doAutoBackup makes
 * a new one), so every other call after the first is nearly free.
 */
async function pushTodaysBackup() {
  const config = readCloudConfig();
  if (!config) return;

  const filePath = todaysBackupPath();
  if (!fs.existsSync(filePath)) return;

  const raw = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  if (sha256 === getLastPushedSha()) return;

  const gz = zlib.gzipSync(raw);
  const { count, lastOrderAt } = orderStats();
  const stat = fs.statSync(filePath);

  try {
    await postRaw(config.cloudUrl, '/api/backup/upload', config.apiKey, gz, {
      'Content-Type': 'application/gzip',
      'X-Backup-Taken-At': stat.mtime.toISOString(),
      'X-Backup-Raw-Bytes': String(raw.length),
      'X-Backup-Sha256': sha256,
      'X-Backup-Orders': String(count),
      'X-Backup-Last-Order-At': lastOrderAt || '',
      'X-Backup-Reason': 'scheduled',
    });
    setSetting.run('cloud_last_backup_sha256', sha256);
    console.log(`[Cloud] Backup uploaded (${(gz.length / 1024).toFixed(0)} KB gzipped).`);
  } catch (err) {
    console.error('[Cloud] Backup upload failed:', err.message);
  }
}

/**
 * Started once at boot. The local backup itself is already made at
 * `require` time (db/database.js runs doAutoBackup on load, before this ever
 * fires), so the first check has something to send immediately; checking
 * every few hours after that catches a fresh day's file without needing to
 * be running at any particular minute.
 */
function startBackupPush(intervalMs = 4 * 60 * 60 * 1000) {
  pushTodaysBackup();
  const timer = setInterval(pushTodaysBackup, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { startBackupPush, pushTodaysBackup };
