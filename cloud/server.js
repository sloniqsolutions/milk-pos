/**
 * Entry point for running the cloud API as a persistent process — a VPS via
 * Virtualmin's Apache/nginx reverse proxy, or a laptop during development.
 * This process never faces the internet directly, which is why it binds
 * 127.0.0.1 by default.
 *
 * The app itself — every route, every middleware — lives in app.js and knows
 * nothing about being listened on. That is what lets the exact same app run
 * as a Vercel serverless function instead: see dashboard/api/[...path].js.
 * Nothing below this line has any equivalent there — a serverless invocation
 * has no boot phase to fail during and no process to send SIGTERM to.
 */

const app = require('./app');
const db = require('./db/pg');
const { ensureSchema } = require('./db/ensure-schema');
const { startSessionCleanup } = require('./middleware/session');

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.MILKPOS_CLOUD_HOST || '127.0.0.1';

/*
 * Schema first, then listen.
 *
 * app.js's own request-time gate would apply the schema on the first request
 * regardless, but refusing to listen at all when it cannot be applied is
 * deliberate here: a server that starts accepting connections against a
 * database it could not reach would report an empty shop, which reads
 * exactly like a shop that sold nothing.
 */
ensureSchema()
  .then(() => {
    startSessionCleanup();
    server = app.listen(PORT, HOST, () => {
      console.log(`Pure Milk POS cloud API on http://${HOST}:${PORT}`);
      console.log('Database: Supabase (Postgres)');
    });
    server.on('error', onListenError);
  })
  .catch((err) => {
    console.error('Could not prepare the database:', err.message);
    console.error('Check DATABASE_URL points at the Supabase connection string.');
    process.exit(1);
  });

function onListenError(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
    process.exit(1);
  }
  throw err;
}

// systemd sends SIGTERM on restart and on deploy. Closing the database on the
// way out means WAL is checkpointed rather than left for the next start to
// recover.
let server = null;

function shutdown() {
  if (!server) process.exit(0);
  server.close(async () => {
    try { await db.close(); } catch (e) { /* pool already ended */ }
    process.exit(0);
  });
  // Do not hang forever on a connection that will not close.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
