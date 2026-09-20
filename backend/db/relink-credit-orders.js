const db = require('./database');
const { personKey } = require('./person-key');

/**
 * Points a credit order at its customer when it has lost the link.
 *
 * A restore used to find an order's customer by matching the phone number's raw
 * text, and not at all for a customer with no phone — so an order whose number
 * was written differently ("0300-1234567" against "03001234567"), or that had no
 * phone at all, was restored with no customer. Its litres, balance and history
 * then never reached that customer's screen, which is why the litres consumed
 * came out short for some customers only.
 *
 * Restores now link them correctly (db/cloud-restore.js). This mends a till that
 * was restored before that: it only ever fills in a MISSING link on a credit
 * order (never changes one that is set, never touches a cash sale), matching by
 * the same rule as everything else (db/person-key.js), and can be run again
 * harmlessly. Returns how many orders it linked.
 */
function relinkCreditOrders() {
  const customers = db.prepare('SELECT id, name, phone FROM customers ORDER BY active DESC, id').all();
  const byPerson = new Map();
  for (const c of customers) {
    const key = personKey(c.name, c.phone);
    if (key && !byPerson.has(key)) byPerson.set(key, c.id);
  }
  if (byPerson.size === 0) return 0;

  const orphans = db.prepare(`
    SELECT id, customer_name, customer_phone FROM orders
     WHERE payment_method = 'Credit' AND customer_id IS NULL
       AND (COALESCE(customer_phone, '') != '' OR COALESCE(customer_name, '') != '')`).all();
  const link = db.prepare('UPDATE orders SET customer_id = ? WHERE id = ? AND customer_id IS NULL');
  let linked = 0;
  db.transaction(() => {
    for (const o of orphans) {
      const id = byPerson.get(personKey(o.customer_name, o.customer_phone));
      if (id != null && link.run(id, o.id).changes) linked++;
    }
  })();
  return linked;
}

module.exports = { relinkCreditOrders };
