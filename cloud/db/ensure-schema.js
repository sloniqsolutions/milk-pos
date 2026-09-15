/**
 * Apply the schema exactly once per process, however many times and from
 * wherever this is called.
 *
 * Two callers share this: server.js's boot sequence (a persistent VPS/local
 * process, which awaits this before it starts listening so a bad
 * DATABASE_URL fails loudly instead of quietly) and app.js's own per-request
 * gate (for a serverless deployment, which has no separate "boot" phase to
 * fail during — the first request into a cold container is what triggers
 * this, and every request after it in the same warm container just awaits
 * the same already-resolved promise).
 */

const db = require('./pg');
const { createSchema } = require('./schema');

let ready = null;

function ensureSchema() {
  if (!ready) {
    ready = createSchema(db).catch((err) => {
      // Let the next attempt try again rather than wedging this process into
      // permanently rejecting on a transient connection failure.
      ready = null;
      throw err;
    });
  }
  return ready;
}

module.exports = { ensureSchema };
