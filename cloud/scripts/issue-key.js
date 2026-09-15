/**
 * Issue and manage product keys — the license that makes an install of
 * Milk POS legitimate, separate from which branch it becomes (see
 * routes/activation.js).
 *
 *   node scripts/issue-key.js issue ["label"]
 *   node scripts/issue-key.js list
 *   node scripts/issue-key.js reset  <id>
 *   node scripts/issue-key.js revoke <id>
 *
 * A key is printed ONCE, here. Only its hash is stored, so a lost key is not
 * recovered — issue a new one instead.
 */

const db = require('../db/pg');
const { createSchema } = require('../db/schema');
const { generateProductKey, hashProductKey } = require('../db/product-key');

const [, , command, ...args] = process.argv;

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function issue(label) {
  const key = generateProductKey();
  const row = await db.one(
    'INSERT INTO product_keys (key_hash, label) VALUES (?, ?) RETURNING id',
    [hashProductKey(key), label || null]
  );

  console.log('\n  ---------------------------------------------------------------');
  console.log('  Product key issued. Shown once — it cannot be recovered, only reissued.');
  console.log('  ---------------------------------------------------------------\n');
  console.log(`  Key #${row.id}${label ? `  (${label})` : ''}\n`);
  console.log(`    ${key}\n`);
}

async function list() {
  const rows = await db.q(`
    SELECT id, label, device_id, device_name, activated_at, revoked_at, created_at
      FROM product_keys ORDER BY id
  `);
  console.log('\n  Product keys');
  if (!rows.length) console.log('    (none — run "issue-key.js issue \\"label\\"")');
  rows.forEach((r) => {
    const state = r.revoked_at ? 'revoked'
      : r.device_id ? `activated on ${r.device_name || r.device_id}`
        : 'unused';
    console.log(`    ${r.id}  ${r.label || '(no label)'}  —  ${state}`);
  });
  console.log('');
}

/** Frees a key from whatever device it is bound to, so it can activate a
 * replacement machine — the same shape as rekeying a branch. */
async function reset(idArg) {
  const id = Number(idArg);
  const row = await db.one('SELECT id, label FROM product_keys WHERE id = ?', [id]);
  if (!row) fail(`No product key ${idArg}.`);

  await db.run(
    'UPDATE product_keys SET device_id = NULL, device_name = NULL, activated_at = NULL WHERE id = ?',
    [id]
  );
  console.log(`\n  Key #${id}${row.label ? ` (${row.label})` : ''} freed — it can activate a new device now.\n`);
}

async function revoke(idArg) {
  const id = Number(idArg);
  const row = await db.one('SELECT id, label FROM product_keys WHERE id = ?', [id]);
  if (!row) fail(`No product key ${idArg}.`);

  await db.run('UPDATE product_keys SET revoked_at = NOW() WHERE id = ?', [id]);
  console.log(`\n  Key #${id}${row.label ? ` (${row.label})` : ''} revoked — it will no longer activate anything.\n`);
}

(async () => {
  // The schema is idempotent, so a fresh Supabase project needs no separate
  // migration step: the first command creates the table it needs.
  await createSchema(db);

  switch (command) {
    case 'issue': await issue(args[0]); break;
    case 'list': await list(); break;
    case 'reset': await reset(args[0]); break;
    case 'revoke': await revoke(args[0]); break;
    default:
      console.log(`
  Usage:
    node scripts/issue-key.js issue  ["label"]   generate a key, print it once
    node scripts/issue-key.js list                show every key and its state
    node scripts/issue-key.js reset  <id>         free a key so it can activate a new device
    node scripts/issue-key.js revoke <id>         permanently disable a key
`);
  }
  await db.close();
})().catch((err) => {
  console.error(`\n  ${err.message}\n`);
  console.error('  Check DATABASE_URL points at the Supabase connection string.\n');
  process.exit(1);
});
