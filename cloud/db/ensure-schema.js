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

/**
 * Seeds the "Dahi" menu item if no item of that name exists yet — the cloud
 * side of the same seed backend/db/database.js applies to the till's own
 * SQLite (see that file's "migration_dahi_item_v1"). The cloud never learns
 * about a till-only item on its own (menu sync only ever pulls FROM the
 * cloud, see backend/sync/downlink.js), so without this, a shop that only
 * ever used the till's local Menu screen would have Dahi disappear from
 * their menu the moment cloud sync starts working and the till begins
 * trusting the cloud as authoritative.
 */
async function seedDahiMenuItem() {
  const existing = await db.one('SELECT id FROM menu_items WHERE name = ?', ['Dahi']);
  if (existing) return;
  await db.run(
    `INSERT INTO menu_items (name, category, price, has_variants, description, active)
     VALUES ('Dahi', 'Dahi', 300, 0, 'Fresh yogurt, made in-house from milk', 1)`
  );
}

function ensureSchema() {
  if (!ready) {
    ready = createSchema(db)
      .then(() => seedDahiMenuItem())
      .catch((err) => {
        // Let the next attempt try again rather than wedging this process into
        // permanently rejecting on a transient connection failure.
        ready = null;
        throw err;
      });
  }
  return ready;
}

module.exports = { ensureSchema };
