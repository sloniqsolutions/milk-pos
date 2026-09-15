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

// Rejected CORS preflights arrive here as errors; answer them cleanly instead
// of leaking a stack trace.
app.use((err, req, res, next) => {
  if (err && /Origin not allowed/.test(err.message)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Port conflict handling
const server = app.listen(PORT, HOST, () => {
  console.log(`POS Backend running on http://${HOST}:${PORT}`);
});

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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ERROR: Port ${PORT} is already in use. Close the other application and restart Pure Milk POS.`);
    process.exit(1);
  } else {
    console.error('Server error:', err.message);
    process.exit(1);
  }
});
