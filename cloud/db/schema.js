/**
 * The cloud schema, in Postgres.
 *
 * Applied on boot and idempotent, so a deploy is just a restart. Supabase also
 * offers migration files; this stays in code because the till's own schema
 * (`backend/db/database.js`) works the same way, and one convention across both
 * halves is worth more than following each platform's house style.
 *
 * Deliberate shape decisions, all inherited from the sync design:
 *
 * **Every synced row is keyed on `(branch_id, local_id)`.** Each till assigns
 * its own ids, so E-18's order #12 and CBR Town's order #12 are different sales
 * wearing the same number. The cloud keeps a `id` of its own for joins,
 * and the unique constraint on the pair is what makes a re-sent batch harmless
 * — which matters because on a flaky link a till often cannot tell whether a
 * batch landed and must be free to send it again.
 *
 * **Integer flags stay integers.** Postgres has a real boolean, but the tills
 * send 0 and 1 and the reporting SQL compares against them. Converting here
 * would mean translating in both directions forever, for nothing.
 *
 * **Timestamps are text, not `timestamptz`.** The tills record local wall-clock
 * time as `'2026-09-07 14:32:11'`, with no zone. Storing that as `timestamptz`
 * would make Postgres attach the *server's* zone to it, so the same sale would
 * read differently depending on where the server happened to be. Keeping the
 * till's own string and comparing with `::date` preserves exactly what the shop
 * recorded. The `_ms` columns, which are epoch integers, carry anything that
 * genuinely needs to be compared across machines.
 */

const DDL = `
-- ---------------------------------------------------------------- branches --
CREATE TABLE IF NOT EXISTS branches (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  api_key_hash TEXT NOT NULL UNIQUE,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------- dashboard accounts --
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'owner',
  branch_id     INTEGER REFERENCES branches(id),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- ------------------------------------------------------------ live status --
-- One row per branch, overwritten on every heartbeat. No history: the live
-- view is deliberately not reconstructable, and historical questions belong to
-- the synced tables below, which arrive with completely different guarantees.
CREATE TABLE IF NOT EXISTS live_status (
  branch_id            INTEGER PRIMARY KEY REFERENCES branches(id),
  state                TEXT NOT NULL,
  shift_local_id       INTEGER,
  staff_name           TEXT,
  opened_at            TEXT,
  opening_cash         DOUBLE PRECISION,
  total_orders         INTEGER,
  total_revenue        DOUBLE PRECISION,
  cash_revenue         DOUBLE PRECISION,
  non_cash_revenue     DOUBLE PRECISION,
  drawer_expenses      DOUBLE PRECISION,
  expense_count        INTEGER,
  expected_cash        DOUBLE PRECISION,
  expenses_today_total DOUBLE PRECISION,
  expenses_today_count INTEGER,
  menu_version         INTEGER,
  payload              JSONB,
  till_sent_ms         BIGINT,
  server_received_ms   BIGINT NOT NULL,
  clock_skew_ms        BIGINT,
  agent_started_ms     BIGINT
);

-- ---------------------------------------------------------------- orders --
CREATE TABLE IF NOT EXISTS orders (
  id                     SERIAL PRIMARY KEY,
  branch_id              INTEGER NOT NULL,
  local_id               INTEGER NOT NULL,
  total                  DOUBLE PRECISION,
  discount               DOUBLE PRECISION,
  payment_method         TEXT,
  status                 TEXT,
  cashier_name           TEXT,
  cashier_id             INTEGER,
  created_at             TEXT,
  order_type             TEXT,
  delivery_charge        DOUBLE PRECISION,
  local_shift_id         INTEGER,
  table_number           TEXT,
  voided_at              TEXT,
  tax_rate               DOUBLE PRECISION,
  tax_amount             DOUBLE PRECISION,
  is_employee            INTEGER,
  employee_discount      DOUBLE PRECISION,
  employee_discount_rate DOUBLE PRECISION,
  voided_by              TEXT,
  voided_by_id           INTEGER,
  customer_name          TEXT,
  customer_phone         TEXT,
  customer_address       TEXT,
  received_at            BIGINT NOT NULL,
  -- Which till pushed this row — see the migration block below for why
  -- (branch_id, local_id) alone stopped being a safe key. NULL is fine on a
  -- fresh table (nothing to migrate); a real value is always sent from here
  -- on (backend/db/cloud-sync.js).
  device_id              TEXT,
  UNIQUE (branch_id, device_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_branch     ON orders(branch_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id           SERIAL PRIMARY KEY,
  branch_id    INTEGER NOT NULL,
  local_id     INTEGER NOT NULL,
  -- The CLOUD's orders.id, remapped at ingest. The till's own order id is only
  -- unique within its branch, so storing it here would join one shop's food
  -- onto the other shop's sale of the same number.
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER,
  name         TEXT,
  price        DOUBLE PRECISION,
  quantity     DOUBLE PRECISION,
  is_deal      INTEGER,
  variant_id   INTEGER,
  -- Resolved by the till at push time: menu item ids are per-machine, so the
  -- join to menu_items cannot be done here.
  category     TEXT,
  device_id    TEXT,
  UNIQUE (branch_id, device_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
-- quantity was INTEGER here for years while the till's own column
-- (backend/db/database.js) was REAL NOT NULL from the start — Milk POS sells
-- custom fractional litres ("Milk (Custom 1.5 L)"), which SQLite's dynamic
-- typing let through locally without complaint. Postgres does not: any order
-- containing a fractional-quantity item failed its entire ingest batch with
-- "invalid input syntax for type integer", silently and permanently, taking
-- every other order in the same batch down with it. See the ALTER below,
-- which is what actually fixes an already-deployed database — this
-- CREATE TABLE only matters for one that does not exist yet.

CREATE TABLE IF NOT EXISTS shifts (
  id            SERIAL PRIMARY KEY,
  branch_id     INTEGER NOT NULL,
  local_id      INTEGER NOT NULL,
  staff_id      INTEGER,
  staff_name    TEXT,
  opening_cash  DOUBLE PRECISION,
  closing_cash  DOUBLE PRECISION,
  expected_cash DOUBLE PRECISION,
  variance      DOUBLE PRECISION,
  opened_at     TEXT,
  closed_at     TEXT,
  status        TEXT,
  received_at   BIGINT NOT NULL,
  device_id     TEXT,
  UNIQUE (branch_id, device_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_shifts_branch ON shifts(branch_id);

CREATE TABLE IF NOT EXISTS expenses (
  id             SERIAL PRIMARY KEY,
  branch_id      INTEGER NOT NULL,
  local_id       INTEGER NOT NULL,
  local_shift_id INTEGER,
  staff_id       INTEGER,
  staff_name     TEXT,
  category       TEXT,
  description    TEXT,
  amount         DOUBLE PRECISION,
  from_drawer    INTEGER,
  created_at     TEXT,
  received_at    BIGINT NOT NULL,
  device_id      TEXT,
  UNIQUE (branch_id, device_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_expenses_branch     ON expenses(branch_id);
CREATE INDEX IF NOT EXISTS idx_expenses_created_at ON expenses(created_at);

-- ------------------------------------------------------- staff & inventory --
-- Both are read-only on the dashboard: the branch owns them, and a stock count
-- or a PIN edited in two places at once has no safe resolution.
CREATE TABLE IF NOT EXISTS staff (
  id         SERIAL PRIMARY KEY,
  branch_id  INTEGER NOT NULL,
  local_id   INTEGER NOT NULL,
  name       TEXT,
  role       TEXT,
  color      TEXT,
  active     INTEGER,
  -- No PIN, hashed or otherwise. It is of no use to the dashboard and every
  -- copy of a credential is another place it can leak from.
  received_at BIGINT NOT NULL,
  device_id   TEXT,
  UNIQUE (branch_id, device_id, local_id)
);

/*
 * Credit customers — Milk POS's regulars who take milk on account and pay it
 * off later, not one-off delivery orders. balance, total_credited and
 * total_paid are computed on the till (see backend/db/customer-summary.js,
 * shared between its own ledger screen and this push) and simply carried
 * here: there is no credit_payments table on the cloud at all, because the
 * dashboard's Customers screen only ever needs to answer "what do they owe,"
 * not "list every payment" — pushing the running total on every payment and
 * every credit sale keeps that current without syncing transaction-level
 * rows for it.
 *
 * Keyed per branch like everything else that syncs, because each till
 * maintains its own book. The same phone number ordering from two branches
 * therefore arrives as two rows; the read route sums them, so "what does
 * this household owe" answers across the whole business rather than one
 * branch's half of it.
 */
CREATE TABLE IF NOT EXISTS customers (
  id             SERIAL PRIMARY KEY,
  branch_id      INTEGER NOT NULL,
  local_id       INTEGER NOT NULL,
  name           TEXT,
  phone          TEXT,
  address        TEXT,
  notes          TEXT,
  active         INTEGER DEFAULT 1,
  order_count    INTEGER DEFAULT 0,
  total_spent    DOUBLE PRECISION DEFAULT 0,
  first_order_at TEXT,
  last_order_at  TEXT,
  total_credited DOUBLE PRECISION DEFAULT 0,
  total_paid     DOUBLE PRECISION DEFAULT 0,
  balance        DOUBLE PRECISION DEFAULT 0,
  total_litres   DOUBLE PRECISION DEFAULT 0,
  received_at    BIGINT NOT NULL,
  device_id      TEXT,
  UNIQUE (branch_id, device_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

-- One row per credit payment, pushed alongside the customer's recomputed
-- balance (routes/customers.js's POST /:id/payments already sent the
-- balance; this is the individual event behind it). Exists for exactly one
-- reason: branch-data.js's shift totals need "cash collected from credit
-- customers during THIS shift" and there is no way to derive that from a
-- lifetime total_paid figure alone — a customer's balance going down by
-- Rs.500 says nothing about which shift collected it. Read-only mirror, no
-- origin/version tracking like customers/ingredients/expenses have: nothing
-- on the dashboard ever creates, edits or deletes an individual payment.
CREATE TABLE IF NOT EXISTS credit_payments (
  id                SERIAL PRIMARY KEY,
  branch_id         INTEGER NOT NULL,
  local_id          INTEGER NOT NULL,
  customer_local_id INTEGER,
  local_shift_id    INTEGER,
  amount            DOUBLE PRECISION DEFAULT 0,
  note              TEXT,
  received_by       TEXT,
  created_at        TEXT,
  received_at       BIGINT NOT NULL,
  device_id         TEXT,
  UNIQUE (branch_id, device_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_credit_payments_shift ON credit_payments(branch_id, local_shift_id);

-- Every stock movement recorded at the till — a restock, a Convert-to-Yogurt,
-- reported waste (backend/routes/inventory.js's recordEntry, the only thing
-- that writes this table's till-side counterpart). Read-only mirror for the
-- dashboard's own Stock History screen (routes/inventory.js's GET /history);
-- nothing on the dashboard ever creates one of these — a stock movement is a
-- physical event that happens at the shop, not something to log remotely.
CREATE TABLE IF NOT EXISTS inventory_entries (
  id                  SERIAL PRIMARY KEY,
  branch_id           INTEGER NOT NULL,
  local_id            INTEGER NOT NULL,
  ingredient_local_id INTEGER,
  type                TEXT,
  amount              DOUBLE PRECISION DEFAULT 0,
  entry_date          TEXT,
  created_at          TEXT,
  received_at         BIGINT NOT NULL,
  device_id           TEXT,
  UNIQUE (branch_id, device_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_entries_branch ON inventory_entries(branch_id, entry_date);

CREATE TABLE IF NOT EXISTS ingredients (
  id          SERIAL PRIMARY KEY,
  branch_id   INTEGER NOT NULL,
  local_id    INTEGER NOT NULL,
  name        TEXT,
  unit        TEXT,
  stock       DOUBLE PRECISION,
  low_stock_threshold DOUBLE PRECISION,
  cost_per_unit DOUBLE PRECISION,
  received_at BIGINT NOT NULL,
  UNIQUE (branch_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_ingredients_branch ON ingredients(branch_id);

-- ------------------------------------------------------------ sync cursor --
-- Read by the dashboard, not by the sync. A report that silently omits the
-- last three hours of a disconnected branch is worse than no report, so the
-- reports screen shows how complete its data actually is.
CREATE TABLE IF NOT EXISTS sync_cursor (
  branch_id      INTEGER NOT NULL,
  table_name     TEXT NOT NULL,
  rows_received  INTEGER NOT NULL DEFAULT 0,
  last_synced_ms BIGINT,
  PRIMARY KEY (branch_id, table_name)
);

-- ------------------------------------------------------------------- menu --
-- The cloud is the single writer for the menu (see routes/menu.js). Tills pull
-- a whole snapshot and never push one back, which removes conflict resolution
-- by design rather than solving it.
CREATE TABLE IF NOT EXISTS menu_items (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT,
  price        DOUBLE PRECISION DEFAULT 0,
  image_url    TEXT,
  has_variants INTEGER DEFAULT 0,
  active       INTEGER DEFAULT 1,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS item_variants (
  id           SERIAL PRIMARY KEY,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  label        TEXT,
  price        DOUBLE PRECISION DEFAULT 0,
  sort_order   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deals (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  price       DOUBLE PRECISION DEFAULT 0,
  image_url   TEXT,
  active      INTEGER DEFAULT 1,
  deal_group  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deal_items (
  id           SERIAL PRIMARY KEY,
  deal_id      INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  quantity     INTEGER DEFAULT 1,
  variant_id   INTEGER REFERENCES item_variants(id) ON DELETE SET NULL,
  description  TEXT
);

/*
 * One integer the tills can check cheaply.
 *
 * A till asks "what version is the menu?" on every heartbeat -- a few bytes,
 * which succeeds on a link far too weak to download a menu. Only when the
 * number differs does it fetch the whole snapshot. That is what makes the
 * downlink survivable on a bad connection: the common case costs nothing.
 */
/*
 * Shop-wide settings, and their own version counter.
 *
 * Separate from menu_version on purpose: changing the tax rate should not make
 * every till re-download and re-apply the whole menu, which retires and
 * reinserts every item.
 */
CREATE TABLE IF NOT EXISTS cloud_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings_version (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT settings_version_single_row CHECK (id = 1)
);
INSERT INTO settings_version (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS menu_version (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT menu_version_single_row CHECK (id = 1)
);
INSERT INTO menu_version (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------ migrations --
--
-- Added after the tables above were already live, so they are ALTERs rather
-- than edits to the CREATE statements: a running database has to arrive at the
-- same shape a fresh one does. All idempotent, so this file stays safe to
-- re-run on every boot.

-- A branch's short code, printed in front of the order number: E-18-041.
-- Display only; the key is still (branch_id, local_id). See
-- backend/db/order-no.js for the reasoning and the format.
ALTER TABLE branches ADD COLUMN IF NOT EXISTS code TEXT;

-- Staff, once the dashboard became the place they are created.
--
-- The PIN hash now lives here, which the first version of this file
-- deliberately refused. The reason it refused still stands: every copy of a
-- credential is another place it can leak from, and a four-digit PIN behind
-- bcrypt is brute-forceable by anyone who takes the database.
--
-- It is stored anyway because the alternative is worse. The owner asked to
-- create staff from the dashboard, and a till authenticates PINs offline
-- against its own SQLite — so a PIN set here that never reaches the till is a
-- staff account that cannot sign in at the only place it is used. There is no
-- version of "create staff from the dashboard" that does not move the
-- credential down the wire.
--
-- What limits the damage: the hash is never returned by any read route (see
-- routes/staff.js), a PIN is useful only to somebody standing at a physical
-- till in one of the two shops, and it grants no access to this database or
-- the dashboard, which authenticate entirely separately.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pin_hash TEXT;
-- 'cloud' rows were created here and own their fields; 'branch' rows came up
-- from a till and are only mirrored. The distinction decides who wins when
-- both have a row for the same person.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'branch';
ALTER TABLE staff ADD COLUMN IF NOT EXISTS updated_ms BIGINT;

-- Bumped on any staff change, so a till can ask for one integer and download a
-- roster only when it has actually moved — exactly as the menu works.
CREATE TABLE IF NOT EXISTS staff_version (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_version_single_row CHECK (id = 1)
);
INSERT INTO staff_version (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------- payroll --
--
-- Wages live only here. Nothing in this section is ever sent to a till, and no
-- till route can read it: what a person is paid is between them and the owner,
-- and a manager standing at a drawer has no business seeing a colleague's
-- salary. Keeping it cloud-only makes that a property of where the data sits
-- rather than a permission somebody could get wrong later.

/*
 * Everyone who draws a wage — which is not the same set as everyone who can
 * sign in to a till.
 *
 * A rider, a cook or a cleaner is paid every month and never touches the POS;
 * a till account is a credential, not a person on the payroll. So this is its
 * own roster, and staff_local_id links the rows that are both. It is NULL for
 * everybody else, which is why the uniqueness below is a partial index: two
 * riders at the same branch must both be allowed to have no till account.
 */
CREATE TABLE IF NOT EXISTS employees (
  id             SERIAL PRIMARY KEY,
  branch_id      INTEGER NOT NULL,
  staff_local_id INTEGER,
  name           TEXT NOT NULL,
  job_title      TEXT,
  phone          TEXT,
  -- The agreed monthly figure. Copied onto each month's payslip rather than
  -- read through it, so raising somebody's salary in March does not silently
  -- rewrite what they were paid in January.
  monthly_salary DOUBLE PRECISION NOT NULL DEFAULT 0,
  joined_on      DATE,
  active         INTEGER NOT NULL DEFAULT 1,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_ms     BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS employees_one_per_till_account
  ON employees (branch_id, staff_local_id) WHERE staff_local_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS employees_branch ON employees (branch_id);

/*
 * One row per person per month.
 *
 * The month is text, 'YYYY-MM', because that is exactly what it is — a label
 * for a pay cycle, not a point in time. A date would invite arithmetic that
 * makes no sense here.
 *
 * Two different dates matter and are kept apart: paid_on is the day the
 * money actually changed hands, which is what the reports count, and paid_at
 * is when it was recorded on the dashboard. They differ whenever somebody
 * writes up Friday's payments on Monday.
 */
CREATE TABLE IF NOT EXISTS payslips (
  id             SERIAL PRIMARY KEY,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period         TEXT NOT NULL,
  base_salary    DOUBLE PRECISION NOT NULL DEFAULT 0,
  bonus          DOUBLE PRECISION NOT NULL DEFAULT 0,
  overtime       DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- Money already handed over during the month, subtracted at the end of it.
  -- Extremely common here, and the single easiest thing to forget and pay twice.
  advance        DOUBLE PRECISION NOT NULL DEFAULT 0,
  deduction      DOUBLE PRECISION NOT NULL DEFAULT 0,
  notes          TEXT,
  -- What was actually handed over. Recorded separately from the net figure so
  -- a short payment shows an outstanding balance instead of quietly redefining
  -- what was owed.
  paid_amount    DOUBLE PRECISION,
  paid_on        DATE,
  paid_at        TIMESTAMPTZ,
  payment_method TEXT,
  updated_ms     BIGINT,
  UNIQUE (employee_id, period)
);
CREATE INDEX IF NOT EXISTS payslips_period ON payslips (period);
CREATE INDEX IF NOT EXISTS payslips_paid_on ON payslips (paid_on);

-- ------------------------------------------------------------- backups --
--
-- A compressed copy of each till's whole SQLite database, so a branch can be
-- rebuilt on a different machine. This is the only copy of a till's own
-- history that is not on that till: the local backups sit on the same disk as
-- the database, which protects against a deleted record and against nothing
-- that happens to the machine.
--
-- One row per branch per day, replaced in place. That bounds the storage to a
-- fortnight of compressed copies per branch regardless of how often a till
-- uploads, while still letting it upload every half hour so the newest is
-- never far behind. Going back past a problem needs distinct days, not
-- distinct half-hours.
--
-- The blob is gzipped on the till and stored exactly as received; this server
-- never opens it. The counts beside it are what the till reported at the time,
-- which is what makes a stale or empty backup visible on the dashboard without
-- anything having to decompress 40 MB to find out.
CREATE TABLE IF NOT EXISTS branch_backups (
  id              SERIAL PRIMARY KEY,
  branch_id       INTEGER NOT NULL,
  backup_day      DATE NOT NULL,
  taken_at        TIMESTAMPTZ NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  gz_bytes        BIGINT NOT NULL,
  raw_bytes       BIGINT,
  sha256          TEXT,
  orders_count    INTEGER,
  last_order_at   TEXT,
  reason          TEXT,
  blob            BYTEA NOT NULL,
  UNIQUE (branch_id, backup_day)
);
CREATE INDEX IF NOT EXISTS branch_backups_recent ON branch_backups (branch_id, backup_day DESC);

-- ---------------------------------------------------- staff deletions --
--
-- A tombstone per removed staff member, and it is load-bearing in two places.
--
-- The till's roster downlink upserts and never deletes, because a row missing
-- from a snapshot usually means the cloud has not heard about that person yet
-- rather than that they are gone. So a deletion has to be stated rather than
-- inferred from an absence — otherwise somebody removed here would keep their
-- PIN working at the till forever.
--
-- And the till pushes its staff up every five minutes. Without a record that
-- the row was deleted on purpose, that push would simply put it back, and the
-- delete would appear to work and then quietly undo itself.
--
-- Past orders, shifts and expenses are unaffected: each stores the person's
-- name inline at the time it was recorded, so history keeps reading correctly
-- with nobody to point at.
-- device_id distinguishes which till's numbering a deletion belongs to —
-- without it, one till deleting "staff 5" would tombstone every future
-- push of *any* till's own "staff 5" too, deleting an unrelated person's
-- account the moment their till's regular staff-list push next ran. See
-- the migration block below for the same reasoning applied to an
-- already-deployed database.
CREATE TABLE IF NOT EXISTS staff_deletions (
  branch_id  INTEGER NOT NULL,
  device_id  TEXT NOT NULL DEFAULT 'legacy',
  local_id   INTEGER NOT NULL,
  name       TEXT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_by TEXT,
  PRIMARY KEY (branch_id, device_id, local_id)
);

-- ----------------------------------------------------- dashboard CRUD -----
--
-- Customers, ingredients and expenses used to be till-authoritative only —
-- the dashboard could read them but never write. Now the dashboard can
-- create/edit/delete them too, on the same pattern staff and the menu
-- already use: a version counter per table (poll one integer, download a
-- snapshot only when it moves), an 'origin' column so a till's routine push
-- can't silently undo a dashboard edit, and a tombstone table so a
-- dashboard delete sticks instead of being re-created by the till's next
-- push.
--
-- Ingredient 'stock' is the one field this does NOT cover: a shop's real
-- physical stock only changes through something that actually happened at
-- the till (a sale, a delivery entered, a conversion) — the dashboard
-- editing a number from elsewhere would just make it wrong. So 'origin'
-- gates name/unit/low_stock_threshold/cost_per_unit; stock keeps updating
-- from the till's push regardless of who last touched the rest of the row
-- (see routes/ingest.js's ingredient handler, which updates stock
-- unconditionally and the rest only when origin allows it). Customer
-- balance/total_litres/order_count are the same idea: always till-derived,
-- never dashboard-editable, for the same reason credit balances are
-- computed rather than stored anywhere else in this codebase.

ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'branch';
ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS updated_ms BIGINT;
CREATE TABLE IF NOT EXISTS ingredient_version (
  id INTEGER PRIMARY KEY DEFAULT 1, version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ingredient_version_single_row CHECK (id = 1)
);
INSERT INTO ingredient_version (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS ingredient_deletions (
  branch_id INTEGER NOT NULL, local_id INTEGER NOT NULL, name TEXT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_by TEXT,
  PRIMARY KEY (branch_id, local_id)
);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'branch';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_ms BIGINT;
CREATE TABLE IF NOT EXISTS customer_version (
  id INTEGER PRIMARY KEY DEFAULT 1, version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_version_single_row CHECK (id = 1)
);
INSERT INTO customer_version (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS customer_deletions (
  branch_id INTEGER NOT NULL, local_id INTEGER NOT NULL, name TEXT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_by TEXT,
  PRIMARY KEY (branch_id, local_id)
);

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'branch';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS updated_ms BIGINT;
CREATE TABLE IF NOT EXISTS expense_version (
  id INTEGER PRIMARY KEY DEFAULT 1, version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT expense_version_single_row CHECK (id = 1)
);
INSERT INTO expense_version (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
-- Same device_id reasoning as staff_deletions above.
CREATE TABLE IF NOT EXISTS expense_deletions (
  branch_id INTEGER NOT NULL, device_id TEXT NOT NULL DEFAULT 'legacy', local_id INTEGER NOT NULL, description TEXT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), deleted_by TEXT,
  PRIMARY KEY (branch_id, device_id, local_id)
);

-- ------------------------------------------------------------- pairing --
--
-- Short codes that turn a freshly installed till into a particular branch.
--
-- The branch API key is 64 hex characters. Nobody is reading that down a phone
-- line to a manager in a shop, and asking them to create a JSON file in
-- AppData is worse. So the owner generates a code here, reads it out, and the
-- till exchanges it for the real key over HTTPS.
--
-- A code is a credential, and a weak one by design: eight characters, typed by
-- a person. Three things keep that safe, and all three are load-bearing:
--
--   * Single use. Claimed once and it is spent, so a code left on a WhatsApp
--     message cannot pair a second machine.
--   * Short lived. Hours, not forever, so a forgotten code stops mattering.
--   * Rate limited on the claim endpoint, because eight characters from a
--     32-letter alphabet is only strong while guessing is slow.
--
-- Stored as a SHA-256 hash for the same reason the branch keys are: whoever
-- reads this table should not come away with anything they can use. The lookup
-- is by hash, so it stays a single indexed read.
CREATE TABLE IF NOT EXISTS pairing_codes (
  id          SERIAL PRIMARY KEY,
  branch_id   INTEGER NOT NULL,
  code_hash   TEXT NOT NULL UNIQUE,
  -- The last four characters, in clear, so the owner can tell which code a
  -- listing row refers to without it being enough to pair with.
  hint        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  claimed_at  TIMESTAMPTZ,
  claimed_ip  TEXT,
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS pairing_codes_live ON pairing_codes (branch_id, claimed_at, expires_at);

-- api_key_hash is no longer how a till authenticates (see
-- middleware/branch-auth.js — one fixed TILL_API_KEY now, not a per-branch
-- key). Left in place rather than dropped, since existing rows already have
-- a value and nothing reads it any more either way; only the constraint that
-- every new row must supply one is removed.
ALTER TABLE branches ALTER COLUMN api_key_hash DROP NOT NULL;

-- order_items.quantity, for a database created before it was widened to
-- match the till's own REAL column (see the CREATE TABLE comment above).
-- USING quantity::double precision is a no-op cast for existing integer
-- values and costs nothing on a table this size.
ALTER TABLE order_items ALTER COLUMN quantity TYPE DOUBLE PRECISION USING quantity::double precision;

-- Credit-customer fields, for a database that was created before Milk POS's
-- customers table carried a running balance rather than delivery demographics.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes          TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS active         INTEGER DEFAULT 1;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_credited DOUBLE PRECISION DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_paid     DOUBLE PRECISION DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS balance        DOUBLE PRECISION DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_litres   DOUBLE PRECISION DEFAULT 0;

-- Same derivation the till uses, for branches that predate the column.
UPDATE branches
   SET code = NULLIF(regexp_replace(
                       regexp_replace(regexp_replace(name, '\\mbranch\\M', ' ', 'gi'),
                                      '[^A-Za-z0-9]+', '-', 'g'),
                       '^-+|-+$', '', 'g'), '')
 WHERE code IS NULL OR code = '';

-- device_id, for a database created before a branch could have more than one
-- till. (branch_id, local_id) alone used to be the key every synced table
-- upserted on — safe under the original one-till-per-branch assumption, but
-- not once a second till exists: each till's local_id is its own SQLite
-- AUTOINCREMENT, unrelated to any other till's, so two tills' own order #47
-- would have silently overwritten each other under one row. This happened
-- for real, just for ingredients first (two different cloud rows both named
-- "Yogurt", one per till's own local_id) — see routes/ingest.js's
-- ingestIngredients for why that table gets a *name*-based merge instead of
-- this: unlike an order, two ingredients that share a local_id really are
-- meant to be the same thing, and a merge is correct where a sale would need
-- to stay two separate rows.
--
-- Existing rows predate any till sending its own id, so they are backfilled
-- onto whichever till is currently paired to each branch — there being
-- exactly one till per branch until now, that till's history is what they
-- already are. A push from an unupdated client (no device_id sent yet) is
-- read as 'legacy' rather than left NULL: Postgres treats every NULL as
-- distinct for uniqueness, which would silently turn the protection back off
-- for exactly the pushes that need it — see routes/ingest.js's own read of
-- this field for the same reasoning.
ALTER TABLE orders            ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE order_items       ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE shifts            ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE expenses          ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE staff             ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE customers         ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE credit_payments   ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE inventory_entries ADD COLUMN IF NOT EXISTS device_id TEXT;

-- Branch 1's own till — the only till that has ever pushed to this branch
-- before device_id existed, so every pre-migration row genuinely is its
-- history. Read from that till's own db/activation-config.js:getDeviceId()
-- once, here, rather than left to guess: hardcoding it is correct precisely
-- because this is one-time legacy data, not an ongoing assumption — any
-- till pushing from this point on sends its own real id with every row (see
-- backend/db/cloud-sync.js), and a future second branch starts with nothing
-- to backfill at all.
UPDATE orders            SET device_id = '6c927c39-72d8-40c1-b873-251871df45b4' WHERE branch_id = 1 AND device_id IS NULL;
UPDATE order_items       SET device_id = '6c927c39-72d8-40c1-b873-251871df45b4' WHERE branch_id = 1 AND device_id IS NULL;
UPDATE shifts             SET device_id = '6c927c39-72d8-40c1-b873-251871df45b4' WHERE branch_id = 1 AND device_id IS NULL;
UPDATE expenses            SET device_id = '6c927c39-72d8-40c1-b873-251871df45b4' WHERE branch_id = 1 AND device_id IS NULL;
UPDATE staff               SET device_id = '6c927c39-72d8-40c1-b873-251871df45b4' WHERE branch_id = 1 AND device_id IS NULL;
UPDATE customers           SET device_id = '6c927c39-72d8-40c1-b873-251871df45b4' WHERE branch_id = 1 AND device_id IS NULL;
UPDATE credit_payments     SET device_id = '6c927c39-72d8-40c1-b873-251871df45b4' WHERE branch_id = 1 AND device_id IS NULL;
UPDATE inventory_entries   SET device_id = '6c927c39-72d8-40c1-b873-251871df45b4' WHERE branch_id = 1 AND device_id IS NULL;

-- Still-NULL rows (any other branch, or a row this backfill didn't cover)
-- fall back to 'legacy', same as an unupdated client's push, so the new
-- constraint below has something non-NULL to key on either way.
UPDATE orders            SET device_id = 'legacy' WHERE device_id IS NULL;
UPDATE order_items       SET device_id = 'legacy' WHERE device_id IS NULL;
UPDATE shifts             SET device_id = 'legacy' WHERE device_id IS NULL;
UPDATE expenses            SET device_id = 'legacy' WHERE device_id IS NULL;
UPDATE staff               SET device_id = 'legacy' WHERE device_id IS NULL;
UPDATE customers           SET device_id = 'legacy' WHERE device_id IS NULL;
UPDATE credit_payments     SET device_id = 'legacy' WHERE device_id IS NULL;
UPDATE inventory_entries   SET device_id = 'legacy' WHERE device_id IS NULL;

ALTER TABLE orders            DROP CONSTRAINT IF EXISTS orders_branch_id_local_id_key;
ALTER TABLE order_items       DROP CONSTRAINT IF EXISTS order_items_branch_id_local_id_key;
ALTER TABLE shifts            DROP CONSTRAINT IF EXISTS shifts_branch_id_local_id_key;
ALTER TABLE expenses          DROP CONSTRAINT IF EXISTS expenses_branch_id_local_id_key;
ALTER TABLE staff             DROP CONSTRAINT IF EXISTS staff_branch_id_local_id_key;
ALTER TABLE customers         DROP CONSTRAINT IF EXISTS customers_branch_id_local_id_key;
ALTER TABLE credit_payments   DROP CONSTRAINT IF EXISTS credit_payments_branch_id_local_id_key;
ALTER TABLE inventory_entries DROP CONSTRAINT IF EXISTS inventory_entries_branch_id_local_id_key;

ALTER TABLE orders            DROP CONSTRAINT IF EXISTS orders_branch_id_device_id_local_id_key;
ALTER TABLE order_items       DROP CONSTRAINT IF EXISTS order_items_branch_id_device_id_local_id_key;
ALTER TABLE shifts            DROP CONSTRAINT IF EXISTS shifts_branch_id_device_id_local_id_key;
ALTER TABLE expenses          DROP CONSTRAINT IF EXISTS expenses_branch_id_device_id_local_id_key;
ALTER TABLE staff             DROP CONSTRAINT IF EXISTS staff_branch_id_device_id_local_id_key;
ALTER TABLE customers         DROP CONSTRAINT IF EXISTS customers_branch_id_device_id_local_id_key;
ALTER TABLE credit_payments   DROP CONSTRAINT IF EXISTS credit_payments_branch_id_device_id_local_id_key;
ALTER TABLE inventory_entries DROP CONSTRAINT IF EXISTS inventory_entries_branch_id_device_id_local_id_key;

ALTER TABLE orders            ADD CONSTRAINT orders_branch_id_device_id_local_id_key UNIQUE (branch_id, device_id, local_id);
ALTER TABLE order_items       ADD CONSTRAINT order_items_branch_id_device_id_local_id_key UNIQUE (branch_id, device_id, local_id);
ALTER TABLE shifts            ADD CONSTRAINT shifts_branch_id_device_id_local_id_key UNIQUE (branch_id, device_id, local_id);
ALTER TABLE expenses          ADD CONSTRAINT expenses_branch_id_device_id_local_id_key UNIQUE (branch_id, device_id, local_id);
ALTER TABLE staff             ADD CONSTRAINT staff_branch_id_device_id_local_id_key UNIQUE (branch_id, device_id, local_id);
ALTER TABLE customers         ADD CONSTRAINT customers_branch_id_device_id_local_id_key UNIQUE (branch_id, device_id, local_id);
ALTER TABLE credit_payments   ADD CONSTRAINT credit_payments_branch_id_device_id_local_id_key UNIQUE (branch_id, device_id, local_id);
ALTER TABLE inventory_entries ADD CONSTRAINT inventory_entries_branch_id_device_id_local_id_key UNIQUE (branch_id, device_id, local_id);

-- Same device_id treatment for the two tombstone tables — a delete from one
-- till must not be able to suppress a resurrection of a *different* till's
-- unrelated row of the same number (see routes/staff.js's DELETE
-- /local/:localId and routes/ingest.js's dropDeletedStaff, the two things
-- that actually read these). Every existing row predates any till sending
-- a device_id, so 'legacy' is exactly right for them, not a guess — that
-- was already the only device_id any of them could have meant.
ALTER TABLE staff_deletions   ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE expense_deletions ADD COLUMN IF NOT EXISTS device_id TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE staff_deletions   DROP CONSTRAINT IF EXISTS staff_deletions_pkey;
ALTER TABLE staff_deletions   DROP CONSTRAINT IF EXISTS staff_deletions_branch_id_device_id_local_id_pkey;
ALTER TABLE staff_deletions   ADD CONSTRAINT staff_deletions_branch_id_device_id_local_id_pkey PRIMARY KEY (branch_id, device_id, local_id);

ALTER TABLE expense_deletions DROP CONSTRAINT IF EXISTS expense_deletions_pkey;
ALTER TABLE expense_deletions DROP CONSTRAINT IF EXISTS expense_deletions_branch_id_device_id_local_id_pkey;
ALTER TABLE expense_deletions ADD CONSTRAINT expense_deletions_branch_id_device_id_local_id_pkey PRIMARY KEY (branch_id, device_id, local_id);

-- ---------------------------------------------------------- activation --
--
-- The product key that makes an install of Milk POS a licensed one — the
-- same idea as a Windows product key, and deliberately separate from
-- branches and pairing_codes above. A till can be activated before anyone
-- has chosen a shop for it, or before the internet is even set up enough to
-- pair, so this has to stand entirely on its own rather than hang off a
-- branch that may not exist yet. See routes/activation.js.
--
-- Stored as a SHA-256 hash, the same reasoning as every other credential in
-- this schema: the key is shown once, at issue, and never again.
--
-- A key activates exactly one device. device_id is NULL until the first
-- successful activation and then fixed — a second machine presenting the
-- same key is refused, which is the entire point of a product key rather
-- than a shared password. Moving a license to replacement hardware is a
-- deliberate admin action (scripts/issue-key.js's reset command), the same
-- shape as rekeying a branch: freeing a binding is not something the key's
-- holder can do just by presenting the key again.
CREATE TABLE IF NOT EXISTS product_keys (
  id           SERIAL PRIMARY KEY,
  key_hash     TEXT NOT NULL UNIQUE,
  -- Who this was issued to, for the owner's own records — never shown back
  -- as proof of anything, just a label on a list.
  label        TEXT,
  device_id    TEXT,
  device_name  TEXT,
  activated_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_keys_device
  ON product_keys (device_id) WHERE device_id IS NOT NULL;
`;

/**
 * Settings every connection needs, applied to the role rather than per session.
 *
 * See db/pg.js for why each matters. Doing it here means one statement at boot
 * instead of a query on every connection that races the pool.
 *
 * Non-fatal: a role without ALTER privileges still gets a working server, just
 * one whose floats are truncated on the wire — worth a loud warning, not a
 * refusal to start.
 */
async function applyRoleSettings(db) {
  try {
    const { rows } = await db.pool.query('SELECT current_user AS role');
    const role = rows[0].role;
    // The role name comes from the server, not from input, but quote it anyway
    // — ALTER ROLE takes an identifier, which cannot be parameterised.
    const quoted = '"' + String(role).replace(/"/g, '""') + '"';
    await db.pool.query(`ALTER ROLE ${quoted} SET extra_float_digits = 3`);
    await db.pool.query(`ALTER ROLE ${quoted} SET idle_in_transaction_session_timeout = '30s'`);
  } catch (err) {
    console.warn('Could not set role defaults (floats may lose precision):', err.message);
  }
}

async function createSchema(db) {
  // Several serverless containers can cold-start at once and all reach this
  // on their very first request. The DDL itself is idempotent (`CREATE TABLE
  // IF NOT EXISTS`), so nothing here is unsafe to run twice — the problem was
  // several of them piling connections onto Postgres simultaneously until one
  // timed out. A Postgres advisory lock serializes them: whichever container
  // gets there first runs the DDL while the rest simply wait a moment, then
  // find the tables already exist and move on quickly.
  //
  // Must run on one held client, not `db.pool.query()` — an advisory lock is
  // tied to the session that took it, and the pool can hand different
  // queries to different underlying connections.
  //
  // 727215 is an arbitrary fixed key. It only needs to be unique to this one
  // lock in this codebase — nothing else ever takes it.
  const client = await db.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727215)');
    try {
      await client.query(DDL);
    } finally {
      await client.query('SELECT pg_advisory_unlock(727215)');
    }
  } finally {
    client.release();
  }
  await applyRoleSettings(db);
}

module.exports = { createSchema, applyRoleSettings, DDL };
