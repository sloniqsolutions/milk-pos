const db = require('../db/database.js');
console.log('Dropping item_variants to force recreation with new schema...');
db.exec('DROP TABLE IF EXISTS item_variants;');

db.exec(`
  CREATE TABLE item_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_item_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    price REAL NOT NULL,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
  );
`);

console.log('Schema fixed.');
