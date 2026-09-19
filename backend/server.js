const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3001;

// SECURITY: bind to the loopback interface only.
//
// This used to be a bare `app.listen(PORT)`, which binds 0.0.0.0 — every
// interface on the machine. On a shop's wifi that meant any phone or laptop
// on the same network could reach the API, and since none of these routes
// carry authentication, that is a full remote takeover: void orders, read
// the staff table, or POST /api/settings/restore to replace the database.
// The frontend always runs on this same machine, so loopback is sufficient.
const HOST = process.env.POS_BIND_HOST || '127.0.0.1';

// SECURITY: the previous CORS config called back(null, true) for every origin,
// including the two "checks" above it, which made it a no-op allow-all.
// The renderer is either a file:// page (origin `null`, sent as undefined by
// some Chromium versions) in the packaged build, or the Vite dev server.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

app.use(cors({
  origin: function (origin, callback) {
    // No Origin header: same-origin, curl, or a file:// page. Because we are
    // bound to loopback, these can only come from this machine.
    if (!origin || origin === 'null') return callback(null, true);
    if (origin.startsWith('file://')) return callback(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    return callback(new Error(`Origin not allowed: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const {
  attachUser, requireAuth, requireAdmin, adminOnlyWrites,
} = require('./middleware/auth');

// Resolve the caller's session for every request; individual routes decide
// what they require.
app.use(attachUser);

/**
 * Permission matrix.
 *
 * Reads that the till needs in order to sell — the menu, the shop's
 * tax and currency settings — are open to any signed-in user. Everything that
 * changes them, plus inventory, staff and backups, is admin-only.
 *
 * These are the real boundary. The React app hides the same things, but that
 * is a convenience: this is what actually stops a manager repricing the menu.
 */
app.use('/api/menu', adminOnlyWrites, require('./routes/menu'));
/**
 * Settings: readable without a token, writable only by an administrator.
 *
 * The sign-in screen draws the shop's name and branding before anyone has
 * signed in, so requiring a token to *read* settings left the PIN screen
 * unable to load — and, because a 401 signs the user out, bouncing in a loop.
 * Nothing in here is secret: it is the tax rate, currency and receipt wording
 * that get printed on every customer's receipt anyway.
 */
app.use('/api/settings', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  return requireAdmin(req, res, next);
}, require('./routes/settings'));

// Stock counts are day-to-day till work, so both roles keep and adjust them.
app.use('/api/inventory', requireAuth, require('./routes/inventory'));

// Staff administration. The login route inside is exempt — see routes/staff.js.
app.use('/api/staff', require('./routes/staff'));

// Pairing this till with the cloud, from Settings. Read is either role; the
// route itself restricts pairing and unpairing to an administrator.
app.use('/api/cloud', requireAuth, require('./routes/cloud'));

// The daily WhatsApp report sends the shop's figures out of the building.
app.use('/api/whatsapp', requireAdmin, require('./routes/whatsapp'));

// Taking money and running the till: both roles.
app.use('/api/orders', requireAuth, require('./routes/orders'));
app.use('/api/customers', requireAuth, require('./routes/customers'));
// Petty cash out of the drawer is till work, so both roles record it.
app.use('/api/expenses', requireAuth, require('./routes/expenses'));
app.use('/api/shifts', requireAuth, require('./routes/shifts'));
app.use('/api/reports', requireAuth, require('./routes/reports'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Software activation. Open, like /api/health above — this has to work
// before a shift, a PIN or a paired cloud address exists at all. See
// routes/activation.js and db/activation-config.js.
app.use('/api/activation', require('./routes/activation'));

// Backup — reads from correct DB location. Admin only: it hands over the
// entire trading history as a file.
app.get('/api/backup', requireAdmin, (req, res) => {
  const userDataDir = process.env.POS_USER_DATA_PATH || path.join(__dirname);
  const dbPath = path.join(userDataDir, 'pos_database.db');

  if (!fs.existsSync(dbPath)) {
    return res.status(404).json({ error: 'Database file not found' });
  }

  const date = new Date().toISOString().split('T')[0];
  res.download(dbPath, `pos_backup_${date}.db`);
});

// Anything under /api that no route claimed: a clear answer, not an HTML error page.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'That request was not recognised. Please update the app or contact support.' });
});

/**
 * The last line of defence. Whatever a route lets escape — a malformed body, a
 * value of the wrong type reaching the database, a constraint it did not
 * foresee — ends here as a plain-language answer the till can show, never a
 * stack trace or a raw SQL message, and never takes the process down.
 */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && /Origin not allowed/.test(err.message)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'The request could not be read. Please try again.', code: 'BAD_REQUEST' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That upload is too large.', code: 'TOO_LARGE' });
  }
  if (err && /SQLite3 can only bind/.test(String(err.message))) {
    return res.status(400).json({ error: 'Some of the information sent was in the wrong format. Please check it and try again.', code: 'BAD_INPUT' });
  }
  if (err && /^SQLITE_CONSTRAINT/.test(String(err.code || ''))) {
    return res.status(409).json({ error: 'That change conflicts with information already saved. Refresh the page and try again.', code: 'CONFLICT' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong on our side. Nothing was lost — please try again.', code: 'INTERNAL' });
});

// A rejected promise nobody awaited (a background sync, say) must never end the
// till's process mid-sale.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Port conflict handling
const server = app.listen(PORT, HOST, () => {
  console.log(`POS Backend running on http://${HOST}:${PORT}`);
});

/**
 * The one exception to "sync waits for the first sign-in": a brand-new install
 * (paired by the installer, holding no data at all) catches up with its
 * branch's staff and history here, at boot, *before* anyone signs in — so the
 * first person to reach the PIN screen already sees the real roster, and no
 * session exists yet that the swap could invalidate. It does nothing on a
 * device that has data of its own, and stops for good once it has run. See
 * sync/bootstrap.js.
 */
require('./sync/bootstrap').startBootstrap();

// Milk and Dahi items that reached this till without a recipe (from the
// dashboard, or typed at the Menu screen) sold without moving any stock; give
// them the recipe their size implies so their sales show up in stock reports.
try {
  const fixed = require('./db/menu-pricing').backfillMissingRecipes();
  if (fixed > 0) console.log(`Added recipes to ${fixed} menu item(s) that had none.`);
} catch (err) {
  console.error('Recipe backfill skipped:', err.message);
}

/**
 * Cloud sync starts on the first sign-in of this process's life, not at
 * process boot.
 *
 * It used to start here unconditionally — every one of these polls/pushes
 * is already a no-op until cloud-sync.json exists, so it was harmless, but
 * "harmless" isn't "correct": the till was reaching out to the internet
 * before anyone had touched the PIN screen, which is backwards for an
 * offline-first app whose whole point is that it works locally first and
 * syncs *because* it's in use, not on its own initiative before anyone is
 * even at it. See middleware/auth.js's setOnFirstSignIn — sessions are
 * memory-only, so "a session was just created" and "the till just started
 * being used this run" are the same event.
 */
require('./middleware/auth').setOnFirstSignIn(() => {
  // Pulls the menu, staff roster and shop-wide settings down from the cloud
  // when paired (see backend/sync/downlink.js). A no-op every tick until
  // cloud-sync.json exists, so an unpaired till pays nothing for this.
  require('./sync/downlink').startDownlinkPolling();

  // Feeds the dashboard's Live tab (see backend/sync/heartbeat.js). Same
  // no-op-until-paired behaviour as the downlink poller above.
  require('./sync/heartbeat').startHeartbeat();

  // Uploads the till's own daily backup to the cloud (see
  // backend/sync/backup-push.js) — same no-op-until-paired behaviour.
  require('./sync/backup-push').startBackupPush();

  // One-time: re-file this till's earlier stock movements on the cloud under
  // the right ingredient (see db/cloud-sync.js's pushInventoryEntriesResync).
  // Remembered only once the cloud has actually accepted all of them.
  try {
    const localDb = require('./db/database');
    const done = localDb.prepare("SELECT value FROM settings WHERE key = 'entries_name_resync_v1'").get();
    if (!done) {
      require('./db/cloud-sync').pushInventoryEntriesResync().then((ok) => {
        if (ok) {
          localDb.prepare(
            "INSERT INTO settings (key, value) VALUES ('entries_name_resync_v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
        }
      }).catch((err) => console.error('[Cloud] Stock movement resync will retry:', err.message));
    }
  } catch (err) {
    console.error('[Cloud] Stock movement resync skipped:', err.message);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ERROR: Port ${PORT} is already in use. Close the other application and restart Pure Milk POS.`);
    process.exit(1);
  } else {
    console.error('Server error:', err.message);
    process.exit(1);
  }
});
