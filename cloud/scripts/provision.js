/**
 * Provision the branch and the owner account.
 *
 *   node scripts/provision.js branch 1 "Pure Milk"
 *   node scripts/provision.js owner owner@puremilk.example "a good password" "Shop Owner"
 *   node scripts/provision.js list
 *
 * Pure Milk POS is one shop, one till, so branch id `1` is the only one
 * needed and the only one that will ever exist — the till's own database has
 * no `branches` table to match against (see cloud/README.md's Provisioning
 * section).
 *
 * There is no branch key to print here any more. The till authenticates with
 * a single fixed TILL_API_KEY (see cloud/middleware/branch-auth.js) — set it
 * once as an environment variable on this cloud deployment and paste the
 * same value into the till's cloud-sync.json. Nothing here generates or
 * rotates it.
 */

const bcrypt = require('bcryptjs');
const db = require('../db/pg');
const { createSchema } = require('../db/schema');

const [, , command, ...args] = process.argv;

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function createBranch(idArg, name) {
  const id = Number(idArg);
  if (!Number.isInteger(id) || id <= 0) fail('Branch id must be a positive whole number.');
  if (!name) fail('Branch name required.');

  if (await db.one('SELECT 1 FROM branches WHERE id = ?', [id])) {
    fail(`Branch ${id} already exists.`);
  }

  await db.run('INSERT INTO branches (id, name) VALUES (?, ?)', [id, name]);

  console.log(`\n  Branch ${id} created: ${name}`);
  console.log('  Make sure TILL_API_KEY is set on this cloud deployment and matches the');
  console.log('  till\'s cloud-sync.json — see cloud/.env.example.\n');
}

async function createOwner(email, password, name) {
  if (!email || !password) fail('Usage: provision.js owner <email> <password> [name]');
  if (String(password).length < 10) {
    // This account can read the shop's entire trading history from anywhere in
    // the world. A four-digit habit from the till would not survive a week.
    fail('Password must be at least 10 characters. This login is on the public internet.');
  }

  const normalised = String(email).trim().toLowerCase();
  if (await db.one('SELECT 1 FROM users WHERE email = ?', [normalised])) {
    fail(`${normalised} already exists.`);
  }

  const hash = await bcrypt.hash(String(password), 10);
  await db.run('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
    [normalised, hash, name || null, 'owner']);

  console.log(`\n  Owner account created: ${normalised}\n`);
}

async function list() {
  const branches = await db.q('SELECT id, name, active, created_at FROM branches ORDER BY id');
  const users = await db.q('SELECT id, email, name, role, branch_id, active FROM users ORDER BY id');

  console.log('\n  Branches');
  if (!branches.length) console.log('    (none — run "provision.js branch 1 \\"Pure Milk\\"")');
  branches.forEach(b => console.log(`    ${b.id}  ${b.name}${b.active ? '' : '  (inactive)'}`));

  console.log('\n  Dashboard accounts');
  if (!users.length) console.log('    (none — run "provision.js owner <email> <password>")');
  users.forEach(u => console.log(
    `    ${u.id}  ${u.email}  ${u.role}${u.branch_id ? `  branch ${u.branch_id}` : '  all branches'}${u.active ? '' : '  (disabled)'}`
  ));
  console.log('');
}

(async () => {
  // The schema is idempotent, so provisioning a fresh Supabase project needs no
  // separate migration step: the first command creates the tables it needs.
  await createSchema(db);

  switch (command) {
    case 'branch': await createBranch(args[0], args[1]); break;
    case 'owner':  await createOwner(args[0], args[1], args[2]); break;
    case 'list':   await list(); break;
    default:
      console.log(`
  Usage:
    node scripts/provision.js branch <id> <name>
    node scripts/provision.js owner  <email> <password> [name]
    node scripts/provision.js list                     show what exists
`);
  }
  await db.close();
})().catch((err) => {
  // Almost always a bad or missing DATABASE_URL, so say so rather than
  // printing a bare connection stack trace.
  console.error(`\n  ${err.message}\n`);
  console.error('  Check DATABASE_URL points at the Supabase connection string.\n');
  process.exit(1);
});
