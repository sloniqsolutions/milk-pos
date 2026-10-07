/** Read till's SQLite stock values. */
const path = require('path');
const dbPath = process.env.POS_USER_DATA_PATH
  ? path.join(process.env.POS_USER_DATA_PATH, 'pos_database.db')
  : path.join(__dirname, '..', '..', 'backend', 'pos_database.db');

let Database;
try { Database = require('better-sqlite3'); } catch(e) {
  console.error('better-sqlite3 not available in cloud/. Trying from backend...');
  try { Database = require(path.join(__dirname, '..', '..', 'backend', 'node_modules', 'better-sqlite3')); } catch(e2) {
    console.error('Cannot load better-sqlite3:', e2.message);
    process.exit(1);
  }
}

try {
  const db = new Database(dbPath, { readonly: true });
  const ings = db.prepare('SELECT name, stock, unit FROM ingredients ORDER BY name').all();
  console.log('POS TILL (SQLite at ' + dbPath + '):');
  for (const r of ings) console.log('  ' + r.name + ': ' + r.stock + ' ' + r.unit);

  const count = db.prepare('SELECT COUNT(*) AS cnt FROM orders').get();
  console.log('\nTotal orders in till: ' + count.cnt);

  const recent = db.prepare('SELECT id, created_at FROM orders ORDER BY id DESC LIMIT 3').all();
  console.log('Last 3 orders:');
  for (const r of recent) console.log('  #' + r.id + '  ' + r.created_at);

  db.close();
} catch(err) {
  console.error('Failed to read till database:', err.message);
}
