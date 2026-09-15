const express = require('express');
const router = express.Router();
const db = require('../db/database');
const fs = require('fs');
const path = require('path');
// No cloud sync here on purpose: the shop-wide settings the dashboard cares
// about (restaurant_name, tax_rate, currency, ...) are edited on the cloud
// side and pulled down, not pushed up from the till — see
// cloud/routes/settings.js and db/cloud-sync.js.

const userDataDir = process.env.POS_USER_DATA_PATH || path.join(__dirname, '..');
const DB_PATH = path.join(userDataDir, 'pos_database.db');

// GET all settings
router.get('/', (req, res) => {
  try {
    const data = db.prepare('SELECT * FROM settings').all();
    const settingsObj = {};
    data.forEach((row) => { settingsObj[row.key] = row.value; });
    res.json(settingsObj);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update multiple settings
router.put('/', (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const upsert = db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `);

  try {
    db.transaction(() => {
      for (const [key, value] of Object.entries(updates)) {
        upsert.run(key, value === null || value === undefined ? '' : value.toString());
      }
    })();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST restore from a backup file.
 *
 * FIX (Bug 5): Settings had a "Choose Backup File" button wired to a hidden
 * <input type="file"> that carried no onChange handler at all — picking a file
 * did precisely nothing. This is the endpoint that makes it work.
 *
 * The uploaded file is validated as a real SQLite database containing the
 * tables we expect before anything is overwritten, and the current database is
 * copied aside first so a bad restore is always recoverable.
 */
router.post('/restore', (req, res) => {
  const { data, filename } = req.body;

  if (!data) return res.status(400).json({ error: 'No backup data provided' });

  const stagingPath = path.join(userDataDir, `restore_staging_${Date.now()}.db`);

  try {
    const buffer = Buffer.from(data, 'base64');

    // SQLite files begin with "SQLite format 3\0".
    if (buffer.length < 16 || buffer.subarray(0, 15).toString('utf8') !== 'SQLite format 3') {
      return res.status(400).json({ error: 'That file is not a valid SQLite database' });
    }

    fs.writeFileSync(stagingPath, buffer);

    // Verify the schema before trusting it.
    const Database = require('better-sqlite3');
    const candidate = new Database(stagingPath, { readonly: true });
    const required = ['menu_items', 'orders', 'order_items', 'staff', 'settings'];
    const tables = candidate
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    candidate.close();

    const missing = required.filter((t) => !tables.includes(t));
    if (missing.length > 0) {
      fs.unlinkSync(stagingPath);
      return res.status(400).json({
        error: `Backup is missing required tables: ${missing.join(', ')}`,
      });
    }

    // Safety copy of what we are about to replace.
    const safetyDir = path.join(userDataDir, 'backups');
    if (!fs.existsSync(safetyDir)) fs.mkdirSync(safetyDir, { recursive: true });
    const safetyPath = path.join(safetyDir, `pre_restore_${Date.now()}.db`);
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, safetyPath);

    // Flush WAL, then stage the file for pickup on next boot. Swapping the
    // file underneath an open better-sqlite3 handle is not safe, so the
    // restore is applied at startup instead.
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* non-fatal */ }
    const pendingPath = path.join(userDataDir, 'pending_restore.db');
    fs.renameSync(stagingPath, pendingPath);

    res.json({
      success: true,
      message: 'Backup verified. Restart Pure Milk POS to complete the restore.',
      safety_copy: path.basename(safetyPath),
      source: filename || 'backup.db',
    });
  } catch (err) {
    if (fs.existsSync(stagingPath)) {
      try { fs.unlinkSync(stagingPath); } catch (e) { /* ignore */ }
    }
    res.status(500).json({ error: err.message });
  }
});

// NOTE: the old GET /settings/backup route was removed. It pointed at
// `__dirname/../pos_database.db` and ignored POS_USER_DATA_PATH, so in a
// packaged build it downloaded the wrong file (or 404'd). The working route
// lives at GET /api/backup in server.js.

module.exports = router;
