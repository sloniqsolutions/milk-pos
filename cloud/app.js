/**
 * Pure Milk POS cloud API — the Express app itself, with no opinion on how it
 * is run.
 *
 * Two kinds of caller, with two entirely separate credentials:
 *
 *   - **Tills**, authenticated by a per-branch API key. They only ever push:
 *     live status now, sales later. They never read another branch's data.
 *   - **The owner**, authenticated by an httpOnly session cookie. Reads only.
 *
 * Split out of server.js so the same app can be run two ways without
 * duplicating a single route: `server.js` calls `app.listen()` for a
 * persistent process (a VPS, or a laptop during development), and
 * `dashboard/api/[...path].js` hands this straight to Vercel as a
 * serverless function, alongside the dashboard's own static build in the
 * same deployment. Same origin either way, which is what lets the session
 * cookie stay a plain SameSite=Lax httpOnly cookie with no CORS negotiation.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');

require('./env').loadEnv();

const db = require('./db/pg');
const { attachUser } = require('./middleware/session');
const { ensureSchema } = require('./db/ensure-schema');
const { requireBranch } = require('./middleware/branch-auth');

const app = express();

/*
 * Behind a reverse proxy (Virtualmin's Apache/nginx for a VPS deploy, or
 * Vercel's own edge network), so trust its forwarded address — otherwise
 * every request appears to come from one internal IP and every IP-keyed rate
 * limiter in this codebase (login, pairing, activation) would be keyed on a
 * single value for the whole internet.
 */
app.set('trust proxy', 1);

// Bodies here are small: a heartbeat is a few hundred bytes and a sales batch
// is capped by the till. A low limit means a malformed or hostile request is
// rejected before it is parsed rather than after.
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Cheap, dependency-free hardening. No CSP here: the dashboard is served from
// this same origin with no third-party scripts, so there is nothing a CSP
// would be restricting that isn't already true.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

/*
 * Schema readiness gate.
 *
 * A persistent process (server.js) already awaits ensureSchema() before it
 * starts listening, so this resolves instantly there — the schema is applied
 * before the first request can ever reach it. A serverless cold start has no
 * such boot phase: the very first request IS what starts this process, so
 * without a gate it would race table creation against whatever query that
 * request happens to make. Every request after the first, in the same warm
 * container, just awaits the same resolved promise.
 */
app.use((req, res, next) => {
  ensureSchema()
    .then(() => next())
    .catch((err) => {
      console.error('Could not prepare the database:', err.message);
      res.status(503).json({ error: 'Database unavailable' });
    });
});

app.use(attachUser);

/** Liveness probe. Open, and deliberately says nothing about the shop. */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'pure-milk-pos-cloud', time: new Date().toISOString() });
});

// --- Till-facing: branch key ------------------------------------------------
app.use('/api/ping', requireBranch, require('./routes/ping'));
app.use('/api/ingest', require('./routes/ingest'));
// Pulling everything down onto a replacement machine, the opposite direction
// from ingest — see routes/restore.js for when this is what a fresh install
// actually needs instead of starting empty.
app.use('/api/restore', require('./routes/restore'));

// --- Owner-facing: session cookie -------------------------------------------
app.use('/api/auth', require('./routes/auth'));

// Mixed: the write half takes a branch key, the read half a session cookie, so
// each is guarded inside the router rather than at the mount.
app.use('/api/live', require('./routes/live'));

// Both-branch reporting. Every route inside requires a signed-in owner.
app.use('/api/reports', require('./routes/reports'));
app.use('/api/branches', require('./routes/branches'));

/*
 * Staff, which the cloud now owns the way it owns the menu.
 *
 * Mounted ahead of branch-data because both answer under /api/staff. This
 * router holds the writes and the two till-facing endpoints; the reads it does
 * not define — the list and the performance figures — fall through to
 * branch-data below. Guards are inside, as with the menu: editing needs a
 * signed-in owner, /version and /snapshot answer a branch key.
 */
app.use('/api/staff', require('./routes/staff'));

/*
 * Ingredients, credit customers and expenses — the dashboard can now
 * create/edit/delete these too (see each file's own docstring for exactly
 * what stays till-derived: ingredient stock, customer balance/litres).
 * Mounted ahead of branch-data for the same reason staff is: each answers
 * under the same base path branch-data's own read-only GET already used,
 * and only the write routes plus /version and /snapshot are defined here.
 */
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/expenses', require('./routes/expenses'));

/*
 * Payroll. The dashboard and nowhere else.
 *
 * There is no branch-key route in here and no downlink: wages never travel to
 * a till, so a manager on a drawer cannot see what a colleague earns even if a
 * permission were misconfigured. See routes/payroll.js.
 */
app.use('/api/payroll', require('./routes/payroll'));

/*
 * Backups: a till uploading one, and the owner getting it back onto a
 * different machine. Guards are inside — the upload answers a branch key, the
 * rest needs a signed-in owner. Mounted before the JSON body parser matters
 * here: the upload route brings its own raw parser, since a gzipped database
 * is not JSON. See routes/backup.js.
 */
app.use('/api/backup', require('./routes/backup'));

/*
 * Software activation — the product key that makes an install licensed,
 * checked before a till has necessarily been paired to any branch at all.
 * Unauthenticated and rate limited for the same reason pairing's claim
 * endpoint is. See routes/activation.js.
 */
app.use('/api/activation', require('./routes/activation'));

/*
 * Clearing all trading data before handing this install to its next owner.
 * Owner-only and re-verifies the dashboard password inside the route itself
 * — see routes/admin.js for why a session cookie alone isn't enough here.
 */
app.use('/api/admin', require('./routes/admin'));

// Expenses, shifts, staff figures and stock — read-only, in the till's own
// response shapes so the POS screens can be reused on the dashboard unaltered.
app.use('/api', require('./routes/branch-data'));

/*
 * The menu, which the cloud owns outright. Guards are inside the router: the
 * dashboard's editing needs a session, while /version and /snapshot answer a
 * branch key, because those two are a till asking.
 */
app.use('/api/menu', require('./routes/menu'));
// No /api/deals mount: Milk POS's till has no combo/bundle concept at all
// (see frontend/db/menu-data.js), so there is nothing on the dashboard that
// would ever call this. routes/deals.js and its schema tables are left in
// place, unreachable, rather than deleted — reintroducing a deals feature
// later (a bundled-litres discount, say) is then a one-line change here.

// Shop-wide settings — tax, staff discount, currency, shop name. Branch-owned
// settings (printer, receipt wording, delivery price) stay on each till.
app.use('/api/settings', require('./routes/settings'));

/*
 * Serve the dashboard build from this same process, for the persistent
 * deployment path (server.js on a VPS or a laptop). On Vercel this branch is
 * simply never reached: Vercel's own static hosting serves dashboard/dist
 * directly, and this app is only ever invoked there for requests already
 * under /api/*, via dashboard/api/[...path].js.
 *
 * Optional: if the build is absent, the API still runs. Useful in
 * development, where Vite serves the UI itself and proxies /api across.
 */
const DASHBOARD_DIST = process.env.MILKPOS_DASHBOARD_DIST
  || path.join(__dirname, '..', 'dashboard', 'dist');

if (fs.existsSync(path.join(DASHBOARD_DIST, 'index.html'))) {
  app.use(express.static(DASHBOARD_DIST));
  // Anything not matched above and not under /api is a client-side route, so
  // hand back index.html rather than a 404.
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(DASHBOARD_DIST, 'index.html'));
  });
  console.log(`Serving dashboard from ${DASHBOARD_DIST}`);
} else {
  console.log('No dashboard build found — API only. (Run `npm run build` in dashboard/.)');
}

// 404 as JSON, so a dashboard fetch gets a parseable body rather than HTML.
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Server error' });
});

module.exports = app;
