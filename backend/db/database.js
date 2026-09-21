const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const userDataDir = process.env.POS_USER_DATA_PATH || path.join(__dirname, '..');

if (!fs.existsSync(userDataDir)) {
  fs.mkdirSync(userDataDir, { recursive: true });
}

const DB_PATH = path.join(userDataDir, 'pos_database.db');
console.log('Using database at:', DB_PATH);

// FIX (Bug 5): apply a pending restore before opening the database. The
// restore endpoint stages the verified file here rather than swapping it
// underneath a live connection, which would corrupt open handles.
const PENDING_RESTORE = path.join(userDataDir, 'pending_restore.db');
if (fs.existsSync(PENDING_RESTORE)) {
  try {
    ['-wal', '-shm'].forEach((suffix) => {
      const sidecar = DB_PATH + suffix;
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    });
    fs.copyFileSync(PENDING_RESTORE, DB_PATH);
    fs.unlinkSync(PENDING_RESTORE);
    console.log('Restore applied from pending_restore.db');
  } catch (e) {
    console.error('Restore failed, keeping existing database:', e.message);
  }
}

/**
 * better-sqlite3 is a native module: its compiled binary loads only on the
 * Node ABI it was built for. Plain Node 24 is NODE_MODULE_VERSION 137 and
 * Electron 42 is 146, and there is a single binary on disk, so running the
 * backend on the "wrong" runtime fails here with a stack trace that does not
 * say what to do about it. Translate it into instructions.
 */
let db;
try {
  db = new Database(DB_PATH);
} catch (err) {
  if (err.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(err.message)) {
    const wanted = process.versions.modules;
    console.error(
      `\nbetter-sqlite3 was built for a different Node ABI than this runtime ` +
      `(this process needs NODE_MODULE_VERSION ${wanted}).\n\n` +
      `The backend is meant to run on Electron's Node, which is how the app\n` +
      `spawns it in production. Start it with:\n\n` +
      `  npm start          (from the backend folder)\n` +
      `  npm run dev        (same, with restart-on-change)\n\n` +
      `Running "node server.js" directly uses plain Node instead and will not\n` +
      `load the module. If you have run "npm rebuild better-sqlite3", that\n` +
      `rebuilt it for plain Node and the desktop app will no longer start —\n` +
      `restore it with:\n\n` +
      `  npm run rebuild:electron\n`
    );
    process.exit(1);
  }
  throw err;
}

// Crash protection + performance
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('wal_checkpoint(TRUNCATE)');

// Create all tables
db.exec(`
  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price REAL NOT NULL,
    image_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total REAL NOT NULL,
    discount REAL DEFAULT 0,
    payment_method TEXT DEFAULT 'Cash',
    status TEXT DEFAULT 'completed',
    cashier_name TEXT DEFAULT 'Admin',
    -- Local wall-clock, not CURRENT_TIMESTAMP's UTC. Routes also pass this
    -- explicitly; the default only matters for a freshly created database.
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    menu_item_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    quantity REAL NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );

  CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'Cashier',
    pin TEXT NOT NULL UNIQUE,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS item_variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_item_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    price REAL NOT NULL,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    unit TEXT NOT NULL,
    stock REAL DEFAULT 0,
    low_stock_threshold REAL DEFAULT 0,
    cost_per_unit REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_item_id INTEGER NOT NULL,
    variant_id INTEGER DEFAULT NULL,
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id) REFERENCES item_variants(id) ON DELETE CASCADE
  );

  -- One row per stock movement: a restock/adjustment from the Inventory
  -- screen, a milk->yogurt conversion, or reported waste. 'amount' is signed
  -- (positive = added, negative = removed) so a running total for any
  -- ingredient is just SUM(amount). 'entry_date' is the date the owner picked
  -- for the movement, independent of 'created_at' (when the row was actually
  -- entered) — that's what lets Stock History be searched/sorted by the date
  -- milk actually arrived rather than the date someone got around to typing it in.
  CREATE TABLE IF NOT EXISTS inventory_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ingredient_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    entry_date TEXT NOT NULL,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (ingredient_id) REFERENCES ingredients(id) ON DELETE CASCADE
  );

  -- FIX (Bug 5): Shift Management in Settings was entirely client-side fake
  -- data (hardcoded 23 orders / Rs. 12,400 and three invented history rows).
  -- This table makes it real and auditable.
  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id INTEGER,
    staff_name TEXT,
    opening_cash REAL DEFAULT 0,
    closing_cash REAL DEFAULT NULL,
    expected_cash REAL DEFAULT NULL,
    variance REAL DEFAULT NULL,
    opened_at DATETIME DEFAULT (datetime('now', 'localtime')),
    closed_at DATETIME DEFAULT NULL,
    status TEXT DEFAULT 'open'
  );

  CREATE TABLE IF NOT EXISTS recipe_ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL,
    ingredient_id INTEGER NOT NULL,
    quantity_required REAL NOT NULL,
    FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE,
    FOREIGN KEY (ingredient_id) REFERENCES ingredients(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    notes TEXT,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );

  -- One row per payment a credit customer makes toward their balance.
  -- Balance itself is never stored — it's derived (credit orders minus
  -- payments) so it can never drift out of sync, same reasoning as the
  -- server recomputing order totals instead of trusting the client.
  CREATE TABLE IF NOT EXISTS credit_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    received_by TEXT,
    received_by_id INTEGER,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  );
`);

// Migrations
try { db.exec("ALTER TABLE orders ADD COLUMN cashier_name TEXT DEFAULT 'Admin';"); } catch(e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN cashier_id INTEGER DEFAULT NULL;"); } catch(e) {}
try { db.exec("ALTER TABLE staff ADD COLUMN color TEXT DEFAULT '#DC2626';"); } catch(e) {}
try { db.exec("ALTER TABLE staff ADD COLUMN avatar_initials TEXT DEFAULT '';"); } catch(e) {}
try { db.exec("UPDATE staff SET active = 1 WHERE role = 'Owner';"); } catch(e) {}
try { db.exec("UPDATE staff SET color = '#7C3AED' WHERE color IS NULL OR color = '';"); } catch(e) {}
try { db.exec("ALTER TABLE menu_items ADD COLUMN has_variants INTEGER DEFAULT 0;"); } catch(e) {}
try { db.exec("UPDATE menu_items SET category = 'Pizza' WHERE category IN ('Standard Pizza', 'Classic Pizza', 'Premium Pizza', 'Special Pizza', 'Deep Dish', 'New Addition');"); } catch(e) {}
// NOTE: this was a one-off consolidation for a previous restaurant's menu,
// but it ran on EVERY startup — so any category named 'Fries' or 'Wrap' was
// silently renamed to 'Sides' each time the app booted, which quietly undid
// menu changes. Guarded so it can only ever apply once.
try {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'migration_sides_consolidated'").get();
  if (!done) {
    db.exec("UPDATE menu_items SET category = 'Sides' WHERE category IN ('Wrap', 'Hot Wings', 'Broast Chicken', 'Special Meal');");
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration_sides_consolidated', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
  }
} catch(e) {}

// Dine-in vs Delivery on each order, and the exact delivery amount charged at the time
try { db.exec("ALTER TABLE orders ADD COLUMN order_type TEXT DEFAULT 'Walk-in';"); } catch(e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN delivery_charge REAL DEFAULT 0;"); } catch(e) {}
try { db.exec("ALTER TABLE ingredients ADD COLUMN low_stock_threshold REAL DEFAULT 0;"); } catch(e) {}

// A sale (or a void's return) names the exact order line it belongs to, and any
// movement can carry a reason (a corrected count is 'Recount'). Additive only.
try { db.exec("ALTER TABLE inventory_entries ADD COLUMN order_id INTEGER;"); } catch(e) {}
try { db.exec("ALTER TABLE inventory_entries ADD COLUMN order_item_id INTEGER;"); } catch(e) {}
try { db.exec("ALTER TABLE inventory_entries ADD COLUMN reason TEXT;"); } catch(e) {}
// One sale entry per order line and ingredient, so a sale can never be logged twice.
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_inventory_entries_sale_line ON inventory_entries(order_item_id, ingredient_id) WHERE type = 'sale' AND amount < 0 AND order_item_id IS NOT NULL;");
} catch(e) {}

// FIX (Bug 5): stamp every order with the shift it belongs to, so shift
// totals are derived from real sales instead of hardcoded numbers.
try { db.exec("ALTER TABLE orders ADD COLUMN shift_id INTEGER DEFAULT NULL;"); } catch(e) {}
// FIX (Bug 6): the Sale screen collected no table/token number even though
// receipts displayed a placeholder for it.
try { db.exec("ALTER TABLE orders ADD COLUMN table_number TEXT DEFAULT NULL;"); } catch(e) {}
// Tax is stored per order: both the rate that applied at the time and the
// amount it produced. Keeping the rate means an old receipt still reprints
// with the tax it was actually charged after the owner changes the rate, and
// keeping the amount means reports never have to re-derive it.
try { db.exec("ALTER TABLE orders ADD COLUMN tax_rate REAL DEFAULT 0;"); } catch(e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN tax_amount REAL DEFAULT 0;"); } catch(e) {}

// Staff discount. `discount` continues to hold the *combined* discount so
// every existing report, export and reconciliation keeps working untouched;
// these two columns record how much of it was the staff portion and flag the
// order as a staff purchase so it can be identified in reporting.
try { db.exec("ALTER TABLE orders ADD COLUMN is_employee INTEGER DEFAULT 0;"); } catch(e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN employee_discount REAL DEFAULT 0;"); } catch(e) {}
// The rate too, so a reprint shows the discount actually given even after
// the owner changes the percentage — same reasoning as tax_rate.
try { db.exec("ALTER TABLE orders ADD COLUMN employee_discount_rate REAL DEFAULT 0;"); } catch(e) {}

// The printed menu lists an ingredient line under each pizza. Storing it
// keeps the card and the till in step, and gives staff something to read
// out when a customer asks what is on a pizza.
try { db.exec("ALTER TABLE menu_items ADD COLUMN description TEXT DEFAULT NULL;"); } catch(e) {}

// ─── Roles ──────────────────────────────────────────────────────────────────
// The shop runs on two roles: an administrator with full access and a manager
// who works the till. 'Cashier' was the old name for the till role and carried
// no meaningful restrictions, so those accounts become Managers. 'Owner' is
// left alone — it is the existing admin account and is honoured as an admin
// everywhere, renaming it would risk locking the shop out on upgrade.
try { db.exec("UPDATE staff SET role = 'Manager' WHERE role = 'Cashier';"); } catch(e) {}

// Who voided an order. Managers are allowed to void, so a void needs a name
// against it — otherwise "ring up, take cash, void" leaves no trace.
try { db.exec("ALTER TABLE orders ADD COLUMN voided_by TEXT DEFAULT NULL;"); } catch(e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN voided_by_id INTEGER DEFAULT NULL;"); } catch(e) {}

// Delivery orders capture the customer's details before the receipt prints, so
// the rider knows where the food is going. All optional — the cashier can skip
// the prompt when a regular rings up.
try { db.exec("ALTER TABLE orders ADD COLUMN customer_name TEXT DEFAULT NULL;"); } catch(e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN customer_phone TEXT DEFAULT NULL;"); } catch(e) {}
try { db.exec("ALTER TABLE orders ADD COLUMN customer_address TEXT DEFAULT NULL;"); } catch(e) {}

// Links an order to a credit customer. Nullable — a Cash/Card/Online sale
// has no customer attached.
try { db.exec("ALTER TABLE orders ADD COLUMN customer_id INTEGER DEFAULT NULL REFERENCES customers(id);"); } catch(e) {}

try { db.exec("CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);"); } catch(e) {}
// One active customer per phone number. Refused at the database, not just in the
// create route, because restores and cloud pulls insert customers too. Fails
// (quietly, and is retried next start) while duplicates still exist — merge them
// first with scripts/merge-duplicate-customers.js.
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_active_phone ON customers(phone) WHERE active = 1 AND phone IS NOT NULL AND phone != '';"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_credit_payments_customer ON credit_payments(customer_id);"); } catch(e) {}

// Links a credit payment to the shift it was collected during, so cash
// received from a credit customer counts toward that day's drawer total —
// same reasoning as orders.shift_id and expenses.shift_id.
try { db.exec("ALTER TABLE credit_payments ADD COLUMN shift_id INTEGER DEFAULT NULL;"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_credit_payments_shift ON credit_payments(shift_id);"); } catch(e) {}

/*
 * Petty cash going out — rider fuel, staff lunch, and so on.
 *
 * `from_drawer` is the important one: money handed out of the till has to come
 * off the drawer's expected balance, or every shift closes short by exactly the
 * amount that was spent. It is attached to the shift that was open at the time
 * so the reconciliation stays with the right trading period.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER DEFAULT NULL,
    staff_id INTEGER DEFAULT NULL,
    staff_name TEXT,
    category TEXT NOT NULL,
    description TEXT,
    amount REAL NOT NULL,
    from_drawer INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );
`);
try { db.exec("CREATE INDEX IF NOT EXISTS idx_expenses_shift ON expenses(shift_id);"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_expenses_created ON expenses(created_at);"); } catch(e) {}

// Menu items are retired rather than deleted. A hard DELETE failed outright
// with "FOREIGN KEY constraint failed" whenever the item belonged to a deal,
// and when it did succeed it broke sales-by-category for every past order
// containing that item, because the reporting join had nothing left to match.
try { db.exec("ALTER TABLE menu_items ADD COLUMN active INTEGER DEFAULT 1;"); } catch(e) {}

// Voiding an order now preserves its amounts and records when it happened,
// instead of zeroing total/discount and destroying the audit trail.
try { db.exec("ALTER TABLE orders ADD COLUMN voided_at DATETIME DEFAULT NULL;"); } catch(e) {}

// FIX: a deal was written into order_items.menu_item_id using the *deal's* id,
// which collides with menu_items ids. Sales-by-category then joined that id to
// whatever unrelated menu item happened to share it, so deal revenue was
// reported against the wrong category. This flag lets reports tell the two
// apart. Historical rows cannot be recovered — nothing recorded which they
// were — so they stay as they are and only new orders are attributed correctly.
try { db.exec("ALTER TABLE order_items ADD COLUMN is_deal INTEGER DEFAULT 0;"); } catch(e) {}

// The sale deducts stock using the *variant's* recipe (a 12-piece wings order
// consumes twice a 6-piece one), but the variant was never recorded on the
// line, so a void had no way to restore the right quantity. Recording it makes
// the void exactly mirror the sale.
try { db.exec("ALTER TABLE order_items ADD COLUMN variant_id INTEGER DEFAULT NULL;"); } catch(e) {}

// Helpful indexes for the reporting queries.
try { db.exec("CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_orders_shift ON orders(shift_id);"); } catch(e) {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);"); } catch(e) {}

// ─── Timezone correction ────────────────────────────────────────────────────
// SQLite's CURRENT_TIMESTAMP is UTC, but this till serves one shop in one
// timezone and every consumer of these timestamps treats them as local:
//   * reports/shifts filter with DATE(created_at) BETWEEN <local from> AND <to>,
//     where from/to are computed from the browser's local clock;
//   * the UI renders them with moment(created_at), which parses as local.
// At UTC+5 that booked every sale between midnight and 5am to the *previous*
// trading day and displayed every time five hours early.
//
// The fix is to store local time. This one-off migration converts rows written
// under the old UTC behaviour; all inserts now pass an explicit local
// timestamp. Guarded by a settings flag so it can never double-shift.
try {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'migration_timestamps_localtime'").get();
  if (!done) {
    db.transaction(() => {
      // datetime(x, 'localtime') reads x as UTC and returns local wall-clock.
      db.exec("UPDATE orders SET created_at = datetime(created_at, 'localtime') WHERE created_at IS NOT NULL;");
      db.exec("UPDATE shifts SET opened_at = datetime(opened_at, 'localtime') WHERE opened_at IS NOT NULL;");
      db.exec("UPDATE shifts SET closed_at = datetime(closed_at, 'localtime') WHERE closed_at IS NOT NULL;");
      db.prepare("INSERT INTO settings (key, value) VALUES ('migration_timestamps_localtime', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    })();
    console.log('Timestamps converted from UTC to local time.');
  }
} catch (e) {
  console.error('Timestamp localtime migration failed:', e.message);
}

// Rebrand: move an existing install off the old default restaurant name.
// Runs once; never overwrites a name the owner has customised themselves.
try {
  db.prepare("UPDATE settings SET value = 'Blaze' WHERE key = 'restaurant_name' AND value = 'Al-Madina Fast Food'").run();
} catch(e) {}
// Rebrand: retire the old orange staff colour.
try { db.exec("UPDATE staff SET color = '#DC2626' WHERE color = '#F97316';"); } catch(e) {}

// Seed menu items — the printed Blaze Pizza House menu.
// Defined once in db/menu-data.js and shared with scripts/seed_blaze_menu.js,
// so a fresh install and a re-seed can never produce different menus.
const { MENU: SEED_MENU } = require('./menu-data.js');

const count = db.prepare('SELECT COUNT(*) as count FROM menu_items').get();
if (count.count === 0) {
  const insertItem = db.prepare(
    'INSERT INTO menu_items (name, category, price, has_variants, description) VALUES (?, ?, ?, ?, ?)'
  );
  const insertVariant = db.prepare(
    'INSERT INTO item_variants (menu_item_id, label, price, sort_order) VALUES (?, ?, ?, ?)'
  );

  db.transaction(() => {
    SEED_MENU.forEach(m => {
      const hasV = Array.isArray(m.v) && m.v.length > 0;
      const id = insertItem.run(m.n, m.c, hasV ? 0 : (m.p || 0), hasV ? 1 : 0, m.d || null).lastInsertRowid;
      if (hasV) m.v.forEach(([label, price], i) => insertVariant.run(id, label, price, i));
    });
  })();
}


// Seed admin — always with bcrypt hashed PIN
const staffCount = db.prepare('SELECT COUNT(*) as count FROM staff').get();
if (staffCount.count === 0) {
  const hashedPin = bcrypt.hashSync('1234', 10);
  db.prepare("INSERT INTO staff (name, role, pin, color, active) VALUES ('Admin', 'Owner', ?, '#DC2626', 1)").run(hashedPin);
}

// Seed settings
// Use ON CONFLICT so settings seed is idempotent — earlier migrations may
// have already inserted a row (e.g. migration_sides_consolidated), which
// would cause a plain INSERT-if-empty check to skip the entire block.
const upsertSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
);
[
  ['restaurant_name', 'Pure Milk'],
  ['restaurant_address', ''],
  ['restaurant_phone', ''],
  ['tax_rate', '0'],
  ['currency_symbol', 'Rs.'],
  ['receipt_footer', 'Thank you for your purchase!'],
  ['auto_print', 'true'],
  ['delivery_price', '0'],
  // Percentage taken off a staff purchase when the cashier flags one.
  ['employee_discount_rate', '20']
].forEach(([k, v]) => upsertSetting.run(k, v));

// Safety net: delivery_price for existing installs
const deliveryPriceRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('delivery_price');
if (!deliveryPriceRow) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('delivery_price', '0');
}

// --- Seed Ingredients and Recipes (Milk) ---
const ingCount = db.prepare('SELECT COUNT(*) as count FROM ingredients').get();
if (ingCount.count === 0) {
  const insertIng = db.prepare('INSERT INTO ingredients (name, unit, stock, cost_per_unit, low_stock_threshold) VALUES (?, ?, ?, ?, ?)');
  const insertRecipe = db.prepare('INSERT INTO recipes (menu_item_id, variant_id) VALUES (?, ?)');
  const insertRecipeIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity_required) VALUES (?, ?, ?)');
  const getItemId = db.prepare('SELECT id FROM menu_items WHERE name = ?');

  db.transaction(() => {
    // Starts at 0 — you add real stock from the Inventory screen when milk arrives.
    const milkIngId = insertIng.run('Milk', 'Litre', 0, 0, 10).lastInsertRowid;

    // Link each item to the 'Milk' ingredient with the respective litre deduction
    const itemMap = [
      ['0.5 Litre', 0.5],
      ['1 Litre', 1.0],
      ['2 Litre', 2.0],
    ];

    itemMap.forEach(([itemName, qty]) => {
      const item = getItemId.get(itemName);
      if (item) {
        const recipeId = insertRecipe.run(item.id, null).lastInsertRowid;
        insertRecipeIng.run(recipeId, milkIngId, qty);
      }
    });
  })();
}

// Migration: ensure the 3 dedicated milk items (0.5 Litre, 1 Litre, 2 Litre)
// are always present in the database with their respective recipes.
try {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'migration_three_milk_items_v1'").get();
  if (!done) {
    db.transaction(() => {
      // Ensure the 'Milk' ingredient exists
      let milkIng = db.prepare("SELECT id FROM ingredients WHERE name = 'Milk'").get();
      if (!milkIng) {
        const res = db.prepare("INSERT INTO ingredients (name, unit, stock, cost_per_unit, low_stock_threshold) VALUES ('Milk', 'Litre', 0, 0, 10)").run();
        milkIng = { id: res.lastInsertRowid };
      }

      // 1. Deactivate or retire old 'Milk' generic item
      const oldMilk = db.prepare("SELECT id FROM menu_items WHERE name = 'Milk' AND category = 'Milk'").get();
      if (oldMilk) {
        db.prepare("UPDATE menu_items SET active = 0 WHERE id = ?").run(oldMilk.id);
        // Clean up any recipe on the old item
        const oldRecipes = db.prepare("SELECT id FROM recipes WHERE menu_item_id = ?").all(oldMilk.id);
        oldRecipes.forEach(r => {
          db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?").run(r.id);
          db.prepare("DELETE FROM recipes WHERE id = ?").run(r.id);
        });
      }

      // 2. Ensure each of the 3 items exists
      const targetItems = [
        { name: '0.5 Litre', price: 100, qty: 0.5, desc: 'Fresh pure milk (0.5 Litre)' },
        { name: '1 Litre',   price: 200, qty: 1.0, desc: 'Fresh pure milk (1 Litre)' },
        { name: '2 Litre',   price: 400, qty: 2.0, desc: 'Fresh pure milk (2 Litre)' },
      ];

      targetItems.forEach(({ name, price, qty, desc }) => {
        let item = db.prepare("SELECT id FROM menu_items WHERE name = ? AND category = 'Milk'").get(name);
        let itemId;
        if (!item) {
          const res = db.prepare(
            "INSERT INTO menu_items (name, category, price, has_variants, description, active) VALUES (?, 'Milk', ?, 0, ?, 1)"
          ).run(name, price, desc);
          itemId = res.lastInsertRowid;
        } else {
          db.prepare("UPDATE menu_items SET price = ?, active = 1, has_variants = 0, description = ? WHERE id = ?").run(price, desc, item.id);
          itemId = item.id;
        }

        // Ensure recipe exists for this item
        const existingRecipe = db.prepare("SELECT id FROM recipes WHERE menu_item_id = ?").get(itemId);
        let recipeId;
        if (!existingRecipe) {
          const res = db.prepare("INSERT INTO recipes (menu_item_id, variant_id) VALUES (?, NULL)").run(itemId);
          recipeId = res.lastInsertRowid;
        } else {
          recipeId = existingRecipe.id;
          db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?").run(recipeId);
        }

        db.prepare(
          "INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity_required) VALUES (?, ?, ?)"
        ).run(recipeId, milkIng.id, qty);
      });

      db.prepare("INSERT INTO settings (key, value) VALUES ('migration_three_milk_items_v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    })();
    console.log('3 Milk items migration applied successfully.');
  }
} catch (e) {
  console.error('Migration for 3 milk items failed:', e.message);
}

// Migration: seed the 'Yogurt' ingredient (grams), made by converting Milk.
try {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'migration_yogurt_ingredient_v1'").get();
  if (!done) {
    const existing = db.prepare("SELECT id FROM ingredients WHERE name = 'Yogurt'").get();
    if (!existing) {
      db.prepare(
        "INSERT INTO ingredients (name, unit, stock, cost_per_unit, low_stock_threshold) VALUES ('Yogurt', 'grams', 0, 0, 0)"
      ).run();
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration_yogurt_ingredient_v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    console.log('Yogurt ingredient migration applied successfully.');
  }
} catch (e) {
  console.error('Migration for Yogurt ingredient failed:', e.message);
}

// Migration: seed the 'Dahi' menu item and tie it to the Yogurt ingredient
// via a recipe, the same way the 3 milk items are tied to Milk. Its price is
// per KILOGRAM: recipe_ingredients.quantity_required is 1000 (grams), so
// buying "quantity" 0.25 of this item is 250g — same convention Milk uses for
// fractional litres — and a sale is refused the same way a milk sale is if
// Yogurt stock in db/routes/orders.js's stock check comes up short.
try {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'migration_dahi_item_v1'").get();
  if (!done) {
    db.transaction(() => {
      let yogurtIng = db.prepare("SELECT id FROM ingredients WHERE name = 'Yogurt'").get();
      if (!yogurtIng) {
        const res = db.prepare(
          "INSERT INTO ingredients (name, unit, stock, cost_per_unit, low_stock_threshold) VALUES ('Yogurt', 'grams', 0, 0, 0)"
        ).run();
        yogurtIng = { id: res.lastInsertRowid };
      }

      let item = db.prepare("SELECT id FROM menu_items WHERE name = 'Dahi'").get();
      let itemId;
      if (!item) {
        const res = db.prepare(
          "INSERT INTO menu_items (name, category, price, has_variants, description, active) VALUES ('Dahi', 'Dahi', 300, 0, 'Fresh yogurt, made in-house from milk', 1)"
        ).run();
        itemId = res.lastInsertRowid;
      } else {
        itemId = item.id;
      }

      const existingRecipe = db.prepare("SELECT id FROM recipes WHERE menu_item_id = ?").get(itemId);
      let recipeId;
      if (!existingRecipe) {
        recipeId = db.prepare("INSERT INTO recipes (menu_item_id, variant_id) VALUES (?, NULL)").run(itemId).lastInsertRowid;
      } else {
        recipeId = existingRecipe.id;
        db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?").run(recipeId);
      }

      db.prepare(
        "INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity_required) VALUES (?, ?, 1000)"
      ).run(recipeId, yogurtIng.id);

      db.prepare("INSERT INTO settings (key, value) VALUES ('migration_dahi_item_v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    })();
    console.log('Dahi menu item migration applied successfully.');
  }
} catch (e) {
  console.error('Migration for Dahi menu item failed:', e.message);
}

/*
 * Migration: seed "0.5 KG" and "2 KG" Dahi sizes, the same pack-size pattern
 * Milk already has (0.5 Litre / 1 Litre / 2 Litre) — see the "3 Milk items"
 * migration above. Priced off the "Dahi" universal item at seed time (not
 * hardcoded), same rule db/menu-pricing.js enforces on every later edit: a
 * sized item's price is always universal price × its own size factor. Not
 * using menu-pricing.js's derivedPriceFor here directly — requiring it from
 * inside this file, which menu-pricing.js itself requires database.js from,
 * would be a circular require that runs mid-way through this file's own
 * execution, before `module.exports` is set — so the tiny bit of arithmetic
 * it would have done is just inlined instead.
 */
try {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'migration_dahi_sizes_v1'").get();
  if (!done) {
    db.transaction(() => {
      const yogurtIng = db.prepare("SELECT id FROM ingredients WHERE name = 'Yogurt'").get();
      const universalDahi = db.prepare("SELECT price FROM menu_items WHERE name = 'Dahi' AND category = 'Dahi'").get();
      const perKg = universalDahi ? Number(universalDahi.price) : 300;

      const sizes = [
        { name: '0.5 KG', factor: 0.5, grams: 500, desc: 'Fresh yogurt, made in-house from milk (500g)' },
        { name: '2 KG', factor: 2, grams: 2000, desc: 'Fresh yogurt, made in-house from milk (2kg)' },
      ];

      sizes.forEach(({ name, factor, grams, desc }) => {
        const price = Math.round(perKg * factor);
        let item = db.prepare("SELECT id FROM menu_items WHERE name = ? AND category = 'Dahi'").get(name);
        let itemId;
        if (!item) {
          itemId = db.prepare(
            "INSERT INTO menu_items (name, category, price, has_variants, description, active) VALUES (?, 'Dahi', ?, 0, ?, 1)"
          ).run(name, price, desc).lastInsertRowid;
        } else {
          itemId = item.id;
          db.prepare("UPDATE menu_items SET price = ?, active = 1 WHERE id = ?").run(price, itemId);
        }

        const existingRecipe = db.prepare("SELECT id FROM recipes WHERE menu_item_id = ?").get(itemId);
        let recipeId;
        if (!existingRecipe) {
          recipeId = db.prepare("INSERT INTO recipes (menu_item_id, variant_id) VALUES (?, NULL)").run(itemId).lastInsertRowid;
        } else {
          recipeId = existingRecipe.id;
          db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?").run(recipeId);
        }

        if (yogurtIng) {
          db.prepare(
            "INSERT INTO recipe_ingredients (recipe_id, ingredient_id, quantity_required) VALUES (?, ?, ?)"
          ).run(recipeId, yogurtIng.id, grams);
        }
      });

      db.prepare("INSERT INTO settings (key, value) VALUES ('migration_dahi_sizes_v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    })();
    console.log('Dahi sizes (0.5 KG / 2 KG) migration applied successfully.');
  }
} catch (e) {
  console.error('Migration for Dahi sizes failed:', e.message);
}

// ─── Auto Backup ────────────────────────────────────────────────────────────
const backupDir = path.join(userDataDir, 'backups');
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

function doAutoBackup() {
  const date = new Date().toISOString().split('T')[0];
  const backupPath = path.join(backupDir, `pos_backup_${date}.db`);

  if (!fs.existsSync(backupPath)) {
    try {
      fs.copyFileSync(DB_PATH, backupPath);
      console.log('Auto backup created:', backupPath);

      // Keep only last 7 daily backups
      const backups = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('pos_backup_'))
        .sort();
      if (backups.length > 7) {
        backups.slice(0, backups.length - 7)
          .forEach(f => fs.unlinkSync(path.join(backupDir, f)));
      }
    } catch(e) {
      console.error('Auto backup failed:', e.message);
    }
  }
}

doAutoBackup(); // on startup
// unref'd so the timer never holds the process open by itself. The server is
// kept alive by its listening socket; a one-off maintenance script that
// requires this module can now exit when it finishes instead of hanging on a
// 24-hour timer that will never fire.
const backupTimer = setInterval(doAutoBackup, 24 * 60 * 60 * 1000); // every 24h
if (typeof backupTimer.unref === 'function') backupTimer.unref();

module.exports = db;