#!/usr/bin/env node
/**
 * One-off: set every ingredient's stock to 0 on the cloud.
 *
 * For each ingredient, creates a 'stock' entry (reason 'Recount') whose amount
 * is the negative of the current stock — so the ledger sum becomes 0 — then
 * recomputes the ingredient's stock from its entries.
 *
 * Usage:  node cloud/scripts/zero-stock.js
 *
 * Reads DATABASE_URL from cloud/.env (or from the environment if already set).
 */

require('../env').loadEnv();

const { Client } = require('pg');

const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows: ingredients } = await client.query(
      "SELECT branch_id, local_id, name, unit, stock FROM ingredients ORDER BY branch_id, name"
    );

    if (!ingredients.length) {
      console.log('No ingredients found.');
      return;
    }

    console.log('Current stock:');
    for (const i of ingredients) {
      console.log(`  ${i.name}: ${i.stock} ${i.unit}  (branch ${i.branch_id}, id ${i.local_id})`);
    }

    await client.query('BEGIN');

    for (const ing of ingredients) {
      const current = Number(ing.stock);
      if (current === 0) {
        console.log(`  ${ing.name} is already 0 — skipped.`);
        continue;
      }

      // Allocate a local_id for this cloud-created entry.
      const { rows: [{ next_id }] } = await client.query(
        `SELECT COALESCE(MAX(local_id), 0) + 1 AS next_id
           FROM inventory_entries
          WHERE branch_id = $1 AND device_id = 'cloud'`,
        [ing.branch_id]
      );

      // Create an entry that zeroes the stock.
      const change = -current;
      await client.query(
        `INSERT INTO inventory_entries
           (branch_id, local_id, device_id, ingredient_local_id, type, amount,
            entry_date, created_at, received_at, reason)
         VALUES ($1, $2, 'cloud', $3, 'stock', $4, $5, $6, $7, 'Recount')`,
        [ing.branch_id, next_id, ing.local_id, change, today,
         new Date().toISOString(), Date.now()]
      );

      console.log(`  ${ing.name}: entry created (${change} ${ing.unit})`);
    }

    // Recompute every ingredient's stock from its entries.
    await client.query(`
      UPDATE ingredients i
         SET stock = COALESCE(
               (SELECT SUM(e.amount)
                  FROM inventory_entries e
                 WHERE e.branch_id = i.branch_id
                   AND e.ingredient_local_id = i.local_id
                   AND e.superseded_by IS NULL), 0)
    `);

    await client.query('COMMIT');

    // Verify.
    const { rows: after } = await client.query(
      "SELECT name, stock, unit FROM ingredients ORDER BY name"
    );
    console.log('\nAfter:');
    for (const i of after) {
      console.log(`  ${i.name}: ${i.stock} ${i.unit}`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Failed — rolled back:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
