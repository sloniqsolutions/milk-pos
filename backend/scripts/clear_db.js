const db = require('../db/database.js');
console.log('Clearing all menu items...');

db.transaction(() => {
  db.prepare('DELETE FROM item_variants').run();
  db.prepare('DELETE FROM menu_items').run();
  db.prepare('DELETE FROM categories').run();

  // Reset sqlite_sequence for autoincrement ids so they start at 1 again
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name='item_variants'").run(); } catch(e) {}
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name='menu_items'").run(); } catch(e) {}
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name='categories'").run(); } catch(e) {}
})();

console.log('Database cleared successfully.');
